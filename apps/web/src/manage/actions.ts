import { useQueryClient } from '@tanstack/react-query';
import type {
  Folder,
  FolderRequest,
  FoldersResponse,
  Subscription,
  SubscriptionsResponse,
  UpdateSubscriptionRequest,
} from '@tidings/shared';
import { ApiRequestError, NetworkError, apiDelete, apiPatch, apiPost } from '../api';
import { toast } from '../lib/toast';
import { FOLDERS_KEY, SUBSCRIPTIONS_KEY } from './data';

export const COPY = {
  duplicate: 'You already have a folder with that name.',
  folderLimit: "You've reached the limit of 200 folders.",
  gone: 'That no longer exists. Reload the list and try again.',
  network: "Couldn't reach Tidings. Check your connection and try again.",
  rateLimited: 'Too many requests. Try again in a minute.',
  server: 'Something went wrong on our side. Try again.',
} as const;

/** The one fixed sentence shown for a failed write. Nothing from the server's text is shown. */
export function failureMessage(err: unknown): string {
  if (err instanceof NetworkError) return COPY.network;
  if (err instanceof ApiRequestError) {
    if (err.status === 409) return COPY.duplicate;
    if (err.status === 422 && err.code === 'limit_reached') return COPY.folderLimit;
    if (err.status === 404) return COPY.gone;
    if (err.status === 429) return COPY.rateLimited;
  }
  return COPY.server;
}

export type Result = { ok: true } | { ok: false; message: string };

/**
 * Writes for Manage (FLOWS 2.4). Create and rename wait for the server, because the answer can be
 * an inline error ("already exists"). Move, delete and unsubscribe are optimistic: the tree
 * updates at once and rolls back with an error toast if the request fails.
 */
export function useManageActions() {
  const client = useQueryClient();
  const refresh = (...keys: (readonly string[])[]) => {
    for (const queryKey of keys) void client.invalidateQueries({ queryKey });
  };
  const patchSubs = (fn: (items: Subscription[]) => Subscription[]) =>
    client.setQueryData<SubscriptionsResponse>(SUBSCRIPTIONS_KEY, (old) =>
      old ? { items: fn(old.items) } : old,
    );
  const patchFolders = (fn: (items: Folder[]) => Folder[]) =>
    client.setQueryData<FoldersResponse>(FOLDERS_KEY, (old) =>
      old ? { items: fn(old.items) } : old,
    );

  /** Runs an optimistic change; on failure restores both caches and says so. */
  async function optimistic(
    change: () => void,
    request: () => Promise<unknown>,
    failure: string,
  ): Promise<boolean> {
    const before = {
      folders: client.getQueryData<FoldersResponse>(FOLDERS_KEY),
      subs: client.getQueryData<SubscriptionsResponse>(SUBSCRIPTIONS_KEY),
    };
    change();
    try {
      await request();
      return true;
    } catch (err) {
      client.setQueryData(FOLDERS_KEY, before.folders);
      client.setQueryData(SUBSCRIPTIONS_KEY, before.subs);
      toast.error(err instanceof NetworkError ? COPY.network : failure);
      return false;
    } finally {
      refresh(FOLDERS_KEY, SUBSCRIPTIONS_KEY);
    }
  }

  return {
    async createFolder(name: string): Promise<Result> {
      try {
        const folder = await apiPost<Folder>('/api/folders', { name } satisfies FolderRequest);
        patchFolders((items) => [...items, folder]);
        refresh(FOLDERS_KEY);
        toast.success(`Created ${folder.name}`);
        return { ok: true };
      } catch (err) {
        return { ok: false, message: failureMessage(err) };
      }
    },

    async renameFolder(folder: Folder, name: string): Promise<Result> {
      try {
        const saved = await apiPatch<Folder>(`/api/folders/${folder.id}`, {
          name,
        } satisfies FolderRequest);
        patchFolders((items) => items.map((f) => (f.id === saved.id ? saved : f)));
        refresh(FOLDERS_KEY);
        return { ok: true };
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 404) refresh(FOLDERS_KEY);
        return { ok: false, message: failureMessage(err) };
      }
    },

    /** `title` null or blank clears the custom title (FR-SU-5). */
    async renameSubscription(sub: Subscription, title: string | null): Promise<Result> {
      try {
        const saved = await apiPatch<Subscription>(`/api/subscriptions/${sub.id}`, {
          title,
        } satisfies UpdateSubscriptionRequest);
        patchSubs((items) => items.map((s) => (s.id === saved.id ? saved : s)));
        refresh(SUBSCRIPTIONS_KEY);
        return { ok: true };
      } catch (err) {
        return { ok: false, message: failureMessage(err) };
      }
    },

    moveSubscription(sub: Subscription, folderId: string | null): Promise<boolean> {
      return optimistic(
        () => patchSubs((items) => items.map((s) => (s.id === sub.id ? { ...s, folderId } : s))),
        () =>
          apiPatch(`/api/subscriptions/${sub.id}`, {
            folderId,
          } satisfies UpdateSubscriptionRequest),
        "Couldn't move that feed. Try again.",
      );
    },

    async deleteFolder(folder: Folder): Promise<boolean> {
      const ok = await optimistic(
        () => {
          patchFolders((items) => items.filter((f) => f.id !== folder.id));
          patchSubs((items) =>
            items.map((s) => (s.folderId === folder.id ? { ...s, folderId: null } : s)),
          );
        },
        () => apiDelete(`/api/folders/${folder.id}`),
        "Couldn't delete that folder. Try again.",
      );
      if (ok) toast.success(`Deleted ${folder.name}`);
      return ok;
    },

    async unsubscribe(sub: Subscription): Promise<boolean> {
      const ok = await optimistic(
        () => patchSubs((items) => items.filter((s) => s.id !== sub.id)),
        () => apiDelete(`/api/subscriptions/${sub.id}`),
        "Couldn't unsubscribe. Try again.",
      );
      if (ok) {
        refresh(['counts'], ['entries']);
        toast.success(`Unsubscribed from ${sub.title}`);
      }
      return ok;
    },
  };
}
