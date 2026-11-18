import { useEffect, useRef, useState, type RefObject } from 'react';
import { prefersReducedMotion } from './useSwipe';

export type PullState = 'idle' | 'pulling' | 'ready' | 'refreshing';

/** Distance in px the content must be stretched down before releasing refreshes. */
export const PULL_THRESHOLD = 64;
/** The content rests this far down while the refresh runs, showing the indicator. */
export const REFRESH_HOLD = 48;
/** Past the threshold the stretch gets stiffer and approaches this many extra px. */
const OVERSHOOT = 40;

/** Finger travel in px to content stretch in px: half as far, then stiffer past the threshold. */
export function dampen(travel: number): number {
  const d = travel * 0.5;
  if (d <= PULL_THRESHOLD) return d;
  return PULL_THRESHOLD + OVERSHOOT * (1 - Math.exp(-(d - PULL_THRESHOLD) / OVERSHOOT));
}

/**
 * Pull to refresh (FR-RD-11) for a page that scrolls the window. Only a downward drag that starts
 * with the page scrolled to the top counts. `onRefresh` should refetch cached server data only.
 *
 * Like a native app, the header never moves: document bounce is off (`overscroll-behavior-y: none`,
 * index.css) and the drag stretches `content` down with a CSSOM transform, with resistance,
 * revealing the indicator that sits above it. It springs back on release, or rests at
 * `REFRESH_HOLD` while refreshing. With reduced motion nothing is stretched, only `state` changes.
 *
 * The `touchmove` listener is non-passive but calls `preventDefault()` only while a downward pull
 * from the top is under way, so ordinary scrolling is never blocked.
 */
export function usePullToRefresh(
  onRefresh: () => Promise<unknown>,
  enabled = true,
  content?: RefObject<HTMLElement | null>,
): PullState {
  const [state, setState] = useState<PullState>('idle');
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;
  const mode = useRef<PullState>('idle');

  useEffect(() => {
    if (!enabled) return;
    let startY: number | null = null;
    let timer = 0;
    const set = (s: PullState) => {
      mode.current = s;
      setState(s);
    };
    /** Moves the content; `ms` > 0 animates (release), 0 follows the finger. */
    const stretch = (px: number, ms = 0) => {
      const el = content?.current;
      if (!el || prefersReducedMotion()) return;
      window.clearTimeout(timer);
      el.style.transition = ms ? `transform ${ms}ms var(--ease-standard)` : '';
      el.style.transform = px > 0 || ms ? `translateY(${px}px)` : '';
      if (ms) {
        timer = window.setTimeout(() => {
          el.style.transition = '';
          if (px === 0) el.style.transform = '';
        }, ms);
      }
    };

    const onStart = (e: TouchEvent) => {
      if (mode.current === 'refreshing' || window.scrollY > 0 || e.touches.length !== 1) return;
      startY = e.touches[0]?.clientY ?? null;
    };
    const onMove = (e: TouchEvent) => {
      if (startY === null || mode.current === 'refreshing') return;
      const travel = (e.touches[0]?.clientY ?? startY) - startY;
      if (travel <= 0 || window.scrollY > 0) {
        if (mode.current !== 'idle') {
          set('idle');
          stretch(0);
        }
        return;
      }
      if (e.cancelable) e.preventDefault();
      const d = dampen(travel);
      stretch(d);
      const next = d >= PULL_THRESHOLD ? 'ready' : 'pulling';
      if (next !== mode.current) set(next);
    };
    const onEnd = () => {
      const was = mode.current;
      startY = null;
      if (was === 'ready') {
        set('refreshing');
        stretch(REFRESH_HOLD, 200);
        void refresh.current().finally(() => {
          set('idle');
          stretch(0, 250);
        });
      } else if (was !== 'refreshing') {
        set('idle');
        stretch(0, 250);
      }
    };

    const onCancel = () => {
      startY = null;
      if (mode.current !== 'refreshing') {
        set('idle');
        stretch(0, 250);
      }
    };

    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onCancel);
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onCancel);
      window.clearTimeout(timer);
      const el = content?.current;
      if (el) {
        el.style.transition = '';
        el.style.transform = '';
      }
    };
  }, [enabled, content]);

  return state;
}
