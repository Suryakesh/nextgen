import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { corsHeaders, handleOptions } from "@/lib/cors";
import { logAuditEvent } from "@/lib/audit";
import { checkRateLimit } from "@/lib/rate-limit";

export const maxDuration = 60;

export async function OPTIONS(request: Request) {
  return handleOptions(request);
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const headers = corsHeaders(origin);

  // Rate limit before any work (IPFS upload, DB write) is done. Vercel sets
  // x-forwarded-for to the client IP; fall back to "unknown" so unattributable
  // requests still share a single (shared, more restrictive) bucket rather
  // than bypassing the limit entirely.
  const rateLimitKey = request.headers.get("x-forwarded-for") || "unknown";
  const rateLimit = checkRateLimit(rateLimitKey, 5, 60_000);
  if (!rateLimit.allowed) {
    console.error(`[verify] submit rejected: rate limit exceeded for key '${rateLimitKey}'`);
    return NextResponse.json(
      { error: "Rate limit exceeded. Try again in a minute." },
      { status: 429, headers }
    );
  }

  try {
    const formData = await request.formData();
    const photo = formData.get("photo") as File | null;
    const latitudeStr = formData.get("latitude") as string | null;
    const longitudeStr = formData.get("longitude") as string | null;
    const wallet = (formData.get("wallet") || formData.get("wallet_address")) as string | null;

    // 1. Validate Photo
    if (!photo || !(photo instanceof File)) {
      console.error("[verify] submit rejected: missing 'photo' file");
      return NextResponse.json(
        { error: "Validation failed: 'photo' file is required." },
        { status: 400, headers }
      );
    }

    const validMimeTypes = ["image/jpeg", "image/png", "image/jpg", "image/webp"];
    if (!validMimeTypes.includes(photo.type.toLowerCase())) {
      console.error(`[verify] submit rejected: invalid photo mime type '${photo.type}'`);
      return NextResponse.json(
        { error: `Validation failed: Invalid photo mime type '${photo.type}'. Allowed types: jpeg, png, webp.` },
        { status: 400, headers }
      );
    }

    const maxSizeBytes = 10 * 1024 * 1024; // 10MB
    if (photo.size > maxSizeBytes) {
      console.error(`[verify] submit rejected: photo size ${photo.size} bytes exceeds ${maxSizeBytes} byte limit`);
      return NextResponse.json(
        { error: `Validation failed: Photo size (${(photo.size / (1024 * 1024)).toFixed(2)}MB) exceeds 10MB limit.` },
        { status: 400, headers }
      );
    }

    // 2. Validate Latitude & Longitude
    if (latitudeStr === null || latitudeStr === undefined || latitudeStr.trim() === "") {
      console.error("[verify] submit rejected: missing 'latitude'");
      return NextResponse.json(
        { error: "Validation failed: 'latitude' is required." },
        { status: 400, headers }
      );
    }

    const latitude = parseFloat(latitudeStr);
    if (isNaN(latitude) || latitude < -90 || latitude > 90) {
      console.error(`[verify] submit rejected: invalid latitude '${latitudeStr}'`);
      return NextResponse.json(
        { error: "Validation failed: 'latitude' must be a valid number between -90 and 90." },
        { status: 400, headers }
      );
    }

    if (longitudeStr === null || longitudeStr === undefined || longitudeStr.trim() === "") {
      console.error("[verify] submit rejected: missing 'longitude'");
      return NextResponse.json(
        { error: "Validation failed: 'longitude' is required." },
        { status: 400, headers }
      );
    }

    const longitude = parseFloat(longitudeStr);
    if (isNaN(longitude) || longitude < -180 || longitude > 180) {
      console.error(`[verify] submit rejected: invalid longitude '${longitudeStr}'`);
      return NextResponse.json(
        { error: "Validation failed: 'longitude' must be a valid number between -180 and 180." },
        { status: 400, headers }
      );
    }

    // 3. Validate Wallet (strictly 40 hex characters after 0x prefix)
    if (!wallet || typeof wallet !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(wallet.trim())) {
      console.error(`[verify] submit rejected: invalid or missing wallet field (received keys: ${Array.from(formData.keys()).join(", ")})`);
      return NextResponse.json(
        { error: "Validation failed: 'wallet' must be a valid 0x-prefixed 40-character hex Ethereum address." },
        { status: 400, headers }
      );
    }

    const walletAddress = wallet.trim();

    // 4. Upsert User by wallet_address
    let user;
    try {
      user = await prisma.user.upsert({
        where: { wallet_address: walletAddress },
        update: {},
        create: { wallet_address: walletAddress },
      });
    } catch (dbErr: any) {
      console.error(`[verify] submit failed: user upsert threw: ${dbErr.message || String(dbErr)}`);
      return NextResponse.json(
        { error: `Database error while upserting user: ${dbErr.message || String(dbErr)}` },
        { status: 500, headers }
      );
    }

    // 5. Upload Photo to IPFS via Pinata
    const pinataJwt = process.env.PINATA_JWT;

    if (!pinataJwt) {
      console.error("[verify] submit failed: PINATA_JWT is not set in environment");
      return NextResponse.json(
        { error: "Server configuration error: PINATA_JWT is not set in environment." },
        { status: 500, headers }
      );
    }

    let ipfsHash = "";
    try {
      const pinataFormData = new FormData();
      pinataFormData.append("file", photo, photo.name || "mangrove-site.jpg");

      const pinataRes = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${pinataJwt}`,
        },
        body: pinataFormData,
      });

      if (!pinataRes.ok) {
        const errorText = await pinataRes.text();
        console.error(`[verify] submit failed: Pinata upload returned ${pinataRes.status}: ${errorText}`);
        return NextResponse.json(
          { error: `IPFS upload failed (Pinata API error): ${errorText}` },
          { status: 500, headers }
        );
      }

      const pinataData = await pinataRes.json();
      ipfsHash = pinataData.IpfsHash;
    } catch (ipfsErr: any) {
      console.error(`[verify] submit failed: Pinata upload threw: ${ipfsErr.message || String(ipfsErr)}`);
      return NextResponse.json(
        { error: `IPFS upload network error: ${ipfsErr.message || String(ipfsErr)}` },
        { status: 500, headers }
      );
    }

    // 6. Construct photo_url
    const gatewayBase = (process.env.PINATA_GATEWAY_URL || "https://gateway.pinata.cloud/ipfs").replace(/\/$/, "");
    const photoUrl = `${gatewayBase}/${ipfsHash}`;

    // 7. Create Submission record
    let submission;
    try {
      submission = await prisma.submission.create({
        data: {
          user_id: user.id,
          photo_url: photoUrl,
          ipfs_hash: ipfsHash,
          latitude,
          longitude,
          status: "pending",
        },
      });
    } catch (dbErr: any) {
      console.error(`[verify] submit failed: submission create threw: ${dbErr.message || String(dbErr)}`);
      return NextResponse.json(
        { error: `Database error while creating submission: ${dbErr.message || String(dbErr)}` },
        { status: 500, headers }
      );
    }

    // 8. Log the audit trail entry (non-critical — never blocks the response)
    await logAuditEvent({
      submissionId: submission.id,
      action: "submission_created",
      actor: walletAddress,
      detail: { ipfs_hash: submission.ipfs_hash, latitude, longitude },
    });

    // 9. Return successful response
    return NextResponse.json(
      {
        id: submission.id,
        ipfs_hash: submission.ipfs_hash,
        status: submission.status,
      },
      { status: 201, headers }
    );
  } catch (err: any) {
    console.error(`[verify] submit failed: unexpected error: ${err.message || String(err)}`);
    return NextResponse.json(
      { error: `Unexpected server error: ${err.message || String(err)}` },
      { status: 500, headers }
    );
  }
}
