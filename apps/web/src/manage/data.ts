import { useQuery } from '@tanstack/react-query';
import type { Folder, FoldersResponse, Subscription, SubscriptionsResponse } from '@tidings/shared';
import { apiGet } from '../api';

/** Query keys shared by Manage, Add feed and the drawer's folder list. */
export const FOLDERS_KEY = ['folders'] as const;
export const SUBSCRIPTIONS_KEY = ['subscriptions'] as const;

export function useFolders() {
  return useQuery({
    queryKey: FOLDERS_KEY,
    queryFn: ({ signal }) => apiGet<FoldersResponse>('/api/folders', { signal }),
    staleTime: 5 * 60_000,
  });
}

export function useSubscriptions() {
  return useQuery({
    queryKey: SUBSCRIPTIONS_KEY,
    queryFn: ({ signal }) => apiGet<SubscriptionsResponse>('/api/subscriptions', { signal }),
    staleTime: 5 * 60_000,
  });
}

/** FR-FO-4: alphabetical, case-insensitive. */
const compare = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });

export function sortedFolders(items: Folder[] | undefined): Folder[] {
  return [...(items ?? [])].sort((a, b) => compare(a.name, b.name));
}

/** Subscriptions grouped by folder ID (null = top level), each group sorted by title. */
export function groupByFolder(
  items: Subscription[] | undefined,
): Map<string | null, Subscription[]> {
  const groups = new Map<string | null, Subscription[]>();
  for (const s of [...(items ?? [])].sort((a, b) => compare(a.title, b.title))) {
    const list = groups.get(s.folderId) ?? [];
    list.push(s);
    groups.set(s.folderId, list);
  }
  return groups;
}
