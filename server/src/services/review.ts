import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db, Queryable, Tx } from "../db/pool.js";
import { withTransaction } from "../db/pool.js";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../lib/errors.js";
import type { AuditContext, AuthUser } from "../lib/context.js";
import { calculateSession, roundMinutes, type CalcAdjustment } from "../domain/calc.js";
import { localDate } from "../domain/time.js";
import { assertTutorInScope, requireProjectRole, type ProjectRow, type ProjectScope } from "./access.js";
import { writeAudit } from "./audit.js";
import { notify, reviewersFor } from "./notifications.js";
import { loadBundles, loadSessionRows, type SessionBundle } from "./sessions.js";

// ---------------------------------------------------------------------------
// Correction requests (tutor-initiated)
// ---------------------------------------------------------------------------

export const requestedChangeSchema = z
  .object({
    issue: z.enum(["missed_clock_out", "wrong_clock_in", "wrong_clock_out", "missed_break", "other"]),
    clock_in_at: z.iso.datetime({ offset: true }).nullish(),
    clock_out_at: z.iso.datetime({ offset: true }).nullish(),
  })
  .strict();
export type RequestedChange = z.infer<typeof requestedChangeSchema>;

export const correctionInputSchema = z.object({
  session_id: z.uuid(),
  requested_change: requestedChangeSchema,
  explanation: z.string().trim().min(5, "Please explain what happened (at least 5 characters).").max(2000),
});

function validateRequestedTimes(change: { clock_in_at?: string | null; clock_out_at?: string | null }, now: Date) {
  const inAt = change.clock_in_at ? new Date(change.clock_in_at) : null;
  const outAt = change.clock_out_at ? new Date(change.clock_out_at) : null;
  if (inAt && inAt > now) throw unprocessable("FUTURE_TIME", "Requested clock-in time cannot be in the future.");
  if (outAt && outAt > now) throw unprocessable("FUTURE_TIME", "Requested clock-out time cannot be in the future.");
  if (inAt && outAt && outAt <= inAt) throw unprocessable("INVALID_RANGE", "Clock-out must be after clock-in.");
  return { inAt, outAt };
}

export async function createCorrection(db: Db, ctx: AuditContext, user: AuthUser, input: z.infer<typeof correctionInputSchema>) {
  return withTransaction(db, async (tx) => {
    const { rows } = await tx.query<{ id: string; project_id: string; tutor_id: string; started_at: Date }>(
      `SELECT id, project_id, tutor_id, started_at FROM work_sessions WHERE id = $1`,
      [input.session_id],
    );
    const session = rows[0];
    // Tutors can only request corrections on their own sessions; don't reveal others exist.
    if (!session || session.tutor_id !== user.id) throw notFound("Session not found.");
    await requireProjectRole(tx, user, session.project_id, "tutor");
    const now = new Date();
    validateRequestedTimes(input.requested_change, now);
    const change = input.requested_change;
    if (change.issue !== "other" && change.issue !== "missed_break" && !change.clock_in_at && !change.clock_out_at) {
      throw unprocessable("MISSING_REQUESTED_TIME", "Enter the corrected time you are requesting.");
    }
    let id: string;
    try {
      const ins = await tx.query<{ id: string; submitted_at: Date }>(
        `INSERT INTO correction_requests (project_id, session_id, requester_id, requested_change, explanation)
         VALUES ($1,$2,$3,$4,$5) RETURNING id, submitted_at`,
        [session.project_id, session.id, user.id, JSON.stringify(change), input.explanation],
      );
      id = ins.rows[0]!.id;
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw conflict("CORRECTION_ALREADY_PENDING", "A correction for this session is already pending review.");
      }
      throw err;
    }
    await writeAudit(tx, ctx, {
      projectId: session.project_id,
      action: "correction.submitted",
      targetType: "correction_request",
      targetId: id,
      after: { session_id: session.id, requested_change: change, explanation: input.explanation },
    });
    await notify(tx, {
      projectId: session.project_id,
      rule: "correction_submitted",
      recipientIds: await reviewersFor(tx, session.project_id, user.id),
      dedupeKey: `correction_submitted:${id}`,
      relatedEntityId: id,
      title: `Correction request from ${user.display_name}`,
      body: `Issue: ${change.issue.replaceAll("_", " ")}`,
    });
    return getCorrection(tx, id);
  });
}

