import { IANAZone } from "luxon";

export interface PortalConfig {
  databaseUrl: string;
  port: number;
  env: "development" | "production" | "test";
  /** Admin / integration API key. Compared in constant time; never logged. */
  apiKey: string;
  /** Base URL used to build personal links and kiosk pairing links. */
  publicBaseUrl: string;
  /** IANA zone used for "today" and timesheet day boundaries. */
  timezone: string;
  webhook: { url: string; secret: Buffer } | null;
  /** Run the outbox delivery loop in-process (long-running servers). Serverless: use POST /webhooks/deliver. */
  webhookWorker: boolean;
  databaseSsl: { ca?: string; rejectUnauthorized: boolean } | undefined;
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PortalConfig {
  const nodeEnv = env.NODE_ENV === "production" || env.NODE_ENV === "test" ? env.NODE_ENV : "development";
  const apiKey = env.PORTAL_API_KEY ?? (nodeEnv === "production" ? "" : "dev-api-key-change-me-0123456789abcdef");
  if (apiKey.length < 32) throw new ConfigError("PORTAL_API_KEY must be set to at least 32 random characters.");
  const timezone = env.PORTAL_TIMEZONE ?? "UTC";
  if (!IANAZone.isValidZone(timezone)) throw new ConfigError(`PORTAL_TIMEZONE "${timezone}" is not a valid IANA zone.`);
  let webhook: PortalConfig["webhook"] = null;
  if (env.WEBHOOK_URL) {
    const url = new URL(env.WEBHOOK_URL);
    if (nodeEnv === "production" && url.protocol !== "https:") throw new ConfigError("WEBHOOK_URL must use https in production.");
    const raw = env.WEBHOOK_SECRET ?? "";
    // Standard Webhooks secrets are "whsec_" + base64 of at least 24 random bytes.
    const secret = Buffer.from(raw.replace(/^whsec_/, ""), "base64");
    if (secret.length < 24) throw new ConfigError("WEBHOOK_SECRET must be whsec_<base64 of at least 24 random bytes>.");
    webhook = { url: url.toString(), secret };
  }
  return {
    databaseUrl: env.DATABASE_URL ?? "postgres://ttc:ttc@localhost:5432/shift_dev",
    port: Number(env.PORT ?? 3010),
    env: nodeEnv,
    apiKey,
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? "http://localhost:5180").replace(/\/$/, ""),
    timezone,
    webhook,
    webhookWorker: env.WEBHOOK_WORKER !== "false" && nodeEnv !== "test",
    databaseSsl: env.DATABASE_CA_CERT
      ? { ca: env.DATABASE_CA_CERT, rejectUnauthorized: true }
      : env.DATABASE_SSL === "require"
        ? { rejectUnauthorized: false }
        : undefined,
  };
}
