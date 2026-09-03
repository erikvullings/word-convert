import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      'virtual:wordconvert-formula-recognizer': fileURLToPath(
        new URL(
          './apps/web/src/worker/configured-formula-recognizer.texteller.ts',
          import.meta.url,
        ),
      ),
    },
  },
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
    include: [
      'apps/**/*.test.ts',
      'packages/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
  },
});
