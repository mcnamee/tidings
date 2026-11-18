import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { SessionResponse, User, UserSettings } from '@tidings/shared';
import { apiPatch } from '../api';
import { SESSION_KEY } from '../lib/session';
import { toast } from '../lib/toast';

const APPEARANCE_DEFAULTS: Record<string, string> = { theme: 'system', textSize: 'm' };

function withUser(client: ReturnType<typeof useQueryClient>, change: (u: User) => User) {
  client.setQueryData<SessionResponse>(SESSION_KEY, (old) =>
    old?.user ? { ...old, user: change(old.user) } : old,
  );
}

/**
 * `PATCH /api/me` for one or more settings. The change shows at once (the session's copy of the
 * user is the single source every screen reads, and the theme mirror follows it); if the server
 * refuses or can't be reached, only the keys in this change go back, with a toast.
 */
export function useUpdateSettings(): (patch: UserSettings) => Promise<boolean> {
  const client = useQueryClient();
  return useCallback(
    async (patch) => {
      const before = client.getQueryData<SessionResponse>(SESSION_KEY)?.user?.settings ?? {};
      withUser(client, (u) => ({ ...u, settings: { ...u.settings, ...patch } }));
      try {
        await apiPatch<User>('/api/me', { settings: patch });
        return true;
      } catch {
        withUser(client, (u) => {
          const settings: Record<string, unknown> = { ...u.settings };
          for (const key of Object.keys(patch)) {
            if (key in before) settings[key] = (before as Record<string, unknown>)[key];
            // Never chosen before: the device mirror goes back to the default, not the failed choice.
            else if (key in APPEARANCE_DEFAULTS) settings[key] = APPEARANCE_DEFAULTS[key];
            else delete settings[key];
          }
          return { ...u, settings: settings as UserSettings };
        });
        toast.error("Couldn't save that setting. Check your connection and try again.");
        return false;
      }
    },
    [client],
  );
}

/** Renames the account (FR-ST-3). Returns the server's answer, or a sentence to show. */
export function useRenameAccount(): (name: string) => Promise<string | null> {
  const client = useQueryClient();
  return useCallback(
    async (displayName) => {
      try {
        const user = await apiPatch<User>('/api/me', { displayName });
        withUser(client, (u) => ({ ...u, displayName: user.displayName }));
        return null;
      } catch {
        return "Couldn't save your name. Check your connection and try again.";
      }
    },
    [client],
  );
}
