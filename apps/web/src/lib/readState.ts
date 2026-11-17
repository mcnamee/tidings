/**
 * Read-state changes (FR-RD-8, spec 11.3). A change is optimistic: the `entry` cache, every cached
 * list that holds the entry and the unread counts change at once, then `PATCH /api/entries/:id` is
 * sent. If it fails, the same three are put back and a toast says so. A row read in an unread-only
 * list stays in it (FR-RD-4): only its flag changes.
 */
import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import type { Counts, EntriesResponse, Entry, EntrySummary, Subscription } from '@tidings/shared';
import { apiPatch } from '../api';
import { COUNTS_KEY, SUBSCRIPTIONS_KEY, entryKey, scheduleCountsRefetch } from './queries';
import { toast } from './toast';

export const READ_STATE_ERROR = "Couldn't update that article. Try again.";

type Target = Pick<EntrySummary, 'id' | 'subscriptionId'>;

function adjustCounts(
  counts: Counts,
  subscriptionId: string,
  folderId: string | null,
  delta: number,
): Counts {
  const bump = (n: number | undefined) => Math.max(0, (n ?? 0) + delta);
  return {
    total: bump(counts.total),
    subscriptions: {
      ...counts.subscriptions,
      [subscriptionId]: bump(counts.subscriptions[subscriptionId]),
    },
    folders:
      folderId === null
        ? counts.folders
        : { ...counts.folders, [folderId]: bump(counts.folders[folderId]) },
  };
}

/** Writes the new state into every cache that shows it. Calling it twice with the same value is harmless for the flags, so callers only apply it when the state really changes. */
function applyRead(client: QueryClient, target: Target, isRead: boolean): void {
  client.setQueryData<Entry>(entryKey(target.id), (old) =>
    old && old.isRead !== isRead ? { ...old, isRead } : old,
  );
  client.setQueriesData<InfiniteData<EntriesResponse, string | null>>(
    { queryKey: ['entries'] },
    (data) => {
      if (
        !data?.pages.some((p) => p.items.some((i) => i.id === target.id && i.isRead !== isRead))
      ) {
        return data;
      }
      return {
        ...data,
        pages: data.pages.map((p) => ({
          ...p,
          items: p.items.map((i) => (i.id === target.id ? { ...i, isRead } : i)),
        })),
      };
    },
  );
  const folderId =
    client
      .getQueryData<Subscription[]>(SUBSCRIPTIONS_KEY)
      ?.find((s) => s.id === target.subscriptionId)?.folderId ?? null;
  client.setQueryData<Counts>(COUNTS_KEY, (old) =>
    old ? adjustCounts(old, target.subscriptionId, folderId, isRead ? -1 : 1) : old,
  );
}

// One change at a time per entry, so quick taps reach the server in the order they were made.
const queue = new Map<string, Promise<void>>();

/**
 * Marks one entry read or unread. `current` is the state the screen is showing; nothing is sent
 * when it already matches. Resolves when the request has settled (never rejects).
 */
export function setEntryRead(
  client: QueryClient,
  entry: Target & { isRead: boolean },
  isRead: boolean,
): Promise<void> {
  if (entry.isRead === isRead) return Promise.resolve();
  // A detail request already in flight would land with the old state: drop it.
  void client.cancelQueries({ queryKey: entryKey(entry.id) });
  applyRead(client, entry, isRead);

  const run = async () => {
    try {
      await apiPatch<EntrySummary>(`/api/entries/${encodeURIComponent(entry.id)}`, { isRead });
    } catch {
      applyRead(client, entry, !isRead);
      toast.error(READ_STATE_ERROR);
    }
    scheduleCountsRefetch(client);
  };
  const next = (queue.get(entry.id) ?? Promise.resolve()).then(run);
  queue.set(entry.id, next);
  void next.then(() => {
    if (queue.get(entry.id) === next) queue.delete(entry.id);
  });
  return next;
}
