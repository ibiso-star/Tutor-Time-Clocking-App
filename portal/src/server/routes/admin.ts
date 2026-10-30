import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DateTime } from "luxon";
import { ApiError } from "../errors.js";
import { requireApiKey } from "../auth.js";
import { hashSecret, newBadgeCode, newToken, normalizeBadge } from "../credentials.js";
import { workedSeconds } from "../domain.js";
import { EVENT_SELECT, toEventDto, type EventRow } from "../events.js";
import { deliverDue } from "../webhooks.js";
import { parse } from "./public.js";
import type { AppDeps } from "../app.js";

const EMP_COLS = `id, display_name, external_ref, link_enabled, kiosk_enabled, active, state, state_since AS since, created_at`;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

export async function adminRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db, config } = deps;
  const auth = (req: Parameters<typeof requireApiKey>[1]) => {
    deps.limiter.check(`api-ip:${req.ip}`, 600, 60_000);
    requireApiKey(config.apiKey, req);
  };
  const linkUrl = (token: string) => `${config.publicBaseUrl}/s#t=${token}`;

  /** Issues fresh credentials; plain values are returned once and only their hashes are stored. */
  async function issue(id: string, which: { link: boolean; badge: boolean }) {
    const token = which.link ? newToken() : null;
    const badge = which.badge ? newBadgeCode() : null;
    const { rows } = await db.query(
      `UPDATE shift.employees SET
          link_token_hash = COALESCE($2, link_token_hash),
          badge_code_hash = COALESCE($3, badge_code_hash),
          updated_at = now()
        WHERE id = $1 RETURNING ${EMP_COLS}`,
      [id, token && hashSecret(token), badge && hashSecret(normalizeBadge(badge))],
    );
    if (!rows[0]) throw new ApiError(404, "NOT_FOUND", "Employee not found.");
    return { employee: rows[0], link_url: token ? linkUrl(token) : null, badge_code: badge };
  }

  app.get("/api/v1/employees", async (req) => {
    auth(req);
    const { rows } = await db.query(`SELECT ${EMP_COLS} FROM shift.employees ORDER BY active DESC, display_name`);
    return { employees: rows };
  });

  const employeeInput = z.object({
    display_name: z.string().trim().min(1).max(120),
    external_ref: z.string().trim().min(1).max(120).nullish(),
    link_enabled: z.boolean().default(true),
    kiosk_enabled: z.boolean().default(true),
  });

  app.post("/api/v1/employees", async (req, reply) => {
    auth(req);
    const body = parse(employeeInput, req.body);
    try {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO shift.employees (display_name, external_ref, link_enabled, kiosk_enabled) VALUES ($1,$2,$3,$4) RETURNING id`,
        [body.display_name, body.external_ref ?? null, body.link_enabled, body.kiosk_enabled],
      );
      reply.status(201);
      return issue(rows[0]!.id, { link: true, badge: true });
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new ApiError(409, "DUPLICATE_EXTERNAL_REF", "Another employee already has that external reference.");
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>("/api/v1/employees/:id", async (req) => {
    auth(req);
    const id = parse(z.uuid(), req.params.id);
    const body = parse(employeeInput.partial().extend({ active: z.boolean().optional() }), req.body);
    const { rows } = await db.query(
      `UPDATE shift.employees SET
          display_name = COALESCE($2, display_name),
          external_ref = CASE WHEN $3::boolean THEN $4 ELSE external_ref END,
          link_enabled = COALESCE($5, link_enabled),
          kiosk_enabled = COALESCE($6, kiosk_enabled),
          active = COALESCE($7, active),
          updated_at = now()
        WHERE id = $1 RETURNING ${EMP_COLS}`,
      [id, body.display_name ?? null, body.external_ref !== undefined, body.external_ref ?? null, body.link_enabled ?? null, body.kiosk_enabled ?? null, body.active ?? null],
    );
    if (!rows[0]) throw new ApiError(404, "NOT_FOUND", "Employee not found.");
    return rows[0];
  });

  app.post<{ Params: { id: string } }>("/api/v1/employees/:id/credentials", async (req) => {
    auth(req);
    const id = parse(z.uuid(), req.params.id);
    const body = parse(z.object({ link: z.boolean().default(false), badge: z.boolean().default(false) }), req.body);
    if (!body.link && !body.badge) throw new ApiError(400, "NOTHING_TO_ROTATE", "Choose link, badge, or both.");
    return issue(id, body);
  });

  /** Live snapshot for the admin dashboard: who is on shift now and today's worked time per person. */
  app.get("/api/v1/overview", async (req) => {
    auth(req);
    const now = new Date();
    const day = DateTime.fromJSDate(now, { zone: config.timezone }).startOf("day");
    const from = day.toJSDate();
    const to = day.plus({ days: 1 }).toJSDate();
    const { rows: people } = await db.query<{ id: string; display_name: string; external_ref: string | null; state: "OUT" | "IN" | "BREAK"; since: Date | null }>(
      `SELECT id, display_name, external_ref, state, state_since AS since FROM shift.employees WHERE active ORDER BY display_name`,
    );
    const { rows } = await db.query<{ employee_id: string; event_type: EventRow["event_type"]; occurred_at: Date }>(
      `SELECT employee_id, event_type, occurred_at FROM shift.events WHERE session_id IN (
          SELECT DISTINCT session_id FROM shift.events WHERE occurred_at >= $1::timestamptz - interval '2 days')
        ORDER BY seq`,
      [from],
    );
    const byEmp = new Map<string, Array<{ type: EventRow["event_type"]; at: Date }>>();
    let punches = 0;
    for (const r of rows) {
      byEmp.set(r.employee_id, [...(byEmp.get(r.employee_id) ?? []), { type: r.event_type, at: r.occurred_at }]);
      if (r.occurred_at >= from && r.occurred_at < to) punches++;
    }
    const list = people.map((p) => ({
      id: p.id,
      display_name: p.display_name,
      external_ref: p.external_ref,
      state: p.state,
      since: p.since?.toISOString() ?? null,
      today_worked_seconds: workedSeconds(byEmp.get(p.id) ?? [], from, to, now),
    }));
    return {
      timezone: config.timezone,
      server_time: now.toISOString(),
      counts: { IN: list.filter((p) => p.state === "IN").length, BREAK: list.filter((p) => p.state === "BREAK").length, OUT: list.filter((p) => p.state === "OUT").length },
      today: { worked_seconds: list.reduce((t, p) => t + p.today_worked_seconds, 0), punches },
      people: list,
    };
  });

  app.get("/api/v1/kiosks", async (req) => {
    auth(req);
    const { rows } = await db.query(`SELECT id, name, active, created_at, last_seen_at, revoked_at FROM shift.kiosks ORDER BY active DESC, created_at DESC`);
    return { kiosks: rows };
  });

  app.post("/api/v1/kiosks", async (req, reply) => {
    auth(req);
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(80) }), req.body);
    const token = newToken();
    const { rows } = await db.query(
      `INSERT INTO shift.kiosks (name, token_hash) VALUES ($1,$2) RETURNING id, name, active, created_at`,
      [name, hashSecret(token)],
    );
    reply.status(201);
    return { kiosk: rows[0], pairing_url: `${config.publicBaseUrl}/kiosk#pair=${token}` };
  });

  app.post<{ Params: { id: string } }>("/api/v1/kiosks/:id/revoke", async (req) => {
    auth(req);
    const id = parse(z.uuid(), req.params.id);
    const { rowCount } = await db.query(`UPDATE shift.kiosks SET active = false, revoked_at = now() WHERE id = $1 AND active`, [id]);
    return { ok: true, revoked: rowCount === 1 };
  });

  app.get("/api/v1/events", async (req) => {
    auth(req);
    const q = parse(
      z.object({
        after: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        employee_id: z.uuid().optional(),
        order: z.enum(["asc", "desc"]).default("asc"),
      }),
      req.query,
    );
    const { rows } = await db.query<EventRow>(
      `${EVENT_SELECT} WHERE e.seq > $1 AND ($3::uuid IS NULL OR e.employee_id = $3) ORDER BY e.seq ${q.order === "desc" ? "DESC" : "ASC"} LIMIT $2`,
      [q.after, q.limit, q.employee_id ?? null],
    );
    const events = rows.map(toEventDto);
    const maxSeq = events.reduce((m, e) => Math.max(m, e.seq), q.after);
    return { events, next_cursor: maxSeq };
  });

  app.get("/api/v1/timesheet", async (req, reply) => {
    auth(req);
    const q = parse(z.object({ from: isoDate, to: isoDate, format: z.enum(["json", "csv"]).default("json") }), req.query);
    const tz = config.timezone;
    const start = DateTime.fromISO(q.from, { zone: tz }).startOf("day");
    const end = DateTime.fromISO(q.to, { zone: tz }).plus({ days: 1 }).startOf("day");
    if (!start.isValid || !end.isValid || end <= start) throw new ApiError(400, "INVALID_RANGE", "Check the dates.");
    if (end.diff(start, "days").days > 93) throw new ApiError(400, "RANGE_TOO_LARGE", "Choose 93 days or fewer.");
    // Include whole sessions that touch the range so time is clipped correctly at its edges.
    const { rows } = await db.query<EventRow>(
      `${EVENT_SELECT} WHERE e.session_id IN (
          SELECT DISTINCT session_id FROM shift.events WHERE occurred_at >= $1::timestamptz - interval '2 days' AND occurred_at < $2)
        ORDER BY e.seq`,
      [start.toJSDate(), end.toJSDate()],
    );
    const now = new Date();
    const byEmp = new Map<string, EventRow[]>();
    for (const r of rows) byEmp.set(r.employee_id, [...(byEmp.get(r.employee_id) ?? []), r]);
    const lines: Array<{ employee_id: string; external_ref: string | null; display_name: string; date: string; worked_seconds: number }> = [];
    for (const evs of byEmp.values()) {
      const timed = evs.map((e) => ({ type: e.event_type, at: e.occurred_at }));
      for (let d = start; d < end; d = d.plus({ days: 1 })) {
        const secs = workedSeconds(timed, d.toJSDate(), d.plus({ days: 1 }).toJSDate(), now);
        if (secs > 0) lines.push({ employee_id: evs[0]!.employee_id, external_ref: evs[0]!.external_ref, display_name: evs[0]!.display_name, date: d.toISODate()!, worked_seconds: secs });
      }
    }
    lines.sort((a, b) => a.display_name.localeCompare(b.display_name) || a.date.localeCompare(b.date));
    if (q.format === "csv") {
      const cell = (v: unknown) => {
        let s = v == null ? "" : String(v);
        if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
        return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
      };
      const csv = [["employee_id", "external_ref", "display_name", "date", "worked_minutes", "timezone"].join(",")]
        .concat(lines.map((l) => [l.employee_id, l.external_ref, l.display_name, l.date, (l.worked_seconds / 60).toFixed(2), tz].map(cell).join(",")))
        .join("\r\n");
      reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="timesheet_${q.from}_${q.to}.csv"`);
      return csv + "\r\n";
    }
    return { timezone: tz, from: q.from, to: q.to, lines };
  });

  app.get("/api/v1/webhooks/status", async (req) => {
    auth(req);
    const { rows } = await db.query(
      `SELECT status, count(*)::int AS n, max(last_error) FILTER (WHERE status <> 'delivered') AS last_error
         FROM shift.webhook_outbox GROUP BY status`,
    );
    return { configured: !!config.webhook, url: config.webhook ? new URL(config.webhook.url).origin : null, counts: rows };
  });

  app.post("/api/v1/webhooks/deliver", async (req) => {
    auth(req);
    if (!config.webhook) throw new ApiError(400, "WEBHOOKS_NOT_CONFIGURED", "Set WEBHOOK_URL and WEBHOOK_SECRET to enable webhooks.");
    return deliverDue(db, config.webhook, { limit: 200 });
  });

  const specPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../openapi.yaml");
  app.get("/api/v1/openapi.yaml", async (_req, reply) => {
    reply.header("content-type", "application/yaml; charset=utf-8");
    return readFile(specPath, "utf8");
  });
}
