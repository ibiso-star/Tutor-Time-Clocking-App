import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, withTransaction, type Db } from "./db.js";
import { loadConfig } from "./config.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

export async function migrate(db: Db): Promise<string[]> {
  await db.query(`CREATE SCHEMA IF NOT EXISTS shift;
    CREATE TABLE IF NOT EXISTS shift.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await db.query<{ name: string }>("SELECT name FROM shift.schema_migrations")).rows.map((r) => r.name));
  const ran: string[] = [];
  for (const file of (await readdir(DIR)).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(file)) continue;
    const sql = await readFile(path.join(DIR, file), "utf8");
    await withTransaction(db, async (tx) => {
      await tx.query(sql);
      await tx.query("INSERT INTO shift.schema_migrations (name) VALUES ($1)", [file]);
    });
    ran.push(file);
  }
  return ran;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const config = loadConfig();
  const db = createPool(config.databaseUrl, { ssl: config.databaseSsl });
  migrate(db)
    .then((ran) => console.log(ran.length ? `applied: ${ran.join(", ")}` : "schema up to date"))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => db.end());
}
