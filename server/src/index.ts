import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { migrate } from "./db/migrate.js";
import { startAlertWorker } from "./services/notifications.js";

const config = loadConfig();
const db = createPool(config.databaseUrl, { ssl: config.databaseSsl });
await migrate(db, (m) => console.log(`[migrate] ${m}`));

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/server/src -> dist/web in production builds.
const webDist = path.resolve(here, "../../web");
const app = await buildApp({ db, config, logger: true, webDist: config.env === "production" ? webDist : undefined });

const stopWorker = config.alertWorkerEnabled ? startAlertWorker(db, app.log) : () => undefined;

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  stopWorker();
  await app.close();
  await db.end();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ port: config.port, host: "0.0.0.0" });
