import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { corsHeaders, handleOptions } from "@/lib/cors";
import { logAuditEvent } from "@/lib/audit";

export const maxDuration = 60;

export async function OPTIONS(request: Request) {
  return handleOptions(request);
}

export async function POST(
  request: Request,
  { params }: { params: { submissionId: string } }
) {
  const origin = request.headers.get("origin");
  const headers = corsHeaders(origin);

  try {
    const { submissionId } = params;

    if (!submissionId) {
      return NextResponse.json(
        { error: "Validation failed: 'submissionId' path parameter is required." },
        { status: 400, headers }
      );
    }

    // 1. Load Submission from Postgres
    const submission = await prisma.submission.findUnique({
      where: { id: submissionId },
    });

    if (!submission) {
      return NextResponse.json(
        { error: `Submission '${submissionId}' not found.` },
        { status: 404, headers }
      );
    }

    // 2. SATELLITE CHECK (Sentinel Hub Statistical API)
    let ndvi_score: number | null = null;
    try {
      const clientId = process.env.SENTINELHUB_CLIENT_ID;
      const clientSecret = process.env.SENTINELHUB_CLIENT_SECRET;

      if (!clientId || !clientSecret) {
        console.warn("[Satellite Check] SENTINELHUB_CLIENT_ID or SENTINELHUB_CLIENT_SECRET is missing.");
      } else {
        // Step 2a: OAuth2 Token Request
        const tokenRes = await fetch("https://services.sentinel-hub.com/oauth/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: clientId,
            client_secret: clientSecret,
          }),
        });

        if (!tokenRes.ok) {
          const tokenErrText = await tokenRes.text();
          console.warn(`[Satellite Check] OAuth token request failed (${tokenRes.status}): ${tokenErrText}`);
        } else {
          const tokenData = await tokenRes.json();
          const accessToken = tokenData.access_token;

          // Step 2b: Bounding box calculation (~50m buffer)
          const lat = submission.latitude;
          const lng = submission.longitude;
          const bufferDegLat = 0.00045; // ~50m
          const bufferDegLng = 0.00045 / Math.max(0.01, Math.cos((lat * Math.PI) / 180));

          const minLng = Number((lng - bufferDegLng).toFixed(6));
          const minLat = Number((lat - bufferDegLat).toFixed(6));
          const maxLng = Number((lng + bufferDegLng).toFixed(6));
          const maxLat = Number((lat + bufferDegLat).toFixed(6));

          const now = new Date();
          const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

          const evalscript = `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B04", "B08", "dataMask"] }],
    output: [
      { id: "default", bands: 1 },
      { id: "dataMask", bands: 1 }
    ]
  };
}
function evaluatePixel(samples) {
  let denominator = samples.B08 + samples.B04;
  let ndvi = denominator === 0 ? 0 : (samples.B08 - samples.B04) / denominator;
  return {
    default: [ndvi],
    dataMask: [samples.dataMask]
  };
}`;

          const statsRequestBody = {
            input: {
              bounds: {
                bbox: [minLng, minLat, maxLng, maxLat],
                properties: {
                  crs: "http://www.opengis.net/def/crs/EPSG/0/4326",
                },
              },
              data: [
                {
                  type: "sentinel-2-l2a",
                  dataFilter: {
                    maxCloudCoverage: 80,
                  },
                },
              ],
            },
            aggregation: {
              timeRange: {
                from: thirtyDaysAgo.toISOString(),
                to: now.toISOString(),
              },
              aggregationInterval: {
                of: "P30D",
              },
              evalscript,
            },
          };

          const statsRes = await fetch("https://services.sentinel-hub.com/api/v1/statistics", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(statsRequestBody),
          });

          if (!statsRes.ok) {
            const statsErrText = await statsRes.text();
            console.warn(`[Satellite Check] Statistical API request failed (${statsRes.status}): ${statsErrText}`);
          } else {
            const statsData = await statsRes.json();
            const intervalData = statsData?.data?.[0];
            const bandStats =
              intervalData?.outputs?.default?.bands?.B0?.stats ||
              intervalData?.outputs?.default?.bands?.["0"]?.stats;

            if (bandStats && typeof bandStats.mean === "number" && !isNaN(bandStats.mean)) {
              ndvi_score = Number(bandStats.mean.toFixed(4));
              console.log(`[Satellite Check] NDVI score retrieved: ${ndvi_score}`);
            } else {
              console.warn("[Satellite Check] No valid mean NDVI found in Statistical API response.");
            }
          }
        }
      }
    } catch (satErr: any) {
      console.warn(`[Satellite Check] Failed with error: ${satErr.message || String(satErr)}`);
      ndvi_score = null;
    }

    // 3. PHOTO CHECK (OpenAI gpt-4o-mini vision)
    let photo_confidence: number | null = null;
    let reasoning: string | null = null;

    try {
      const openAiApiKey = process.env.OPENAI_API_KEY;

      if (!openAiApiKey) {
        console.warn("[Photo Check] OPENAI_API_KEY is missing in environment.");
        reasoning = "OpenAI API key missing in server configuration.";
      } else {
        // The public Pinata gateway routinely times out fetching cold-cached
        // files — both our own fetch below AND OpenAI's own image_url fetch
        // hit the same timeout, so we must resolve to a base64 data URL
        // ourselves rather than ever handing OpenAI a gateway URL directly.
        // Try the submission's original gateway URL, then two well-known
        // public IPFS gateways keyed off the same hash, before giving up.
        const gatewayCandidates = [
          submission.photo_url,
          submission.ipfs_hash ? `https://ipfs.io/ipfs/${submission.ipfs_hash}` : null,
          submission.ipfs_hash ? `https://dweb.link/ipfs/${submission.ipfs_hash}` : null,
        ].filter((url): url is string => Boolean(url));

        let imagePayloadUrl: string | null = null;
        const pinataJwt = process.env.PINATA_JWT;

        for (const candidateUrl of gatewayCandidates) {
          try {
            const fetchHeaders: HeadersInit = { "User-Agent": "Mozilla/5.0" };
            if (pinataJwt && candidateUrl.includes("pinata")) {
              fetchHeaders["Authorization"] = `Bearer ${pinataJwt}`;
            }
            const imgFetchRes = await fetch(candidateUrl, {
              headers: fetchHeaders,
              signal: AbortSignal.timeout(12000),
            });
            if (!imgFetchRes.ok) {
              console.warn(`[Photo Check] gateway returned ${imgFetchRes.status} for ${candidateUrl}`);
              continue;
            }
            const arrayBuffer = await imgFetchRes.arrayBuffer();
            let contentType = imgFetchRes.headers.get("content-type") || "image/jpeg";
            if (!contentType.startsWith("image/")) {
              contentType = "image/jpeg";
            }
            imagePayloadUrl = `data:${contentType};base64,${Buffer.from(arrayBuffer).toString("base64")}`;
            console.log(
              `[Photo Check] fetched image from ${candidateUrl} (${arrayBuffer.byteLength} bytes, ${contentType})`
            );
            break;
          } catch (fetchErr: any) {
            console.warn(
              `[Photo Check] gateway fetch failed for ${candidateUrl}: ${fetchErr.message || String(fetchErr)}`
            );
          }
        }

        if (!imagePayloadUrl) {
          console.warn("[Photo Check] all IPFS gateways timed out or failed; skipping OpenAI call.");
          reasoning = "Could not fetch the site photo from any IPFS gateway (all attempts timed out or failed).";
        } else {
          const dataUrlPrefixMatch = imagePayloadUrl.match(/^data:([^;]+);base64,/);
          console.log(
            `[Photo Check] request payload: model=gpt-4o-mini imageSource=base64 data URL ` +
              `mimeType=${dataUrlPrefixMatch?.[1] ?? "unknown"} ` +
              `payloadLength=${imagePayloadUrl.length}`
          );

          const openAiRes = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${openAiApiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "gpt-4o-mini",
              messages: [
                {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: "Does this photo clearly show mangrove or coastal vegetation? Respond only with JSON: {\"confidence\": 0-100, \"reasoning\": string}",
                    },
                    {
                      type: "image_url",
                      image_url: {
                        url: imagePayloadUrl,
                      },
                    },
                  ],
                },
              ],
              response_format: { type: "json_object" },
              max_tokens: 300,
            }),
          });

          if (!openAiRes.ok) {
            const openAiErrText = await openAiRes.text();
            let errMessage = openAiErrText;
            let errParam: string | null = null;
            let errCode: string | null = null;
            try {
              const parsedErr = JSON.parse(openAiErrText);
              errMessage = parsedErr?.error?.message ?? openAiErrText;
              errParam = parsedErr?.error?.param ?? null;
              errCode = parsedErr?.error?.code ?? null;
            } catch {
              // Body wasn't JSON — keep the raw text as the message.
            }
            console.warn(
              `[Photo Check] OpenAI Vision API call failed (${openAiRes.status}): ` +
                `message=${errMessage} param=${errParam} code=${errCode}`
            );
            reasoning = `OpenAI API returned error status ${openAiRes.status}: ${errMessage}`;
          } else {
            const openAiData = await openAiRes.json();
            const rawContent = openAiData?.choices?.[0]?.message?.content;

            if (rawContent) {
              const parsed = JSON.parse(rawContent);
              if (typeof parsed.confidence === "number") {
                photo_confidence = Math.max(0, Math.min(100, parsed.confidence));
              }
              if (typeof parsed.reasoning === "string") {
                reasoning = parsed.reasoning;
              }
              console.log(`[Photo Check] Photo confidence: ${photo_confidence}, Reasoning: ${reasoning}`);
            }
          }
        }
      }
    } catch (visionErr: any) {
      console.warn(`[Photo Check] Failed with error: ${visionErr.message || String(visionErr)}`);
      photo_confidence = null;
      reasoning = reasoning || `Photo classification failed: ${visionErr.message || String(visionErr)}`;
    }

    // 4. DECISION LOGIC
    // verified if photo_confidence > 60 AND (ndvi_score > 0.3 OR ndvi_score is null/unavailable)
    // rejected otherwise (or if photo_confidence is null)
    let decisionStatus: "verified" | "rejected" = "rejected";

    if (
      photo_confidence !== null &&
      photo_confidence > 60 &&
      (ndvi_score === null || ndvi_score > 0.3)
    ) {
      decisionStatus = "verified";
    } else {
      decisionStatus = "rejected";
    }

    // Reporting only — does not affect decisionStatus/submission.status above.
    // "pending_imagery" means the satellite or vision check never ran (missing
    // credentials, upstream failure), so there is no imagery basis for a
    // verified/rejected call even though decisionStatus still resolves one.
    const ndviAvailable = ndvi_score !== null;
    let verificationStatus: "verified" | "pending_imagery" | "failed";
    if (photo_confidence === null || ndvi_score === null) {
      verificationStatus = "pending_imagery";
    } else if (photo_confidence > 60 && ndvi_score > 0.3) {
      verificationStatus = "verified";
    } else {
      verificationStatus = "failed";
    }

    // 5. Write Verification row & 6. Update Submission status
    try {
      await prisma.verification.upsert({
        where: { submission_id: submission.id },
        update: {
          ndvi_score,
          photo_confidence,
          reasoning,
          verified_at: new Date(),
        },
        create: {
          submission_id: submission.id,
          ndvi_score,
          photo_confidence,
          reasoning,
          verified_at: new Date(),
        },
      });

      await prisma.submission.update({
        where: { id: submission.id },
        data: { status: decisionStatus, verification_status: verificationStatus },
      });
    } catch (dbErr: any) {
      console.error(`[Database Error] Failed to write verification or update submission: ${dbErr.message || String(dbErr)}`);
      return NextResponse.json(
        { error: `Database write failure: ${dbErr.message || String(dbErr)}` },
        { status: 500, headers }
      );
    }

    // 7. Log the audit trail entry (non-critical — never blocks the response)
    await logAuditEvent({
      submissionId: submission.id,
      action: decisionStatus === "verified" ? "verification_passed" : "verification_failed",
      actor: "system",
      detail: {
        ndvi_score,
        photo_confidence,
        reasoning,
        verification_status: verificationStatus,
      },
    });

    // 8. Return 200 JSON response
    return NextResponse.json(
      {
        status: decisionStatus,
        ndvi_score,
        photo_confidence,
        reasoning,
        ndviAvailable,
        verificationStatus,
      },
      { status: 200, headers }
    );
  } catch (err: any) {
    return NextResponse.json(
      { error: `Unexpected server error: ${err.message || String(err)}` },
      { status: 500, headers }
    );
  }
}
