/**
 * The isolation suite's index (spec 10.8, ADR 0012, TID-013 AC11). Each ID input of each route
 * names the test that proves user B, holding A's ID, gets `404 not_found` (or has the ID ignored,
 * where the spec says so) and that A's data is unchanged. `api-guard.test.ts` fails when a
 * registered route has an ID input here without an entry, or when the named test is missing from
 * the named file, so renaming or deleting a test cannot silently drop coverage.
 *
 * A story that adds a route with an ID input adds its row to `route-table.ts` and its case here.
 */
export interface IsolationCase {
  /** File in `apps/worker/test/`. */
  file: string;
  /** A substring of the `it(...)` title. */
  test: string;
}

export const ISOLATION_CASES: Readonly<Record<string, IsolationCase>> = {
  // TID-018 AC8. `id` names a folder (view=folder) or a subscription (view=feed).
  'GET /api/entries query:id': {
    file: 'entries-api.test.ts',
    test: 'B asking for A’s subscription or folder gets 404 not_found, identical to a missing ID',
  },
  'POST /api/subscriptions body:folderId': {
    file: 'subscribe.test.ts',
    test: 'B posting A’s folderId gets 404 not_found, and nothing is created or changed',
  },
};
