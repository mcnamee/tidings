import type { QueryClient } from '@tanstack/react-query';

/**
 * Name of the IndexedDB database the persisted query cache lives in (TID-023 builds the
 * persister and must use this name). An explicit sign out deletes it; a session ending (401)
 * leaves it alone so the next sign-in repaints instantly (ADR 0010 item 4).
 */
export const CACHE_DB_NAME = 'tidings-cache';

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      // Another tab holds it open: the delete completes when that tab lets go.
      req.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

/**
 * Explicit sign out only: drops every cached query except the session itself (whose observers
 * must keep working) and deletes the persisted copy.
 */
export async function clearClientCache(client: QueryClient, sessionKey: readonly unknown[]) {
  await client.cancelQueries();
  client.removeQueries({ predicate: (q) => q.queryKey[0] !== sessionKey[0] });
  await deleteDatabase(CACHE_DB_NAME);
}
