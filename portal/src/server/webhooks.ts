import { createHmac } from "node:crypto";
import type { Db } from "./db.js";

/**
 * Standard Webhooks signing (https://www.standardwebhooks.com): the receiver recomputes
 * base64(HMAC-SHA256(secret, `${id}.${timestamp}.${body}`)) and compares it with `webhook-signature`.
 * The message id is the event id, so receivers can deduplicate retries.
 */
export function signWebhook(secret: Buffer, id: string, timestampSeconds: number, body: string): string {
  const mac = createHmac("sha256", secret).update(`${id}.${timestampSeconds}.${body}`).digest("base64");
  return `v1,${mac}`;
}

export const MAX_ATTEMPTS = 12;

/** Exponential backoff: 30 s, 1 m, 2 m … capped at 6 h. About 1.5 days of retries in total. */
export function backoffSeconds(attempts: number): number {
  return Math.min(30 * 2 ** Math.max(0, attempts - 1), 6 * 3600);
}

export interface DeliveryReport {
  attempted: number;
  delivered: number;
  failed: number;
}

/**
 * Delivers due outbox messages. Rows are claimed with SKIP LOCKED and a short lease, so several
 * workers (or overlapping serverless calls) never send the same message concurrently.
 */
export async function deliverDue(
  db: Db,
  webhook: { url: string; secret: Buffer },
  opts: { limit?: number; timeoutMs?: number; fetchImpl?: typeof fetch; onlyEventIds?: string[] } = {},
): Promise<DeliveryReport> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { rows } = await db.query<{ id: string; event_id: string; payload: unknown; attempts: number }>(
    `UPDATE shift.webhook_outbox o SET locked_until = now() + interval '60 seconds'
      WHERE o.id IN (
        SELECT id FROM shift.webhook_outbox
         WHERE status = 'pending' AND next_attempt_at <= now() AND (locked_until IS NULL OR locked_until < now())
           AND ($2::uuid[] IS NULL OR event_id = ANY($2::uuid[]))
         ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING o.id, o.event_id, o.payload, o.attempts`,
    [opts.limit ?? 50, opts.onlyEventIds ?? null],
  );
  const report: DeliveryReport = { attempted: rows.length, delivered: 0, failed: 0 };
  for (const row of rows) {
    const body = JSON.stringify(row.payload);
    const ts = Math.floor(Date.now() / 1000);
    let error: string | null = null;
    try {
      const res = await fetchImpl(webhook.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "webhook-id": row.event_id,
          "webhook-timestamp": String(ts),
          "webhook-signature": signWebhook(webhook.secret, row.event_id, ts, body),
          "user-agent": "shift-portal-webhooks/1",
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
      });
      if (!res.ok) error = `HTTP ${res.status}`;
    } catch (err) {
      error = err instanceof Error ? err.message.slice(0, 200) : "request failed";
    }
    const attempts = row.attempts + 1;
    if (!error) {
      report.delivered++;
      await db.query(
        `UPDATE shift.webhook_outbox SET status = 'delivered', attempts = $2::int, delivered_at = now(), locked_until = NULL, last_error = NULL WHERE id = $1`,
        [row.id, attempts],
      );
    } else {
      report.failed++;
      await db.query(
        `UPDATE shift.webhook_outbox SET attempts = $2::int, last_error = $3, locked_until = NULL,
                status = CASE WHEN $2::int >= $4::int THEN 'dead' ELSE 'pending' END,
                next_attempt_at = now() + make_interval(secs => $5::int)
          WHERE id = $1`,
        [row.id, attempts, error, MAX_ATTEMPTS, backoffSeconds(attempts)],
      );
    }
  }
  return report;
}

export function startWebhookWorker(db: Db, webhook: { url: string; secret: Buffer }, log: (err: unknown) => void, intervalMs = 15_000) {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await deliverDue(db, webhook);
    } catch (err) {
      log(err);
    } finally {
      busy = false;
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
