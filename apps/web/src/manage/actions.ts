import { useQueryClient } from '@tanstack/react-query';
import type {
  ChangeFeedUrlRequest,
  ChangeFeedUrlResponse,
  FeedCandidate,
  Folder,
  FolderRequest,
  Subscription,
  UpdateSubscriptionRequest,
} from '@tidings/shared';
import { ApiRequestError, NetworkError, apiDelete, apiPatch, apiPost } from '../api';
import { toast } from '../lib/toast';
import { ADDRESS_COPY, existingId, isCandidates } from './feedAddress';
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

/** What the Change feed address sheet shows after the server answers (TID-068). */
export type ChangeAddressResult =
  | { ok: true; changed: boolean; fetch: ChangeFeedUrlResponse['fetch'] }
  | { ok: false; kind: 'choice'; candidates: FeedCandidate[] }
  | { ok: false; kind: 'already'; subscriptionId: string | null }
  /** `field`: the message is about the address and shows under the field. */
  | { ok: false; kind: 'message'; message: string; field: boolean };

/** The server waits up to 10 s to look at the address and 10 s for the first fetch. */
const CHANGE_ADDRESS_TIMEOUT_MS = 30_000;

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
    client.setQueryData<Subscription[]>(SUBSCRIPTIONS_KEY, (old) => (old ? fn(old) : old));
  const patchFolders = (fn: (items: Folder[]) => Folder[]) =>
    client.setQueryData<Folder[]>(FOLDERS_KEY, (old) => (old ? fn(old) : old));

  /** Runs an optimistic change; on failure restores both caches and says so. */
  async function optimistic(
    change: () => void,
    request: () => Promise<unknown>,
    failure: string,
  ): Promise<boolean> {
    const before = {
      folders: client.getQueryData<Folder[]>(FOLDERS_KEY),
      subs: client.getQueryData<Subscription[]>(SUBSCRIPTIONS_KEY),
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

    async moveSubscription(sub: Subscription, folderId: string | null): Promise<boolean> {
      const ok = await optimistic(
        () => patchSubs((items) => items.map((s) => (s.id === sub.id ? { ...s, folderId } : s))),
        () =>
          apiPatch(`/api/subscriptions/${sub.id}`, {
            folderId,
          } satisfies UpdateSubscriptionRequest),
        "Couldn't move that feed. Try again.",
      );
      // Folder unread counts and folder lists change with the move.
      if (ok) refresh(['counts'], ['entries']);
      return ok;
    },

    /**
     * Points the subscription at another feed address (TID-068). Waits for the server: the answer
     * can be a choice of feeds or an inline error, and a successful change runs the first fetch.
     */
    async changeFeedAddress(sub: Subscription, url: string): Promise<ChangeAddressResult> {
      try {
        const res = await apiPost<ChangeFeedUrlResponse>(
          `/api/subscriptions/${sub.id}/url`,
          { url } satisfies ChangeFeedUrlRequest,
          { timeoutMs: CHANGE_ADDRESS_TIMEOUT_MS },
        );
        patchSubs((items) =>
          items.map((s) => (s.id === res.subscription.id ? res.subscription : s)),
        );
        // The articles now belong to the same subscription under the new feed.
        refresh(SUBSCRIPTIONS_KEY, ['counts'], ['entries']);
        return { ok: true, changed: res.changed, fetch: res.fetch };
      } catch (err) {
        if (err instanceof NetworkError) {
          return { ok: false, kind: 'message', message: ADDRESS_COPY.network, field: false };
        }
        if (!(err instanceof ApiRequestError)) {
          return { ok: false, kind: 'message', message: ADDRESS_COPY.server, field: false };
        }
        switch (err.code) {
          case 'feed_choice_required':
            if (isCandidates(err.details)) {
              return { ok: false, kind: 'choice', candidates: err.details.candidates };
            }
            break;
          case 'no_feed_found':
            return { ok: false, kind: 'message', message: ADDRESS_COPY.noFeed, field: true };
          case 'blocked_address':
            return { ok: false, kind: 'message', message: ADDRESS_COPY.blocked, field: true };
          case 'validation_failed':
            return { ok: false, kind: 'message', message: ADDRESS_COPY.invalid, field: true };
          case 'already_subscribed':
            return { ok: false, kind: 'already', subscriptionId: existingId(err.details) };
          case 'rate_limited':
            return { ok: false, kind: 'message', message: ADDRESS_COPY.rateLimited, field: false };
          case 'not_found':
            refresh(SUBSCRIPTIONS_KEY);
            return { ok: false, kind: 'message', message: COPY.gone, field: false };
        }
        return { ok: false, kind: 'message', message: ADDRESS_COPY.server, field: false };
      }
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
      if (ok) {
        refresh(['counts'], ['entries']);
        toast.success(`Deleted ${folder.name}`);
      }
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
