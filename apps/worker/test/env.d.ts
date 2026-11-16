import type { D1Migration } from '@cloudflare/vitest-plugin';
import type { Env as WorkerEnv } from '../env';

// Types `env` from "cloudflare:workers" / "cloudflare:test" in tests.
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
