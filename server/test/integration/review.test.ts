import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clock, login, setupTestEnv, type Client, type TestEnv } from "../helpers.js";

let env: TestEnv;
let admin: Client;
let sup: Client;
let ada: Client;
let pid: string;
beforeAll(async () => {
  env = await setupTestEnv();
  pid = env.ids.projectId;
  admin = await login(env.app, "admin@example.com");
  sup = await login(env.app, "supervisor@example.com");
  ada = await login(env.app, "ada@example.com");
});
afterAll(() => env.close());

describe("correction workflow", () => {
  it("lists the pending seeded correction for the reviewer", async () => {
    const inbox = await sup.get(`/v1/admin/correction-requests?project_id=${pid}`);
    expect(inbox.status).toBe(200);
    expect(inbox.body.corrections).toHaveLength(1);
    expect(inbox.body.corrections[0].requester_name).toBe("Ada Lovelace");
  });

  it("prevents a second pending request on the same session", async () => {
    const c = (await sup.get(`/v1/admin/correction-requests?project_id=${pid}`)).body.corrections[0];
    const dup = await ada.post("/v1/correction-requests", { session_id: c.session_id, requested_change: { issue: "other" }, explanation: "Another try at this" });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("CORRECTION_ALREADY_PENDING");
  });

  it("requires a reason and the current version to decide", async () => {
    const c = (await sup.get(`/v1/admin/correction-requests?project_id=${pid}`)).body.corrections[0];
    expect((await sup.post(`/v1/admin/correction-requests/${c.id}/decision`, { decision: "approve", reason: "", version: c.version })).status).toBe(400);
    const stale = await sup.post(`/v1/admin/correction-requests/${c.id}/decision`, { decision: "approve", reason: "Looks right", version: c.version + 5 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("VERSION_CONFLICT");
  });

  it("approves by appending an adjustment and preserves the original events", async () => {
    const c = (await sup.get(`/v1/admin/correction-requests?project_id=${pid}`)).body.corrections[0];
    const before = await sup.get(`/v1/admin/sessions/${c.session_id}`);
    const res = await sup.post(`/v1/admin/correction-requests/${c.id}/decision`, { decision: "approve", reason: "Confirmed with site lead", version: c.version });
    expect(res.status).toBe(200);
    expect(res.body.correction.status).toBe("approved");
    expect(res.body.adjustment_id).toBeTruthy();
    const after = await sup.get(`/v1/admin/sessions/${c.session_id}`);
    expect(after.body.events).toEqual(before.body.events);
    expect(after.body.raw).toEqual(before.body.raw);
    expect(after.body.effective.start).toBe(c.requested_change.clock_in_at.replace(/\.\d+Z$|Z$/, ".000Z"));
    expect(after.body.effective.work_seconds).toBeGreaterThan(before.body.effective.work_seconds);
    expect(after.body.adjustments).toHaveLength(1);
    expect(after.body.audit.map((a: { action: string }) => a.action)).toEqual(expect.arrayContaining(["correction.submitted", "correction.approved", "adjustment.created"]));
    // Second decision on the same request is a conflict.
    const again = await sup.post(`/v1/admin/correction-requests/${c.id}/decision`, { decision: "reject", reason: "changed mind", version: c.version + 1 });
    expect(again.status).toBe(409);
    // Tutor sees the decision and is notified.
    const mine = await ada.get(`/v1/me/correction-requests?project_id=${pid}`);
    expect(mine.body.corrections[0].status).toBe("approved");
    expect(mine.body.corrections[0].decision_reason).toBe("Confirmed with site lead");
    const notes = await ada.get(`/v1/me/notifications?project_id=${pid}`);
    expect(notes.body.notifications.some((n: { event_type: string }) => n.event_type === "correction_decided")).toBe(true);
  });

  it("rejection leaves the record unchanged; tutors can withdraw pending requests", async () => {
    const out = await clock(ada, pid, "CLOCK_IN");
    await clock(ada, pid, "CLOCK_OUT");
    const req = await ada.post("/v1/correction-requests", {
      session_id: out.body.session_id,
      requested_change: { issue: "wrong_clock_in", clock_in_at: new Date(Date.now() - 3600_000).toISOString() },
      explanation: "Started an hour earlier",
    });
    expect(req.status).toBe(201);
    expect(req.body.status).toBe("pending");
    const before = await sup.get(`/v1/admin/sessions/${out.body.session_id}`);
    const rej = await sup.post(`/v1/admin/correction-requests/${req.body.id}/decision`, { decision: "reject", reason: "No evidence of early start", version: req.body.version });
    expect(rej.status).toBe(200);
    const after = await sup.get(`/v1/admin/sessions/${out.body.session_id}`);
    expect(after.body.effective).toEqual(before.body.effective);

    const req2 = await ada.post("/v1/correction-requests", { session_id: out.body.session_id, requested_change: { issue: "other" }, explanation: "Never mind, testing withdraw" });
    expect((await ada.post(`/v1/me/correction-requests/${req2.body.id}/withdraw`)).body.status).toBe("withdrawn");
  });

  it("rejects corrections requesting future or inverted times", async () => {
    const { rows } = await env.db.query(`SELECT id FROM work_sessions WHERE tutor_id = $1 AND state='closed' ORDER BY started_at LIMIT 1`, [env.ids.tutors.ada]);
    const future = await ada.post("/v1/correction-requests", { session_id: rows[0].id, requested_change: { issue: "wrong_clock_out", clock_out_at: new Date(Date.now() + 86400_000).toISOString() }, explanation: "From the future" });
    expect(future.status).toBe(422);
    const missing = await ada.post("/v1/correction-requests", { session_id: rows[0].id, requested_change: { issue: "wrong_clock_out" }, explanation: "No time given" });
    expect(missing.body.error.code).toBe("MISSING_REQUESTED_TIME");
  });
});

describe("manual adjustments", () => {
  it("resolves a missed clock-out by closing the session with an attributed event plus adjustment", async () => {
    const { rows } = await env.db.query(`SELECT id, started_at FROM work_sessions WHERE tutor_id = $1 AND state = 'in'`, [env.ids.tutors.mary]);
    const sid = rows[0].id;
    const roster = await sup.get(`/v1/admin/roster?project_id=${pid}`);
    const mary = roster.body.tutors.find((t: { tutor: { name: string } }) => t.tutor.name === "Mary Jackson");
    expect(mary.alerts.map((a: { code: string }) => a.code)).toContain("missed_clock_out");

    const end = new Date(new Date(rows[0].started_at).getTime() + 6 * 3600_000).toISOString();
    const input = { session_id: sid, adjustment_type: "replace_interpretation", effective_end: end, reason: "Tutor confirmed leaving at 3pm" };
    const preview = await sup.post("/v1/admin/adjustments/preview", input);
    expect(preview.status).toBe(200);
    expect(preview.body.closes_open_session).toBe(true);
    expect(preview.body.after.work_seconds).toBe(6 * 3600);
    const missingReason = await sup.post("/v1/admin/adjustments", { ...input, reason: "" });
    expect(missingReason.status).toBe(400);
    const res = await sup.post("/v1/admin/adjustments", input);
    expect(res.status).toBe(201);
    const detail = await sup.get(`/v1/admin/sessions/${sid}`);
    expect(detail.body.state).toBe("closed");
    expect(detail.body.effective.work_seconds).toBe(6 * 3600);
    const closeEvent = detail.body.events.find((e: { event_type: string }) => e.event_type === "clock_out");
    expect(closeEvent.source).toBe("admin_adjustment");
    expect(closeEvent.actor.name).toBe("Sam Supervisor");
    // Raw time still shows the true (long) open span — nothing was back-dated.
    expect(detail.body.raw.work_seconds).toBeGreaterThan(6 * 3600);
    // Mary can clock in again.
    const mary2 = await login(env.app, "mary@example.com");
    expect((await clock(mary2, pid, "CLOCK_IN")).status).toBe(201);
  });

  it("supports add-time, supersede and void with full history", async () => {
    const { rows } = await env.db.query(`SELECT id FROM work_sessions WHERE tutor_id = $1 AND state='closed' ORDER BY started_at LIMIT 1`, [env.ids.tutors.ada]);
    const sid = rows[0].id;
    const base = (await sup.get(`/v1/admin/sessions/${sid}`)).body.effective.work_seconds;
    const add = await sup.post("/v1/admin/adjustments", { session_id: sid, adjustment_type: "add_time", delta_minutes: 30, reason: "Prep time approved" });
    expect((await sup.get(`/v1/admin/sessions/${sid}`)).body.effective.work_seconds).toBe(base + 1800);
    await sup.post("/v1/admin/adjustments", { session_id: sid, adjustment_type: "add_time", delta_minutes: 15, reason: "Corrected prep time", supersedes_adjustment_id: add.body.adjustment_id });
    const d = (await sup.get(`/v1/admin/sessions/${sid}`)).body;
    expect(d.effective.work_seconds).toBe(base + 900);
    expect(d.adjustments.find((a: { id: string }) => a.id === add.body.adjustment_id).superseded).toBe(true);
    const dupe = await sup.post("/v1/admin/adjustments", { session_id: sid, adjustment_type: "add_time", delta_minutes: 5, reason: "x again", supersedes_adjustment_id: add.body.adjustment_id });
    expect(dupe.body.error.code).toBe("ALREADY_SUPERSEDED");
    await sup.post("/v1/admin/adjustments", { session_id: sid, adjustment_type: "void_session", reason: "Duplicate entry" });
    expect((await sup.get(`/v1/admin/sessions/${sid}`)).body.effective.work_seconds).toBe(0);
  });

  it("prevents adjustments outside the supervisor's team", async () => {
    const { rows } = await env.db.query(`SELECT id FROM work_sessions WHERE tutor_id = $1 LIMIT 1`, [env.ids.tutors.alan]);
    const res = await sup.post("/v1/admin/adjustments", { session_id: rows[0].id, adjustment_type: "add_time", delta_minutes: 10, reason: "Not my team" });
    expect(res.status).toBe(403);
    expect((await admin.post("/v1/admin/adjustments/preview", { session_id: rows[0].id, adjustment_type: "add_time", delta_minutes: 10, reason: "Admin can" })).status).toBe(200);
  });
});
