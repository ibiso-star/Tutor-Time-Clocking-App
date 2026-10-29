// Resets the E2E database and loads demo data using the compiled server code.
import pg from "pg";
import { migrate } from "../dist/server/src/db/migrate.js";
import { seedDemo } from "../dist/server/src/seed.js";

const url = process.env.DATABASE_URL;
if (!url || !/e2e|test/.test(url)) {
  console.error("Refusing to reset a database whose name does not contain 'e2e' or 'test'.");
  process.exit(1);
}
const db = new pg.Pool({ connectionString: url });
await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
await migrate(db);
await seedDemo(db);
await db.end();
