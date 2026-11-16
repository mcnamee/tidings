import { defineConfig } from 'vitest/config';

// `silent: false` and the verbose reporter make vitest print the table the bench logs.
export default defineConfig({
  test: { include: ['bench/**/*.test.ts'], silent: false, reporters: ['verbose'] },
});
