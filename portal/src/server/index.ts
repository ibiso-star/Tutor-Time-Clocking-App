import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { migrate } from "./migrate.js";
import { startWebhookWorker } from "./webhooks.js";

const config = loadConfig();
const db = createPool(config.databaseUrl, { ssl: config.databaseSsl });
await migrate(db);
// dist/server -> dist/web after `npm run build`.
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web");
const app = await buildApp(db, config, { logger: true, webRoot: existsSync(webRoot) ? webRoot : undefined });
if (config.webhook && config.webhookWorker) startWebhookWorker(db, config.webhook, (err) => app.log.error({ err }, "webhook delivery failed"));
await app.listen({ port: config.port, host: "0.0.0.0" });
