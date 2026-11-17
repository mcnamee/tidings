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
  type EntryListView,
  type FoldersResponse,
  type SubscriptionsResponse,
} from '@tidings/shared';
import { apiGet } from '../api';

// Query keys and cache rules from spec 11.3.
export const FOLDERS_KEY = ['folders'] as const;
export const SUBSCRIPTIONS_KEY = ['subscriptions'] as const;
export const COUNTS_KEY = ['counts'] as const;
export const entriesKey = (view: EntryListView, id: string | null, state: EntryListState) =>
  ['entries', view, id, state] as const;

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
) {
  return useInfiniteQuery({
    queryKey: entriesKey(view, id, state),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      const q = new URLSearchParams({ view, state, limit: String(ENTRIES_PAGE_SIZE) });
      if (id !== null) q.set('id', id);
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
