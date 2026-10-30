import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTransaction } from "../../db/pool.js";
import { auditContext, requireUser } from "../../lib/context.js";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../../lib/errors.js";
import { parse } from "../../lib/validate.js";
import { hashPassword, hashToken, passwordProblem, randomToken } from "../../auth/password.js";
import { DEFAULT_SETTINGS, describeRounding, projectSettingsSchema, timezoneSchema } from "../../domain/policy.js";
import { assertTutorInScope, isUuid, requireProjectRole } from "../../services/access.js";
import { writeAudit } from "../../services/audit.js";
import { ensureRules } from "../../services/notifications.js";

const projectQuery = z.object({ project_id: z.uuid("Choose a project.") });

export async function manageRoutes(app: FastifyInstance) {
  const { db } = app;

  // -------------------------------------------------------------------------
  // Projects & settings
  // -------------------------------------------------------------------------
  app.post("/v1/admin/projects", async (req, reply) => {
    const user = requireUser(req.user);
    if (!user.is_system_admin) throw forbidden("Only system administrators can create projects.");
    const body = parse(z.object({ name: z.string().trim().min(2).max(120), timezone: timezoneSchema }), req.body);
    const project = await withTransaction(db, async (tx) => {
      const { rows } = await tx.query(
        `INSERT INTO projects (name, timezone, settings) VALUES ($1,$2,$3) RETURNING id, name, timezone`,
        [body.name, body.timezone, JSON.stringify(DEFAULT_SETTINGS)],
      );
      await ensureRules(tx, rows[0].id);
      await writeAudit(tx, auditContext(req), { projectId: rows[0].id, action: "project.created", targetType: "project", targetId: rows[0].id, after: body });
      return rows[0];
    });
    reply.status(201);
    return project;
  });

  app.get<{ Params: { id: string } }>("/v1/admin/projects/:id/settings", async (req) => {
    const user = requireUser(req.user);
    const scope = await requireProjectRole(db, user, req.params.id, "supervisor");
    const p = scope.project;
    return {
      id: p.id,
      name: p.name,
      timezone: p.timezone,
      retention_days: p.retention_days,
      settings: p.settings,
      version: p.settings_version,
      rounding_rule: describeRounding(p.settings.rounding),
      can_edit: scope.role === "admin",
      updated_at: p.updated_at,
    };
  });

  const settingsPatch = z.object({
    version: z.number().int().positive(),
    name: z.string().trim().min(2).max(120).optional(),
    timezone: timezoneSchema.optional(),
    retention_days: z.number().int().min(30).max(3650).nullable().optional(),
    settings: projectSettingsSchema.optional(),
    reason: z.string().trim().max(500).optional(),
  });

  /** Settings changes are versioned (optimistic), validated, audited before/after, and never rewrite history. */
  app.patch<{ Params: { id: string } }>("/v1/admin/projects/:id/settings", async (req) => {
    const user = requireUser(req.user);
    const body = parse(settingsPatch, req.body);
    return withTransaction(db, async (tx) => {
      const scope = await requireProjectRole(tx, user, req.params.id, "admin");
      const { rows } = await tx.query(`SELECT settings_version FROM projects WHERE id = $1 FOR UPDATE`, [req.params.id]);
      if (rows[0].settings_version !== body.version) {
        throw conflict("VERSION_CONFLICT", "Settings changed since you opened them. Reload to see the latest values.");
      }
      const p = scope.project;
      if (body.settings?.require_location) {
        const { rows: locs } = await tx.query(`SELECT 1 FROM work_locations WHERE project_id = $1 AND active LIMIT 1`, [p.id]);
        if (!locs[0]) throw unprocessable("NO_LOCATIONS", "Add at least one active work location before requiring a location at clock-in.");
      }
      const before = { name: p.name, timezone: p.timezone, retention_days: p.retention_days, settings: p.settings };
      const after = {
        name: body.name ?? p.name,
        timezone: body.timezone ?? p.timezone,
        retention_days: body.retention_days === undefined ? p.retention_days : body.retention_days,
        settings: body.settings ?? p.settings,
      };
      await tx.query(
        `UPDATE projects SET name = $2, timezone = $3, retention_days = $4, settings = $5,
                settings_version = settings_version + 1, updated_at = now() WHERE id = $1`,
        [p.id, after.name, after.timezone, after.retention_days, JSON.stringify(after.settings)],
      );
      await writeAudit(tx, auditContext(req), {
        projectId: p.id,
        action: "project.settings_updated",
        targetType: "project",
        targetId: p.id,
        reason: body.reason ?? null,
        before: { ...before, version: body.version },
        after: { ...after, version: body.version + 1 },
      });
      return { ok: true, version: body.version + 1, effective: "Applies to new clock events and calculations from now. Existing event times are unchanged." };
    });
  });

  // -------------------------------------------------------------------------
  // People & teams
  // -------------------------------------------------------------------------
  app.get("/v1/admin/people", async (req) => {
    const user = requireUser(req.user);
    const q = parse(projectQuery, req.query);
    const scope = await requireProjectRole(db, user, q.project_id, "supervisor");
    const { rows } = await db.query(
      `SELECT m.id AS membership_id, m.role, m.team_id, t.name AS team_name, m.active_from, m.active_to,
              u.id AS user_id, u.display_name, u.email, u.status, tp.employee_code,
              EXISTS (SELECT 1 FROM work_sessions s WHERE s.tutor_id = u.id AND s.project_id = m.project_id AND s.state <> 'closed') AS has_open_session
         FROM project_memberships m
         JOIN users u ON u.id = m.user_id
         LEFT JOIN teams t ON t.id = m.team_id
         LEFT JOIN tutor_profiles tp ON tp.user_id = u.id
        WHERE m.project_id = $1 AND ($2::uuid IS NULL OR m.role <> 'tutor' OR m.team_id = $2)
        ORDER BY m.active_to IS NULL DESC, u.display_name`,
      [q.project_id, scope.teamId],
    );
    const { rows: teams } = await db.query(`SELECT id, name FROM teams WHERE project_id = $1 ORDER BY name`, [q.project_id]);
    return { people: rows, teams, can_edit: scope.role === "admin" };
  });

  app.post("/v1/admin/teams", async (req, reply) => {
    const user = requireUser(req.user);
    const body = parse(z.object({ project_id: z.uuid(), name: z.string().trim().min(1).max(80) }), req.body);
    await requireProjectRole(db, user, body.project_id, "admin");
    const team = await withTransaction(db, async (tx) => {
      const { rows } = await tx.query(`INSERT INTO teams (project_id, name) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id, name`, [body.project_id, body.name]);
      if (!rows[0]) throw conflict("DUPLICATE", "A team with that name already exists.");
      await writeAudit(tx, auditContext(req), { projectId: body.project_id, action: "team.created", targetType: "team", targetId: rows[0].id, after: rows[0] });
      return rows[0];
    });
    reply.status(201);
    return team;
  });

  const personSchema = z.object({
    project_id: z.uuid(),
    email: z.string().trim().toLowerCase().email("Enter a valid email address."),
    display_name: z.string().trim().min(1).max(120),
    role: z.enum(["tutor", "supervisor", "admin"]),
    team_id: z.uuid().nullish(),
    employee_code: z.string().trim().max(40).nullish(),
    temporary_password: z.string().max(200).nullish(),
  });

  /** Adds a person to the project. New accounts get an invite (reset) link unless a temporary password is set. */
  app.post("/v1/admin/people", async (req, reply) => {
    const user = requireUser(req.user);
    const body = parse(personSchema, req.body);
    await requireProjectRole(db, user, body.project_id, "admin");
    if (body.temporary_password) {
      const problem = passwordProblem(body.temporary_password);
      if (problem) throw badRequest("WEAK_PASSWORD", problem);
    }
    let inviteToken: string | null = null;
    let email = "";
    const result = await withTransaction(db, async (tx) => {
      if (body.team_id) {
        const { rows } = await tx.query(`SELECT 1 FROM teams WHERE id = $1 AND project_id = $2`, [body.team_id, body.project_id]);
        if (!rows[0]) throw badRequest("INVALID_TEAM", "That team does not belong to this project.");
      }
      const existing = await tx.query<{ id: string; email: string; status: string }>(`SELECT id, email, status FROM users WHERE lower(email) = $1`, [body.email]);
      let userId = existing.rows[0]?.id;
      email = existing.rows[0]?.email ?? body.email;
      if (!userId) {
        const status = body.temporary_password ? "active" : "invited";
        const ins = await tx.query<{ id: string }>(
          `INSERT INTO users (auth_subject, email, display_name, status) VALUES ($1,$2,$3,$4) RETURNING id`,
          [`local|${randomUUID()}`, body.email, body.display_name, status],
        );
        userId = ins.rows[0]!.id;
        if (body.temporary_password) {
          await tx.query(`INSERT INTO user_credentials (user_id, password_hash) VALUES ($1,$2)`, [userId, await hashPassword(body.temporary_password)]);
        } else {
          inviteToken = randomToken();
          await tx.query(
            `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '7 days')`,
            [userId, hashToken(inviteToken)],
          );
        }
        await writeAudit(tx, auditContext(req), { projectId: body.project_id, action: "user.created", targetType: "user", targetId: userId, after: { email: body.email, display_name: body.display_name, status } });
      } else if (existing.rows[0]!.status === "deactivated") {
        throw conflict("USER_DEACTIVATED", "This account is deactivated. Reactivate it before adding it to a project.");
      }
      const { rows: active } = await tx.query(`SELECT 1 FROM project_memberships WHERE project_id = $1 AND user_id = $2 AND active_to IS NULL`, [body.project_id, userId]);
      if (active[0]) throw conflict("ALREADY_MEMBER", "This person is already a member of the project.");
      const m = await tx.query<{ id: string }>(
        `INSERT INTO project_memberships (project_id, user_id, role, team_id) VALUES ($1,$2,$3,$4) RETURNING id`,
        [body.project_id, userId, body.role, body.team_id ?? null],
      );
      if (body.employee_code !== undefined) {
        await tx.query(
          `INSERT INTO tutor_profiles (user_id, employee_code) VALUES ($1,$2)
           ON CONFLICT (user_id) DO UPDATE SET employee_code = EXCLUDED.employee_code, updated_at = now()`,
          [userId, body.employee_code],
        );
      }
      await writeAudit(tx, auditContext(req), {
        projectId: body.project_id,
        action: "membership.created",
        targetType: "project_membership",
        targetId: m.rows[0]!.id,
        after: { user_id: userId, role: body.role, team_id: body.team_id ?? null },
      });
      return { user_id: userId, membership_id: m.rows[0]!.id };
    });
    // The person is saved either way. If the email fails, they can still use "Forgot password".
    let emailSent = false;
    if (inviteToken) {
      try {
        await app.mailer.send({
          to: email,
          subject: "You've been invited to Tutor Time Clock",
          text: `Set your password within 7 days to get started:\n${app.config.appBaseUrl}/reset-password?token=${inviteToken}`,
        });
        emailSent = true;
      } catch (err) {
        req.log.error({ err }, "invite email failed");
      }
    }
    reply.status(201);
    return { ...result, invited: Boolean(inviteToken), email_sent: emailSent };
  });

  const membershipPatch = z.object({
    role: z.enum(["tutor", "supervisor", "admin"]).optional(),
    team_id: z.uuid().nullable().optional(),
    employee_code: z.string().trim().max(40).nullable().optional(),
    end_membership: z.boolean().optional(),
    deactivate_account: z.boolean().optional(),
    reason: z.string().trim().min(3, "A reason is required.").max(500),
  });

  /** Role/team changes and soft deactivation. History and open sessions are preserved for review. */
  app.patch<{ Params: { id: string } }>("/v1/admin/memberships/:id", async (req) => {
    const user = requireUser(req.user);
    if (!isUuid(req.params.id)) throw notFound("Membership not found.");
    const body = parse(membershipPatch, req.body);
    return withTransaction(db, async (tx) => {
      const { rows } = await tx.query(
        `SELECT id, project_id, user_id, role, team_id, active_to FROM project_memberships WHERE id = $1 FOR UPDATE`,
        [req.params.id],
      );
      const m = rows[0];
      if (!m) throw notFound("Membership not found.");
      await requireProjectRole(tx, user, m.project_id, "admin");
      if (m.active_to) throw conflict("MEMBERSHIP_ENDED", "This membership has already ended.");
      if (m.user_id === user.id && (body.end_membership || body.deactivate_account || (body.role && body.role !== "admin"))) {
        throw forbidden("You cannot remove your own admin access.");
      }
      if (body.team_id) {
        const { rows: t } = await tx.query(`SELECT 1 FROM teams WHERE id = $1 AND project_id = $2`, [body.team_id, m.project_id]);
        if (!t[0]) throw badRequest("INVALID_TEAM", "That team does not belong to this project.");
      }
      const ctx = auditContext(req);
      if (body.role || body.team_id !== undefined) {
        await tx.query(`UPDATE project_memberships SET role = $2, team_id = $3 WHERE id = $1`, [
          m.id,
          body.role ?? m.role,
          body.team_id === undefined ? m.team_id : body.team_id,
        ]);
      }
      if (body.employee_code !== undefined) {
        await tx.query(
          `INSERT INTO tutor_profiles (user_id, employee_code) VALUES ($1,$2)
           ON CONFLICT (user_id) DO UPDATE SET employee_code = EXCLUDED.employee_code, updated_at = now()`,
          [m.user_id, body.employee_code],
        );
      }
      if (body.end_membership) await tx.query(`UPDATE project_memberships SET active_to = now() WHERE id = $1`, [m.id]);
      if (body.deactivate_account) {
        await tx.query(`UPDATE users SET status = 'deactivated', updated_at = now() WHERE id = $1`, [m.user_id]);
        await tx.query(`UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [m.user_id]);
      }
      await writeAudit(tx, ctx, {
        projectId: m.project_id,
        action: "membership.updated",
        targetType: "project_membership",
        targetId: m.id,
        reason: body.reason,
        before: { role: m.role, team_id: m.team_id },
        after: {
          role: body.role ?? m.role,
          team_id: body.team_id === undefined ? m.team_id : body.team_id,
          employee_code: body.employee_code,
          end_membership: body.end_membership ?? false,
          deactivate_account: body.deactivate_account ?? false,
        },
      });
      return { ok: true };
    });
  });

  // -------------------------------------------------------------------------
  // Locations
  // -------------------------------------------------------------------------
  app.get("/v1/admin/locations", async (req) => {
    const user = requireUser(req.user);
    const q = parse(projectQuery, req.query);
    const scope = await requireProjectRole(db, user, q.project_id, "supervisor");
    const { rows } = await db.query(
      `SELECT id, name, address, latitude, longitude, geofence_radius_m, geofence_mode, active, updated_at
         FROM work_locations WHERE project_id = $1 ORDER BY active DESC, name`,
      [q.project_id],
    );
    return { locations: rows, location_controls_enabled: scope.project.settings.location_controls.enabled, can_edit: scope.role === "admin" };
  });

  const locationSchema = z.object({
    name: z.string().trim().min(1).max(120),
    address: z.string().trim().max(300).nullish(),
    latitude: z.number().min(-90).max(90).nullish(),
    longitude: z.number().min(-180).max(180).nullish(),
    geofence_radius_m: z.number().int().min(25).max(10000).nullish(),
    geofence_mode: z.enum(["off", "warn", "block"]).default("off"),
    active: z.boolean().default(true),
  });

  const checkGeofence = (enabled: boolean, loc: z.infer<typeof locationSchema>) => {
    const hasGeo = loc.latitude != null || loc.longitude != null || loc.geofence_radius_m != null || loc.geofence_mode !== "off";
    if (hasGeo && !enabled) {
      throw unprocessable("LOCATION_CONTROLS_DISABLED", "Turn on location controls in project settings (after privacy review) before adding coordinates or a geofence.");
    }
    if (loc.geofence_mode !== "off" && (loc.latitude == null || loc.longitude == null || loc.geofence_radius_m == null)) {
      throw unprocessable("GEOFENCE_INCOMPLETE", "A geofence needs latitude, longitude and a radius.");
    }
  };

  app.post("/v1/admin/locations", async (req, reply) => {
    const user = requireUser(req.user);
    const body = parse(locationSchema.extend({ project_id: z.uuid() }), req.body);
    const scope = await requireProjectRole(db, user, body.project_id, "admin");
    checkGeofence(scope.project.settings.location_controls.enabled, body);
    const loc = await withTransaction(db, async (tx) => {
      const { rows } = await tx.query(
        `INSERT INTO work_locations (project_id, name, address, latitude, longitude, geofence_radius_m, geofence_mode, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [body.project_id, body.name, body.address ?? null, body.latitude ?? null, body.longitude ?? null, body.geofence_radius_m ?? null, body.geofence_mode, body.active],
      );
      await writeAudit(tx, auditContext(req), { projectId: body.project_id, action: "location.created", targetType: "work_location", targetId: rows[0].id, after: rows[0] });
      return rows[0];
    });
    reply.status(201);
    return loc;
  });

  app.patch<{ Params: { id: string } }>("/v1/admin/locations/:id", async (req) => {
    const user = requireUser(req.user);
    if (!isUuid(req.params.id)) throw notFound("Location not found.");
    const body = parse(locationSchema, req.body);
    return withTransaction(db, async (tx) => {
      const { rows } = await tx.query(`SELECT * FROM work_locations WHERE id = $1 FOR UPDATE`, [req.params.id]);
      if (!rows[0]) throw notFound("Location not found.");
      const scope = await requireProjectRole(tx, user, rows[0].project_id, "admin");
      checkGeofence(scope.project.settings.location_controls.enabled, body);
      const { rows: updated } = await tx.query(
        `UPDATE work_locations SET name=$2, address=$3, latitude=$4, longitude=$5, geofence_radius_m=$6, geofence_mode=$7, active=$8, updated_at=now()
          WHERE id = $1 RETURNING *`,
        [req.params.id, body.name, body.address ?? null, body.latitude ?? null, body.longitude ?? null, body.geofence_radius_m ?? null, body.geofence_mode, body.active],
      );
      await writeAudit(tx, auditContext(req), { projectId: rows[0].project_id, action: "location.updated", targetType: "work_location", targetId: req.params.id, before: rows[0], after: updated[0] });
      return updated[0];
    });
  });

  // -------------------------------------------------------------------------
  // Shifts
  // -------------------------------------------------------------------------
  app.get("/v1/admin/shifts", async (req) => {
    const user = requireUser(req.user);
    const q = parse(projectQuery.extend({ from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional() }), req.query);
    await requireProjectRole(db, user, q.project_id, "supervisor");
    const { rows } = await db.query(
      `SELECT s.id, s.label, s.scheduled_start, s.scheduled_end, s.status, s.version, s.tutor_id, u.display_name AS tutor_name,
              s.location_id, l.name AS location_name
         FROM shifts s LEFT JOIN users u ON u.id = s.tutor_id LEFT JOIN work_locations l ON l.id = s.location_id
        WHERE s.project_id = $1 AND s.scheduled_end >= coalesce($2::timestamptz, now() - interval '7 days')
          AND s.scheduled_start <= coalesce($3::timestamptz, now() + interval '30 days')
        ORDER BY s.scheduled_start LIMIT 500`,
      [q.project_id, q.from ?? null, q.to ?? null],
    );
    return { shifts: rows };
  });

  app.post("/v1/admin/shifts", async (req, reply) => {
    const user = requireUser(req.user);
    const body = parse(
      z.object({
        project_id: z.uuid(),
        tutor_id: z.uuid().nullish(),
        location_id: z.uuid().nullish(),
        label: z.string().trim().min(1).max(120),
        scheduled_start: z.iso.datetime({ offset: true }),
        scheduled_end: z.iso.datetime({ offset: true }),
      }),
      req.body,
    );
    const scope = await requireProjectRole(db, user, body.project_id, "supervisor");
    if (new Date(body.scheduled_end) <= new Date(body.scheduled_start)) throw unprocessable("INVALID_RANGE", "Shift end must be after its start.");
    if (body.tutor_id) await assertTutorInScope(db, scope, body.tutor_id);
    const shift = await withTransaction(db, async (tx) => {
      if (body.tutor_id) {
        const { rows } = await tx.query(`SELECT 1 FROM project_memberships WHERE project_id = $1 AND user_id = $2 AND role = 'tutor' AND active_to IS NULL`, [body.project_id, body.tutor_id]);
        if (!rows[0]) throw badRequest("INVALID_TUTOR", "That tutor is not an active member of this project.");
      }
      if (body.location_id) {
        const { rows } = await tx.query(`SELECT 1 FROM work_locations WHERE id = $1 AND project_id = $2`, [body.location_id, body.project_id]);
        if (!rows[0]) throw badRequest("INVALID_LOCATION", "That location does not belong to this project.");
      }
      const { rows } = await tx.query(
        `INSERT INTO shifts (project_id, tutor_id, location_id, label, scheduled_start, scheduled_end) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [body.project_id, body.tutor_id ?? null, body.location_id ?? null, body.label, body.scheduled_start, body.scheduled_end],
      );
      await writeAudit(tx, auditContext(req), { projectId: body.project_id, action: "shift.created", targetType: "shift", targetId: rows[0].id, after: rows[0] });
      return rows[0];
    });
    reply.status(201);
    return shift;
  });

  app.post<{ Params: { id: string } }>("/v1/admin/shifts/:id/cancel", async (req) => {
    const user = requireUser(req.user);
    if (!isUuid(req.params.id)) throw notFound("Shift not found.");
    const body = parse(z.object({ version: z.number().int().positive(), reason: z.string().trim().min(3).max(500) }), req.body);
    return withTransaction(db, async (tx) => {
      const { rows } = await tx.query(`SELECT * FROM shifts WHERE id = $1 FOR UPDATE`, [req.params.id]);
      if (!rows[0]) throw notFound("Shift not found.");
      const scope = await requireProjectRole(tx, user, rows[0].project_id, "supervisor");
      if (rows[0].tutor_id) await assertTutorInScope(tx, scope, rows[0].tutor_id);
      if (rows[0].version !== body.version) throw conflict("VERSION_CONFLICT", "This shift changed since you opened it. Reload and try again.");
      if (rows[0].status !== "scheduled") throw conflict("NOT_SCHEDULED", "Only scheduled shifts can be cancelled.");
      await tx.query(`UPDATE shifts SET status = 'cancelled', version = version + 1, updated_at = now() WHERE id = $1`, [req.params.id]);
      await writeAudit(tx, auditContext(req), { projectId: rows[0].project_id, action: "shift.cancelled", targetType: "shift", targetId: req.params.id, reason: body.reason, before: { status: "scheduled" }, after: { status: "cancelled" } });
      return { ok: true };
    });
  });

  // -------------------------------------------------------------------------
  // Audit log
  // -------------------------------------------------------------------------
  app.get("/v1/admin/audit-logs", async (req) => {
    const user = requireUser(req.user);
    const q = parse(
      projectQuery.extend({
        action: z.string().trim().max(60).optional(),
        target_id: z.uuid().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
        before: z.iso.datetime({ offset: true }).optional(),
      }),
      req.query,
    );
    await requireProjectRole(db, user, q.project_id, "admin");
    const { rows } = await db.query(
      `SELECT a.id, a.action, a.target_type, a.target_id, a.reason, a.before, a.after, a.occurred_at, a.request_id,
              a.user_agent_summary, u.display_name AS actor_name
         FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
        WHERE a.project_id = $1 AND ($2::text IS NULL OR a.action LIKE $2 || '%') AND ($3::uuid IS NULL OR a.target_id = $3)
          AND ($4::timestamptz IS NULL OR a.occurred_at < $4)
        ORDER BY a.occurred_at DESC LIMIT $5`,
      [q.project_id, q.action ?? null, q.target_id ?? null, q.before ?? null, q.limit],
    );
    return { entries: rows };
  });
}
