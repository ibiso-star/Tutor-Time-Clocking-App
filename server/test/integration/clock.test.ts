import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clock, login, setupTestEnv, type Client, type TestEnv } from "../helpers.js";

let env: TestEnv;
let ada: Client;
let pid: string;

beforeAll(async () => {
  env = await setupTestEnv();
  pid = env.ids.projectId;
  ada = await login(env.app, "ada@example.com");
});
afterAll(() => env.close());

describe("clock commands", () => {
  it("starts clocked out with no active session", async () => {
    const res = await ada.get(`/v1/me/time-status?project_id=${pid}`);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("OUT");
    expect(res.body.session).toBeNull();
  });

  it("requires an idempotency key", async () => {
    const res = await ada.post("/v1/clock-events", { project_id: pid, event_type: "CLOCK_IN" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("uses server time, not the client's, as the official timestamp", async () => {
    const before = Date.now();
    const res = await clock(ada, pid, "CLOCK_IN", { client_captured_at: "2001-01-01T00:00:00Z" });
    expect(res.status).toBe(201);
    expect(res.body.session_state).toBe("IN");
    expect(res.body.replayed).toBe(false);
    const ts = new Date(res.body.server_timestamp).getTime();
    expect(ts).toBeGreaterThanOrEqual(before - 1000);
    expect(ts).toBeLessThanOrEqual(Date.now() + 1000);
    expect(res.body.server_timestamp.endsWith("Z")).toBe(true);
    const { rows } = await env.db.query(`SELECT client_captured_at, occurred_at FROM clock_events WHERE id = $1`, [res.body.event_id]);
    expect(rows[0].client_captured_at.toISOString()).toBe("2001-01-01T00:00:00.000Z");
    expect(res.body.status.state).toBe("IN");
  });

  it("rejects invalid transitions without creating events", async () => {
    const count = async () => (await env.db.query(`SELECT count(*)::int n FROM clock_events WHERE actor_id = $1`, [env.ids.tutors.ada])).rows[0].n;
    const n = await count();
    const res = await clock(ada, pid, "CLOCK_IN");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ALREADY_CLOCKED_IN");
    expect(res.body.error.message).toMatch(/already clocked in/i);
    const end = await clock(ada, pid, "BREAK_END");
    expect(end.body.error.code).toBe("NOT_ON_BREAK");
    expect(await count()).toBe(n);
  });

  it("replays a repeated key as one event and rejects key reuse for another action", async () => {
    const key = randomUUID();
    const first = await clock(ada, pid, "BREAK_START", {}, key);
    expect(first.status).toBe(201);
    const again = await clock(ada, pid, "BREAK_START", {}, key);
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(again.body.event_id).toBe(first.body.event_id);
    expect(again.body.server_timestamp).toBe(first.body.server_timestamp);
    const reuse = await clock(ada, pid, "BREAK_END", {}, key);
    expect(reuse.status).toBe(409);
    expect(reuse.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("requires ending a break before clocking out (no silent inference)", async () => {
    const res = await clock(ada, pid, "CLOCK_OUT", { end_open_break: true });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ON_BREAK");
  });

  it("completes the break and clock-out, excluding breaks from worked time", async () => {
    expect((await clock(ada, pid, "BREAK_END")).status).toBe(201);
    const out = await clock(ada, pid, "CLOCK_OUT");
    expect(out.status).toBe(201);
    expect(out.body.session_state).toBe("OUT");
    const detail = await ada.get(`/v1/me/time-entries/${out.body.session_id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.events.map((e: { event_type: string }) => e.event_type)).toEqual(["clock_in", "break_start", "break_end", "clock_out"]);
    expect(detail.body.raw.work_seconds).toBeLessThanOrEqual(detail.body.raw.break_seconds + 60);
    expect(out.body.status.today.sessions).toBeGreaterThanOrEqual(1);
  });

  it("records an explicit combined end-break-and-clock-out when policy allows", async () => {
    const admin = await login(env.app, "admin@example.com");
    const s = await admin.get(`/v1/admin/projects/${pid}/settings`);
    const patched = await admin.patch(`/v1/admin/projects/${pid}/settings`, {
      version: s.body.version,
      settings: { ...s.body.settings, breaks: { ...s.body.settings.breaks, clock_out_while_on_break: "allow_combined" } },
    });
    expect(patched.status).toBe(200);
    await clock(ada, pid, "CLOCK_IN");
    await clock(ada, pid, "BREAK_START");
    const out = await clock(ada, pid, "CLOCK_OUT", { end_open_break: true });
    expect(out.status).toBe(201);
    const detail = await ada.get(`/v1/me/time-entries/${out.body.session_id}`);
    expect(detail.body.events.map((e: { event_type: string }) => e.event_type)).toEqual(["clock_in", "break_start", "break_end", "clock_out"]);
    expect(detail.body.flags.filter((f: { code: string }) => f.code === "anomaly")).toEqual([]);
  });

  it("allows exactly one clock-in under concurrent requests with different keys", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => clock(ada, pid, "CLOCK_IN")));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);
    const { rows } = await env.db.query(`SELECT count(*)::int n FROM work_sessions WHERE tutor_id = $1 AND state <> 'closed'`, [env.ids.tutors.ada]);
    expect(rows[0].n).toBe(1);
  });

  it("produces one event for concurrent retries of the same key", async () => {
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 6 }, () => clock(ada, pid, "CLOCK_OUT", {}, key)));
    expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.event_id)).size).toBe(1);
    expect(results.filter((r) => r.body.replayed === false)).toHaveLength(1);
    const { rows } = await env.db.query(`SELECT count(*)::int n FROM clock_events WHERE idempotency_key = $1`, [key]);
    expect(rows[0].n).toBe(1);
  });

  it("writes an audit row atomically with every clock event", async () => {
    const { rows } = await env.db.query(
      `SELECT count(*)::int n FROM clock_events e WHERE e.actor_id = $1 AND e.source = 'web'
         AND NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a.target_id = e.id AND a.action = 'clock.' || e.event_type)`,
      [env.ids.tutors.ada],
    );
    expect(rows[0].n).toBe(0);
  });

  it("enforces append-only storage at the database level", async () => {
    await expect(env.db.query(`UPDATE clock_events SET occurred_at = now()`)).rejects.toThrow(/append-only/);
    await expect(env.db.query(`DELETE FROM clock_events`)).rejects.toThrow(/append-only/);
    await expect(env.db.query(`DELETE FROM audit_logs`)).rejects.toThrow(/append-only/);
    await expect(env.db.query(`UPDATE time_adjustments SET reason = 'x'`)).resolves.toBeDefined(); // no rows yet is fine
  });

  it("shows an actionable error for clock-out with no open session", async () => {
    const res = await clock(ada, pid, "CLOCK_OUT");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("NOT_CLOCKED_IN");
    expect(res.body.error.details.current_state).toBe("OUT");
  });
});

describe("location policy", () => {
  it("blocks clock-in outside a block-mode geofence and stores coordinates only when enabled", async () => {
    const admin = await login(env.app, "admin@example.com");
    const grace = await login(env.app, "alan@example.com");
    // Without location controls, geofence configuration is refused.
    const refused = await admin.post("/v1/admin/locations", { project_id: pid, name: "Field site", latitude: 34.05, longitude: -118.25, geofence_radius_m: 100, geofence_mode: "block" });
    expect(refused.status).toBe(422);
    const s = await admin.get(`/v1/admin/projects/${pid}/settings`);
    await admin.patch(`/v1/admin/projects/${pid}/settings`, { version: s.body.version, settings: { ...s.body.settings, location_controls: { enabled: true } } });
    const loc = await admin.post("/v1/admin/locations", { project_id: pid, name: "Field site", latitude: 34.05, longitude: -118.25, geofence_radius_m: 100, geofence_mode: "block" });
    expect(loc.status).toBe(201);

    const outside = await clock(grace, pid, "CLOCK_IN", { location_id: loc.body.id, coords: { lat: 34.1, lng: -118.25, accuracy_m: 10 } });
    expect(outside.status).toBe(422);
    expect(outside.body.error.code).toBe("OUTSIDE_GEOFENCE");
    const missing = await clock(grace, pid, "CLOCK_IN", { location_id: loc.body.id });
    expect(missing.body.error.code).toBe("LOCATION_UNAVAILABLE");
    const inside = await clock(grace, pid, "CLOCK_IN", { location_id: loc.body.id, coords: { lat: 34.0503, lng: -118.2501, accuracy_m: 10 } });
    expect(inside.status).toBe(201);
    const { rows } = await env.db.query(`SELECT location_lat, metadata FROM clock_events WHERE id = $1`, [inside.body.event_id]);
    expect(Number(rows[0].location_lat)).toBeCloseTo(34.0503);
    expect(rows[0].metadata.geofence).toBe("inside");
  });
});
