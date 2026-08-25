import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts', '../../scripts/test/**/*.test.ts'],
    // E2E teardown (gh#318): deletes every org an E2E run created, from Qdrant
    // and Postgres. No-op for non-E2E runs — the created-org manifest is empty.
    globalSetup: ['test/e2e/global-setup.ts'],
    exclude: ['**/node_modules/**', '**/.claude/**', '**/.pnpm-store/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
    },
  },
});
