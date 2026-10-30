import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { transition, workedSeconds, type Action, type State } from "../src/server/domain.js";
import { newBadgeCode, newToken, normalizeBadge } from "../src/server/credentials.js";
import { backoffSeconds, signWebhook } from "../src/server/webhooks.js";

describe("state machine", () => {
  const cases: Array<[State, Action, string]> = [
    ["OUT", "CLOCK_IN", "IN"], ["OUT", "CLOCK_OUT", "NOT_CLOCKED_IN"], ["OUT", "BREAK_START", "NOT_CLOCKED_IN"], ["OUT", "BREAK_END", "NOT_CLOCKED_IN"],
    ["IN", "CLOCK_IN", "ALREADY_CLOCKED_IN"], ["IN", "BREAK_START", "BREAK"], ["IN", "BREAK_END", "NOT_ON_BREAK"], ["IN", "CLOCK_OUT", "OUT"],
    ["BREAK", "CLOCK_IN", "ALREADY_CLOCKED_IN"], ["BREAK", "BREAK_START", "ALREADY_ON_BREAK"], ["BREAK", "BREAK_END", "IN"], ["BREAK", "CLOCK_OUT", "ON_BREAK"],
  ];
  it.each(cases)("%s + %s → %s", (s, a, expected) => {
    const t = transition(s, a);
    expect(t.ok ? t.events.at(-1)!.stateAfter : (t as { code: string }).code).toBe(expected);
  });
  it("records an explicit break end before clocking out when asked", () => {
    const t = transition("BREAK", "CLOCK_OUT", { endBreak: true });
    expect(t.ok && t.events.map((e) => e.type)).toEqual(["break_end", "clock_out"]);
  });
});

describe("workedSeconds", () => {
  const at = (s: string) => new Date(s);
  const day = [at("2026-01-05T00:00:00Z"), at("2026-01-06T00:00:00Z")] as const;
  it("subtracts breaks", () => {
    const evs = [
      { type: "clock_in" as const, at: at("2026-01-05T09:00:00Z") },
      { type: "break_start" as const, at: at("2026-01-05T12:00:00Z") },
      { type: "break_end" as const, at: at("2026-01-05T12:30:00Z") },
      { type: "clock_out" as const, at: at("2026-01-05T17:00:00Z") },
    ];
    expect(workedSeconds(evs, day[0], day[1], at("2026-01-07T00:00:00Z"))).toBe(7.5 * 3600);
  });
  it("clips overnight shifts to the day window and counts open shifts to now", () => {
    const evs = [{ type: "clock_in" as const, at: at("2026-01-05T22:00:00Z") }];
    expect(workedSeconds(evs, day[0], day[1], at("2026-01-06T03:00:00Z"))).toBe(2 * 3600);
  });
});

describe("credentials", () => {
  it("generates high-entropy unique tokens and readable badge codes", () => {
    expect(newToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newToken()).not.toBe(newToken());
    expect(newBadgeCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  });
  it("normalises typed badge codes", () => {
    expect(normalizeBadge(" ab0c-dEfg o1lI ")).toBe("AB0CDEFG0111");
  });
});

describe("webhook signing", () => {
  it("matches the Standard Webhooks construction", () => {
    const secret = Buffer.from("MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", "base64");
    const expected = createHmac("sha256", secret).update("msg_1.1700000000.{\"a\":1}").digest("base64");
    expect(signWebhook(secret, "msg_1", 1700000000, '{"a":1}')).toBe(`v1,${expected}`);
  });
  it("backs off exponentially with a cap", () => {
    expect([1, 2, 3].map(backoffSeconds)).toEqual([30, 60, 120]);
    expect(backoffSeconds(20)).toBe(6 * 3600);
  });
});
