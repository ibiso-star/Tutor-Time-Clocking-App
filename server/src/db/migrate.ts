import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createPool, withTransaction, type Db } from "./pool.js";
import { loadConfig } from "../config.js";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

/** Applies pending forward-only SQL migrations in filename order. */
export async function migrate(db: Db, log: (msg: string) => void = () => undefined): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const applied = new Set(
    (await db.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
  );
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    await withTransaction(db, async (tx) => {
      await tx.query(sql);
      await tx.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
    });
    log(`applied ${file}`);
    ran.push(file);
  }
  return ran;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const db = createPool(loadConfig().databaseUrl);
  migrate(db, console.log)
    .then((ran) => console.log(ran.length ? `${ran.length} migration(s) applied` : "schema up to date"))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => db.end());
}
