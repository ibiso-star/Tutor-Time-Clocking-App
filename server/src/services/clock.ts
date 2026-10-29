import { randomUUID } from "node:crypto";
import type { Db, Queryable, Tx } from "../db/pool.js";
import { withTransaction } from "../db/pool.js";
import { conflict, forbidden, unprocessable } from "../lib/errors.js";
import type { AuditContext, AuthUser } from "../lib/context.js";
import { stateFromSession, transition, type ClockCommand, type EventType } from "../domain/stateMachine.js";
import { localDate, localDateRange } from "../domain/time.js";
import { loadProject, type ProjectRow } from "./access.js";
import { writeAudit } from "./audit.js";
import { eventDto, loadBundles, loadSessionRows, toSessionDto } from "./sessions.js";

export interface ClockInput {
  project_id: string;
  event_type: ClockCommand;
  idempotency_key: string;
  location_id?: string | null;
  shift_id?: string | null;
  end_open_break?: boolean;
  client_captured_at?: string | null;
  coords?: { lat: number; lng: number; accuracy_m?: number | null } | null;
}

export interface ClockResult {
  event_id: string;
  event_type: EventType;
  server_timestamp: string;
  session_id: string;
  session_state: "OUT" | "IN" | "BREAK";
  sync_status: "accepted";
  replayed: boolean;
  warnings: string[];
}

interface OpenSession {
  id: string;
  state: "in" | "break";
  version: number;
}

/**
 * Executes one clock command (TRD §3–5). Everything — authorization, idempotency lookup, state
 * validation, policy checks, event insert, session projection update and audit — happens in one
 * transaction serialized on the tutor's membership row, so concurrent taps cannot create
 * duplicate or invalid events. The official timestamp is the database clock, never the client's.
 */
