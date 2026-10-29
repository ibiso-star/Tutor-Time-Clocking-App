import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import type { Db } from "./db/pool.js";
import type { AppConfig } from "./config.js";
import { ApiError, forbidden } from "./lib/errors.js";
import type { AuthUser } from "./lib/context.js";
import { RateLimiter } from "./lib/rateLimit.js";
import { OutboxMailer, type Mailer } from "./lib/mailer.js";
import { hashToken } from "./auth/password.js";
import { authRoutes, SESSION_COOKIE } from "./routes/auth.js";
import { meRoutes } from "./routes/me.js";
import { clockRoutes } from "./routes/clock.js";
import { adminRoutes } from "./routes/admin/index.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    config: AppConfig;
    limiter: RateLimiter;
    mailer: Mailer;
  }
  interface FastifyRequest {
    user: AuthUser | null;
    authSessionId: string | null;
    csrfToken: string | null;
  }
}

export interface BuildOptions {
  db: Db;
  config: AppConfig;
  mailer?: Mailer;
  logger?: boolean;
  /** Directory of the built web client to serve (production). */
  webDist?: string;
}

const CSRF_EXEMPT = new Set(["/v1/auth/login", "/v1/auth/password-reset/request", "/v1/auth/password-reset/confirm"]);

export async function buildApp(opts: BuildOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger
      ? {
          level: opts.config.env === "production" ? "info" : "debug",
          // Never log credentials, cookies or session tokens.
          redact: ["req.headers.cookie", "req.headers.authorization", "req.headers['x-csrf-token']", "req.body.password"],
        }
      : false,
    genReqId: () => randomUUID(),
    trustProxy: opts.config.env === "production",
    bodyLimit: 256 * 1024,
  });

  app.decorate("db", opts.db);
  app.decorate("config", opts.config);
  app.decorate("limiter", new RateLimiter());
  app.decorate("mailer", opts.mailer ?? new OutboxMailer((m) => app.log.info(m)));
  app.decorateRequest("user", null);
  app.decorateRequest("authSessionId", null);
  app.decorateRequest("csrfToken", null);

  await app.register(cookie);

  // Resolve the signed-in user from the opaque session cookie.
  app.addHook("onRequest", async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    const { rows } = await opts.db.query(
      `SELECT s.id AS session_id, s.csrf_token, u.id, u.email, u.display_name, u.status, u.is_system_admin
         FROM auth_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [hashToken(token)],
    );
    const row = rows[0];
    if (!row || row.status !== "active") return;
    req.user = { id: row.id, email: row.email, display_name: row.display_name, status: row.status, is_system_admin: row.is_system_admin };
    req.authSessionId = row.session_id;
    req.csrfToken = row.csrf_token;
  });

  // CSRF: cookie-authenticated state-changing requests must echo the per-session token in a header.
  app.addHook("preHandler", async (req) => {
    if (!req.url.startsWith("/v1/")) return;
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
    if (CSRF_EXEMPT.has(req.routeOptions.url ?? "")) return;
    if (!req.user) return; // route-level auth will reject
    if (req.headers["x-csrf-token"] !== req.csrfToken) throw forbidden("Your session security token is missing or stale. Reload the page and try again.");
  });

  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("x-request-id", req.id);
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "same-origin");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=(self)");
    if (req.url.startsWith("/v1/")) reply.header("cache-control", "no-store");
    else
      reply.header(
        "content-security-policy",
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      );
    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details ?? null, request_id: req.id } });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ error: { code: "BAD_REQUEST", message: err instanceof Error ? err.message : "Bad request", details: null, request_id: req.id } });
    }
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send({
      error: { code: "INTERNAL", message: "Something went wrong on our side. Nothing was recorded; please try again.", details: null, request_id: req.id },
    });
  });

  app.get("/healthz", async () => {
    await opts.db.query("SELECT 1");
    return { ok: true };
  });

  await app.register(authRoutes);
  await app.register(meRoutes);
  await app.register(clockRoutes);
  await app.register(adminRoutes);

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/v1/") || !opts.webDist) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Not found.", details: null, request_id: req.id } });
    }
    return reply.sendFile("index.html");
  });

  if (opts.webDist && existsSync(opts.webDist)) {
    await app.register(fastifyStatic, { root: path.resolve(opts.webDist), wildcard: false });
  }

  return app;
}
