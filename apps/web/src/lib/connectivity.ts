import { useSyncExternalStore } from 'react';

// FR-PW-3: the offline banner shows when the browser says it is offline, or when an API request
// got no response at all while the browser claims to be online (captive portal, dead Wi-Fi).
// Any answer from the server, even an error status, proves the network works and clears it, and
// so does the `online` event.

let unreachable = false;
const listeners = new Set<() => void>();

/** Called by the API client: `false` after a request got no response, `true` after any response. */
export function reportReachable(reachable: boolean): void {
  if (unreachable === !reachable) return;
  unreachable = !reachable;
  listeners.forEach((l) => l());
}

export function isApiUnreachable(): boolean {
  return unreachable;
}

function subscribe(notify: () => void): () => void {
  const onOnline = () => reportReachable(true);
  listeners.add(notify);
  window.addEventListener('online', onOnline);
  window.addEventListener('online', notify);
  window.addEventListener('offline', notify);
  return () => {
    listeners.delete(notify);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('online', notify);
    window.removeEventListener('offline', notify);
  };
}

/** True when the offline banner should show. */
export function useOffline(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => !navigator.onLine || unreachable,
    () => false,
  );
}