export async function executeClock(db: Db, ctx: AuditContext, user: AuthUser, input: ClockInput): Promise<ClockResult> {
  return withTransaction(db, async (tx) => {
    // Serialize all commands for this tutor/project.
    const membership = await tx.query<{ role: string }>(
      `SELECT role FROM project_memberships
        WHERE project_id = $1 AND user_id = $2 AND active_to IS NULL
        FOR UPDATE`,
      [input.project_id, user.id],
    );
    if (!membership.rows[0]) throw forbidden("You are not an active member of this project.");
    if (membership.rows[0].role !== "tutor") throw forbidden("Only tutors record clock events.");

    const replay = await findReplay(tx, user.id, input);
    if (replay) return replay;

    const project = await loadProject(tx, input.project_id);
    if (project.status !== "active") throw forbidden("This project is not active.");
    const settings = project.settings;

    const open = await tx.query<OpenSession>(
      `SELECT id, state, version FROM work_sessions
        WHERE project_id = $1 AND tutor_id = $2 AND state IN ('in','break')
        FOR UPDATE`,
      [project.id, user.id],
    );
    const session = open.rows[0] ?? null;
    const current = stateFromSession(session?.state);

    const result = transition(
      current,
      input.event_type,
      { breaksEnabled: settings.breaks.enabled, clockOutWhileOnBreak: settings.breaks.clock_out_while_on_break },
      { endOpenBreak: input.end_open_break },
    );
    if (!result.ok) throw conflict(result.code, result.message, { current_state: current });

    const warnings: string[] = [];
    const metadata: Record<string, unknown> = { command: input.event_type };
    let location: { id: string | null; lat: number | null; lng: number | null; accuracy: number | null } = {
      id: null,
      lat: null,
      lng: null,
      accuracy: null,
    };
    let shiftId: string | null = null;

    if (input.event_type === "CLOCK_IN") {
      location = await checkLocationPolicy(tx, project, input, metadata, warnings);
      if (warnings.length) metadata.warnings = warnings;
      shiftId = await checkShift(tx, project, user.id, input.shift_id ?? null);
    }

    // Official time comes from the database clock, read after the lock is held.
    const { rows: timeRows } = await tx.query<{ t: Date }>("SELECT clock_timestamp() AS t");
    const t = timeRows[0]!.t;
    const clientCaptured = parseClientTime(input.client_captured_at);

    let sessionId: string;
    if (input.event_type === "CLOCK_IN") {
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO work_sessions (project_id, tutor_id, shift_id, location_id, state, started_at, settings_version)
         VALUES ($1,$2,$3,$4,'in',$5,$6) RETURNING id`,
        [project.id, user.id, shiftId, location.id, t, project.settings_version],
      );
      sessionId = ins.rows[0]!.id;
    } else {
      sessionId = session!.id;
      const nextState = result.nextState === "OUT" ? "closed" : result.nextState === "BREAK" ? "break" : "in";
      await tx.query(
        `UPDATE work_sessions
            SET state = $2, closed_at = CASE WHEN $2 = 'closed' THEN $3::timestamptz ELSE NULL END,
                version = version + 1, updated_at = $3
          WHERE id = $1`,
        [sessionId, nextState, t],
      );
    }

    let primaryEventId = "";
    let primaryType: EventType = result.events[result.events.length - 1]!;
    for (const [i, eventType] of result.events.entries()) {
      const isPrimary = i === result.events.length - 1;
      // A combined command records the implied break end as its own explicit event with its own key.
      const key = isPrimary ? input.idempotency_key : randomUUID();
      const meta = isPrimary ? metadata : { command: input.event_type, part_of: input.idempotency_key };
      const ev = await tx.query<{ id: string }>(
        `INSERT INTO clock_events (project_id, session_id, actor_id, event_type, occurred_at, client_captured_at,
                                   received_at, source, idempotency_key, sync_status, location_id, location_lat,
                                   location_lng, location_accuracy_m, settings_version, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$5,'web',$7,'accepted',$8,$9,$10,$11,$12,$13) RETURNING id`,
        [
          project.id, sessionId, user.id, eventType, t, clientCaptured, key,
          isPrimary ? location.id : null, isPrimary ? location.lat : null, isPrimary ? location.lng : null,
          isPrimary ? location.accuracy : null, project.settings_version, JSON.stringify(meta),
        ],
      );
      await writeAudit(tx, ctx, {
        projectId: project.id,
        action: `clock.${eventType}`,
        targetType: "clock_event",
        targetId: ev.rows[0]!.id,
        after: { session_id: sessionId, occurred_at: t.toISOString(), source: "web", ...(isPrimary ? {} : { part_of: input.idempotency_key }) },
      });
      if (isPrimary) {
        primaryEventId = ev.rows[0]!.id;
        primaryType = eventType;
      }
    }

    return {
      event_id: primaryEventId,
      event_type: primaryType,
      server_timestamp: t.toISOString(),
      session_id: sessionId,
      session_state: result.nextState,
      sync_status: "accepted" as const,
      replayed: false,
      warnings,
    };
  });
}

async function findReplay(tx: Tx, actorId: string, input: ClockInput): Promise<ClockResult | null> {
  const { rows } = await tx.query<{
    id: string;
    event_type: EventType;
    occurred_at: Date;
    session_id: string;
    metadata: { command?: string; warnings?: string[] };
  }>(
    `SELECT id, event_type, occurred_at, session_id, metadata FROM clock_events
      WHERE actor_id = $1 AND project_id = $2 AND idempotency_key = $3`,
    [actorId, input.project_id, input.idempotency_key],
  );
  const prior = rows[0];
  if (!prior) return null;
  if (prior.metadata.command !== input.event_type) {
    throw conflict("IDEMPOTENCY_KEY_REUSED", "This request key was already used for a different action. Please retry.");
  }
  const { rows: s } = await tx.query<{ state: string }>(
    `SELECT state FROM work_sessions WHERE project_id = $1 AND tutor_id = $2 AND state IN ('in','break')`,
    [input.project_id, actorId],
  );
  return {
    event_id: prior.id,
    event_type: prior.event_type,
    server_timestamp: prior.occurred_at.toISOString(),
    session_id: prior.session_id,
    session_state: stateFromSession(s[0]?.state as "in" | "break" | undefined),
    sync_status: "accepted",
    replayed: true,
    warnings: prior.metadata.warnings ?? [],
  };
}

async function checkLocationPolicy(
  tx: Tx,
  project: ProjectRow,
  input: ClockInput,
  metadata: Record<string, unknown>,
  warnings: string[],
) {
  const settings = project.settings;
  const out = { id: null as string | null, lat: null as number | null, lng: null as number | null, accuracy: null as number | null };
  if (!input.location_id) {
    if (settings.require_location) {
      throw unprocessable("LOCATION_REQUIRED", "Choose your work location before clocking in.");
    }
    return out;
  }
  const { rows } = await tx.query<{
    id: string;
    latitude: string | null;
    longitude: string | null;
    geofence_radius_m: number | null;
    geofence_mode: "off" | "warn" | "block";
  }>(
    `SELECT id, latitude, longitude, geofence_radius_m, geofence_mode FROM work_locations
      WHERE id = $1 AND project_id = $2 AND active`,
    [input.location_id, project.id],
  );
  const loc = rows[0];
  if (!loc) throw unprocessable("INVALID_LOCATION", "That work location is not available on this project.");
  out.id = loc.id;

  // Coordinates are only ever considered (or stored) when the project has enabled location controls.
  if (!settings.location_controls.enabled || loc.geofence_mode === "off" || loc.latitude === null || loc.longitude === null || !loc.geofence_radius_m) {
    return out;
  }
  const coords = input.coords;
  if (!coords) {
    if (loc.geofence_mode === "block") {
      throw unprocessable(
        "LOCATION_UNAVAILABLE",
        "This location requires a location check at clock-in. Allow location access and try again, or request a review from your supervisor.",
      );
    }
    metadata.geofence = "unverified";
    warnings.push("Your location could not be checked. This clock-in is marked for supervisor review.");
    return out;
  }
  out.lat = coords.lat;
  out.lng = coords.lng;
  out.accuracy = coords.accuracy_m ?? null;
  const distance = haversineMeters(coords.lat, coords.lng, Number(loc.latitude), Number(loc.longitude));
  const inside = distance <= loc.geofence_radius_m + Math.min(coords.accuracy_m ?? 0, 100);
  metadata.geofence = inside ? "inside" : "outside";
  if (!inside) {
    if (loc.geofence_mode === "block") {
      throw unprocessable(
        "OUTSIDE_GEOFENCE",
        "You appear to be outside the approved area. Try again at the work location or request a review.",
      );
    }
    warnings.push("You appear to be outside the approved area. This clock-in is marked for supervisor review.");
  }
  return out;
}

async function checkShift(tx: Tx, project: ProjectRow, tutorId: string, shiftId: string | null): Promise<string | null> {
  if (!shiftId) return null;
  const { rows } = await tx.query(
    `SELECT id FROM shifts WHERE id = $1 AND project_id = $2 AND status = 'scheduled'
        AND (tutor_id IS NULL OR tutor_id = $3)`,
    [shiftId, project.id, tutorId],
  );
  if (!rows[0]) throw unprocessable("INVALID_SHIFT", "That shift is not assigned to you or is no longer scheduled.");
  return shiftId;
}

function parseClientTime(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Current state, active session, today's total and next shift for the tutor home screen. */
export async function timeStatus(q: Queryable, tutorId: string, project: ProjectRow, now: Date) {
  const today = localDate(now, project.timezone);
  const { start, end } = localDateRange(today, today, project.timezone);
  // Sessions are attributed to the local date on which they (effectively) start — the same rule
  // exports use, so the tutor's daily total reconciles with payroll output.
  const sessions = await loadSessionRows(
    q,
    `s.project_id = $1 AND s.tutor_id = $2 AND (s.state <> 'closed' OR (s.started_at >= $3::timestamptz - interval '1 day' AND s.started_at < $4::timestamptz))`,
    [project.id, tutorId, start, end],
    "ORDER BY s.started_at",
  );
  const bundles = await loadBundles(q, sessions);
  const dtos = bundles.map((b) => ({ bundle: b, dto: toSessionDto(b, project, now) }));
  const todays = dtos.filter((d) => d.dto.local_date === today);
  const active = dtos.find((d) => d.dto.state !== "closed") ?? null;

  const { rows: shifts } = await q.query(
    `SELECT s.id, s.label, s.scheduled_start, s.scheduled_end, l.id AS location_id, l.name AS location_name
       FROM shifts s LEFT JOIN work_locations l ON l.id = s.location_id
      WHERE s.project_id = $1 AND (s.tutor_id = $2) AND s.status = 'scheduled' AND s.scheduled_end > $3
      ORDER BY s.scheduled_start LIMIT 1`,
    [project.id, tutorId, now],
  );
  const { rows: locations } = await q.query(
    `SELECT id, name, geofence_mode FROM work_locations WHERE project_id = $1 AND active ORDER BY name`,
    [project.id],
  );
  const s = project.settings;
  return {
    project: { id: project.id, name: project.name, timezone: project.timezone },
    state: stateFromSession(active?.dto.state === "closed" ? null : active?.dto.state),
    session: active ? { ...active.dto, events: active.bundle.events.map(eventDto) } : null,
    today: {
      date: today,
      work_seconds: todays.reduce((sum, d) => sum + d.dto.effective.work_seconds, 0),
      sessions: todays.length,
    },
    next_shift: shifts[0] ?? null,
    policy: {
      breaks_enabled: s.breaks.enabled,
      clock_out_while_on_break: s.breaks.clock_out_while_on_break,
      require_location: s.require_location,
      confirm_clock_out: s.confirm_clock_out,
      location_controls_enabled: s.location_controls.enabled,
      max_shift_minutes: s.max_shift_minutes,
    },
    locations,
    server_time: now.toISOString(),
  };
}
