/**
 * Mark all as read (FR-RD-9, spec 8.5, 11.3). Like a single read-state change it is optimistic: every
 * cached list and the counts change at once, then `POST /api/entries/mark-all-read` is sent with the
 * list's `asOf` as the watermark. A failure puts the caches back and a toast says so. On success the
 * lists and counts are refetched (a list in unread-only mode empties, and anything that arrived
 * after the watermark shows again), and an Undo toast is offered unless more than
 * `MARK_ALL_UNDO_MAX` entries changed. Undo is the batch mark-unread call with the returned IDs.
 */
import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import {
  MARK_ALL_UNDO_MAX,
  type Counts,
  type EntriesResponse,
  type EntryListView,
  type EntrySummary,
  type MarkAllReadRequest,
  type MarkAllReadResponse,
  type ReadStateRequest,
  type ReadStateResponse,
  type Subscription,
} from '@tidings/shared';
import { apiPost } from '../api';
import { COUNTS_KEY, SUBSCRIPTIONS_KEY, trimToFirstPage } from './queries';
import { toast } from './toast';

export const MARK_ALL_ERROR = "Couldn't mark these as read. Try again.";
export const UNDO_ERROR = "Couldn't undo. Your change was kept.";
export const markedMessage = (n: number) => `Marked ${n} as read`;

export interface MarkAllScope {
  view: EntryListView;
  id: string | null;
  /** The first page's `asOf`. */
  before: string;
}

type Lists = InfiniteData<EntriesResponse, string | null>;

function folderOf(client: QueryClient, subscriptionId: string): string | null {
  return (
    client.getQueryData<Subscription[]>(SUBSCRIPTIONS_KEY)?.find((s) => s.id === subscriptionId)
      ?.folderId ?? null
  );
}

function inScope(client: QueryClient, scope: MarkAllScope, item: EntrySummary): boolean {
  if (item.isRead || Date.parse(item.publishedAt) > Date.parse(scope.before)) return false;
  if (scope.view === 'all') return true;
  if (scope.view === 'feed') return item.subscriptionId === scope.id;
  return folderOf(client, item.subscriptionId) === scope.id;
}

function applyToLists(client: QueryClient, scope: MarkAllScope): void {
  client.setQueriesData<Lists>({ queryKey: ['entries'] }, (data) => {
    if (!data?.pages.some((p) => p.items.some((i) => inScope(client, scope, i)))) return data;
    return {
      ...data,
      pages: data.pages.map((p) => ({
        ...p,
        items: p.items.map((i) => (inScope(client, scope, i) ? { ...i, isRead: true } : i)),
      })),
    };
  });
}

/** Zeroes the counts of every subscription in scope. The refetch after success corrects any entry that arrived after the watermark. */
function applyToCounts(client: QueryClient, scope: MarkAllScope): void {
  const subs = client.getQueryData<Subscription[]>(SUBSCRIPTIONS_KEY) ?? [];
  client.setQueryData<Counts>(COUNTS_KEY, (old) => {
    if (!old) return old;
    const next: Counts = {
      total: old.total,
      subscriptions: { ...old.subscriptions },
      folders: { ...old.folders },
    };
    for (const s of subs) {
      const inView =
        scope.view === 'all' ||
        (scope.view === 'feed' && s.id === scope.id) ||
        (scope.view === 'folder' && s.folderId === scope.id);
      const n = next.subscriptions[s.id] ?? 0;
      if (!inView || n === 0) continue;
      next.subscriptions[s.id] = 0;
      next.total = Math.max(0, next.total - n);
      if (s.folderId !== null) {
        next.folders[s.folderId] = Math.max(0, (next.folders[s.folderId] ?? 0) - n);
      }
    }
    return next;
  });
}

/** Lists drop to page 1 before they are refetched, so a long scroll costs one request, not one per page. */
function refreshFromServer(client: QueryClient): void {
  for (const [key] of client.getQueriesData<Lists>({ queryKey: ['entries'] })) {
    trimToFirstPage(client, key);
  }
  void client.invalidateQueries({ queryKey: ['entries'] });
  void client.invalidateQueries({ queryKey: COUNTS_KEY });
}

/** Resolves when the request has settled (never rejects). */
export async function markAllRead(client: QueryClient, scope: MarkAllScope): Promise<void> {
  const lists = client.getQueriesData<Lists>({ queryKey: ['entries'] });
  const counts = client.getQueryData<Counts>(COUNTS_KEY);
  await client.cancelQueries({ queryKey: ['entries'] });
  applyToLists(client, scope);
  applyToCounts(client, scope);

  const body: MarkAllReadRequest = {
    view: scope.view,
    before: scope.before,
    ...(scope.id === null ? {} : { id: scope.id }),
  };
  let done: MarkAllReadResponse;
  try {
    done = await apiPost<MarkAllReadResponse>('/api/entries/mark-all-read', body);
  } catch {
    for (const [key, data] of lists) client.setQueryData(key, data);
    if (counts) client.setQueryData(COUNTS_KEY, counts);
    toast.error(MARK_ALL_ERROR);
    return;
  }
  refreshFromServer(client);
  const ids = done.entryIds;
  if (ids !== null && ids.length > 0 && ids.length <= MARK_ALL_UNDO_MAX) {
    toast.undo(markedMessage(done.updated), () => void undoMarkAll(client, ids));
  } else if (done.updated > 0) {
    toast.success(markedMessage(done.updated));
  }
}

async function undoMarkAll(client: QueryClient, entryIds: string[]): Promise<void> {
  const body: ReadStateRequest = { entryIds, isRead: false };
  try {
    await apiPost<ReadStateResponse>('/api/entries/read-state', body);
  } catch {
    toast.error(UNDO_ERROR);
  }
  // Either way the server decides what the lists and counts show.
  refreshFromServer(client);
}
