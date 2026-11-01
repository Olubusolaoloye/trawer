import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // DB tests share one database; files run sequentially to keep fixtures predictable.
    fileParallelism: false,
  },
});
