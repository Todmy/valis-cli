import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/.claude/**', '**/.pnpm-store/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
    },
  },
});
