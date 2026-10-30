export interface AppConfig {
  databaseUrl: string;
  port: number;
  env: "development" | "production" | "test";
  appBaseUrl: string;
  sessionTtlHours: number;
  alertWorkerEnabled: boolean;
  /** TLS for the database connection. Undefined means whatever the connection string specifies. */
  databaseSsl: { ca?: string; rejectUnauthorized: boolean } | undefined;
  /** Load demo data on startup when the database is empty (demo deployments only). */
  demoSeed: boolean;
  /** Transactional email via Resend. Null means emails are only written to the log. */
  mail: { provider: "resend"; apiKey: string; from: string } | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV === "production" || env.NODE_ENV === "test" ? env.NODE_ENV : "development";
  return {
    databaseUrl: env.DATABASE_URL ?? "postgres://ttc:ttc@localhost:5432/ttc_dev",
    port: Number(env.PORT ?? 3000),
    env: nodeEnv,
    appBaseUrl: env.APP_BASE_URL ?? "http://localhost:5173",
    sessionTtlHours: Number(env.SESSION_TTL_HOURS ?? 12),
    alertWorkerEnabled: env.ALERT_WORKER_ENABLED !== "false" && nodeEnv !== "test",
    databaseSsl: env.DATABASE_CA_CERT
      ? { ca: env.DATABASE_CA_CERT, rejectUnauthorized: true }
      : env.DATABASE_SSL === "require"
        ? { rejectUnauthorized: false }
        : undefined,
    demoSeed: env.DEMO_SEED === "true",
    mail: mailConfig(env),
  };
}

function mailConfig(env: NodeJS.ProcessEnv): AppConfig["mail"] {
  const apiKey = env.RESEND_API_KEY?.trim();
  if (!apiKey) return null;
  const from = env.MAIL_FROM?.trim();
  if (!from) throw new Error("MAIL_FROM must be set when RESEND_API_KEY is, e.g. \"Tutor Time Clock <noreply@example.org>\".");
  return { provider: "resend", apiKey, from };
}
