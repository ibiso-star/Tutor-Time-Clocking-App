import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { DateTime } from "luxon";
import { ApiError } from "../errors.js";
import { employeeByBadge, requireKiosk, requireLink } from "../auth.js";
import { hashIp } from "../credentials.js";
import { workedSeconds, type State } from "../domain.js";
import { EVENT_SELECT, toEventDto, type EventRow } from "../events.js";
import { punch, type PunchResult } from "../punch.js";
import { deliverDue } from "../webhooks.js";
import type { AppDeps } from "../app.js";

const punchBody = z.object({
  action: z.enum(["CLOCK_IN", "BREAK_START", "BREAK_END", "CLOCK_OUT"]),
  end_break: z.boolean().optional(),
  client_time: z.iso.datetime({ offset: true }).nullish(),
});

function idempotencyKey(req: FastifyRequest): string {
  const key = req.headers["idempotency-key"];
  if (typeof key !== "string" || !z.uuid().safeParse(key).success) {
    throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "Send a UUID Idempotency-Key header with every punch.");
  }
  return key;
}

const publicResult = ({ event, state, replayed }: PunchResult) => ({ event, state, replayed });

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) throw new ApiError(400, "VALIDATION_ERROR", r.error.issues[0]?.message ?? "Invalid request.");
  return r.data;
}

export async function publicRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db, config, limiter } = deps;

  /** Push the new event's webhook right away; the outbox retries anything that fails. */
  const deliverNow = async (result: PunchResult) => {
    if (!config.webhook || result.eventIds.length === 0) return;
    await deliverDue(db, config.webhook, { onlyEventIds: result.eventIds, timeoutMs: 3000 }).catch((err) =>
      app.log.warn({ err }, "immediate webhook delivery failed; will retry"),
    );
  };

  app.get("/api/v1/me", async (req) => {
    limiter.check(`link-ip:${req.ip}`, 120, 60_000);
    const who = await requireLink(db, req);
    const now = new Date();
    const day = DateTime.fromJSDate(now, { zone: config.timezone }).startOf("day");
    const from = day.toJSDate();
    const to = day.plus({ days: 1 }).toJSDate();
    const { rows: emp } = await db.query<{ state: State; state_since: Date | null; open_session_id: string | null }>(
      `SELECT state, state_since, open_session_id FROM shift.employees WHERE id = $1`,
      [who.employeeId],
    );
    // Today's events plus the whole open session (it may have started before midnight).
    const { rows } = await db.query<EventRow>(
      `${EVENT_SELECT} WHERE e.employee_id = $1 AND (e.occurred_at >= $2 OR e.session_id = $3) ORDER BY e.seq`,
      [who.employeeId, from, emp[0]!.open_session_id],
    );
    return {
      employee: { display_name: who.displayName },
      state: emp[0]!.state,
      since: emp[0]!.state_since?.toISOString() ?? null,
      today: {
        worked_seconds: workedSeconds(rows.map((r) => ({ type: r.event_type, at: r.occurred_at })), from, to, now),
        events: rows.filter((r) => r.occurred_at >= from).map(toEventDto),
      },
      timezone: config.timezone,
      server_time: now.toISOString(),
    };
  });

  app.post("/api/v1/punch", async (req, reply) => {
    limiter.check(`link-ip:${req.ip}`, 120, 60_000);
    const who = await requireLink(db, req);
    limiter.check(`punch:${who.employeeId}`, 20, 60_000);
    const key = idempotencyKey(req);
    const body = parse(punchBody, req.body);
    const result = await punch(
      db,
      { employeeId: who.employeeId, action: body.action, endBreak: body.end_break, idempotencyKey: key, clientTime: body.client_time, source: "link", ipHash: hashIp(req.ip) },
      !!config.webhook,
    );
    await deliverNow(result);
    reply.status(result.replayed ? 200 : 201);
    return publicResult(result);
  });

  app.post("/api/v1/kiosk/identify", async (req) => {
    const kiosk = await requireKiosk(db, req);
    // Badge guessing is throttled per kiosk device and per network address.
    limiter.check(`badge-kiosk:${kiosk.kioskId}`, 60, 60_000);
    limiter.check(`badge-ip:${req.ip}`, 60, 60_000);
    const { badge } = parse(z.object({ badge: z.string().min(4).max(40) }), req.body);
    const e = await employeeByBadge(db, badge);
    return { display_name: e.display_name, state: e.state, since: e.state_since?.toISOString() ?? null };
  });

  app.post("/api/v1/kiosk/punch", async (req, reply) => {
    const kiosk = await requireKiosk(db, req);
    limiter.check(`badge-kiosk:${kiosk.kioskId}`, 60, 60_000);
    const key = idempotencyKey(req);
    const body = parse(punchBody.extend({ badge: z.string().min(4).max(40) }), req.body);
    const e = await employeeByBadge(db, body.badge);
    const result = await punch(
      db,
      { employeeId: e.id, action: body.action, endBreak: body.end_break, idempotencyKey: key, clientTime: body.client_time, source: "kiosk", kioskId: kiosk.kioskId, ipHash: hashIp(req.ip) },
      !!config.webhook,
    );
    await deliverNow(result);
    reply.status(result.replayed ? 200 : 201);
    return { ...publicResult(result), display_name: e.display_name };
  });
}
