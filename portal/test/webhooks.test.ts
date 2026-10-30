import http from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createEmployee, punchLink, setup } from "./helpers.js";

const secret = randomBytes(32);
const received: Array<{ headers: http.IncomingHttpHeaders; body: string }> = [];
let failNext = 0;
let server: http.Server;
let env: Awaited<ReturnType<typeof setup>>;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (failNext > 0) {
        failNext--;
        res.statusCode = 503;
        return res.end();
      }
      received.push({ headers: req.headers, body });
      res.end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  env = await setup({ webhook: { url: `http://127.0.0.1:${port}/hook`, secret } });
});
afterAll(async () => {
  await env.close();
  server.close();
});

describe("webhooks", () => {
  it("delivers a verifiably signed event right after the punch", async () => {
    const e = await createEmployee(env.app, "Hooked", { external_ref: "crm-7" });
    const res = await punchLink(env.app, e.token, "CLOCK_IN");
    const msg = received.at(-1)!;
    expect(msg.headers["webhook-id"]).toBe(res.body.event.id);
    const expected = createHmac("sha256", secret).update(`${msg.headers["webhook-id"]}.${msg.headers["webhook-timestamp"]}.${msg.body}`).digest("base64");
    expect(msg.headers["webhook-signature"]).toBe(`v1,${expected}`);
    const payload = JSON.parse(msg.body);
    expect(payload).toMatchObject({ type: "shift.clock_in", schema_version: 1 });
    expect(payload.data.employee.external_ref).toBe("crm-7");
  });

  it("queues failed deliveries for retry with backoff and never double-delivers", async () => {
    const e = await createEmployee(env.app, "Retry Me");
    failNext = 1;
    const before = received.length;
    const res = await punchLink(env.app, e.token, "CLOCK_IN");
    expect(res.status).toBe(201); // the punch never depends on the receiver
    expect(received.length).toBe(before);
    const { rows } = await env.db.query(`SELECT status, attempts, last_error FROM shift.webhook_outbox WHERE event_id = $1`, [res.body.event.id]);
    expect(rows[0]).toMatchObject({ status: "pending", attempts: 1, last_error: "HTTP 503" });
    // Not due yet: a manual flush sends nothing.
    expect((await admin(env.app, "POST", "/api/v1/webhooks/deliver")).body.attempted).toBe(0);
    await env.db.query(`UPDATE shift.webhook_outbox SET next_attempt_at = now() WHERE event_id = $1`, [res.body.event.id]);
    const [a, b] = await Promise.all([admin(env.app, "POST", "/api/v1/webhooks/deliver"), admin(env.app, "POST", "/api/v1/webhooks/deliver")]);
    expect(a.body.delivered + b.body.delivered).toBe(1);
    expect(received.filter((m) => m.headers["webhook-id"] === res.body.event.id)).toHaveLength(1);
    const status = await admin(env.app, "GET", "/api/v1/webhooks/status");
    expect(status.body.configured).toBe(true);
  });

  it("writes one outbox message per event, including an implied break end", async () => {
    const e = await createEmployee(env.app, "Combined");
    await punchLink(env.app, e.token, "CLOCK_IN");
    await punchLink(env.app, e.token, "BREAK_START");
    await punchLink(env.app, e.token, "CLOCK_OUT", undefined, { end_break: true });
    const { rows } = await env.db.query(
      `SELECT payload->>'type' AS type FROM shift.webhook_outbox o JOIN shift.events e ON e.id = o.event_id WHERE e.employee_id = $1 ORDER BY e.seq`,
      [e.id],
    );
    expect(rows.map((r) => r.type)).toEqual(["shift.clock_in", "shift.break_start", "shift.break_end", "shift.clock_out"]);
    const { rows: pending } = await env.db.query(
      `SELECT count(*)::int n FROM shift.webhook_outbox o JOIN shift.events e ON e.id = o.event_id WHERE e.employee_id = $1 AND o.status <> 'delivered'`,
      [e.id],
    );
    expect(pending[0].n).toBe(0);
  });
});
