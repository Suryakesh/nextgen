import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

/**
 * Append-only audit trail for status-changing submission actions. A logging
 * failure must never fail or throw into the calling route's response — this
 * is judge-facing evidence, not a critical-path dependency, so every error is
 * swallowed after a console.error (same treatment the routes already give
 * non-critical steps like the Pinata/Sentinel Hub calls).
 */
export async function logAuditEvent(params: {
  submissionId: string;
  action: string;
  actor?: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  const { submissionId, action, actor, detail } = params;

  try {
    await prisma.auditEvent.create({
      data: {
        submission_id: submissionId,
        action,
        actor: actor ?? null,
        detail: (detail ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  } catch (err: any) {
    console.error(
      `[audit] failed to log event '${action}' for submission '${submissionId}': ${err.message || String(err)}`
    );
  }
}
