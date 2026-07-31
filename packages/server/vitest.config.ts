import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Forks pool gives each test file its own process for clean SQLite state.
    pool: 'forks',
    poolOptions: { forks: { singleFork: false } },
  },
});
