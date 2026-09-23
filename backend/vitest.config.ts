import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration test files share one PostgreSQL database and some rules are
    // global (e.g. R8 counts every System Admin), so files run one at a time.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
