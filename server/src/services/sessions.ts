import type { Queryable } from "../db/pool.js";
import { calculateSession, roundMinutes, sessionFlags, type CalcAdjustment, type CalcEvent, type SessionFlag } from "../domain/calc.js";
import type { ProjectRow } from "./access.js";
import { localDate } from "../domain/time.js";

export interface SessionRow {
  id: string;
  project_id: string;
  tutor_id: string;
  tutor_name: string;
  tutor_email: string;
  shift_id: string | null;
  shift_label: string | null;
  location_id: string | null;
  location_name: string | null;
  state: "in" | "break" | "closed";
  started_at: Date;
  closed_at: Date | null;
  settings_version: number;
  version: number;
}

export interface EventRow extends CalcEvent {
  id: string;
  session_id: string;
  actor_id: string;
  actor_name: string;
  received_at: Date;
  client_captured_at: Date | null;
  source: string;
  idempotency_key: string;
  location_id: string | null;
  metadata: Record<string, unknown>;
}

export interface AdjustmentRow extends CalcAdjustment {
  session_id: string;
  reason: string;
  source_correction_id: string | null;
  created_by: string;
  created_by_name: string;
}

export interface CorrectionSummary {
  id: string;
  status: string;
  submitted_at: Date;
}

export interface SessionBundle {
  session: SessionRow;
  events: EventRow[];
  adjustments: AdjustmentRow[];
  corrections: CorrectionSummary[];
}

const SESSION_SELECT = `
  SELECT s.id, s.project_id, s.tutor_id, u.display_name AS tutor_name, u.email AS tutor_email,
         s.shift_id, sh.label AS shift_label, s.location_id, l.name AS location_name,
         s.state, s.started_at, s.closed_at, s.settings_version, s.version
    FROM work_sessions s
    JOIN users u ON u.id = s.tutor_id
    LEFT JOIN shifts sh ON sh.id = s.shift_id
    LEFT JOIN work_locations l ON l.id = s.location_id`;

export async function loadSessionRows(q: Queryable, where: string, params: unknown[], tail = ""): Promise<SessionRow[]> {
  const { rows } = await q.query<SessionRow>(`${SESSION_SELECT} WHERE ${where} ${tail}`, params);
  return rows;
}

/** Loads events, adjustments and correction summaries for many sessions in three queries. */
export async function loadBundles(q: Queryable, sessions: SessionRow[]): Promise<SessionBundle[]> {
  if (sessions.length === 0) return [];
  const ids = sessions.map((s) => s.id);
  const [events, adjustments, corrections] = await Promise.all([
    q.query<EventRow>(
      `SELECT e.id, e.session_id, e.actor_id, u.display_name AS actor_name, e.event_type, e.occurred_at,
              e.received_at, e.client_captured_at, e.source, e.idempotency_key, e.sync_status,
              e.location_id, e.metadata
         FROM clock_events e JOIN users u ON u.id = e.actor_id
        WHERE e.session_id = ANY($1::uuid[])
        ORDER BY e.occurred_at, e.received_at`,
      [ids],
    ),
    q.query<AdjustmentRow>(
      `SELECT a.id, a.session_id, a.adjustment_type, a.effective_start, a.effective_end, a.delta_minutes,
              a.supersedes_adjustment_id, a.created_at, a.reason, a.source_correction_id, a.created_by,
              u.display_name AS created_by_name
         FROM time_adjustments a JOIN users u ON u.id = a.created_by
        WHERE a.session_id = ANY($1::uuid[])
        ORDER BY a.created_at`,
      [ids],
    ),
    q.query<CorrectionSummary & { session_id: string }>(
      `SELECT id, session_id, status, submitted_at FROM correction_requests
        WHERE session_id = ANY($1::uuid[]) ORDER BY submitted_at`,
      [ids],
    ),
  ]);
  const by = <T extends { session_id: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) m.set(r.session_id, [...(m.get(r.session_id) ?? []), r]);
    return m;
  };
  const ev = by(events.rows);
  const adj = by(adjustments.rows);
  const cor = by(corrections.rows);
  return sessions.map((session) => ({
    session,
    events: ev.get(session.id) ?? [],
    adjustments: adj.get(session.id) ?? [],
    corrections: cor.get(session.id) ?? [],
  }));
}

