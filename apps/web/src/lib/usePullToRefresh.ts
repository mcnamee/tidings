import { useEffect, useRef, useState } from 'react';

export type PullState = 'idle' | 'pulling' | 'ready' | 'refreshing';

/** Distance in px the finger must travel, damped, before releasing refreshes. */
export const PULL_THRESHOLD = 64;

/**
 * Pull to refresh (FR-RD-11) for a page that scrolls the window. Only a downward drag that starts
 * with the page scrolled to the top counts. `onRefresh` should refetch cached server data only.
 */
export function usePullToRefresh(onRefresh: () => Promise<unknown>, enabled = true): PullState {
  const [state, setState] = useState<PullState>('idle');
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;
  const mode = useRef<PullState>('idle');

  useEffect(() => {
    if (!enabled) return;
    let startY: number | null = null;
    const set = (s: PullState) => {
      mode.current = s;
      setState(s);
    };

    const onStart = (e: TouchEvent) => {
      if (mode.current === 'refreshing' || window.scrollY > 0 || e.touches.length !== 1) return;
      startY = e.touches[0]?.clientY ?? null;
    };
    const onMove = (e: TouchEvent) => {
      if (startY === null || mode.current === 'refreshing') return;
      const dy = ((e.touches[0]?.clientY ?? startY) - startY) * 0.5;
      if (dy <= 0 || window.scrollY > 0) {
        if (mode.current !== 'idle') set('idle');
        return;
      }
      const next = dy >= PULL_THRESHOLD ? 'ready' : 'pulling';
      if (next !== mode.current) set(next);
    };
    const onEnd = () => {
      const was = mode.current;
      startY = null;
      if (was === 'ready') {
        set('refreshing');
        void refresh.current().finally(() => set('idle'));
      } else if (was !== 'refreshing') {
        set('idle');
      }
    };

    const onCancel = () => {
      startY = null;
      if (mode.current !== 'refreshing') set('idle');
    };

    // Passive listeners: we never preventDefault, so scrolling is never blocked.
    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onCancel);
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onCancel);
    };
  }, [enabled]);

  return state;
}
