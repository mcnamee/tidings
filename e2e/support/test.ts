import { test as base, expect } from '@playwright/test';
import { startFixtureServer, type FixtureServer } from './fixture-server.ts';
import { FIXTURE_PORT } from './ports.ts';

/**
 * Project `test`: adds a `fixtureServer` fixture (the local feed server on FIXTURE_PORT, reset before
 * each test). Specs import { test, expect } from '../support/test.ts' instead of '@playwright/test'.
 */
export const test = base.extend<
  { fixtureServer: FixtureServer },
  { fixtureServerWorker: FixtureServer }
>({
  fixtureServerWorker: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const server = await startFixtureServer({ port: FIXTURE_PORT });
      await use(server);
      await server.close();
    },
    { scope: 'worker' },
  ],
  fixtureServer: async ({ fixtureServerWorker }, use) => {
    fixtureServerWorker.reset();
    await use(fixtureServerWorker);
  },
});

export { expect };