export interface SessionDto {
  id: string;
  project_id: string;
  tutor: { id: string; name: string; email: string };
  state: "in" | "break" | "closed";
  local_date: string;
  started_at: string;
  closed_at: string | null;
  shift: { id: string; label: string | null } | null;
  location: { id: string; name: string | null } | null;
  raw: { start: string; end: string | null; work_seconds: number; break_seconds: number; breaks: { start: string; end: string | null }[] };
  effective: { start: string; end: string | null; work_seconds: number; voided: boolean; delta_minutes: number; adjusted: boolean };
  rounded_minutes: number;
  flags: SessionFlag[];
  correction_status: string | null;
  version: number;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toSessionDto(bundle: SessionBundle, project: ProjectRow, now: Date): SessionDto {
  const { session } = bundle;
  const calc = calculateSession(bundle.events, bundle.adjustments, now);
  const latestCorrection = bundle.corrections.at(-1) ?? null;
  const pending = bundle.corrections.some((c) => c.status === "pending");
  const geofence = bundle.events.find((e) => e.event_type === "clock_in")?.metadata?.geofence;
  const locationReview = geofence === "outside" || geofence === "unverified" ? geofence : null;
  return {
    id: session.id,
    project_id: session.project_id,
    tutor: { id: session.tutor_id, name: session.tutor_name, email: session.tutor_email },
    state: session.state,
    local_date: localDate(calc.effective.start, project.timezone),
    started_at: session.started_at.toISOString(),
    closed_at: iso(session.closed_at),
    shift: session.shift_id ? { id: session.shift_id, label: session.shift_label } : null,
    location: session.location_id ? { id: session.location_id, name: session.location_name } : null,
    raw: {
      start: calc.raw.start.toISOString(),
      end: iso(calc.raw.end),
      work_seconds: calc.raw.workSeconds,
      break_seconds: calc.raw.breakSeconds,
      breaks: calc.raw.breaks.map((b) => ({ start: b.start.toISOString(), end: iso(b.end) })),
    },
    effective: {
      start: calc.effective.start.toISOString(),
      end: iso(calc.effective.end),
      work_seconds: calc.effective.workSeconds,
      voided: calc.effective.voided,
      delta_minutes: calc.effective.deltaMinutes,
      adjusted: calc.effective.adjusted,
    },
    rounded_minutes: roundMinutes(calc.effective.workSeconds, project.settings.rounding),
    flags: sessionFlags(calc, project.settings, project.timezone, now, { pendingCorrection: pending, locationReview }),
    correction_status: latestCorrection?.status ?? null,
    version: session.version,
  };
}

export function eventDto(e: EventRow) {
  return {
    id: e.id,
    event_type: e.event_type,
    occurred_at: e.occurred_at.toISOString(),
    received_at: e.received_at.toISOString(),
    client_captured_at: iso(e.client_captured_at),
    source: e.source,
    sync_status: e.sync_status,
    actor: { id: e.actor_id, name: e.actor_name },
    metadata: e.metadata,
  };
}

export function adjustmentDto(a: AdjustmentRow, bundle: SessionBundle) {
  const superseded = bundle.adjustments.some((x) => x.supersedes_adjustment_id === a.id);
  return {
    id: a.id,
    adjustment_type: a.adjustment_type,
    effective_start: iso(a.effective_start),
    effective_end: iso(a.effective_end),
    delta_minutes: a.delta_minutes,
    reason: a.reason,
    source_correction_id: a.source_correction_id,
    supersedes_adjustment_id: a.supersedes_adjustment_id,
    superseded,
    created_by: { id: a.created_by, name: a.created_by_name },
    created_at: a.created_at.toISOString(),
  };
}

export async function loadSessionDetail(q: Queryable, sessionId: string, project: ProjectRow, now: Date) {
  const rows = await loadSessionRows(q, "s.id = $1 AND s.project_id = $2", [sessionId, project.id]);
  if (!rows[0]) return null;
  const [bundle] = await loadBundles(q, rows);
  const { rows: corrections } = await q.query(
    `SELECT c.id, c.status, c.requested_change, c.explanation, c.submitted_at, c.resolved_at,
            c.decision_reason, c.version, r.display_name AS resolved_by_name
       FROM correction_requests c LEFT JOIN users r ON r.id = c.resolved_by
      WHERE c.session_id = $1 ORDER BY c.submitted_at DESC`,
    [sessionId],
  );
  return {
    bundle: bundle!,
    dto: {
      ...toSessionDto(bundle!, project, now),
      events: bundle!.events.map(eventDto),
      adjustments: bundle!.adjustments.map((a) => adjustmentDto(a, bundle!)),
      corrections,
    },
  };
}
