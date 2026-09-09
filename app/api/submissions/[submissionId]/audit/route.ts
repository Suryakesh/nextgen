import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { corsHeaders, handleOptions } from "@/lib/cors";

export const maxDuration = 60;

export async function OPTIONS(request: Request) {
  return handleOptions(request);
}

export async function GET(
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

    // 1. Confirm the submission exists
    const submission = await prisma.submission.findUnique({
      where: { id: submissionId },
    });

    if (!submission) {
      return NextResponse.json(
        { error: `Submission '${submissionId}' not found.` },
        { status: 404, headers }
      );
    }

    // 2. Load the full audit trail, oldest first (chronological timeline)
    const auditEvents = await prisma.auditEvent.findMany({
      where: { submission_id: submissionId },
      orderBy: { created_at: "asc" },
    });

    // 3. Format response fields
    const formattedEvents = auditEvents.map((event) => ({
      id: event.id,
      action: event.action,
      actor: event.actor,
      detail: event.detail,
      created_at: event.created_at,
    }));

    return NextResponse.json(
      { submission_id: submissionId, audit_events: formattedEvents },
      { status: 200, headers }
    );
  } catch (err: any) {
    console.error(`[audit] failed to load audit trail: ${err.message || String(err)}`);
    return NextResponse.json(
      { error: `Unexpected server error: ${err.message || String(err)}` },
      { status: 500, headers }
    );
  }
}
