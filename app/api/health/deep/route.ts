import { NextResponse } from "next/server";
import { ethers } from "ethers";
import { prisma } from "@/lib/prisma";

export const maxDuration = 60;

const CHECK_TIMEOUT_MS = 5000;

type CheckResult = { status: "up" | "down"; latency_ms: number };

/**
 * Races a check against a timeout so one hanging dependency can't hang the
 * whole endpoint. The check itself is expected to never throw (each one below
 * catches internally), but this is a second line of defense.
 */
async function withTimeout(
  label: string,
  fn: (signal: AbortSignal) => Promise<void>
): Promise<CheckResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

  try {
    await fn(controller.signal);
    return { status: "up", latency_ms: Date.now() - start };
  } catch (err: any) {
    console.error(`[health] ${label} check failed: ${err.message || String(err)}`);
    return { status: "down", latency_ms: Date.now() - start };
  } finally {
    clearTimeout(timeout);
  }
}

async function checkDatabase(): Promise<CheckResult> {
  return withTimeout("database", async () => {
    await prisma.$queryRaw`SELECT 1`;
  });
}

async function checkPinata(): Promise<CheckResult> {
  return withTimeout("pinata", async (signal) => {
    const pinataJwt = process.env.PINATA_JWT;
    if (!pinataJwt) {
      throw new Error("PINATA_JWT is not set in environment");
    }

    const res = await fetch("https://api.pinata.cloud/data/testAuthentication", {
      headers: { Authorization: `Bearer ${pinataJwt}` },
      signal,
    });

    if (!res.ok) {
      throw new Error(`Pinata returned ${res.status}`);
    }
  });
}

async function checkSentinelHub(): Promise<CheckResult> {
  return withTimeout("sentinel_hub", async (signal) => {
    const clientId = process.env.SENTINELHUB_CLIENT_ID;
    const clientSecret = process.env.SENTINELHUB_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error("SENTINELHUB_CLIENT_ID or SENTINELHUB_CLIENT_SECRET is not set in environment");
    }

    const res = await fetch("https://services.sentinel-hub.com/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }),
      signal,
    });

    if (!res.ok) {
      throw new Error(`Sentinel Hub OAuth returned ${res.status}`);
    }
  });
}

async function checkOpenAi(): Promise<CheckResult> {
  return withTimeout("openai", async (signal) => {
    const openAiApiKey = process.env.OPENAI_API_KEY;
    if (!openAiApiKey) {
      throw new Error("OPENAI_API_KEY is not set in environment");
    }

    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${openAiApiKey}` },
      signal,
    });

    if (!res.ok) {
      throw new Error(`OpenAI returned ${res.status}`);
    }
  });
}

async function checkPolygonRpc(): Promise<CheckResult> {
  return withTimeout("polygon_rpc", async () => {
    const rpcUrl = process.env.ALCHEMY_RPC_URL;
    if (!rpcUrl) {
      throw new Error("ALCHEMY_RPC_URL is not set in environment");
    }

    // Same provider config as app/api/mint/[submissionId]/route.ts: pinning
    // the network skips ethers' implicit network-detection call, and
    // batchMaxCount: 1 stops that call from being batched with getBlockNumber
    // below — Alchemy rejects batched JSON-RPC requests on this endpoint.
    // ethers doesn't accept an AbortSignal for this call, so the outer
    // withTimeout race (via Promise.race below) is what actually bounds it.
    const provider = new ethers.JsonRpcProvider(
      rpcUrl,
      { chainId: 80002, name: "amoy" },
      { staticNetwork: true, batchMaxCount: 1 }
    );

    await Promise.race([
      provider.getBlockNumber(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Polygon RPC call timed out")), CHECK_TIMEOUT_MS)
      ),
    ]);
  });
}

export async function GET() {
  try {
    const [database, pinata, sentinel_hub, openai, polygon_rpc] = await Promise.allSettled([
      checkDatabase(),
      checkPinata(),
      checkSentinelHub(),
      checkOpenAi(),
      checkPolygonRpc(),
    ]);

    // Each check function already catches its own errors and resolves to a
    // CheckResult, so allSettled should always see "fulfilled" here — this
    // fallback only guards against a genuinely unexpected throw.
    const settle = (result: PromiseSettledResult<CheckResult>): CheckResult =>
      result.status === "fulfilled" ? result.value : { status: "down", latency_ms: 0 };

    const checks = {
      database: settle(database),
      pinata: settle(pinata),
      sentinel_hub: settle(sentinel_hub),
      openai: settle(openai),
      polygon_rpc: settle(polygon_rpc),
    };

    const anyDown = Object.values(checks).some((check) => check.status === "down");

    return NextResponse.json(
      {
        status: anyDown ? "degraded" : "ok",
        timestamp: new Date().toISOString(),
        checks,
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error(`[health] deep check failed unexpectedly: ${err.message || String(err)}`);
    return NextResponse.json(
      {
        status: "degraded",
        timestamp: new Date().toISOString(),
        error: err.message || String(err),
      },
      { status: 200 }
    );
  }
}
