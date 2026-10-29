import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { auditContext, requireUser } from "../../lib/context.js";
import { notFound } from "../../lib/errors.js";
import { parse } from "../../lib/validate.js";
import { assertTutorInScope, isUuid, requireProjectRole, teamFilterSql } from "../../services/access.js";
import {
  adjustmentInputSchema,
  createAdjustment,
  decideCorrection,
  decisionSchema,
  getCorrection,
  previewAdjustment,
} from "../../services/review.js";

export async function reviewRoutes(app: FastifyInstance) {
  const { db } = app;

  app.get("/v1/admin/correction-requests", async (req) => {
    const user = requireUser(req.user);
    const q = parse(
      z.object({ project_id: z.uuid(), status: z.enum(["pending", "approved", "rejected", "withdrawn", "all"]).default("pending") }),
      req.query,
    );
    const scope = await requireProjectRole(db, user, q.project_id, "supervisor");
    const team = teamFilterSql(scope, "c.requester_id", 3);
    const { rows } = await db.query(
      `SELECT c.id, c.session_id, c.requester_id, u.display_name AS requester_name, c.requested_change, c.explanation,
              c.status, c.submitted_at, c.resolved_at, c.decision_reason, rv.display_name AS resolved_by_name, c.version,
              s.started_at AS session_started_at, s.closed_at AS session_closed_at, s.state AS session_state,
              extract(epoch FROM (coalesce(c.resolved_at, now()) - c.submitted_at))::int AS age_seconds
         FROM correction_requests c
         JOIN users u ON u.id = c.requester_id
         JOIN work_sessions s ON s.id = c.session_id
         LEFT JOIN users rv ON rv.id = c.resolved_by
        WHERE c.project_id = $1 AND ($2 = 'all' OR c.status = $2) AND ${team.sql}
        ORDER BY c.status = 'pending' DESC, c.submitted_at ${q.status === "pending" ? "ASC" : "DESC"}
        LIMIT 200`,
      [q.project_id, q.status, ...team.params],
    );
    return { corrections: rows, service_target_hours: scope.project.settings.correction_service_target_hours };
  });

  app.get<{ Params: { id: string } }>("/v1/admin/correction-requests/:id", async (req) => {
    const user = requireUser(req.user);
    if (!isUuid(req.params.id)) throw notFound("Correction request not found.");
    const c = await getCorrection(db, req.params.id);
    if (!c) throw notFound("Correction request not found.");
    const scope = await requireProjectRole(db, user, c.project_id, "supervisor");
    await assertTutorInScope(db, scope, c.requester_id);
    return c;
  });

  app.post<{ Params: { id: string } }>("/v1/admin/correction-requests/:id/decision", async (req) => {
    const user = requireUser(req.user);
    if (!isUuid(req.params.id)) throw notFound("Correction request not found.");
    const body = parse(decisionSchema, req.body);
    return decideCorrection(db, auditContext(req), user, req.params.id, body);
  });

  app.post("/v1/admin/adjustments/preview", async (req) => {
    const user = requireUser(req.user);
    return previewAdjustment(db, user, parse(adjustmentInputSchema, req.body));
  });

  app.post("/v1/admin/adjustments", async (req, reply) => {
    const user = requireUser(req.user);
    const result = await createAdjustment(db, auditContext(req), user, parse(adjustmentInputSchema, req.body));
    reply.status(201);
    return result;
  });
}
