import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests run against the production build (`npm run build`) with a freshly seeded
 * E2E database. Set E2E_DATABASE_URL to a disposable database.
 */
const db = process.env.E2E_DATABASE_URL ?? "postgres://ttc:ttc@localhost:5432/ttc_e2e";

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: "http://localhost:3100", trace: "retain-on-failure" },
  projects: [
    { name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: /tutor\.spec\.ts/ },
    { name: "desktop", use: { ...devices["Desktop Chrome"] }, testMatch: /admin\.spec\.ts/ },
  ],
  webServer: {
    command: `node e2e/reset-db.mjs && node dist/server/src/index.js`,
    url: "http://localhost:3100/healthz",
    reuseExistingServer: false,
    env: { DATABASE_URL: db, PORT: "3100", NODE_ENV: "production", ALERT_WORKER_ENABLED: "false" },
  },
});
