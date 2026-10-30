import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server/app.js";
import { loadConfig, type PortalConfig } from "../src/server/config.js";
import { createPool, type Db } from "../src/server/db.js";
import { migrate } from "../src/server/migrate.js";

export const API_KEY = "test-api-key-0123456789abcdef0123456789";

export async function setup(overrides: Partial<PortalConfig> = {}): Promise<{ app: FastifyInstance; db: Db; config: PortalConfig; close: () => Promise<void> }> {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://ttc:ttc@localhost:5432/shift_test";
  if (!/test/.test(url)) throw new Error("Refusing to run against a non-test database.");
  const db = createPool(url);
  await db.query("DROP SCHEMA IF EXISTS shift CASCADE");
  await migrate(db);
  const config = { ...loadConfig({ NODE_ENV: "test", PORTAL_API_KEY: API_KEY, PORTAL_TIMEZONE: "Europe/London" }), databaseUrl: url, ...overrides };
  const app = await buildApp(db, config);
  await app.ready();
  return { app, db, config, close: async () => { await app.close(); await db.end(); } };
}

export async function call(app: FastifyInstance, method: "GET" | "POST" | "PATCH", url: string, auth?: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({ method, url, payload: body as object | undefined, headers: { ...(auth ? { authorization: auth } : {}), ...headers } });
  let json: any = null;
  try { json = res.json(); } catch { json = null; }
  return { status: res.statusCode, body: json, raw: res.body, headers: res.headers };
}

export const admin = (app: FastifyInstance, method: "GET" | "POST" | "PATCH", url: string, body?: unknown) => call(app, method, url, `Bearer ${API_KEY}`, body);

export async function createEmployee(app: FastifyInstance, name = "Ada Lovelace", extra: Record<string, unknown> = {}) {
  const res = await admin(app, "POST", "/api/v1/employees", { display_name: name, ...extra });
  const token = new URL(res.body.link_url).hash.replace("#t=", "");
  return { id: res.body.employee.id as string, token, badge: res.body.badge_code as string, res };
}

export const punchLink = (app: FastifyInstance, token: string, action: string, key = randomUUID(), extra = {}) =>
  call(app, "POST", "/api/v1/punch", `Link ${token}`, { action, ...extra }, { "idempotency-key": key });
