import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DateTime } from "luxon";
import { auditContext, requireUser } from "../../lib/context.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { parse } from "../../lib/validate.js";
import { isIsoDate, localDate, localDateRange } from "../../domain/time.js";
import { assertTutorInScope, isUuid, requireProjectRole, teamFilterSql } from "../../services/access.js";
import { writeAudit } from "../../services/audit.js";
import { maybeSweepProject } from "../../services/notifications.js";
import { loadBundles, loadSessionDetail, loadSessionRows, toSessionDto } from "../../services/sessions.js";

const projectQuery = z.object({ project_id: z.uuid("Choose a project.") });

const entriesQuery = projectQuery.extend({
  from: z.string().refine(isIsoDate, "Use a YYYY-MM-DD date.").optional(),
  to: z.string().refine(isIsoDate, "Use a YYYY-MM-DD date.").optional(),
  tutor_id: z.uuid().optional(),
  location_id: z.uuid().optional(),
  status: z.enum(["open", "closed"]).optional(),
  flag: z.enum(["any", "long_session", "missed_clock_out", "long_break", "location_review", "pending_correction", "adjusted", "voided", "anomaly"]).optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function oversightRoutes(app: FastifyInstance) {
  const { db } = app;

  /** Live roster: every tutor in scope with current state, elapsed time, today's total and alerts. */
  app.get("/v1/admin/roster", async (req) => {
    const user = requireUser(req.user);
    const q = parse(projectQuery, req.query);
    const scope = await requireProjectRole(db, user, q.project_id, "supervisor");
    const now = new Date();
    const tz = scope.project.timezone;
    const today = localDate(now, tz);
    const range = localDateRange(today, today, tz);
    const team = teamFilterSql(scope, "m.user_id", 2);
    const { rows: tutors } = await db.query<{ id: string; display_name: string; email: string; status: string; team_name: string | null }>(
      `SELECT u.id, u.display_name, u.email, u.status, t.name AS team_name
         FROM project_memberships m
         JOIN users u ON u.id = m.user_id
         LEFT JOIN teams t ON t.id = m.team_id
        WHERE m.project_id = $1 AND m.role = 'tutor' AND m.active_to IS NULL AND ${team.sql}
        ORDER BY u.display_name`,
      [scope.project.id, ...team.params],
    );
    const sessions = await loadSessionRows(
      db,
      `s.project_id = $1 AND s.tutor_id = ANY($2::uuid[]) AND (s.state <> 'closed' OR (s.started_at >= $3::timestamptz - interval '1 day' AND s.started_at < $4))`,
      [scope.project.id, tutors.map((t) => t.id), range.start, range.end],
      "ORDER BY s.started_at",
    );
    const dtos = (await loadBundles(db, sessions)).map((b) => toSessionDto(b, scope.project, now));
    const { rows: pending } = await db.query<{ requester_id: string; n: number }>(
      `SELECT requester_id, count(*)::int AS n FROM correction_requests WHERE project_id = $1 AND status = 'pending' GROUP BY requester_id`,
      [scope.project.id],
    );
    const pendingBy = new Map(pending.map((p) => [p.requester_id, p.n]));
    const rows = tutors.map((t) => {
      const mine = dtos.filter((d) => d.tutor.id === t.id);
      const active = mine.find((d) => d.state !== "closed") ?? null;
      return {
        tutor: { id: t.id, name: t.display_name, email: t.email, status: t.status, team: t.team_name },
        state: active ? (active.state === "break" ? "BREAK" : "IN") : "OUT",
        active_session: active,
        today_seconds: mine.filter((d) => d.local_date === today).reduce((s, d) => s + d.effective.work_seconds, 0),
        alerts: active ? active.flags.filter((f) => ["long_session", "missed_clock_out", "long_break", "location_review", "anomaly"].includes(f.code)) : [],
        pending_corrections: pendingBy.get(t.id) ?? 0,
      };
    });
    return {
      project: { id: scope.project.id, name: scope.project.name, timezone: tz },
      totals: {
        tutors: rows.length,
        clocked_in: rows.filter((r) => r.state === "IN").length,
        on_break: rows.filter((r) => r.state === "BREAK").length,
        clocked_out: rows.filter((r) => r.state === "OUT").length,
        with_alerts: rows.filter((r) => r.alerts.length > 0).length,
        pending_corrections: rows.reduce((s, r) => s + r.pending_corrections, 0),
      },
      tutors: rows,
      server_time: now.toISOString(),
    };
  });

  app.get("/v1/admin/time-entries", async (req) => {
    const user = requireUser(req.user);
    const q = parse(entriesQuery, req.query);
    const scope = await requireProjectRole(db, user, q.project_id, "supervisor");
    const tz = scope.project.timezone;
    const now = new Date();
    const to = q.to ?? localDate(now, tz);
    const from = q.from ?? DateTime.fromISO(to).minus({ days: 6 }).toISODate()!;
    if (from > to) throw badRequest("INVALID_RANGE", "Start date must be on or before end date.");
    if (DateTime.fromISO(to).diff(DateTime.fromISO(from), "days").days > 92) throw badRequest("RANGE_TOO_LARGE", "Choose 93 days or fewer.");
    const range = localDateRange(from, to, tz);
    const team = teamFilterSql(scope, "s.tutor_id", 8);
    const sessions = await loadSessionRows(
      db,
      `s.project_id = $1 AND s.started_at >= $2::timestamptz - interval '1 day' AND s.started_at < $3::timestamptz + interval '1 day'
         AND ($4::uuid IS NULL OR s.tutor_id = $4) AND ($5::uuid IS NULL OR s.location_id = $5)
         AND ($6::text IS NULL OR ($6 = 'open' AND s.state <> 'closed') OR ($6 = 'closed' AND s.state = 'closed'))
         AND ($7::text IS NULL OR u.display_name ILIKE '%' || $7 || '%' OR u.email ILIKE '%' || $7 || '%')
         AND ${team.sql}`,
      [scope.project.id, range.start, range.end, q.tutor_id ?? null, q.location_id ?? null, q.status ?? null, q.q ? q.q.replace(/[%_\\]/g, "\\$&") : null, ...team.params],
      "ORDER BY s.started_at DESC",
    );
    let dtos = (await loadBundles(db, sessions))
      .map((b) => toSessionDto(b, scope.project, now))
      .filter((d) => d.local_date >= from && d.local_date <= to);
    if (q.flag === "any") dtos = dtos.filter((d) => d.flags.length > 0);
    else if (q.flag) dtos = dtos.filter((d) => d.flags.some((f) => f.code === q.flag));
    return {
      from,
      to,
      timezone: tz,
      total: dtos.length,
      total_seconds: dtos.reduce((s, d) => s + d.effective.work_seconds, 0),
      entries: dtos.slice(q.offset, q.offset + q.limit),
    };
  });

  /** Full investigation view: canonical calculation, raw events, adjustments, corrections and audit trail. */
  app.get<{ Params: { id: string } }>("/v1/admin/sessions/:id", async (req) => {
    const user = requireUser(req.user);
    if (!isUuid(req.params.id)) throw notFound("Session not found.");
    const { rows } = await db.query<{ project_id: string; tutor_id: string }>(`SELECT project_id, tutor_id FROM work_sessions WHERE id = $1`, [req.params.id]);
    if (!rows[0]) throw notFound("Session not found.");
    const scope = await requireProjectRole(db, user, rows[0].project_id, "supervisor");
    await assertTutorInScope(db, scope, rows[0].tutor_id);
    const detail = await loadSessionDetail(db, req.params.id, scope.project, new Date());
    const ids = [req.params.id, ...detail!.bundle.events.map((e) => e.id), ...detail!.bundle.adjustments.map((a) => a.id), ...detail!.dto.corrections.map((c: { id: string }) => c.id)];
    const { rows: audit } = await db.query(
      `SELECT a.id, a.action, a.target_type, a.target_id, a.reason, a.before, a.after, a.occurred_at, a.request_id,
              u.display_name AS actor_name
         FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
        WHERE a.target_id = ANY($1::uuid[]) ORDER BY a.occurred_at`,
      [ids],
    );
    return { ...detail!.dto, timezone: scope.project.timezone, rounding: scope.project.settings.rounding, audit };
  });

  app.get("/v1/admin/alerts", async (req) => {
    const user = requireUser(req.user);
    const q = parse(projectQuery.extend({ include_acknowledged: z.enum(["true", "false"]).optional() }), req.query);
    await requireProjectRole(db, user, q.project_id, "supervisor");
    if (!app.config.alertWorkerEnabled) {
      // No background worker here (e.g. serverless): reviewers' polling drives the deduplicated sweep.
      await maybeSweepProject(db, q.project_id).catch((err) => req.log.error({ err }, "alert sweep failed"));
    }
    const { rows } = await db.query(
      `SELECT d.id, r.event_type, d.title, d.body, d.related_entity_id, d.scheduled_at, d.acknowledged_at,
              ack.display_name AS acknowledged_by_name
         FROM notification_deliveries d
         JOIN notification_rules r ON r.id = d.rule_id
         LEFT JOIN users ack ON ack.id = d.acknowledged_by
        WHERE d.project_id = $1 AND d.recipient_id = $2 AND ($3 OR d.acknowledged_at IS NULL)
        ORDER BY d.scheduled_at DESC LIMIT 200`,
      [q.project_id, user.id, q.include_acknowledged === "true"],
    );
    return { alerts: rows };
  });

  app.post<{ Params: { id: string } }>("/v1/admin/alerts/:id/ack", async (req) => {
    const user = requireUser(req.user);
    if (!isUuid(req.params.id)) throw notFound();
    const { rows } = await db.query<{ project_id: string }>(
      `UPDATE notification_deliveries SET acknowledged_at = now(), acknowledged_by = $2
        WHERE id = $1 AND recipient_id = $2 AND acknowledged_at IS NULL RETURNING project_id`,
      [req.params.id, user.id],
    );
    if (rows[0]) {
      await writeAudit(db, auditContext(req), { projectId: rows[0].project_id, action: "alert.acknowledged", targetType: "notification", targetId: req.params.id });
    }
    return { ok: true };
  });
}
