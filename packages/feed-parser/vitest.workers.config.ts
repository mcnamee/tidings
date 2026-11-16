import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';

// Runs inside workerd so tests exercise the real `HTMLRewriter` (feed autodiscovery, AC8).
export default defineConfig({
  plugins: [cloudflareTest({ miniflare: { compatibilityDate: '2026-11-16' } })],
  test: { include: ['src/**/*.workers.test.ts'] },
});