export async function withdrawCorrection(db: Db, ctx: AuditContext, user: AuthUser, id: string) {
  return withTransaction(db, async (tx) => {
    const c = await lockCorrection(tx, id);
    if (c.requester_id !== user.id) throw notFound("Correction request not found.");
    if (c.status !== "pending") throw conflict("NOT_PENDING", "Only pending requests can be withdrawn.");
    await tx.query(
      `UPDATE correction_requests SET status = 'withdrawn', resolved_at = now(), version = version + 1 WHERE id = $1`,
      [id],
    );
    await writeAudit(tx, ctx, {
      projectId: c.project_id,
      action: "correction.withdrawn",
      targetType: "correction_request",
      targetId: id,
      before: { status: "pending" },
      after: { status: "withdrawn" },
    });
    return getCorrection(tx, id);
  });
}

interface CorrectionRow {
  id: string;
  project_id: string;
  session_id: string;
  requester_id: string;
  requested_change: RequestedChange;
  explanation: string;
  status: string;
  version: number;
}

async function lockCorrection(tx: Tx, id: string): Promise<CorrectionRow> {
  const { rows } = await tx.query<CorrectionRow>(
    `SELECT id, project_id, session_id, requester_id, requested_change, explanation, status, version
       FROM correction_requests WHERE id = $1 FOR UPDATE`,
    [id],
  );
  if (!rows[0]) throw notFound("Correction request not found.");
  return rows[0];
}

