/**
 * Vercel serverless entry point. The Fastify app is built once per function instance and reused
 * across invocations; Vercel routes /v1/* and /healthz here (see vercel.json) while the built SPA
 * is served as static files.
 *
 * Differences from the long-running server (server/src/index.ts):
 *  - migrations are not run on start (apply them once with `npm run db:migrate`, see docs/DEPLOYMENT.md);
 *  - there is no background alert worker; alert sweeps run when reviewers poll their alerts;
 *  - the connection pool is small, because each instance is short-lived and the database sits
 *    behind a transaction-mode pooler.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../server/src/app.js";
import { loadConfig } from "../server/src/config.js";
import { createPool } from "../server/src/db/pool.js";
import { ensureDemoData } from "../server/src/seed.js";

let ready: Promise<FastifyInstance> | null = null;

async function init(): Promise<FastifyInstance> {
  const config = { ...loadConfig(), alertWorkerEnabled: false };
  const db = createPool(config.databaseUrl, { max: 3, ssl: config.databaseSsl });
  if (config.demoSeed) await ensureDemoData(db);
  const app = await buildApp({ db, config, logger: true });
  await app.ready();
  return app;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  ready ??= init().catch((err) => {
    ready = null; // let the next request retry a failed cold start
    throw err;
  });
  const app = await ready;
  app.server.emit("request", req, res);
}
