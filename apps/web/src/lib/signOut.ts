import type { QueryClient } from '@tanstack/react-query';
import { ApiRequestError, apiPost } from '../api';
import { clearClientCache } from './cache';
import { SESSION_KEY, SIGNED_OUT } from './session';
import { clearSignedInHint } from './signedInHint';

/**
 * True from the moment a person chooses Sign out until the login screen has mounted. The route
 * guard reads it so an explicit sign out lands on a plain `/login` (no "Your session ended"
 * banner, no remembered route), as login.md 2.7 requires.
 */
let explicit = false;

export function isExplicitSignOut(): boolean {
  return explicit;
}

export function resetExplicitSignOut(): void {
  explicit = false;
}

/**
 * Explicit sign out (TID-008 AC5, AC13): end the session on the server, forget this device's
 * hint, clear the cache (including the persisted copy), then publish "signed out" so the guard
 * routes to `/login`. Returns false when the server could not be reached, in which case nothing
 * is cleared and the person is still signed in.
 */
export async function signOut(client: QueryClient): Promise<boolean> {
  explicit = true;
  try {
    await apiPost('/api/auth/logout', {});
  } catch (err) {
    // 401: the session was already gone, which is what was asked for.
    if (!(err instanceof ApiRequestError && err.status === 401)) {
      explicit = false;
      return false;
    }
  }
  clearSignedInHint();
  await clearClientCache(client, SESSION_KEY);
  client.setQueryData(SESSION_KEY, SIGNED_OUT);
  return true;
}
