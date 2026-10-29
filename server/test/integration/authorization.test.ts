import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clock, login, setupTestEnv, type TestEnv } from "../helpers.js";

let env: TestEnv;
beforeAll(async () => { env = await setupTestEnv(); });
afterAll(() => env.close());

async function sessionOf(tutorId: string) {
  const { rows } = await env.db.query(`SELECT id FROM work_sessions WHERE tutor_id = $1 ORDER BY started_at DESC LIMIT 1`, [tutorId]);
  return rows[0].id as string;
}

describe("role and project scoping", () => {
  it("blocks tutors from admin endpoints", async () => {
    const ada = await login(env.app, "ada@example.com");
    expect((await ada.get(`/v1/admin/roster?project_id=${env.ids.projectId}`)).status).toBe(403);
    expect((await ada.get(`/v1/admin/time-entries?project_id=${env.ids.projectId}`)).status).toBe(403);
    expect((await ada.post(`/v1/admin/exports`, { project_id: env.ids.projectId, format: "csv", from: "2026-01-01", to: "2026-01-02" })).status).toBe(403);
  });

  it("hides other tutors' sessions from a tutor (object-level authorization)", async () => {
    const ada = await login(env.app, "ada@example.com");
    const alanSession = await sessionOf(env.ids.tutors.alan);
    expect((await ada.get(`/v1/me/time-entries/${alanSession}`)).status).toBe(404);
    const res = await ada.post("/v1/correction-requests", {
      session_id: alanSession,
      requested_change: { issue: "other" },
      explanation: "Trying to edit someone else's record",
    });
    expect(res.status).toBe(404);
  });

  it("limits a team-scoped supervisor to their team", async () => {
    const sup = await login(env.app, "supervisor@example.com");
    const roster = await sup.get(`/v1/admin/roster?project_id=${env.ids.projectId}`);
    expect(roster.status).toBe(200);
    const names = roster.body.tutors.map((t: { tutor: { name: string } }) => t.tutor.name);
    expect(names).toContain("Ada Lovelace");
    expect(names).not.toContain("Alan Turing");
    expect((await sup.get(`/v1/admin/sessions/${await sessionOf(env.ids.tutors.alan)}`)).status).toBe(403);
    expect((await sup.get(`/v1/admin/sessions/${await sessionOf(env.ids.tutors.ada)}`)).status).toBe(200);
    const entries = await sup.get(`/v1/admin/time-entries?project_id=${env.ids.projectId}`);
    expect(entries.body.entries.every((e: { tutor: { name: string } }) => e.tutor.name !== "Alan Turing")).toBe(true);
  });

  it("applies team scope to correction detail and shift management", async () => {
    const sup = await login(env.app, "supervisor@example.com");
    const alan = await login(env.app, "alan@example.com");
    const { rows } = await env.db.query(`SELECT id FROM work_sessions WHERE tutor_id = $1 AND state = 'closed' LIMIT 1`, [env.ids.tutors.alan]);
    const req = await alan.post("/v1/correction-requests", { session_id: rows[0].id, requested_change: { issue: "other" }, explanation: "South team request" });
    expect(req.status).toBe(201);
    expect((await sup.get(`/v1/admin/correction-requests/${req.body.id}`)).status).toBe(403);
    expect((await sup.post(`/v1/admin/correction-requests/${req.body.id}/decision`, { decision: "approve", reason: "Not my team", version: 1 })).status).toBe(403);
    const start = new Date(Date.now() + 86400_000).toISOString();
    const end = new Date(Date.now() + 90000_000).toISOString();
    const shift = await sup.post("/v1/admin/shifts", { project_id: env.ids.projectId, tutor_id: env.ids.tutors.alan, label: "x", scheduled_start: start, scheduled_end: end });
    expect(shift.status).toBe(403);
    const own = await sup.post("/v1/admin/shifts", { project_id: env.ids.projectId, tutor_id: env.ids.tutors.grace, label: "Prep", scheduled_start: start, scheduled_end: end });
    expect(own.status).toBe(201);
  });

  it("restricts settings changes to admins", async () => {
    const sup = await login(env.app, "supervisor@example.com");
    const s = await sup.get(`/v1/admin/projects/${env.ids.projectId}/settings`);
    expect(s.body.can_edit).toBe(false);
    expect((await sup.patch(`/v1/admin/projects/${env.ids.projectId}/settings`, { version: s.body.version, name: "Hijacked" })).status).toBe(403);
  });

  it("rejects access to projects the user is not a member of", async () => {
    const admin = await login(env.app, "admin@example.com");
    const created = await admin.post("/v1/admin/projects", { name: "Other Org", timezone: "Europe/London" });
    expect(created.status).toBe(201);
    const ada = await login(env.app, "ada@example.com");
    expect((await ada.get(`/v1/me/time-status?project_id=${created.body.id}`)).status).toBe(403);
    expect((await clock(ada, created.body.id, "CLOCK_IN")).status).toBe(403);
  });

  it("only lets tutors record clock events", async () => {
    const sup = await login(env.app, "supervisor@example.com");
    const res = await clock(sup, env.ids.projectId, "CLOCK_IN");
    expect(res.status).toBe(403);
  });

  it("revokes access immediately when an account is deactivated, preserving its records", async () => {
    const admin = await login(env.app, "admin@example.com");
    const mary = await login(env.app, "mary@example.com");
    const people = await admin.get(`/v1/admin/people?project_id=${env.ids.projectId}`);
    const m = people.body.people.find((p: { email: string }) => p.email === "mary@example.com");
    expect(m.has_open_session).toBe(true);
    const res = await admin.patch(`/v1/admin/memberships/${m.membership_id}`, { deactivate_account: true, reason: "Left the program" });
    expect(res.status).toBe(200);
    expect((await mary.get("/v1/me")).status).toBe(401);
    const { rows } = await env.db.query(`SELECT count(*)::int n FROM work_sessions WHERE tutor_id = $1`, [env.ids.tutors.mary]);
    expect(rows[0].n).toBeGreaterThan(0);
    const roster = await admin.get(`/v1/admin/time-entries?project_id=${env.ids.projectId}&tutor_id=${env.ids.tutors.mary}&from=2020-01-01&to=2020-01-02`);
    expect(roster.status).toBe(200);
  });
});
