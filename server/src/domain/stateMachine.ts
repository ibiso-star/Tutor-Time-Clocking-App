/**
 * Clock state machine (PRD §8, TRD §3):
 *   OUT -> IN -> BREAK -> IN -> OUT, and IN -> OUT.
 * BREAK -> OUT is only possible as an explicit combined "end break and clock out" command
 * when policy allows it; it is never inferred.
 */
export type ClockState = "OUT" | "IN" | "BREAK";
export type ClockCommand = "CLOCK_IN" | "CLOCK_OUT" | "BREAK_START" | "BREAK_END";
export type EventType = "clock_in" | "clock_out" | "break_start" | "break_end";

export interface TransitionPolicy {
  breaksEnabled: boolean;
  clockOutWhileOnBreak: "require_end" | "allow_combined";
}

export type TransitionResult =
  | { ok: true; events: EventType[]; nextState: ClockState }
  | { ok: false; code: string; message: string };

export function transition(
  state: ClockState,
  command: ClockCommand,
  policy: TransitionPolicy,
  opts: { endOpenBreak?: boolean } = {},
): TransitionResult {
  switch (command) {
    case "CLOCK_IN":
      if (state === "OUT") return { ok: true, events: ["clock_in"], nextState: "IN" };
      return reject("ALREADY_CLOCKED_IN", state === "BREAK"
        ? "You are already clocked in and on a break. End your break to continue working."
        : "You are already clocked in. Clock out when your session ends.");

    case "BREAK_START":
      if (!policy.breaksEnabled) return reject("BREAKS_DISABLED", "Breaks are not used on this project.");
      if (state === "IN") return { ok: true, events: ["break_start"], nextState: "BREAK" };
      if (state === "BREAK") return reject("ALREADY_ON_BREAK", "You are already on a break.");
      return reject("NOT_CLOCKED_IN", "You need to clock in before starting a break.");

    case "BREAK_END":
      if (state === "BREAK") return { ok: true, events: ["break_end"], nextState: "IN" };
      if (state === "IN") return reject("NOT_ON_BREAK", "You are not on a break.");
      return reject("NOT_CLOCKED_IN", "You are clocked out. Clock in to start a session.");

    case "CLOCK_OUT":
      if (state === "IN") return { ok: true, events: ["clock_out"], nextState: "OUT" };
      if (state === "BREAK") {
        if (opts.endOpenBreak && policy.clockOutWhileOnBreak === "allow_combined") {
          return { ok: true, events: ["break_end", "clock_out"], nextState: "OUT" };
        }
        return reject(
          "ON_BREAK",
          policy.clockOutWhileOnBreak === "allow_combined"
            ? "You are on a break. Choose \"End break and clock out\" to finish your session."
            : "You are on a break. End your break before clocking out.",
        );
      }
      return reject("NOT_CLOCKED_IN", "You are not clocked in, so there is no session to clock out of.");
  }
}

function reject(code: string, message: string): TransitionResult {
  return { ok: false, code, message };
}

export function stateFromSession(sessionState: "in" | "break" | "closed" | null | undefined): ClockState {
  if (sessionState === "in") return "IN";
  if (sessionState === "break") return "BREAK";
  return "OUT";
}
