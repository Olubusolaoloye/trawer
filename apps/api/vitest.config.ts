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
    },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
