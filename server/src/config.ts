export interface AppConfig {
  databaseUrl: string;
  port: number;
  env: "development" | "production" | "test";
  appBaseUrl: string;
  sessionTtlHours: number;
  alertWorkerEnabled: boolean;
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
  };
}
