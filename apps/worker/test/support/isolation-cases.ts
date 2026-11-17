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
  'POST /api/subscriptions body:folderId': {
    file: 'subscribe.test.ts',
    test: 'B posting A’s folderId gets 404 not_found, and nothing is created or changed',
  },
  'PATCH /api/folders/:id path:id': {
    file: 'folders.test.ts',
    test: 'B renaming A’s folder gets 404 not_found, and A’s folder is unchanged',
  },
  'DELETE /api/folders/:id path:id': {
    file: 'folders.test.ts',
    test: 'B deleting A’s folder gets 404 not_found, and A’s folder and subscriptions are unchanged',
  },
  'PATCH /api/subscriptions/:id path:id': {
    file: 'folders.test.ts',
    test: 'B editing A’s subscription gets 404 not_found, and A’s subscription is unchanged',
  },
  'PATCH /api/subscriptions/:id body:folderId': {
    file: 'folders.test.ts',
    test: 'B moving their own subscription into A’s folder gets 404 not_found, and nothing changes',
  },
  'DELETE /api/subscriptions/:id path:id': {
    file: 'folders.test.ts',
    test: 'B unsubscribing with A’s subscription ID gets 404 not_found, and A’s subscription and entries are unchanged',
  },
};
