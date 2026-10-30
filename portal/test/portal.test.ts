import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, call, createEmployee, punchLink, setup, API_KEY } from "./helpers.js";

let env: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { env = await setup(); });
afterAll(() => env.close());

describe("personal links", () => {
  it("issues a link whose token is only stored hashed", async () => {
    const e = await createEmployee(env.app, "Ada Lovelace", { external_ref: "user-42" });
    expect(e.res.status).toBe(201);
    expect(e.res.body.link_url).toMatch(/\/s#t=[A-Za-z0-9_-]{43}$/);
    const { rows } = await env.db.query(`SELECT link_token_hash FROM shift.employees WHERE id = $1`, [e.id]);
    expect(rows[0].link_token_hash).not.toContain(e.token);
    expect(rows[0].link_token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("runs a full shift with server timestamps and computes today's time", async () => {
    const e = await createEmployee(env.app, "Grace Hopper");
    expect((await call(env.app, "GET", "/api/v1/me", `Link ${e.token}`)).body.state).toBe("OUT");
    const before = Date.now();
    const inRes = await punchLink(env.app, e.token, "CLOCK_IN", randomUUID(), { client_time: "2001-01-01T00:00:00Z" });
    expect(inRes.status).toBe(201);
    expect(Math.abs(new Date(inRes.body.event.occurred_at).getTime() - before)).toBeLessThan(5000);
    expect(inRes.body.event.client_time).toBe("2001-01-01T00:00:00.000Z");
    expect((await punchLink(env.app, e.token, "BREAK_START")).body.state).toBe("BREAK");
    expect((await punchLink(env.app, e.token, "CLOCK_OUT")).body.error.code).toBe("ON_BREAK");
    const out = await punchLink(env.app, e.token, "CLOCK_OUT", randomUUID(), { end_break: true });
    expect(out.status).toBe(201);
    expect(out.body.state).toBe("OUT");
    const me = await call(env.app, "GET", "/api/v1/me", `Link ${e.token}`);
    expect(me.body.today.events.map((x: any) => x.type)).toEqual(["clock_in", "break_start", "break_end", "clock_out"]);
    expect(new Set(me.body.today.events.map((x: any) => x.session_id)).size).toBe(1);
    expect(me.body.timezone).toBe("Europe/London");
    expect(me.body.week.days).toHaveLength(7);
    expect(me.body.week.days[6].date).toBe(DateTime.now().setZone("Europe/London").toISODate());
    expect(me.body.week.worked_seconds).toBe(me.body.today.worked_seconds);
  });

  it("is idempotent and safe under concurrent taps", async () => {
    const e = await createEmployee(env.app, "Alan Turing");
    const key = randomUUID();
    const same = await Promise.all(Array.from({ length: 5 }, () => punchLink(env.app, e.token, "CLOCK_IN", key)));
    expect(new Set(same.map((r) => r.body.event.id)).size).toBe(1);
    expect(same.filter((r) => r.status === 201)).toHaveLength(1);
    expect((await punchLink(env.app, e.token, "CLOCK_OUT", key)).body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    const racing = await Promise.all(Array.from({ length: 6 }, () => punchLink(env.app, e.token, "BREAK_START")));
    expect(racing.filter((r) => r.status === 201)).toHaveLength(1);
    const { rows } = await env.db.query(`SELECT count(*)::int n FROM shift.events WHERE employee_id = $1`, [e.id]);
    expect(rows[0].n).toBe(2);
  });

  it("requires an idempotency key and a valid credential", async () => {
    const e = await createEmployee(env.app, "Mary Jackson");
    expect((await call(env.app, "POST", "/api/v1/punch", `Link ${e.token}`, { action: "CLOCK_IN" })).body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect((await call(env.app, "GET", "/api/v1/me", `Link not-a-real-token`)).status).toBe(401);
    expect((await call(env.app, "GET", "/api/v1/me")).status).toBe(401);
    expect((await call(env.app, "GET", "/api/v1/me", `Bearer ${API_KEY}`)).status).toBe(401);
  });

  it("stops old links immediately after rotation, and honours disabled links", async () => {
    const e = await createEmployee(env.app, "Katherine Johnson");
    const rotated = await admin(env.app, "POST", `/api/v1/employees/${e.id}/credentials`, { link: true });
    const fresh = new URL(rotated.body.link_url).hash.replace("#t=", "");
    expect((await call(env.app, "GET", "/api/v1/me", `Link ${e.token}`)).status).toBe(401);
    expect((await call(env.app, "GET", "/api/v1/me", `Link ${fresh}`)).status).toBe(200);
    await admin(env.app, "PATCH", `/api/v1/employees/${e.id}`, { link_enabled: false });
    expect((await call(env.app, "GET", "/api/v1/me", `Link ${fresh}`)).body.error.code).toBe("LINK_DISABLED");
    await admin(env.app, "PATCH", `/api/v1/employees/${e.id}`, { link_enabled: true, active: false });
    expect((await call(env.app, "GET", "/api/v1/me", `Link ${fresh}`)).status).toBe(401);
  });

  it("never lets one employee's link act for another", async () => {
    const a = await createEmployee(env.app, "Person A");
    const b = await createEmployee(env.app, "Person B");
    await punchLink(env.app, a.token, "CLOCK_IN");
    const meB = await call(env.app, "GET", "/api/v1/me", `Link ${b.token}`);
    expect(meB.body.employee.display_name).toBe("Person B");
    expect(meB.body.state).toBe("OUT");
  });

  it("keeps events append-only in the database", async () => {
    await expect(env.db.query(`UPDATE shift.events SET occurred_at = now()`)).rejects.toThrow(/append-only/);
    await expect(env.db.query(`DELETE FROM shift.events`)).rejects.toThrow(/append-only/);
  });
});

describe("kiosk", () => {
  it("pairs a device and punches by badge, but a badge alone is useless", async () => {
    const e = await createEmployee(env.app, "Kiosk User");
    const k = await admin(env.app, "POST", "/api/v1/kiosks", { name: "Front desk tablet" });
    expect(k.status).toBe(201);
    const ktoken = new URL(k.body.pairing_url).hash.replace("#pair=", "");
    const typed = e.badge.toLowerCase().replaceAll("-", " ");
    const who = await call(env.app, "POST", "/api/v1/kiosk/identify", `Kiosk ${ktoken}`, { badge: typed });
    expect(who.body).toMatchObject({ display_name: "Kiosk User", state: "OUT" });
    expect(who.body.today).toBeUndefined();
    const p = await call(env.app, "POST", "/api/v1/kiosk/punch", `Kiosk ${ktoken}`, { badge: e.badge, action: "CLOCK_IN" }, { "idempotency-key": randomUUID() });
    expect(p.status).toBe(201);
    expect(p.body.event.source).toBe("kiosk");
    expect(p.body.event.kiosk_id).toBe(k.body.kiosk.id);
    // Without a kiosk token a badge code cannot be used, even as a link token.
    expect((await call(env.app, "POST", "/api/v1/kiosk/identify", undefined, { badge: e.badge })).status).toBe(401);
    expect((await call(env.app, "GET", "/api/v1/me", `Link ${e.badge}`)).status).toBe(401);
    expect((await call(env.app, "POST", "/api/v1/kiosk/identify", `Kiosk ${ktoken}`, { badge: "AAAA-AAAA-AAAA" })).body.error.code).toBe("BADGE_NOT_RECOGNISED");
    // Revocation is immediate.
    await admin(env.app, "POST", `/api/v1/kiosks/${k.body.kiosk.id}/revoke`);
    expect((await call(env.app, "POST", "/api/v1/kiosk/identify", `Kiosk ${ktoken}`, { badge: e.badge })).status).toBe(401);
  });

  it("refuses badges for employees with kiosk access turned off", async () => {
    const e = await createEmployee(env.app, "Remote Only", { kiosk_enabled: false });
    const k = await admin(env.app, "POST", "/api/v1/kiosks", { name: "Tablet 2" });
    const ktoken = new URL(k.body.pairing_url).hash.replace("#pair=", "");
    expect((await call(env.app, "POST", "/api/v1/kiosk/identify", `Kiosk ${ktoken}`, { badge: e.badge })).status).toBe(404);
  });
});

describe("integration surface", () => {
  it("requires the API key", async () => {
    expect((await call(env.app, "GET", "/api/v1/employees")).status).toBe(401);
    expect((await call(env.app, "GET", "/api/v1/events", "Bearer wrong")).status).toBe(401);
  });

  it("pages through the event feed with a cursor", async () => {
    const page1 = await admin(env.app, "GET", "/api/v1/events?limit=3");
    expect(page1.body.events).toHaveLength(3);
    const page2 = await admin(env.app, "GET", `/api/v1/events?after=${page1.body.next_cursor}&limit=500`);
    const seqs = [...page1.body.events, ...page2.body.events].map((e: any) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    const done = await admin(env.app, "GET", `/api/v1/events?after=${page2.body.next_cursor}`);
    expect(done.body.events).toEqual([]);
    expect(page1.body.events[0].employee).toHaveProperty("external_ref");
    const latest = await admin(env.app, "GET", "/api/v1/events?order=desc&limit=2");
    expect(latest.body.events[0].seq).toBeGreaterThan(latest.body.events[1].seq);
  });

  it("produces a timesheet as JSON and formula-safe CSV", async () => {
    const e = await createEmployee(env.app, "=HYPERLINK(\"x\")");
    // A historical 7.5 h shift with a 30 min break (London is on GMT in January).
    for (const [type, at, state] of [["clock_in", "09:00", "IN"], ["break_start", "12:00", "BREAK"], ["break_end", "12:30", "IN"], ["clock_out", "17:00", "OUT"]]) {
      await env.db.query(
        `INSERT INTO shift.events (employee_id, session_id, event_type, occurred_at, state_after, source, idempotency_key, action)
         VALUES ($1, '00000000-0000-4000-8000-000000000001', $2, $3, $4, 'api', gen_random_uuid(), 'fixture')`,
        [e.id, type, `2026-01-15T${at}:00Z`, state],
      );
    }
    const json = await admin(env.app, "GET", `/api/v1/timesheet?from=2026-01-15&to=2026-01-15`);
    expect(json.body.timezone).toBe("Europe/London");
    expect(json.body.lines).toEqual([expect.objectContaining({ employee_id: e.id, date: "2026-01-15", worked_seconds: 7.5 * 3600 })]);
    const csv = await admin(env.app, "GET", `/api/v1/timesheet?from=2026-01-15&to=2026-01-15&format=csv`);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.raw).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv.raw).toContain(",450.00,Europe/London");
  });

  it("gives a live overview of who is on shift and today's time", async () => {
    const on = await createEmployee(env.app, "Overview On");
    const brk = await createEmployee(env.app, "Overview Break");
    await punchLink(env.app, on.token, "CLOCK_IN");
    await punchLink(env.app, brk.token, "CLOCK_IN");
    await punchLink(env.app, brk.token, "BREAK_START");
    const res = await admin(env.app, "GET", "/api/v1/overview");
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(res.body.people.map((p: any) => [p.display_name, p]));
    expect(byName["Overview On"]).toMatchObject({ state: "IN", today_worked_seconds: expect.any(Number) });
    expect(byName["Overview On"].since).not.toBeNull();
    expect(byName["Overview Break"].state).toBe("BREAK");
    expect(res.body.counts.IN).toBeGreaterThanOrEqual(1);
    expect(res.body.counts.BREAK).toBeGreaterThanOrEqual(1);
    expect(res.body.today.punches).toBeGreaterThanOrEqual(3);
    expect(res.body.timezone).toBe("Europe/London");
    expect((await call(env.app, "GET", "/api/v1/overview")).status).toBe(401);
    expect((await call(env.app, "GET", "/api/v1/overview", `Link ${on.token}`)).status).toBe(401);
  });

  it("serves the OpenAPI contract", async () => {
    const res = await call(env.app, "GET", "/api/v1/openapi.yaml");
    expect(res.raw).toContain("openapi: 3.1.0");
  });
});

describe("static frontend", () => {
  it("serves SPA routes with a strict CSP and blocks path traversal", async () => {
    const { buildApp } = await import("../src/server/app.js");
    const { mkdtemp, writeFile, mkdir } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const root = await mkdtemp(path.join(os.tmpdir(), "web-"));
    await writeFile(path.join(root, "index.html"), "<!doctype html><title>Shift</title>");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets", "a.js"), "console.log(1)");
    const app = await buildApp(env.db, env.config, { webRoot: root });
    const page = await app.inject({ url: "/kiosk" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(page.headers["permissions-policy"]).toContain("camera=(self)");
    expect((await app.inject({ url: "/s" })).headers["permissions-policy"]).toContain("camera=()");
    expect((await app.inject({ url: "/assets/a.js" })).headers["cache-control"]).toContain("immutable");
    expect((await app.inject({ url: "/..%2F..%2Fetc%2Fpasswd" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/api/v1/me" })).statusCode).toBe(401);
    await app.close();
  });
});
