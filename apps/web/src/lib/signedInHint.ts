/**
 * A device-local hint that someone signed in here, so a signed-out answer on a later visit can
 * say "Your session ended" (login.md 2.7) instead of showing a first-time visitor that message.
 * It holds no secret and grants nothing: the server's cookie is the only authority. Cleared by an
 * explicit sign out.
 */
const KEY = 'tidings.hasSession';

export function markSignedIn(storage?: Pick<Storage, 'setItem'>): void {
  try {
    // Read the global inside the try: merely touching it can throw SecurityError.
    (storage ?? localStorage).setItem(KEY, '1');
  } catch {
    // storage blocked: the banner just won't appear
  }
}

export function clearSignedInHint(storage?: Pick<Storage, 'removeItem'>): void {
  try {
    (storage ?? localStorage).removeItem(KEY);
  } catch {
    // nothing to clear
  }
}

export function hasSignedInHint(storage?: Pick<Storage, 'getItem'>): boolean {
  try {
    return (storage ?? localStorage).getItem(KEY) === '1';
  } catch {
    return false;
  }
}
