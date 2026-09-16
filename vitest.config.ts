import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@fshine\/([\w-]+)$/,
        replacement: fileURLToPath(new URL('./packages', import.meta.url)) + '/$1/src/index.ts',
      },
    ],
  },
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    environment: 'node',
  },
});
