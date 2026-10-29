import { describe, expect, it } from "vitest";
import { transition, type ClockCommand, type ClockState } from "../../src/domain/stateMachine.js";

const withBreaks = { breaksEnabled: true, clockOutWhileOnBreak: "require_end" as const };
const combined = { breaksEnabled: true, clockOutWhileOnBreak: "allow_combined" as const };
const noBreaks = { breaksEnabled: false, clockOutWhileOnBreak: "require_end" as const };

describe("clock state machine", () => {
  // Full transition matrix with breaks enabled and require_end policy.
  const matrix: Array<[ClockState, ClockCommand, ClockState | string]> = [
    ["OUT", "CLOCK_IN", "IN"],
    ["OUT", "CLOCK_OUT", "NOT_CLOCKED_IN"],
    ["OUT", "BREAK_START", "NOT_CLOCKED_IN"],
    ["OUT", "BREAK_END", "NOT_CLOCKED_IN"],
    ["IN", "CLOCK_IN", "ALREADY_CLOCKED_IN"],
    ["IN", "CLOCK_OUT", "OUT"],
    ["IN", "BREAK_START", "BREAK"],
    ["IN", "BREAK_END", "NOT_ON_BREAK"],
    ["BREAK", "CLOCK_IN", "ALREADY_CLOCKED_IN"],
    ["BREAK", "CLOCK_OUT", "ON_BREAK"],
    ["BREAK", "BREAK_START", "ALREADY_ON_BREAK"],
    ["BREAK", "BREAK_END", "IN"],
  ];
  it.each(matrix)("%s + %s => %s", (state, cmd, expected) => {
    const r = transition(state, cmd, withBreaks);
    if (r.ok) expect(r.nextState).toBe(expected);
    else expect(r.code).toBe(expected);
  });

  it("rejects breaks when the feature is disabled", () => {
    const r = transition("IN", "BREAK_START", noBreaks);
    expect(r).toMatchObject({ ok: false, code: "BREAKS_DISABLED" });
  });

  it("never infers a break end when clocking out on break", () => {
    expect(transition("BREAK", "CLOCK_OUT", combined)).toMatchObject({ ok: false, code: "ON_BREAK" });
    expect(transition("BREAK", "CLOCK_OUT", withBreaks, { endOpenBreak: true })).toMatchObject({ ok: false });
  });

  it("allows an explicit combined end-break-and-clock-out when policy permits", () => {
    expect(transition("BREAK", "CLOCK_OUT", combined, { endOpenBreak: true })).toEqual({
      ok: true,
      events: ["break_end", "clock_out"],
      nextState: "OUT",
    });
  });

  it("returns actionable messages", () => {
    const r = transition("OUT", "CLOCK_OUT", withBreaks);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/not clocked in/i);
  });
});
