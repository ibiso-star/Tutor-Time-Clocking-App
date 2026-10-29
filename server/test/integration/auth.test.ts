import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { login, setupTestEnv, type TestEnv } from "../helpers.js";

let env: TestEnv;
beforeAll(async () => { env = await setupTestEnv(); });
afterAll(() => env.close());

describe("authentication & session security", () => {
  it("rejects bad credentials with a generic message", async () => {
    const res = await env.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: "ada@example.com", password: "wrong-password" } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toBe("Email or password is incorrect.");
    const unknown = await env.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: "nobody@example.com", password: "wrong-password" } });
    expect(unknown.json().error.message).toBe("Email or password is incorrect.");
  });

  it("sets an httpOnly SameSite session cookie and never stores the raw token", async () => {
    const res = await env.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: "ada@example.com", password: "demo-password-1" } });
    const cookie = res.cookies.find((c) => c.name === "ttc_session")!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("Lax");
    const { rows } = await env.db.query(`SELECT count(*)::int n FROM auth_sessions WHERE token_hash = $1`, [cookie.value]);
    expect(rows[0].n).toBe(0);
  });

  it("requires authentication for API routes", async () => {
    const res = await env.app.inject({ method: "GET", url: "/v1/me" });
    expect(res.statusCode).toBe(401);
  });

  it("requires the CSRF token on state-changing requests", async () => {
    const ada = await login(env.app, "ada@example.com");
    const res = await ada.post("/v1/clock-events", { project_id: env.ids.projectId, event_type: "CLOCK_IN" }, { "x-csrf-token": "forged", "idempotency-key": crypto.randomUUID() });
    expect(res.status).toBe(403);
  });

  it("returns the user's memberships and csrf token from /v1/me", async () => {
    const ada = await login(env.app, "ada@example.com");
    const me = await ada.get("/v1/me");
    expect(me.body.user.email).toBe("ada@example.com");
    expect(me.body.memberships).toHaveLength(1);
    expect(me.body.memberships[0].role).toBe("tutor");
    expect(me.body.csrf_token).toBe(ada.csrf);
  });

  it("supports single-use password reset without revealing account existence", async () => {
    const a = await env.app.inject({ method: "POST", url: "/v1/auth/password-reset/request", payload: { email: "nobody@example.com" } });
    const b = await env.app.inject({ method: "POST", url: "/v1/auth/password-reset/request", payload: { email: "alan@example.com" } });
    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(202);
    expect(a.json().message).toBe(b.json().message);
    const mail = env.mailer.outbox.at(-1)!;
    expect(mail.to).toBe("alan@example.com");
    const token = /token=([\w-]+)/.exec(mail.text)![1];
    const weak = await env.app.inject({ method: "POST", url: "/v1/auth/password-reset/confirm", payload: { token, password: "short" } });
    expect(weak.statusCode).toBe(400);
    const ok = await env.app.inject({ method: "POST", url: "/v1/auth/password-reset/confirm", payload: { token, password: "a-brand-new-password" } });
    expect(ok.statusCode).toBe(200);
    const reused = await env.app.inject({ method: "POST", url: "/v1/auth/password-reset/confirm", payload: { token, password: "another-new-password" } });
    expect(reused.statusCode).toBe(400);
    await expect(login(env.app, "alan@example.com", "a-brand-new-password")).resolves.toBeDefined();
  });

  it("revokes the session on logout", async () => {
    const ada = await login(env.app, "ada@example.com");
    expect((await ada.post("/v1/auth/logout")).status).toBe(200);
    expect((await ada.get("/v1/me")).status).toBe(401);
  });

  it("sets defensive headers", async () => {
    const res = await env.app.inject({ method: "GET", url: "/healthz" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
  });
});
