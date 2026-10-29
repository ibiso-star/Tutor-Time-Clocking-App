import type { EventType } from "./stateMachine.js";
import type { ProjectSettings, RoundingPolicy } from "./policy.js";
import { localDate } from "./time.js";

/**
 * Canonical time calculation. Durations are derived from the immutable event sequence plus
 * append-only adjustments — never from a stored, mutable total (TRD §3, Schema §7).
 * The canonical unit is whole seconds; rounding is applied only at reporting time.
 */

export interface CalcEvent {
  event_type: EventType;
  occurred_at: Date;
  sync_status: "accepted" | "pending_review" | "rejected";
}

export interface CalcAdjustment {
  id: string;
  adjustment_type: "add_time" | "replace_interpretation" | "void_session" | "other";
  effective_start: Date | null;
  effective_end: Date | null;
  delta_minutes: number | null;
  supersedes_adjustment_id: string | null;
  created_at: Date;
}

export interface Interval {
  start: Date;
  end: Date | null;
}

export interface SessionCalc {
  /** Raw interpretation from accepted clock events only. */
  raw: {
    start: Date;
    end: Date | null;
    breaks: Interval[];
    workSeconds: number;
    breakSeconds: number;
  };
  /** Interpretation after applying active (non-superseded) adjustments. */
  effective: {
    start: Date;
    end: Date | null;
    voided: boolean;
    deltaMinutes: number;
    workSeconds: number;
    adjusted: boolean;
    appliedAdjustmentIds: string[];
  };
  open: boolean;
  onBreak: boolean;
  anomalies: string[];
}

/** Tie-break for events recorded at the same instant (e.g. combined end-break + clock-out). */
const ORDER: Record<EventType, number> = { clock_in: 0, break_start: 1, break_end: 2, clock_out: 3 };

function overlapMs(a: { start: number; end: number }, b: { start: number; end: number }): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

/** Work seconds inside [start, end) excluding the portions covered by breaks. */
export function workSecondsInWindow(start: Date, end: Date, breaks: Interval[]): number {
  const window = { start: start.getTime(), end: end.getTime() };
  if (window.end <= window.start) return 0;
  let breakMs = 0;
  for (const b of breaks) {
    breakMs += overlapMs(window, { start: b.start.getTime(), end: (b.end ?? end).getTime() });
  }
  return Math.floor((window.end - window.start - breakMs) / 1000);
}

export function calculateSession(
  events: CalcEvent[],
  adjustments: CalcAdjustment[],
  now: Date,
): SessionCalc {
  const accepted = events
    .filter((e) => e.sync_status === "accepted")
    .sort((a, b) => a.occurred_at.getTime() - b.occurred_at.getTime() || ORDER[a.event_type] - ORDER[b.event_type]);
  const anomalies: string[] = [];

  let start: Date | null = null;
  let end: Date | null = null;
  const breaks: Interval[] = [];
  let openBreak: Interval | null = null;

  for (const e of accepted) {
    switch (e.event_type) {
      case "clock_in":
        if (start) anomalies.push("duplicate_clock_in");
        else start = e.occurred_at;
        break;
      case "break_start":
        if (openBreak) anomalies.push("overlapping_break");
        else {
          openBreak = { start: e.occurred_at, end: null };
          breaks.push(openBreak);
        }
        break;
      case "break_end":
        if (!openBreak) anomalies.push("break_end_without_start");
        else {
          openBreak.end = e.occurred_at;
          openBreak = null;
        }
        break;
      case "clock_out":
        end = e.occurred_at;
        break;
    }
  }
  if (!start) {
    // A session always begins with an accepted clock_in; fall back defensively and flag it.
    anomalies.push("missing_clock_in");
    start = accepted[0]?.occurred_at ?? now;
  }
  if (end && openBreak) anomalies.push("open_break_at_clock_out");

  const rawEnd = end ?? now;
  const rawWork = workSecondsInWindow(start, rawEnd, breaks);
  const rawSpan = Math.max(0, Math.floor((rawEnd.getTime() - start.getTime()) / 1000));

  // Apply adjustments in creation order, skipping any that a later adjustment supersedes.
  const superseded = new Set(adjustments.map((a) => a.supersedes_adjustment_id).filter(Boolean));
  const active = adjustments
    .filter((a) => !superseded.has(a.id))
    .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());

  let effStart = start;
  let effEnd: Date | null = end;
  let voided = false;
  let delta = 0;
  const applied: string[] = [];
  for (const adj of active) {
    switch (adj.adjustment_type) {
      case "replace_interpretation":
        if (adj.effective_start) effStart = adj.effective_start;
        if (adj.effective_end) effEnd = adj.effective_end;
        applied.push(adj.id);
        break;
      case "void_session":
        voided = true;
        applied.push(adj.id);
        break;
      case "add_time":
        delta += adj.delta_minutes ?? 0;
        applied.push(adj.id);
        break;
      case "other":
        // Annotation only; no effect on calculated time.
        break;
    }
  }
  const effWork = voided
    ? 0
    : Math.max(0, workSecondsInWindow(effStart, effEnd ?? now, breaks) + delta * 60);

  return {
    raw: { start, end, breaks, workSeconds: rawWork, breakSeconds: rawSpan - rawWork },
    effective: {
      start: effStart,
      end: effEnd,
      voided,
      deltaMinutes: delta,
      workSeconds: effWork,
      adjusted: applied.length > 0,
      appliedAdjustmentIds: applied,
    },
    open: end === null,
    onBreak: end === null && openBreak !== null,
    anomalies,
  };
}