export async function getCorrection(q: Queryable, id: string) {
  const { rows } = await q.query(
    `SELECT c.id, c.project_id, c.session_id, c.requester_id, ru.display_name AS requester_name,
            c.requested_change, c.explanation, c.status, c.submitted_at, c.resolved_at, c.resolved_by,
            rv.display_name AS resolved_by_name, c.decision_reason, c.version,
            s.started_at AS session_started_at, s.closed_at AS session_closed_at, s.state AS session_state
       FROM correction_requests c
       JOIN users ru ON ru.id = c.requester_id
       JOIN work_sessions s ON s.id = c.session_id
       LEFT JOIN users rv ON rv.id = c.resolved_by
      WHERE c.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export const decisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  reason: z.string().trim().min(3, "A reason is required.").max(2000),
  version: z.number().int().positive(),
});

/**
 * Approve or reject a correction. Rechecks authorization and the request version so a concurrent
 * decision is reported as a conflict rather than silently overwritten. Approval appends an
 * adjustment; the original events are never modified.
 */
export async function decideCorrection(
  db: Db,
  ctx: AuditContext,
  user: AuthUser,
  id: string,
  input: z.infer<typeof decisionSchema>,
) {
  return withTransaction(db, async (tx) => {
    const c = await lockCorrection(tx, id);
    const scope = await requireProjectRole(tx, user, c.project_id, "supervisor");
    const { rows: sess } = await tx.query<{ tutor_id: string }>(`SELECT tutor_id FROM work_sessions WHERE id = $1`, [c.session_id]);
    await assertTutorInScope(tx, scope, sess[0]!.tutor_id);
    if (c.requester_id === user.id) throw forbidden("You cannot decide your own correction request.");
    if (c.version !== input.version) {
      throw conflict("VERSION_CONFLICT", "This request changed since you opened it. Reload to see the latest version.");
    }
    if (c.status !== "pending") throw conflict("NOT_PENDING", `This request is already ${c.status}.`);

    let adjustmentId: string | null = null;
    if (input.decision === "approve") {
      const change = c.requested_change;
      if (change.clock_in_at || change.clock_out_at) {
        adjustmentId = await applyInterpretation(tx, ctx, user, scope.project, c.session_id, {
          start: change.clock_in_at ? new Date(change.clock_in_at) : null,
          end: change.clock_out_at ? new Date(change.clock_out_at) : null,
          reason: input.reason,
          correctionId: c.id,
        });
      }
    }
    const status = input.decision === "approve" ? "approved" : "rejected";
    await tx.query(
      `UPDATE correction_requests
          SET status = $2, resolved_at = now(), resolved_by = $3, decision_reason = $4, version = version + 1
        WHERE id = $1`,
      [id, status, user.id, input.reason],
    );
    await writeAudit(tx, ctx, {
      projectId: c.project_id,
      action: `correction.${status}`,
      targetType: "correction_request",
      targetId: id,
      reason: input.reason,
      before: { status: "pending", version: c.version },
      after: { status, version: c.version + 1, adjustment_id: adjustmentId },
    });
    await notify(tx, {
      projectId: c.project_id,
      rule: "correction_decided",
      recipientIds: [c.requester_id],
      dedupeKey: `correction_decided:${id}`,
      relatedEntityId: id,
      title: `Your correction request was ${status}`,
      body: input.reason,
    });
    return { correction: await getCorrection(tx, id), adjustment_id: adjustmentId };
  });
}

// ---------------------------------------------------------------------------
// Adjustments (supervisor/admin-initiated, append-only)
// ---------------------------------------------------------------------------

export const adjustmentInputSchema = z
  .object({
    session_id: z.uuid(),
    adjustment_type: z.enum(["add_time", "replace_interpretation", "void_session", "other"]),
    effective_start: z.iso.datetime({ offset: true }).nullish(),
    effective_end: z.iso.datetime({ offset: true }).nullish(),
    delta_minutes: z.number().int().min(-24 * 60).max(24 * 60).nullish(),
    reason: z.string().trim().min(3, "A reason is required.").max(2000),
    supersedes_adjustment_id: z.uuid().nullish(),
  })
  .superRefine((v, ctx) => {
    if (v.adjustment_type === "add_time" && !v.delta_minutes) {
      ctx.addIssue({ code: "custom", path: ["delta_minutes"], message: "Enter the minutes to add or remove." });
    }
    if (v.adjustment_type === "replace_interpretation" && !v.effective_start && !v.effective_end) {
      ctx.addIssue({ code: "custom", path: ["effective_start"], message: "Enter a corrected start and/or end time." });
    }
  });
export type AdjustmentInput = z.infer<typeof adjustmentInputSchema>;

async function loadScopedBundle(q: Queryable, user: AuthUser, sessionId: string): Promise<{ scope: ProjectScope; bundle: SessionBundle }> {
  const rows = await loadSessionRows(q, "s.id = $1", [sessionId]);
  if (!rows[0]) throw notFound("Session not found.");
  const scope = await requireProjectRole(q, user, rows[0].project_id, "supervisor");
  await assertTutorInScope(q, scope, rows[0].tutor_id);
  const [bundle] = await loadBundles(q, rows);
  return { scope, bundle: bundle! };
}

function proposedAdjustment(bundle: SessionBundle, input: AdjustmentInput, now: Date): CalcAdjustment {
  return {
    id: "proposed",
    adjustment_type: input.adjustment_type,
    effective_start: input.effective_start ? new Date(input.effective_start) : null,
    effective_end: input.effective_end ? new Date(input.effective_end) : null,
    delta_minutes: input.delta_minutes ?? null,
    supersedes_adjustment_id: input.supersedes_adjustment_id ?? null,
    created_at: new Date(Math.max(now.getTime(), ...bundle.adjustments.map((a) => a.created_at.getTime() + 1))),
  };
}

function validateAdjustment(bundle: SessionBundle, input: AdjustmentInput, now: Date) {
  if (input.supersedes_adjustment_id) {
    const target = bundle.adjustments.find((a) => a.id === input.supersedes_adjustment_id);
    if (!target) throw badRequest("INVALID_SUPERSEDE", "The adjustment being replaced does not belong to this session.");
    if (bundle.adjustments.some((a) => a.supersedes_adjustment_id === target.id)) {
      throw conflict("ALREADY_SUPERSEDED", "That adjustment has already been replaced. Reload to see the latest.");
    }
  }
  if (input.adjustment_type === "replace_interpretation") {
    validateRequestedTimes({ clock_in_at: input.effective_start, clock_out_at: input.effective_end }, now);
    const calc = calculateSession(bundle.events, bundle.adjustments, now);
    const start = input.effective_start ? new Date(input.effective_start) : calc.effective.start;
    const end = input.effective_end ? new Date(input.effective_end) : calc.effective.end;
    if (end && end <= start) throw unprocessable("INVALID_RANGE", "The corrected end must be after the start.");
  }
}

/** Before/after totals and potentially affected exports, without writing anything. */
export async function previewAdjustment(db: Db, user: AuthUser, input: AdjustmentInput) {
  const { scope, bundle } = await loadScopedBundle(db, user, input.session_id);
  const now = new Date();
  validateAdjustment(bundle, input, now);
  const before = calculateSession(bundle.events, bundle.adjustments, now);
  const after = calculateSession(bundle.events, [...bundle.adjustments, proposedAdjustment(bundle, input, now)], now);
  const rounding = scope.project.settings.rounding;
  return {
    before: summarize(before, rounding),
    after: summarize(after, rounding),
    closes_open_session: before.open && !!input.effective_end,
    affected_exports: await affectedExports(db, scope.project, bundle, before.effective.start),
  };
}

function summarize(calc: ReturnType<typeof calculateSession>, rounding: ProjectRow["settings"]["rounding"]) {
  return {
    start: calc.effective.start.toISOString(),
    end: calc.effective.end?.toISOString() ?? null,
    work_seconds: calc.effective.workSeconds,
    rounded_minutes: roundMinutes(calc.effective.workSeconds, rounding),
    voided: calc.effective.voided,
  };
}

export async function createAdjustment(db: Db, ctx: AuditContext, user: AuthUser, input: AdjustmentInput) {
  return withTransaction(db, async (tx) => {
    // Lock the session so concurrent adjustments/clock commands serialize.
    await tx.query(`SELECT id FROM work_sessions WHERE id = $1 FOR UPDATE`, [input.session_id]);
    const { scope, bundle } = await loadScopedBundle(tx, user, input.session_id);
    const now = new Date();
    validateAdjustment(bundle, input, now);
    const before = calculateSession(bundle.events, bundle.adjustments, now);
    const id = await insertAdjustment(tx, ctx, user, scope.project, bundle, {
      type: input.adjustment_type,
      start: input.effective_start ? new Date(input.effective_start) : null,
      end: input.effective_end ? new Date(input.effective_end) : null,
      delta: input.delta_minutes ?? null,
      reason: input.reason,
      supersedes: input.supersedes_adjustment_id ?? null,
      correctionId: null,
    });
    return {
      adjustment_id: id,
      affected_exports: await affectedExports(tx, scope.project, bundle, before.effective.start),
    };
  });
}

/** Shared by correction approval: append a replace_interpretation adjustment (closing an open session if needed). */
async function applyInterpretation(
  tx: Tx,
  ctx: AuditContext,
  user: AuthUser,
  project: ProjectRow,
  sessionId: string,
  input: { start: Date | null; end: Date | null; reason: string; correctionId: string },
): Promise<string> {
  await tx.query(`SELECT id FROM work_sessions WHERE id = $1 FOR UPDATE`, [sessionId]);
  const rows = await loadSessionRows(tx, "s.id = $1", [sessionId]);
  const [bundle] = await loadBundles(tx, rows);
  const now = new Date();
  const calc = calculateSession(bundle!.events, bundle!.adjustments, now);
  const start = input.start ?? calc.effective.start;
  const end = input.end ?? calc.effective.end;
  if (end && end <= start) {
    throw unprocessable("INVALID_RANGE", "The requested times would make the session end before it starts.");
  }
  return insertAdjustment(tx, ctx, user, project, bundle!, {
    type: "replace_interpretation",
    start,
    end: input.end,
    delta: null,
    reason: input.reason,
    supersedes: null,
    correctionId: input.correctionId,
  });
}

async function insertAdjustment(
  tx: Tx,
  ctx: AuditContext,
  user: AuthUser,
  project: ProjectRow,
  bundle: SessionBundle,
  a: {
    type: AdjustmentInput["adjustment_type"];
    start: Date | null;
    end: Date | null;
    delta: number | null;
    reason: string;
    supersedes: string | null;
    correctionId: string | null;
  },
): Promise<string> {
  const session = bundle.session;
  // An open session given a corrected end is closed by an explicit, attributed system event so the
  // tutor can clock in again. The event records when the close happened; the adjustment carries the
  // corrected interpretation. Nothing is back-dated in the event log.
  if (session.state !== "closed" && a.type === "replace_interpretation" && a.end) {
    await closeOpenSession(tx, ctx, user, project, session.id, session.state, a.reason);
  }
  const effectiveStart = a.type === "replace_interpretation" ? (a.start ?? calculateSession(bundle.events, bundle.adjustments, new Date()).effective.start) : a.start;
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO time_adjustments (session_id, project_id, tutor_id, adjustment_type, effective_start, effective_end,
                                   delta_minutes, reason, source_correction_id, supersedes_adjustment_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [session.id, project.id, session.tutor_id, a.type, effectiveStart, a.end, a.delta, a.reason, a.correctionId, a.supersedes, user.id],
  );
  const id = rows[0]!.id;
  await tx.query(`UPDATE work_sessions SET version = version + 1, updated_at = now() WHERE id = $1`, [session.id]);
  await writeAudit(tx, ctx, {
    projectId: project.id,
    action: "adjustment.created",
    targetType: "time_adjustment",
    targetId: id,
    reason: a.reason,
    after: {
      session_id: session.id,
      adjustment_type: a.type,
      effective_start: effectiveStart?.toISOString() ?? null,
      effective_end: a.end?.toISOString() ?? null,
      delta_minutes: a.delta,
      supersedes_adjustment_id: a.supersedes,
      source_correction_id: a.correctionId,
    },
  });
  return id;
}

async function closeOpenSession(
  tx: Tx,
  ctx: AuditContext,
  user: AuthUser,
  project: ProjectRow,
  sessionId: string,
  state: "in" | "break" | "closed",
  reason: string,
) {
  const { rows } = await tx.query<{ t: Date }>("SELECT clock_timestamp() AS t");
  const t = rows[0]!.t;
  const types = state === "break" ? ["break_end", "clock_out"] : ["clock_out"];
  for (const type of types) {
    const ev = await tx.query<{ id: string }>(
      `INSERT INTO clock_events (project_id, session_id, actor_id, event_type, occurred_at, received_at, source,
                                 idempotency_key, sync_status, settings_version, metadata)
       VALUES ($1,$2,$3,$4,$5,$5,'admin_adjustment',$6,'accepted',$7,$8) RETURNING id`,
      [project.id, sessionId, user.id, type, t, randomUUID(), project.settings_version, JSON.stringify({ reason, closed_by_review: true })],
    );
    await writeAudit(tx, ctx, {
      projectId: project.id,
      action: `clock.${type}`,
      targetType: "clock_event",
      targetId: ev.rows[0]!.id,
      reason,
      after: { session_id: sessionId, occurred_at: t.toISOString(), source: "admin_adjustment" },
    });
  }
  await tx.query(
    `UPDATE work_sessions SET state = 'closed', closed_at = $2, version = version + 1, updated_at = $2 WHERE id = $1`,
    [sessionId, t],
  );
}

/** Completed exports whose range and tutor filter include this session (they may now be stale). */
async function affectedExports(q: Queryable, project: ProjectRow, bundle: SessionBundle, effectiveStart: Date) {
  const { rows } = await q.query<{ id: string; format: string; filters: { from: string; to: string; tutor_ids?: string[] | null }; timezone: string; completed_at: Date }>(
    `SELECT id, format, filters, timezone, completed_at FROM export_jobs
      WHERE project_id = $1 AND status = 'completed' ORDER BY completed_at DESC LIMIT 200`,
    [project.id],
  );
  return rows
    .filter((e) => {
      const d = localDate(effectiveStart, e.timezone);
      const tutorOk = !e.filters.tutor_ids?.length || e.filters.tutor_ids.includes(bundle.session.tutor_id);
      return tutorOk && d >= e.filters.from && d <= e.filters.to;
    })
    .map((e) => ({ id: e.id, format: e.format, from: e.filters.from, to: e.filters.to, completed_at: e.completed_at }));
}


