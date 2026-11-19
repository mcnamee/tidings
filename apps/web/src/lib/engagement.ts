/**
 * Engagement signals (TID-066, ADR 0018): `open` when the user opens an article, `click` when they
 * go through to the original website. Fire and forget: the request never blocks navigation, a
 * failure is silent (no toast, no retry queue), and `keepalive` lets it finish while the page is
 * being left for the original site. Marking read by scroll, "Mark all as read" and a reload or
 * direct link never come through here.
 */
import type { EngagementKind, EngagementRequest } from '@tidings/shared';

// Each signal is sent once per entry per page life; the server stores it once anyway (idempotent),
// so this only saves requests. A failed send is forgotten so the next open or click tries again.
const sent = new Set<string>();

export function sendEngagement(
  entryId: string,
  kind: EngagementKind,
  fetchFn: typeof fetch = fetch,
): void {
  const key = `${kind}:${entryId}`;
  if (sent.has(key)) return;
  sent.add(key);
  const body: EngagementRequest = { kind };
  const forget = () => void sent.delete(key);
  try {
    fetchFn(`/api/entries/${encodeURIComponent(entryId)}/engagement`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      keepalive: true,
    }).then((res) => {
      if (!res.ok) forget();
    }, forget);
  } catch {
    forget();
  }
}

/** Props for the two links that leave for the original: a normal click, Enter, or a middle click. */
export function clickThrough(entryId: string) {
  return {
    onClick: () => sendEngagement(entryId, 'click'),
    onAuxClick: (e: { button: number }) => {
      if (e.button === 1) sendEngagement(entryId, 'click');
    },
  };
}

/** Test helper: forget what was sent. */
export function resetEngagementForTests(): void {
  sent.clear();
}
