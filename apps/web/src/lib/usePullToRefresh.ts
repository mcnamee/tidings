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

/** True when the window is scrolled to the very end (sub-pixel rounding tolerated). */
export function atScrollEnd(): boolean {
  const root = document.documentElement;
  return window.scrollY + window.innerHeight >= root.scrollHeight - 1;
}

/**
 * Pull to refresh (FR-RD-11) and an iOS-style rubber band at both ends, for a page that scrolls the
 * window. A downward drag that starts with the page scrolled to the top is a pull; an upward drag
 * that reaches the end of the page (even mid-gesture, after the finger has scrolled there) keeps
 * stretching the content up. `onRefresh` should refetch cached server data only.
 *
 * Like a native app, the header and bottom bar never move: document bounce is off
 * (`overscroll-behavior-y: none`, index.css) and the drag moves `content` with a CSSOM transform,
 * with resistance (`dampen`). At the top it reveals the indicator that sits above it. It springs
 * back with the iOS ease on release, or rests at `REFRESH_HOLD` while refreshing. At the bottom
 * only the stretch happens (`state` stays idle). With reduced motion nothing is stretched, and
 * only the top pull changes `state`.
 *
 * The `touchmove` listener is non-passive but calls `preventDefault()` only while a stretch is
 * under way, so ordinary scrolling is never blocked. Sideways-dominant touches are ignored.
 * Momentum bounce at the end is not emulated: the browser gives no reliable end-of-fling signal
 * once document overscroll is off, and faking it risks jank.
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
    let startX = 0;
    let startY: number | null = null;
    let lastY = 0;
    let fromTop = false;
    let edge: 'none' | 'top' | 'bottom' = 'none';
    let anchor = 0;
    let timer = 0;
    const set = (s: PullState) => {
      mode.current = s;
      setState(s);
    };
    /** Moves the content by `px` (positive down); `ms` > 0 animates (release), 0 follows the finger. */
    const stretch = (px: number, ms = 0) => {
      const el = content?.current;
      if (!el || prefersReducedMotion()) return;
      window.clearTimeout(timer);
      el.style.transition = ms ? `transform ${ms}ms var(--ease-ios)` : '';
      el.style.transform = px !== 0 || ms ? `translateY(${px}px)` : '';
      if (ms) {
        timer = window.setTimeout(() => {
          el.style.transition = '';
          if (px === 0) el.style.transform = '';
        }, ms);
      }
    };
    const settle = () => {
      const was = edge;
      edge = 'none';
      set('idle');
      stretch(0, was === 'bottom' ? 350 : 250);
    };

    const onStart = (e: TouchEvent) => {
      if (mode.current === 'refreshing' || e.touches.length !== 1) {
        startY = null;
        return;
      }
      startY = lastY = e.touches[0]?.clientY ?? 0;
      startX = e.touches[0]?.clientX ?? 0;
      fromTop = window.scrollY <= 0;
      edge = 'none';
    };
    const onMove = (e: TouchEvent) => {
      if (startY === null || mode.current === 'refreshing') return;
      const y = e.touches[0]?.clientY ?? startY;
      const prev = lastY;
      lastY = y;
      // A sideways swipe (menu, back) is not a stretch: give it up for the rest of this touch.
      const across = Math.abs((e.touches[0]?.clientX ?? startX) - startX);
      if (edge === 'none' && across > Math.abs(y - startY)) {
        startY = null;
        return;
      }
      if (edge === 'none') {
        if (fromTop && window.scrollY <= 0 && y > startY) {
          edge = 'top';
          anchor = startY;
        } else if (!prefersReducedMotion() && atScrollEnd() && y < prev) {
          edge = 'bottom';
          anchor = prev;
        } else return;
      }
      const travel = edge === 'top' ? y - anchor : anchor - y;
      if (travel <= 0 || (edge === 'top' && window.scrollY > 0)) {
        edge = 'none';
        if (mode.current !== 'idle') set('idle');
        stretch(0);
        return;
      }
      if (e.cancelable) e.preventDefault();
      const d = dampen(travel);
      stretch(edge === 'top' ? d : -d);
      if (edge === 'bottom') return;
      const next = d >= PULL_THRESHOLD ? 'ready' : 'pulling';
      if (next !== mode.current) set(next);
    };
    const onEnd = () => {
      const was = mode.current;
      startY = null;
      if (was === 'ready') {
        edge = 'none';
        set('refreshing');
        stretch(REFRESH_HOLD, 200);
        void refresh.current().finally(() => {
          set('idle');
          stretch(0, 250);
        });
      } else if (was !== 'refreshing') {
        settle();
      }
    };

    const onCancel = () => {
      startY = null;
      if (mode.current !== 'refreshing') settle();
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
