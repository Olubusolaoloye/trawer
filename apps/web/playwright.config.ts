import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 8799);

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 60_000,
  retries: 0,
  workers: 1,
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure', ...devices['Pixel 7'] },
  webServer: {
    // Same-origin production-like setup: API serves the built SPA.
    command: `pnpm --filter @trawer/api exec tsx src/main.ts`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT: String(PORT),
      DATABASE_URL: process.env.E2E_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/trawer_dev',
      WEB_DIST: new URL('./dist', import.meta.url).pathname,
      AUTH_MODE: 'dev',
      PAYMENT_PROVIDER: 'fake',
      NODE_ENV: 'development',
      ROOT_DOMAIN: 'localhost',
    },
  },
});
