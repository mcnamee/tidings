// Runs the E2E fixture feed server on its own, for the manual refresh check in the README
// (TID-012 AC12): `node e2e/support/serve-fixtures.ts` (Node 22.18+ strips the types itself).
import { FIXTURE_PORT } from './ports.ts';
import { startFixtureServer } from './fixture-server.ts';

const server = await startFixtureServer({ port: FIXTURE_PORT });
console.log(`fixture feed server on ${server.origin} (Ctrl-C to stop)`);
