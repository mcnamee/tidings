import {
  useInfiniteQuery,
  useQuery,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import {
  ENTRIES_PAGE_SIZE,
  type Counts,
  type EntriesResponse,
  type EntryListState,
  type EntrySort,
  type Entry,
  type EntryListView,
  type FoldersResponse,
  type SubscriptionsResponse,
  type TopicCounts,
} from '@tidings/shared';
import { ApiRequestError, apiGet } from '../api';

// Query keys and cache rules from spec 11.3.
export const FOLDERS_KEY = ['folders'] as const;
export const SUBSCRIPTIONS_KEY = ['subscriptions'] as const;
export const COUNTS_KEY = ['counts'] as const;
/** Under COUNTS_KEY, so every refetch or invalidation of the counts covers it too (FR-RD-10). */
export const TOPIC_COUNTS_KEY = ['counts', 'topics'] as const;
export const entryKey = (id: string) => ['entry', id] as const;
export const entriesKey = (
  view: EntryListView,
  id: string | null,
  state: EntryListState,
  sort: EntrySort = 'newest',
  topic: string | null = null,
) => ['entries', view, id, state, sort, topic] as const;

const SECOND = 1000;
const MINUTE = 60 * SECOND;

export function useFolders(enabled = true) {
  return useQuery({
    queryKey: FOLDERS_KEY,
    queryFn: async ({ signal }) =>
      (await apiGet<FoldersResponse>('/api/folders', { signal })).items,
    staleTime: 5 * MINUTE,
    enabled,
  });
}

export const fetchSubscriptions = async (signal?: AbortSignal) =>
  (await apiGet<SubscriptionsResponse>('/api/subscriptions', signal ? { signal } : {})).items;

/** `refetchIntervalMs` is for the import screen's progress (FR-OP-3); false stops polling. */
export function useSubscriptions(enabled = true, refetchIntervalMs: number | false = false) {
  return useQuery({
    queryKey: SUBSCRIPTIONS_KEY,
    queryFn: ({ signal }) => fetchSubscriptions(signal),
    staleTime: 5 * MINUTE,
    enabled,
    refetchInterval: refetchIntervalMs,
  });
}

/**
 * FR-RD-10: counts are refetched on app focus, every 5 minutes while the app is visible (a
 * background tab does not poll), and after read-state changes (see `scheduleCountsRefetch`).
 */
export function useCounts() {
  return useQuery({
    queryKey: COUNTS_KEY,
    queryFn: ({ signal }) => apiGet<Counts>('/api/counts', { signal }),
    staleTime: 30 * SECOND,
    refetchOnWindowFocus: 'always',
    refetchInterval: 5 * MINUTE,
    refetchIntervalInBackground: false,
  });
}

/**
 * TID-078 (ADR 0021 amendment 3): unread per topic, for the chip row. Same cadence as `useCounts`, and it
 * sits under `COUNTS_KEY`, so the refetch after a read-state change covers it. `enabled` is false when the
 * row is not shown, so a person with no chips never pays for it.
 */
export function useTopicCounts(enabled: boolean) {
  return useQuery({
    queryKey: TOPIC_COUNTS_KEY,
    queryFn: ({ signal }) => apiGet<TopicCounts>('/api/counts/topics', { signal }),
    staleTime: 30 * SECOND,
    refetchOnWindowFocus: 'always',
    refetchInterval: 5 * MINUTE,
    refetchIntervalInBackground: false,
    enabled,
  });
}

let countsTimer: ReturnType<typeof setTimeout> | undefined;
/** FR-RD-10: after any read-state mutation, refetch the counts once things have settled (2 s). */
export function scheduleCountsRefetch(client: QueryClient, delayMs = 2000): void {
  clearTimeout(countsTimer);
  countsTimer = setTimeout(() => void client.invalidateQueries({ queryKey: COUNTS_KEY }), delayMs);
}

/**
 * One list view. Lists are not refetched on window focus or reconnect: FR-RD-4 says an article
 * read while the list is loaded stays in it, so rows never jump away under the thumb. They are
 * refreshed when the person comes back to the list from somewhere else, and by pull to refresh.
 */
export function useEntries(
  view: EntryListView,
  id: string | null,
  state: EntryListState,
  refetchOnMount: boolean | 'always',
  sort: EntrySort = 'newest',
  topic: string | null = null,
) {
  return useInfiniteQuery({
    queryKey: entriesKey(view, id, state, sort, topic),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      const q = new URLSearchParams({ view, state, limit: String(ENTRIES_PAGE_SIZE) });
      if (sort !== 'newest') q.set('sort', sort);
      if (id !== null) q.set('id', id);
      if (topic !== null) q.set('topic', topic);
      if (pageParam !== null) q.set('cursor', pageParam);
      return apiGet<EntriesResponse>(`/api/entries?${q.toString()}`, { signal });
    },
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 30 * SECOND,
    refetchOnMount,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

/** Drops everything after page 1, so the next refetch reads one page rather than every loaded page. */
export function trimToFirstPage(client: QueryClient, key: readonly unknown[]): void {
  client.setQueryData<InfiniteData<EntriesResponse, string | null>>(key, (data) =>
    data && data.pages.length > 1
      ? { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) }
      : data,
  );
}

/**
 * FR-RD-4: choosing another chip (or any change of the list's key) leaves the list. Before the list for
 * `key` is shown, what is cached for it is made fit to show: rows read since (in this list or in another
 * topic's view) are dropped when the list is unread-only, the pages after the first go, and the query is
 * marked stale so the observer fetches page 1 again. The cached rows still show meanwhile, so offline a
 * list opened before is not lost.
 */
export function refreshOnEnter(
  client: QueryClient,
  key: readonly unknown[],
  state: EntryListState,
): void {
  if (!client.getQueryData(key)) return;
  if (state === 'unread') {
    client.setQueryData<InfiniteData<EntriesResponse, string | null>>(key, (data) =>
      data?.pages.some((p) => p.items.some((i) => i.isRead))
        ? {
            ...data,
            pages: data.pages.map((p) => ({ ...p, items: p.items.filter((i) => !i.isRead) })),
          }
        : data,
    );
  }
  trimToFirstPage(client, key);
  void client.invalidateQueries({ queryKey: key, exact: true, refetchType: 'none' });
}

/**
 * One article (`['entry', id]`, spec 11.3). `placeholder` is the list's summary of it, shown while
 * the full entry loads; a placeholder has no content, so nothing is rendered from it but the header.
 */
export function useEntry(id: string, placeholder: () => Entry | undefined) {
  return useQuery<Entry>({
    queryKey: entryKey(id),
    queryFn: ({ signal }) => apiGet<Entry>(`/api/entries/${encodeURIComponent(id)}`, { signal }),
    staleTime: 30 * SECOND,
    placeholderData: placeholder,
    // A 4xx (not found, not yours) won't change on retry; show it at once (DEF-072).
    retry: (count, err) =>
      !(err instanceof ApiRequestError && err.status >= 400 && err.status < 500) && count < 3,
  });
}
