import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { login, setupTestEnv, type Client, type TestEnv } from "../helpers.js";
import { DEMO_TZ } from "../../src/seed.js";
import { runAlertSweep } from "../../src/services/notifications.js";

let env: TestEnv;
let admin: Client;
let pid: string;
const today = () => DateTime.now().setZone(DEMO_TZ).toISODate()!;
const daysAgo = (n: number) => DateTime.now().setZone(DEMO_TZ).minus({ days: n }).toISODate()!;

beforeAll(async () => {
  env = await setupTestEnv();
  pid = env.ids.projectId;
  admin = await login(env.app, "admin@example.com");
});
afterAll(() => env.close());

function parseCsv(text: string) {
  const [header, ...lines] = text.trim().split("\r\n");
  const cols = header!.split(",");
  return lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [cols[i], v])));
}

describe("exports", () => {
  it("reconciles CSV totals with the preview and the canonical session calculation", async () => {
    const filters = { project_id: pid, format: "csv", from: daysAgo(14), to: daysAgo(1) };
    const preview = await admin.post("/v1/admin/exports/preview", filters);
    expect(preview.status).toBe(200);
    expect(preview.body.rounding_rule).toBe("Exact (no rounding)");
    const job = await admin.post("/v1/admin/exports", filters);
    expect(job.status).toBe(201);
    expect(job.body.status).toBe("completed");
    expect(job.body.record_version).toBe(preview.body.record_version);
    expect(job.body.checksum).toMatch(/^[0-9a-f]{64}$/);
    const file = await admin.get(`/v1/admin/exports/${job.body.id}/download`);
    expect(file.status).toBe(200);
    expect(file.headers["content-disposition"]).toMatch(/attachment; filename="timesheet_/);
    const rows = parseCsv(file.raw);
    const closed = rows.filter((r) => r.status !== "open");
    const exactSum = closed.reduce((s, r) => s + Number(r.exact_minutes), 0);
    expect(exactSum * 60).toBeCloseTo(preview.body.totals.effective_seconds, -1);
    expect(rows.every((r) => r.timezone === DEMO_TZ && r.rounding_rule === "Exact (no rounding)")).toBe(true);
    // Admin session list over the same period agrees.
    const entries = await admin.get(`/v1/admin/time-entries?project_id=${pid}&from=${daysAgo(14)}&to=${daysAgo(1)}&status=closed&limit=200`);
    expect(entries.body.total_seconds).toBe(preview.body.totals.effective_seconds);
    // Downloads are audited.
    const { rows: audit } = await env.db.query(`SELECT count(*)::int n FROM audit_logs WHERE action = 'export.downloaded' AND target_id = $1`, [job.body.id]);
    expect(audit[0].n).toBe(1);
  });

  it("applies configured rounding and labels the rule", async () => {
    const s = await admin.get(`/v1/admin/projects/${pid}/settings`);
    await admin.patch(`/v1/admin/projects/${pid}/settings`, { version: s.body.version, settings: { ...s.body.settings, rounding: { mode: "nearest", increment_minutes: 15 } } });
    const job = await admin.post("/v1/admin/exports", { project_id: pid, format: "csv", from: daysAgo(14), to: daysAgo(1) });
    const rows = parseCsv((await admin.get(`/v1/admin/exports/${job.body.id}/download`)).raw).filter((r) => r.status === "closed");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => Number(r.rounded_minutes) % 15 === 0)).toBe(true);
    expect(rows[0]!.rounding_rule).toBe("Nearest 15 min per session");
    const s2 = await admin.get(`/v1/admin/projects/${pid}/settings`);
    await admin.patch(`/v1/admin/projects/${pid}/settings`, { version: s2.body.version, settings: { ...s2.body.settings, rounding: { mode: "none", increment_minutes: 1 } } });
  });

  it("escapes spreadsheet formulas from user-controlled text", async () => {
    await env.db.query(`UPDATE users SET display_name = '=HYPERLINK("http://evil")' WHERE id = $1`, [env.ids.tutors.alan]);
    const job = await admin.post("/v1/admin/exports", { project_id: pid, format: "csv", from: daysAgo(14), to: daysAgo(1), tutor_ids: [env.ids.tutors.alan] });
    const raw = (await admin.get(`/v1/admin/exports/${job.body.id}/download`)).raw;
    expect(raw).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(raw.split("\r\n").slice(1).some((l) => l.startsWith("="))).toBe(false);
    await env.db.query(`UPDATE users SET display_name = 'Alan Turing' WHERE id = $1`, [env.ids.tutors.alan]);
  });

  it("produces a PDF and lists open sessions without counting them", async () => {
    const job = await admin.post("/v1/admin/exports", { project_id: pid, format: "pdf", from: daysAgo(2), to: today() });
    expect(job.status).toBe(201);
    const pdf = await env.app.inject({ method: "GET", url: `/v1/admin/exports/${job.body.id}/download`, headers: { cookie: (await loginCookie()) } });
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe("%PDF");
    const preview = await admin.post("/v1/admin/exports/preview", { project_id: pid, format: "csv", from: daysAgo(2), to: today() });
    expect(preview.body.totals.open_sessions_excluded).toBeGreaterThanOrEqual(2);
  });

  it("marks an export as potentially superseded after a later adjustment", async () => {
    const job = await admin.post("/v1/admin/exports", { project_id: pid, format: "csv", from: daysAgo(14), to: daysAgo(1) });
    expect(job.body.potentially_superseded).toBe(false);
    const { rows } = await env.db.query(
      `SELECT id FROM work_sessions WHERE project_id = $1 AND state = 'closed' AND started_at < now() - interval '2 days' ORDER BY started_at DESC LIMIT 1`,
      [pid],
    );
    const preview = await admin.post("/v1/admin/adjustments/preview", { session_id: rows[0].id, adjustment_type: "add_time", delta_minutes: 10, reason: "late fix" });
    expect(preview.body.affected_exports.map((e: { id: string }) => e.id)).toContain(job.body.id);
    await admin.post("/v1/admin/adjustments", { session_id: rows[0].id, adjustment_type: "add_time", delta_minutes: 10, reason: "late fix" });
    const after = await admin.get(`/v1/admin/exports/${job.body.id}`);
    expect(after.body.potentially_superseded).toBe(true);
  });

  it("validates the range", async () => {
    const res = await admin.post("/v1/admin/exports", { project_id: pid, format: "csv", from: "2026-01-10", to: "2026-01-01" });
    expect(res.status).toBe(400);
    const big = await admin.post("/v1/admin/exports/preview", { project_id: pid, format: "csv", from: "2025-01-01", to: "2026-01-01" });
    expect(big.body.error.code).toBe("RANGE_TOO_LARGE");
  });
});

