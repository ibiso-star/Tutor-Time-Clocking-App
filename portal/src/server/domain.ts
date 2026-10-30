/**
 * Shift state machine: OUT -> IN -> BREAK -> IN -> OUT (and IN -> OUT).
 * BREAK -> OUT only with an explicit end_break flag, which records the break end as its own event.
 */
export type State = "OUT" | "IN" | "BREAK";
export type Action = "CLOCK_IN" | "BREAK_START" | "BREAK_END" | "CLOCK_OUT";
export type EventType = "clock_in" | "break_start" | "break_end" | "clock_out";

export type Transition =
  | { ok: true; events: Array<{ type: EventType; stateAfter: State }> }
  | { ok: false; code: string; message: string };

export function transition(state: State, action: Action, opts: { endBreak?: boolean } = {}): Transition {
  const fail = (code: string, message: string): Transition => ({ ok: false, code, message });
  switch (action) {
    case "CLOCK_IN":
      return state === "OUT"
        ? { ok: true, events: [{ type: "clock_in", stateAfter: "IN" }] }
        : fail("ALREADY_CLOCKED_IN", state === "BREAK" ? "You're on a break. End it to keep working." : "You're already clocked in.");
    case "BREAK_START":
      if (state === "IN") return { ok: true, events: [{ type: "break_start", stateAfter: "BREAK" }] };
      return fail(state === "BREAK" ? "ALREADY_ON_BREAK" : "NOT_CLOCKED_IN", state === "BREAK" ? "You're already on a break." : "Clock in before starting a break.");
    case "BREAK_END":
      if (state === "BREAK") return { ok: true, events: [{ type: "break_end", stateAfter: "IN" }] };
      return fail(state === "IN" ? "NOT_ON_BREAK" : "NOT_CLOCKED_IN", state === "IN" ? "You're not on a break." : "You're clocked out.");
    case "CLOCK_OUT":
      if (state === "IN") return { ok: true, events: [{ type: "clock_out", stateAfter: "OUT" }] };
      if (state === "BREAK" && opts.endBreak) {
        return { ok: true, events: [{ type: "break_end", stateAfter: "IN" }, { type: "clock_out", stateAfter: "OUT" }] };
      }
      return state === "BREAK"
        ? fail("ON_BREAK", "You're on a break. End your break first, or choose \"End break and clock out\".")
        : fail("NOT_CLOCKED_IN", "You're not clocked in.");
  }
}

export interface TimedEvent {
  type: EventType;
  at: Date;
}

/** Worked seconds within [from, to): time between clock_in and clock_out, minus breaks. Open intervals run to `now`. */
export function workedSeconds(events: TimedEvent[], from: Date, to: Date, now: Date): number {
  const order: Record<EventType, number> = { clock_in: 0, break_start: 1, break_end: 2, clock_out: 3 };
  const sorted = [...events].sort((a, b) => a.at.getTime() - b.at.getTime() || order[a.type] - order[b.type]);
  let total = 0;
  let workingSince: Date | null = null;
  const add = (start: Date, end: Date) => {
    const s = Math.max(start.getTime(), from.getTime());
    const e = Math.min(end.getTime(), to.getTime());
    if (e > s) total += e - s;
  };
  for (const ev of sorted) {
    if (ev.type === "clock_in" || ev.type === "break_end") workingSince = ev.at;
    else if (workingSince) {
      add(workingSince, ev.at);
      workingSince = null;
    }
  }
  if (workingSince) add(workingSince, now);
  return Math.floor(total / 1000);
}
