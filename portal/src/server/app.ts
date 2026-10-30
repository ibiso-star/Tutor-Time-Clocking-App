import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type { Db } from "./db.js";
import type { PortalConfig } from "./config.js";
import { ApiError } from "./errors.js";
import { RateLimiter } from "./ratelimit.js";
import { publicRoutes } from "./routes/public.js";
import { adminRoutes } from "./routes/admin.js";
import { registerStatic } from "./static.js";

export interface AppDeps {
  db: Db;
  config: PortalConfig;
  limiter: RateLimiter;
}

export async function buildApp(db: Db, config: PortalConfig, opts: { logger?: boolean; webRoot?: string } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ? { level: "info", redact: ["req.headers.authorization"] } : false,
    genReqId: () => randomUUID(),
    trustProxy: config.env === "production",
    bodyLimit: 64 * 1024,
  });
  const deps: AppDeps = { db, config, limiter: new RateLimiter() };

  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("x-request-id", req.id);
    if (!reply.hasHeader("cache-control")) reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: { code: "BAD_REQUEST", message: "The request could not be read." } });
    req.log.error({ err }, "unhandled");
    return reply.status(500).send({ error: { code: "INTERNAL", message: "Something went wrong. Nothing was recorded; please try again." } });
  });

  app.get("/api/health", async () => {
    await db.query("SELECT 1");
    return { ok: true };
  });

  await app.register(async (scope) => publicRoutes(scope, deps));
  await app.register(async (scope) => adminRoutes(scope, deps));
  if (opts.webRoot) registerStatic(app, opts.webRoot);
  return app;
}