/**
 * Applies the configured rounding rule to one session's exact seconds and returns minutes.
 * `none` returns exact minutes (fractional, to the second). Rounding operates per session.
 */
export function roundMinutes(seconds: number, policy: RoundingPolicy): number {
  const exact = seconds / 60;
  if (policy.mode === "none" || policy.increment_minutes <= 0) return Math.round(exact * 100) / 100;
  const inc = policy.increment_minutes * 60;
  const units = seconds / inc;
  const rounded = policy.mode === "nearest" ? Math.round(units) : policy.mode === "up" ? Math.ceil(units) : Math.floor(units);
  return rounded * policy.increment_minutes;
}

export interface SessionFlag {
  code:
    | "long_session"
    | "missed_clock_out"
    | "long_break"
    | "anomaly"
    | "location_review"
    | "pending_correction"
    | "adjusted"
    | "voided";
  label: string;
}

export function sessionFlags(
  calc: SessionCalc,
  settings: ProjectSettings,
  timezone: string,
  now: Date,
  opts: { pendingCorrection?: boolean; locationReview?: "outside" | "unverified" | null } = {},
): SessionFlag[] {
  const flags: SessionFlag[] = [];
  const spanEnd = calc.raw.end ?? now;
  const spanMinutes = (spanEnd.getTime() - calc.raw.start.getTime()) / 60000;
  if (spanMinutes > settings.max_shift_minutes) {
    flags.push({
      code: "long_session",
      label: `Longer than the ${formatHours(settings.max_shift_minutes)} maximum`,
    });
  }
  if (calc.open && localDate(calc.raw.start, timezone) < localDate(now, timezone)) {
    flags.push({ code: "missed_clock_out", label: "Possible missed clock-out (still open from a previous day)" });
  }
  const maxBreak = settings.breaks.max_break_minutes;
  if (maxBreak) {
    const long = calc.raw.breaks.some((b) => ((b.end ?? spanEnd).getTime() - b.start.getTime()) / 60000 > maxBreak);
    if (long) flags.push({ code: "long_break", label: `Break longer than ${maxBreak} min` });
  }
  for (const a of calc.anomalies) flags.push({ code: "anomaly", label: a.replaceAll("_", " ") });
  if (opts.locationReview === "outside") flags.push({ code: "location_review", label: "Clocked in outside the approved area" });
  if (opts.locationReview === "unverified") flags.push({ code: "location_review", label: "Location could not be verified at clock-in" });
  if (opts.pendingCorrection) flags.push({ code: "pending_correction", label: "Correction pending review" });
  if (calc.effective.voided) flags.push({ code: "voided", label: "Voided by adjustment" });
  else if (calc.effective.adjusted) flags.push({ code: "adjusted", label: "Adjusted" });
  return flags;
}

function formatHours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
