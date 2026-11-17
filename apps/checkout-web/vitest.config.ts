import path from 'node:path';
import { defineConfig } from 'vitest/config';

// The logic behind the pages (the wallet flow, formatting) is tested without a browser.
export default defineConfig({
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  test: { include: ['test/**/*.test.ts'] },
});
