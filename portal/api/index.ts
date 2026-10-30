/**
 * Vercel entry point: one function serves /api/*; Vercel serves the built frontend from dist/web.
 * Webhooks are delivered immediately after each punch; retries run when POST /api/v1/webhooks/deliver
 * is called (from the admin page or any scheduler holding the API key).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { createPool } from "../src/server/db.js";

let ready: Promise<FastifyInstance> | null = null;

async function init() {
  const config = { ...loadConfig(), webhookWorker: false };
  const db = createPool(config.databaseUrl, { max: 3, ssl: config.databaseSsl });
  const app = await buildApp(db, config, { logger: true });
  await app.ready();
  return app;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  ready ??= init().catch((err) => {
    ready = null;
    throw err;
  });
  (await ready).server.emit("request", req, res);
}