describe("settings", () => {
  it("uses optimistic versioning and audits before/after", async () => {
    const s = await admin.get(`/v1/admin/projects/${pid}/settings`);
    const ok = await admin.patch(`/v1/admin/projects/${pid}/settings`, { version: s.body.version, settings: { ...s.body.settings, max_shift_minutes: 480 }, reason: "Policy update" });
    expect(ok.status).toBe(200);
    const stale = await admin.patch(`/v1/admin/projects/${pid}/settings`, { version: s.body.version, settings: s.body.settings });
    expect(stale.status).toBe(409);
    const { rows } = await env.db.query(`SELECT before, after, reason FROM audit_logs WHERE action = 'project.settings_updated' ORDER BY occurred_at DESC LIMIT 1`);
    expect(rows[0].before.settings.max_shift_minutes).toBe(600);
    expect(rows[0].after.settings.max_shift_minutes).toBe(480);
    expect(rows[0].reason).toBe("Policy update");
  });

  it("rejects phase-gated features and fixed-offset timezones", async () => {
    const s = await admin.get(`/v1/admin/projects/${pid}/settings`);
    const photo = await admin.patch(`/v1/admin/projects/${pid}/settings`, { version: s.body.version, settings: { ...s.body.settings, photo_capture: { enabled: true } } });
    expect(photo.status).toBe(400);
    const tz = await admin.patch(`/v1/admin/projects/${pid}/settings`, { version: s.body.version, timezone: "UTC+3" });
    expect(tz.status).toBe(400);
  });

  it("does not rewrite historical instants when the timezone changes", async () => {
    const { rows: before } = await env.db.query(`SELECT occurred_at FROM clock_events ORDER BY id LIMIT 5`);
    const s = await admin.get(`/v1/admin/projects/${pid}/settings`);
    expect((await admin.patch(`/v1/admin/projects/${pid}/settings`, { version: s.body.version, timezone: "America/New_York" })).status).toBe(200);
    const { rows: after } = await env.db.query(`SELECT occurred_at FROM clock_events ORDER BY id LIMIT 5`);
    expect(after).toEqual(before);
  });
});

describe("alerts", () => {
  it("raises missed clock-out alerts once per session and recipient (deduplicated)", async () => {
    const first = await runAlertSweep(env.db);
    expect(first).toBeGreaterThan(0);
    const second = await runAlertSweep(env.db);
    expect(second).toBe(0);
    const sup = await login(env.app, "supervisor@example.com");
    const alerts = await sup.get(`/v1/admin/alerts?project_id=${pid}`);
    const missed = alerts.body.alerts.filter((a: { event_type: string }) => a.event_type === "missed_clock_out");
    expect(missed).toHaveLength(1);
    expect(missed[0].title).toContain("Mary Jackson");
    expect((await sup.post(`/v1/admin/alerts/${missed[0].id}/ack`)).status).toBe(200);
    expect((await sup.get(`/v1/admin/alerts?project_id=${pid}`)).body.alerts.find((a: { id: string }) => a.id === missed[0].id)).toBeUndefined();
  });
});

async function loginCookie() {
  const res = await env.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: "admin@example.com", password: "demo-password-1" } });
  const c = res.cookies.find((x) => x.name === "ttc_session")!;
  return `${c.name}=${c.value}`;
}
