import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const maxDuration = 60;

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;

    return NextResponse.json(
      {
        status: "ok",
        timestamp: new Date().toISOString(),
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error(`[health] liveness check failed: ${err.message || String(err)}`);
    return NextResponse.json(
      {
        status: "error",
        error: err.message || String(err),
      },
      { status: 503 }
    );
  }
}
