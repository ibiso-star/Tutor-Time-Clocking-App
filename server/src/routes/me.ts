import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DateTime } from "luxon";
import { auditContext, requireUser } from "../lib/context.js";
import { badRequest, notFound } from "../lib/errors.js";
import { parse } from "../lib/validate.js";
import { isIsoDate, localDate, localDateRange } from "../domain/time.js";
import { describeRounding } from "../domain/policy.js";
import { isUuid, requireProjectRole } from "../services/access.js";
import { timeStatus } from "../services/clock.js";
import { loadBundles, loadSessionDetail, loadSessionRows, toSessionDto } from "../services/sessions.js";
import { correctionInputSchema, createCorrection, withdrawCorrection } from "../services/review.js";

const projectQuery = z.object({ project_id: z.uuid("Choose a project.") });
const rangeQuery = projectQuery.extend({
  from: z.string().refine(isIsoDate, "Use a YYYY-MM-DD date.").optional(),
  to: z.string().refine(isIsoDate, "Use a YYYY-MM-DD date.").optional(),
});

export async function meRoutes(app: FastifyInstance) {
  const { db } = app;

  app.get("/v1/me", async (req) => {
    const user = requireUser(req.user);
    const { rows } = await db.query(
      `SELECT m.role, p.id AS project_id, p.name AS project_name, p.timezone, p.settings, t.name AS team_name
         FROM project_memberships m
         JOIN projects p ON p.id = m.project_id AND p.status = 'active'
         LEFT JOIN teams t ON t.id = m.team_id
        WHERE m.user_id = $1 AND m.active_to IS NULL
        ORDER BY p.name`,
      [user.id],
    );
    let memberships = rows.map((r) => ({
      project: { id: r.project_id, name: r.project_name, timezone: r.timezone, rounding_rule: describeRounding(r.settings.rounding ?? { mode: "none", increment_minutes: 1 }) },
      role: r.role,
      team: r.team_name,
    }));
    if (user.is_system_admin) {
      const { rows: all } = await db.query(`SELECT id, name, timezone, settings FROM projects WHERE status = 'active' ORDER BY name`);
      const seen = new Set(memberships.map((m) => m.project.id));
      memberships = memberships.concat(
        all
          .filter((p) => !seen.has(p.id))
          .map((p) => ({ project: { id: p.id, name: p.name, timezone: p.timezone, rounding_rule: describeRounding(p.settings.rounding) }, role: "admin", team: null })),
      );
    }
    return {
      user: { id: user.id, email: user.email, display_name: user.display_name, is_system_admin: user.is_system_admin },
      memberships,
      csrf_token: req.csrfToken,
      server_time: new Date().toISOString(),
    };
  });

  app.get("/v1/me/time-status", async (req) => {
    const user = requireUser(req.user);
    const q = parse(projectQuery, req.query);
    const scope = await requireProjectRole(db, user, q.project_id, "tutor");
    return timeStatus(db, user.id, scope.project, new Date());
  });

  app.get("/v1/me/time-entries", async (req) => {
    const user = requireUser(req.user);
    const q = parse(rangeQuery, req.query);
    const scope = await requireProjectRole(db, user, q.project_id, "tutor");
    const tz = scope.project.timezone;
    const now = new Date();
    const to = q.to ?? localDate(now, tz);
    const from = q.from ?? DateTime.fromISO(to).minus({ days: 13 }).toISODate()!;
    if (from > to) throw badRequest("INVALID_RANGE", "Start date must be on or before end date.");
    if (DateTime.fromISO(to).diff(DateTime.fromISO(from), "days").days > 92) throw badRequest("RANGE_TOO_LARGE", "Choose 93 days or fewer.");
    const range = localDateRange(from, to, tz);
    const sessions = await loadSessionRows(
      db,
      `s.project_id = $1 AND s.tutor_id = $2 AND s.started_at >= $3::timestamptz - interval '1 day' AND s.started_at < $4::timestamptz + interval '1 day'`,
      [scope.project.id, user.id, range.start, range.end],
      "ORDER BY s.started_at DESC",
    );
    const dtos = (await loadBundles(db, sessions))
      .map((b) => toSessionDto(b, scope.project, now))
      .filter((d) => d.local_date >= from && d.local_date <= to);
    return {
      from,
      to,
      timezone: tz,
      entries: dtos,
      total_seconds: dtos.reduce((s, d) => s + d.effective.work_seconds, 0),
    };
  });

  app.get<{ Params: { id: string } }>("/v1/me/time-entries/:id", async (req) => {
    const user = requireUser(req.user);
    if (!isUuid(req.params.id)) throw notFound("Session not found.");
    const { rows } = await db.query<{ project_id: string; tutor_id: string }>(`SELECT project_id, tutor_id FROM work_sessions WHERE id = $1`, [req.params.id]);
    // Object-level authorization: tutors only ever see their own sessions.
    if (!rows[0] || rows[0].tutor_id !== user.id) throw notFound("Session not found.");
    const scope = await requireProjectRole(db, user, rows[0].project_id, "tutor");
    const detail = await loadSessionDetail(db, req.params.id, scope.project, new Date());
    return { ...detail!.dto, timezone: scope.project.timezone };
  });

  app.post("/v1/correction-requests", async (req, reply) => {
    const user = requireUser(req.user);
    app.limiter.check("corrections", user.id, 10, 60 * 60_000);
    const body = parse(correctionInputSchema, req.body);
    const correction = await createCorrection(db, auditContext(req), user, body);
    reply.status(201);
    return correction;
  });

  app.get("/v1/me/correction-requests", async (req) => {
    const user = requireUser(req.user);
    const q = parse(projectQuery, req.query);
    await requireProjectRole(db, user, q.project_id, "tutor");
    const { rows } = await db.query(
      `SELECT c.id, c.session_id, c.requested_change, c.explanation, c.status, c.submitted_at, c.resolved_at,
              c.decision_reason, rv.display_name AS resolved_by_name, s.started_at AS session_started_at,
              s.closed_at AS session_closed_at
         FROM correction_requests c
         JOIN work_sessions s ON s.id = c.session_id
         LEFT JOIN users rv ON rv.id = c.resolved_by
        WHERE c.project_id = $1 AND c.requester_id = $2
        ORDER BY c.submitted_at DESC LIMIT 200`,
      [q.project_id, user.id],
    );
    return { corrections: rows };
  });

  app.post<{ Params: { id: string } }>("/v1/me/correction-requests/:id/withdraw", async (req) => {
    const user = requireUser(req.user);
    if (!isUuid(req.params.id)) throw notFound("Correction request not found.");
    return withdrawCorrection(db, auditContext(req), user, req.params.id);
  });

  app.get("/v1/me/notifications", async (req) => {
    const user = requireUser(req.user);
    const q = parse(projectQuery, req.query);
    await requireProjectRole(db, user, q.project_id, "tutor");
    const { rows } = await db.query(
      `SELECT d.id, r.event_type, d.title, d.body, d.related_entity_id, d.scheduled_at, d.acknowledged_at
         FROM notification_deliveries d JOIN notification_rules r ON r.id = d.rule_id
        WHERE d.project_id = $1 AND d.recipient_id = $2
        ORDER BY d.acknowledged_at IS NULL DESC, d.scheduled_at DESC LIMIT 100`,
      [q.project_id, user.id],
    );
    return { notifications: rows, unread: rows.filter((r) => !r.acknowledged_at).length };
  });

  app.post<{ Params: { id: string } }>("/v1/me/notifications/:id/ack", async (req) => {
    const user = requireUser(req.user);
    if (!isUuid(req.params.id)) throw notFound();
    const { rowCount } = await db.query(
      `UPDATE notification_deliveries SET acknowledged_at = now(), acknowledged_by = $2
        WHERE id = $1 AND recipient_id = $2 AND acknowledged_at IS NULL`,
      [req.params.id, user.id],
    );
    return { ok: true, updated: rowCount };
  });
}
