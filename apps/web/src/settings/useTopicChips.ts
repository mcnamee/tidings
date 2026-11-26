import { useCallback, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { SessionResponse, User } from '@tidings/shared';
import { apiPatch } from '../api';
import { SESSION_KEY, useSession } from '../lib/session';
import { toast } from '../lib/toast';
import { topicChipsPref } from '../lib/topics';
import { withUser } from './useUpdateSettings';

/** Saves are batched: holding Move down sends one request, not ten (docs/ux/screens/topics.md 2.6). */
export const TOPIC_SAVE_DELAY_MS = 500;
export const TOPICS_SAVE_ERROR = "Couldn't save your topics. Try again.";

/**
 * The chosen chips and how they change (TID-078, FR-ST-5). A change shows at once, in the session's copy of the
 * setting that both this screen and the chip row on All articles read, and is sent as the whole ordered list
 * with `PATCH /api/me` after a short pause (the last change wins). Saves go out one at a time. If the server
 * refuses or can't be reached, the setting goes back to the last list the server accepted, with a toast.
 * A save still waiting when the screen closes is sent at once.
 */
export function useTopicChips(onRolledBack?: () => void) {
  const client = useQueryClient();
  const session = useSession();
  const chips = topicChipsPref(session.data?.user?.settings);

  const accepted = useRef<string[] | null>(null);
  const pending = useRef<string[] | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const rolledBack = useRef(onRolledBack);
  rolledBack.current = onRolledBack;

  const show = useCallback(
    (list: string[]) =>
      withUser(client, (u) => ({ ...u, settings: { ...u.settings, topicChips: list } })),
    [client],
  );

  const send = useCallback(
    (list: string[]) => {
      chain.current = chain.current.then(async () => {
        // A newer change is already waiting: it carries this one, so don't send both.
        if (pending.current !== null) return;
        try {
          await apiPatch<User>('/api/me', { settings: { topicChips: list } });
          accepted.current = list;
        } catch {
          if (pending.current !== null) return;
          show(accepted.current ?? []);
          toast.error(TOPICS_SAVE_ERROR, { duration: 8000 });
          rolledBack.current?.();
        }
      });
    },
    [show],
  );

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    const list = pending.current;
    pending.current = null;
    if (list !== null) send(list);
  }, [send]);

  const setChips = useCallback(
    (list: string[]) => {
      if (accepted.current === null) {
        accepted.current = topicChipsPref(
          client.getQueryData<SessionResponse>(SESSION_KEY)?.user?.settings,
        );
      }
      show(list);
      pending.current = list;
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, TOPIC_SAVE_DELAY_MS);
    },
    [client, show, flush],
  );

  // Leaving the screen sends what is waiting.
  useEffect(() => flush, [flush]);

  return { chips, setChips };
}
