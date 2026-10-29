import { describe, expect, it } from "vitest";
import { calculateSession, roundMinutes, sessionFlags, type CalcAdjustment, type CalcEvent } from "../../src/domain/calc.js";
import { DEFAULT_SETTINGS } from "../../src/domain/policy.js";
import { localDate, localDateRange } from "../../src/domain/time.js";

const t = (iso: string) => new Date(iso);
const ev = (event_type: CalcEvent["event_type"], iso: string, sync_status: CalcEvent["sync_status"] = "accepted"): CalcEvent => ({
  event_type,
  occurred_at: t(iso),
  sync_status,
});
let adjSeq = 0;
const adj = (partial: Partial<CalcAdjustment> & Pick<CalcAdjustment, "adjustment_type">): CalcAdjustment => ({
  id: `adj-${++adjSeq}`,
  effective_start: null,
  effective_end: null,
  delta_minutes: null,
  supersedes_adjustment_id: null,
  created_at: t(`2026-01-01T00:00:${String(adjSeq).padStart(2, "0")}Z`),
  ...partial,
});

describe("calculateSession", () => {
  const now = t("2026-01-05T20:00:00Z");

  it("computes clock-out minus clock-in minus breaks", () => {
    const calc = calculateSession(
      [
        ev("clock_in", "2026-01-05T09:00:00Z"),
        ev("break_start", "2026-01-05T12:00:00Z"),
        ev("break_end", "2026-01-05T12:30:00Z"),
        ev("clock_out", "2026-01-05T17:00:00Z"),
      ],
      [],
      now,
    );
    expect(calc.raw.workSeconds).toBe(7.5 * 3600);
    expect(calc.raw.breakSeconds).toBe(30 * 60);
    expect(calc.effective.workSeconds).toBe(7.5 * 3600);
    expect(calc.open).toBe(false);
    expect(calc.anomalies).toEqual([]);
  });

  it("measures an open session up to now, excluding an open break", () => {
    const calc = calculateSession(
      [ev("clock_in", "2026-01-05T18:00:00Z"), ev("break_start", "2026-01-05T19:00:00Z")],
      [],
      now,
    );
    expect(calc.open).toBe(true);
    expect(calc.onBreak).toBe(true);
    expect(calc.raw.workSeconds).toBe(3600);
  });

  it("ignores events that are not accepted", () => {
    const calc = calculateSession(
      [ev("clock_in", "2026-01-05T09:00:00Z"), ev("clock_out", "2026-01-05T10:00:00Z", "pending_review")],
      [],
      now,
    );
    expect(calc.open).toBe(true);
  });

  it("flags overlapping or open breaks instead of silently inferring", () => {
    const calc = calculateSession(
      [
        ev("clock_in", "2026-01-05T09:00:00Z"),
        ev("break_start", "2026-01-05T10:00:00Z"),
        ev("break_start", "2026-01-05T10:10:00Z"),
        ev("clock_out", "2026-01-05T11:00:00Z"),
      ],
      [],
      now,
    );
    expect(calc.anomalies).toEqual(["overlapping_break", "open_break_at_clock_out"]);
  });

  it("applies replace, add-time and void adjustments without touching raw values", () => {
    const events = [ev("clock_in", "2026-01-05T09:00:00Z"), ev("clock_out", "2026-01-05T10:00:00Z")];
    const replace = adj({
      adjustment_type: "replace_interpretation",
      effective_start: t("2026-01-05T08:30:00Z"),
      effective_end: t("2026-01-05T10:00:00Z"),
    });
    const add = adj({ adjustment_type: "add_time", delta_minutes: 15 });
    const calc = calculateSession(events, [replace, add], now);
    expect(calc.raw.workSeconds).toBe(3600);
    expect(calc.effective.workSeconds).toBe(105 * 60);
    expect(calc.effective.adjusted).toBe(true);

    const voided = calculateSession(events, [replace, add, adj({ adjustment_type: "void_session" })], now);
    expect(voided.effective.workSeconds).toBe(0);
    expect(voided.effective.voided).toBe(true);
  });

  it("honours superseded adjustments", () => {
    const events = [ev("clock_in", "2026-01-05T09:00:00Z"), ev("clock_out", "2026-01-05T10:00:00Z")];
    const first = adj({ adjustment_type: "add_time", delta_minutes: 60 });
    const second = adj({ adjustment_type: "add_time", delta_minutes: 10, supersedes_adjustment_id: first.id });
    const calc = calculateSession(events, [first, second], now);
    expect(calc.effective.workSeconds).toBe(70 * 60);
    expect(calc.effective.appliedAdjustmentIds).toEqual([second.id]);
  });

  it("never yields negative time", () => {
    const events = [ev("clock_in", "2026-01-05T09:00:00Z"), ev("clock_out", "2026-01-05T09:10:00Z")];
    const calc = calculateSession(events, [adj({ adjustment_type: "add_time", delta_minutes: -60 })], now);
    expect(calc.effective.workSeconds).toBe(0);
  });

  it("uses real elapsed time across a DST spring-forward night", () => {
    // America/Los_Angeles springs forward at 2026-03-08 02:00 local (10:00Z).
    // 00:30 PST -> 04:30 PDT is 3 real hours, not 4 wall-clock hours.
    const calc = calculateSession(
      [ev("clock_in", "2026-03-08T08:30:00Z"), ev("clock_out", "2026-03-08T11:30:00Z")],
      [],
      t("2026-03-09T00:00:00Z"),
    );
    expect(calc.raw.workSeconds).toBe(3 * 3600);
    expect(localDate(t("2026-03-08T08:30:00Z"), "America/Los_Angeles")).toBe("2026-03-08");
  });
});

