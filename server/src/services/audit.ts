import type { Queryable } from "../db/pool.js";
import type { AuditContext } from "../lib/context.js";

export interface AuditEntry {
  projectId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
}

/** Writes an append-only audit row. Call with the same transaction client as the mutation. */
export async function writeAudit(q: Queryable, ctx: AuditContext, entry: AuditEntry): Promise<void> {
  await q.query(
    `INSERT INTO audit_logs (project_id, actor_id, action, target_type, target_id, reason, before, after,
                             request_id, ip_hash, user_agent_summary)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      entry.projectId,
      ctx.actorId,
      entry.action,
      entry.targetType,
      entry.targetId,
      entry.reason ?? null,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      ctx.requestId,
      ctx.ipHash,
      ctx.userAgent,
    ],
  );
}
