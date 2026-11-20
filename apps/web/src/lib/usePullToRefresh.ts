import { useEffect, useRef, useState, type RefObject } from 'react';
import { prefersReducedMotion } from './useSwipe';

export type PullState = 'idle' | 'pulling' | 'ready' | 'refreshing';

/** Distance in px the content must be pulled down before releasing refreshes. */
export const PULL_THRESHOLD = 64;
/** The content rests this far down while the refresh runs (touch fallback), showing the indicator. */
export const REFRESH_HOLD = 48;
/** Past the threshold the stretch gets stiffer and approaches this many extra px. */
const OVERSHOOT = 40;

/** Finger travel in px to content stretch in px: half as far, then stiffer past the threshold. */
export function dampen(travel: number): number {
  const d = travel * 0.5;
  if (d <= PULL_THRESHOLD) return d;
  return PULL_THRESHOLD + OVERSHOOT * (1 - Math.exp(-(d - PULL_THRESHOLD) / OVERSHOOT));
}

/** iOS and iPadOS (which reports as a Mac with a touch screen): WebKit scrollers rubber-band natively. */
export function isIOSLike(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (
    /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

export interface PullToRefresh {
  state: PullState;
  /** The browser's own rubber band does the stretching (scrollTop goes negative); nothing is transformed. */
  native: boolean;
}

/**
 * Pull to refresh (FR-RD-11). `onRefresh` should refetch cached server data only.
 *
 * The window is the scroller (TID-069: below `lg` the document scrolls under a fixed header and
 * bottom bar, so a status-bar tap works).
 *
 * Native mode (iOS, or as soon as a scroll event reports a negative scrollY): the document's own
 * rubber band does the stretching, with real momentum, and the fixed header never moves. The pull
 * distance is `-scrollY`; past `PULL_THRESHOLD`, while a finger is still down, the state is
 * `ready`, and lifting the finger refreshes. A fling that bounces with no finger down never does.
 *
 * Touch fallback (Chromium, Android, anywhere scrollY cannot go negative): a downward drag that
 * starts with the page at the top moves `content` with a CSSOM transform, with resistance
 * (`dampen`), springs back with the iOS ease on release, or rests at `REFRESH_HOLD` while
 * refreshing. The `touchmove` listener is non-passive but calls `preventDefault()` only while a
 * pull is under way, so ordinary scrolling is never blocked. Sideways-dominant touches are ignored.
 * With reduced motion nothing is stretched, and only `state` changes.
 */
export function usePullToRefresh(
  onRefresh: () => Promise<unknown>,
  enabled: boolean,
  content?: RefObject<HTMLElement | null>,
): PullToRefresh {
  const [state, setState] = useState<PullState>('idle');
  const [native, setNative] = useState(isIOSLike);
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;
  const mode = useRef<PullState>('idle');
  const isNative = useRef(native);

  useEffect(() => {
    if (!enabled) return;
    const target: Window = window;
    const top = () => window.scrollY;
    let startX = 0;
    let startY: number | null = null;
    let touching = false;
    let pulling = false;
    let timer = 0;
    const set = (s: PullState) => {
      mode.current = s;
      setState(s);
    };
    const useNative = () => isNative.current;
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
      pulling = false;
      set('idle');
      stretch(0, 250);
    };
    const startRefresh = () => {
      pulling = false;
      set('refreshing');
      if (!useNative()) stretch(REFRESH_HOLD, 200);
      void refresh.current().finally(() => {
        set('idle');
        if (!useNative()) stretch(0, 250);
      });
    };

    const onStart = (e: Event) => {
      const t = e as TouchEvent;
      touching = t.touches.length > 0;
      if (mode.current === 'refreshing' || t.touches.length !== 1) {
        startY = null;
        return;
      }
      startY = t.touches[0]?.clientY ?? 0;
      startX = t.touches[0]?.clientX ?? 0;
      pulling = false;
    };
    const onMove = (e: Event) => {
      const t = e as TouchEvent;
      if (useNative() || startY === null || mode.current === 'refreshing') return;
      const y = t.touches[0]?.clientY ?? startY;
      // A sideways swipe (menu, back) is not a pull: give it up for the rest of this touch.
      const across = Math.abs((t.touches[0]?.clientX ?? startX) - startX);
      if (!pulling && across > Math.abs(y - startY)) {
        startY = null;
        return;
      }
      if (!pulling) {
        if (top() <= 0 && y > startY) pulling = true;
        else return;
      }
      const travel = y - startY;
      if (travel <= 0 || top() > 0) {
        pulling = false;
        if (mode.current !== 'idle') set('idle');
        stretch(0);
        return;
      }
      if (t.cancelable) t.preventDefault();
      const d = dampen(travel);
      stretch(d);
      const next = d >= PULL_THRESHOLD ? 'ready' : 'pulling';
      if (next !== mode.current) set(next);
    };
    /** Native: the scroller is overscrolled (scrollTop < 0) while the finger is down. */
    const onScroll = () => {
      const t = top();
      if (t < 0 && !isNative.current) {
        isNative.current = true;
        setNative(true);
      }
      if (!isNative.current || mode.current === 'refreshing') return;
      if (!touching || t >= 0) {
        if (mode.current !== 'idle') set('idle');
        return;
      }
      const next = -t >= PULL_THRESHOLD ? 'ready' : 'pulling';
      if (next !== mode.current) set(next);
    };
    const onEnd = (e: Event) => {
      touching = (e as TouchEvent).touches.length > 0;
      startY = null;
      if (touching) return;
      const was = mode.current;
      if (was === 'ready') startRefresh();
      else if (was !== 'refreshing') settle();
    };
    const onCancel = () => {
      touching = false;
      startY = null;
      if (mode.current !== 'refreshing') settle();
    };

    target.addEventListener('touchstart', onStart, { passive: true });
    target.addEventListener('touchmove', onMove, { passive: false });
    target.addEventListener('touchend', onEnd);
    target.addEventListener('touchcancel', onCancel);
    target.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      target.removeEventListener('touchstart', onStart);
      target.removeEventListener('touchmove', onMove);
      target.removeEventListener('touchend', onEnd);
      target.removeEventListener('touchcancel', onCancel);
      target.removeEventListener('scroll', onScroll);
      window.clearTimeout(timer);
      const el = content?.current;
      if (el) {
        el.style.transition = '';
        el.style.transform = '';
      }
    };
  }, [enabled, content]);

  return { state, native };
}