describe("localDateRange", () => {
  it("produces 23 and 25 hour days at DST transitions", () => {
    const spring = localDateRange("2026-03-08", "2026-03-08", "America/Los_Angeles");
    expect((spring.end.getTime() - spring.start.getTime()) / 3600000).toBe(23);
    const fall = localDateRange("2026-11-01", "2026-11-01", "America/Los_Angeles");
    expect((fall.end.getTime() - fall.start.getTime()) / 3600000).toBe(25);
    expect(spring.start.toISOString()).toBe("2026-03-08T08:00:00.000Z");
  });
});

describe("roundMinutes", () => {
  const s = (min: number, sec = 0) => min * 60 + sec;
  it("returns exact minutes when rounding is off", () => {
    expect(roundMinutes(s(52, 30), { mode: "none", increment_minutes: 1 })).toBe(52.5);
  });
  it.each([
    ["nearest", s(52), 50],
    ["nearest", s(53), 55],
    ["nearest", s(52, 30), 55],
    ["up", s(50, 1), 55],
    ["up", s(50), 50],
    ["down", s(54, 59), 50],
  ] as const)("%s/5 of %ss => %s", (mode, seconds, expected) => {
    expect(roundMinutes(seconds, { mode, increment_minutes: 5 })).toBe(expected);
  });
  it("supports 6-minute (tenth-hour) and 15-minute increments", () => {
    expect(roundMinutes(s(62), { mode: "nearest", increment_minutes: 6 })).toBe(60);
    expect(roundMinutes(s(68), { mode: "nearest", increment_minutes: 15 })).toBe(75);
  });
});

describe("sessionFlags", () => {
  const tz = "America/New_York";
  it("flags long sessions and missed clock-outs", () => {
    const calc = calculateSession([ev("clock_in", "2026-01-04T14:00:00Z")], [], t("2026-01-05T15:00:00Z"));
    const codes = sessionFlags(calc, DEFAULT_SETTINGS, tz, t("2026-01-05T15:00:00Z")).map((f) => f.code);
    expect(codes).toContain("long_session");
    expect(codes).toContain("missed_clock_out");
  });
  it("does not flag a normal same-day session", () => {
    const calc = calculateSession(
      [ev("clock_in", "2026-01-05T14:00:00Z"), ev("clock_out", "2026-01-05T18:00:00Z")],
      [],
      t("2026-01-05T20:00:00Z"),
    );
    expect(sessionFlags(calc, DEFAULT_SETTINGS, tz, t("2026-01-05T20:00:00Z"))).toEqual([]);
  });
  it("flags breaks longer than the configured maximum", () => {
    const calc = calculateSession(
      [ev("clock_in", "2026-01-05T14:00:00Z"), ev("break_start", "2026-01-05T15:00:00Z")],
      [],
      t("2026-01-05T16:30:00Z"),
    );
    expect(sessionFlags(calc, DEFAULT_SETTINGS, tz, t("2026-01-05T16:30:00Z")).map((f) => f.code)).toEqual(["long_break"]);
  });
});
