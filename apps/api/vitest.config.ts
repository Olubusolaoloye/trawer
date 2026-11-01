import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    env: {
      DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/trawer_api_test',
      AUTH_MODE: 'dev',
      PAYMENT_PROVIDER: 'fake',
      NODE_ENV: 'test',
      ROOT_DOMAIN: 'trawer.test',
      APP_URL: 'https://app.trawer.test',
      MESSAGING_PROVIDER: 'console',
      META_APP_SECRET: 'test-meta-app-secret',
      META_WEBHOOK_VERIFY_TOKEN: 'test-verify-token-123',
      CRON_SECRET: 'test-cron-secret-0123456789',
    },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
