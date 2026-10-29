import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createPool, type Db } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { OutboxMailer } from "../src/lib/mailer.js";
import { DEMO_PASSWORD, seedDemo, type DemoIds } from "../src/seed.js";

export interface TestEnv {
  app: FastifyInstance;
  db: Db;
  ids: DemoIds;
  mailer: OutboxMailer;
  close: () => Promise<void>;
}

/** Fresh schema + demo seed per test file, against TEST_DATABASE_URL (a disposable database). */
export async function setupTestEnv(): Promise<TestEnv> {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://ttc:ttc@localhost:5432/ttc_test";
  if (!/test/.test(url)) throw new Error("Refusing to run integration tests against a non-test database URL.");
  const db = createPool(url);
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(db);
  const ids = await seedDemo(db);
  const mailer = new OutboxMailer();
  const app = await buildApp({ db, config: { ...loadConfig({ NODE_ENV: "test" }), databaseUrl: url }, mailer, logger: !!process.env.TEST_LOG });
  await app.ready();
  return { app, db, ids, mailer, close: async () => { await app.close(); await db.end(); } };
}

export interface Client {
  get: (url: string) => Promise<Res>;
  post: (url: string, body?: unknown, headers?: Record<string, string>) => Promise<Res>;
  patch: (url: string, body?: unknown) => Promise<Res>;
  csrf: string;
}
export interface Res {
  status: number;
  body: any;
  headers: Record<string, unknown>;
  raw: string;
}

export async function login(app: FastifyInstance, email: string, password = DEMO_PASSWORD): Promise<Client> {
  const res = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`login failed for ${email}: ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === "ttc_session")!;
  const csrf = res.json().csrf_token as string;
  const cookieHeader = `${cookie.name}=${cookie.value}`;
  const wrap = (r: Awaited<ReturnType<FastifyInstance["inject"]>>): Res => {
    let body: unknown = null;
    try { body = r.json(); } catch { body = null; }
    return { status: r.statusCode, body, headers: r.headers, raw: r.body };
  };
  return {
    csrf,
    get: async (url) => wrap(await app.inject({ method: "GET", url, headers: { cookie: cookieHeader } })),
    post: async (url, body, headers = {}) =>
      wrap(await app.inject({ method: "POST", url, payload: (body ?? {}) as object, headers: { cookie: cookieHeader, "x-csrf-token": csrf, ...headers } })),
    patch: async (url, body) =>
      wrap(await app.inject({ method: "PATCH", url, payload: (body ?? {}) as object, headers: { cookie: cookieHeader, "x-csrf-token": csrf } })),
  };
}

export function clock(c: Client, projectId: string, eventType: string, extra: Record<string, unknown> = {}, key: string = randomUUID()) {
  return c.post("/v1/clock-events", { project_id: projectId, event_type: eventType, ...extra }, { "idempotency-key": key });
}
