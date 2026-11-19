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
  // TID-022: a passkey ID in the path.
  'PATCH /api/auth/passkeys/:id path:id': {
    file: 'settings-account.test.ts',
    test: 'B renaming A’s passkey gets 404 not_found, and A’s passkey is unchanged',
  },
  'DELETE /api/auth/passkeys/:id path:id': {
    file: 'settings-account.test.ts',
    test: 'B removing A’s passkey gets 404 not_found, and A’s passkeys are unchanged',
  },
  // TID-018 AC8. `id` names a folder (view=folder) or a subscription (view=feed).
  'GET /api/entries query:id': {
    file: 'entries-api.test.ts',
    test: 'B asking for A’s subscription or folder gets 404 not_found, identical to a missing ID',
  },
  // TID-019 AC9, AC10.
  'GET /api/entries/:id path:id': {
    file: 'entry-read.test.ts',
    test: 'B asking for A’s entry gets 404 not_found, identical to a missing or malformed ID',
  },
  'PATCH /api/entries/:id path:id': {
    file: 'entry-read.test.ts',
    test: 'B changing A’s entry gets 404 not_found, and A’s entry is unchanged',
  },
  // TID-066: a signal for another user's entry is "not found" and writes nothing.
  'POST /api/entries/:id/engagement path:id': {
    file: 'engagement.test.ts',
    test: 'B signalling A’s entry gets 404 not_found, and nothing is written',
  },
  'POST /api/entries/read-state body:entryIds': {
    file: 'entry-read.test.ts',
    test: 'with another user’s IDs in the list, only mine change',
  },
  // TID-020: the folder or subscription ID in a mark-all-read body.
  'POST /api/entries/mark-all-read body:id': {
    file: 'mark-all-read.test.ts',
    test: 'B posting A’s folder or subscription ID gets 404 not_found, and nothing changes',
  },
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
