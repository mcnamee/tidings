/**
 * Mark as read on scroll (TID-026). A row that scrolls fully above the viewport is marked read at
 * once in every cache (the row dims, the counts drop), and the IDs are sent together in one
 * `POST /api/entries/read-state` at most every `intervalMs`. Anything still waiting is sent when
 * the page is hidden or the list unmounts. A failed batch is put back and one toast says so.
 * Batching keeps D1 writes at the cost of one read-state change per entry (NFR-7).
 */
import { useEffect, useRef, type RefObject } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import {
  READ_STATE_MAX_IDS,
  type EntrySummary,
  type ReadStateRequest,
  type ReadStateResponse,
} from '@tidings/shared';
import { apiPost } from '../api';
import { scheduleCountsRefetch } from './queries';
import { applyRead, type Target } from './readState';
import { toast } from './toast';

export const SCROLL_READ_INTERVAL_MS = 2000;
export const SCROLL_READ_ERROR = "Couldn't mark articles as read. Try again.";

export interface ReadBatcher {
  /** Marks the entry read now (optimistic) and queues it. Ignored if it is already read or queued. */
  add(entry: Target & { isRead: boolean }): void;
  /** Sends what is waiting. `keepalive` lets the request outlive the page. */
  flush(keepalive?: boolean): Promise<void>;
  /** Flushes and stops the timer. */
  dispose(): void;
}

type Send = (body: ReadStateRequest, keepalive: boolean) => Promise<unknown>;

const defaultSend: Send = (body, keepalive) =>
  apiPost<ReadStateResponse>(
    '/api/entries/read-state',
    body,
    keepalive
      ? { fetchFn: (input, init) => fetch(input, { ...init, keepalive: true }) }
      : undefined,
  );

export function createReadBatcher(
  client: QueryClient,
  { intervalMs = SCROLL_READ_INTERVAL_MS, send = defaultSend } = {},
): ReadBatcher {
  const pending = new Map<string, Target>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function flush(keepalive = false): Promise<void> {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (pending.size === 0) return;
    const batch = [...pending.values()];
    pending.clear();
    let failed = false;
    for (let i = 0; i < batch.length; i += READ_STATE_MAX_IDS) {
      const chunk = batch.slice(i, i + READ_STATE_MAX_IDS);
      try {
        await send({ entryIds: chunk.map((t) => t.id), isRead: true }, keepalive);
      } catch {
        failed = true;
        for (const t of chunk) applyRead(client, t, false);
      }
    }
    if (failed) toast.error(SCROLL_READ_ERROR);
    scheduleCountsRefetch(client);
  }

  return {
    add(entry) {
      if (entry.isRead || pending.has(entry.id)) return;
      const target = { id: entry.id, subscriptionId: entry.subscriptionId };
      applyRead(client, target, true);
      pending.set(entry.id, target);
      timer ??= setTimeout(() => void flush(), intervalMs);
    },
    flush,
    dispose() {
      void flush();
    },
  };
}

/**
 * Watches the rows of the list inside `listRef` (`li[data-entry-id]`) and marks each one read when
 * the person has scrolled past it. A row only counts once it has been seen on screen, so rows
 * above the start position (scroll restore) and rows a jump went over are left alone.
 * The window is the scroller (TID-069); `rootMargin` keeps the header (fixed below `lg`, sticky
 * from it) out of the viewport, so a row counts once it is above the header's bottom edge.
 */
export function useMarkReadOnScroll(
  client: QueryClient,
  listRef: RefObject<HTMLElement | null>,
  items: EntrySummary[],
  enabled: boolean,
): void {
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const observerRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    if (!enabled || typeof IntersectionObserver === 'undefined') return;
    const batcher = createReadBatcher(client);
    const seen = new Set<string>();
    const header = document.querySelector('header')?.parentElement;
    const top = header ? Math.round(header.getBoundingClientRect().bottom) : 0;
    const observer = new IntersectionObserver(
      (hits) => {
        for (const hit of hits) {
          const id = (hit.target as HTMLElement).dataset.entryId;
          if (!id) continue;
          if (hit.isIntersecting) {
            seen.add(id);
            continue;
          }
          const above = hit.boundingClientRect.bottom <= (hit.rootBounds?.top ?? top);
          if (!above || !seen.has(id)) continue;
          const item = itemsRef.current.find((i) => i.id === id);
          if (item) batcher.add(item);
        }
      },
      { rootMargin: `-${Math.max(0, top)}px 0px 0px 0px` },
    );
    observerRef.current = observer;
    const onHide = () => {
      if (document.visibilityState === 'hidden') void batcher.flush(true);
    };
    const onPageHide = () => void batcher.flush(true);
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      observer.disconnect();
      observerRef.current = null;
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
      batcher.dispose();
    };
  }, [client, enabled]);

  // Rows that arrive later (next pages) are observed too; observing a row twice is harmless.
  useEffect(() => {
    const observer = observerRef.current;
    const list = listRef.current;
    if (!observer || !list) return;
    list.querySelectorAll('li[data-entry-id]').forEach((li) => observer.observe(li));
  }, [items.length, enabled, listRef]);
}
