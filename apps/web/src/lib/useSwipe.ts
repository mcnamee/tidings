import { useEffect, useRef, type RefObject } from 'react';

/** Movement in px before the gesture picks a direction (vertical scrolling is never hijacked). */
export const SWIPE_LOCK_PX = 10;
/** Edge swipes must start this close to the left edge of the screen. */
export const SWIPE_EDGE_PX = 24;
/** px per ms. A release at or above this speed commits, if it also moved a little. */
export const FLICK_SPEED = 0.5;
const FLICK_MIN_PX = 20;
const SAMPLE_WINDOW_MS = 100;

/** True when the app runs as an installed app (home-screen icon), where the browser has no edge gestures of its own. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return (
    nav.standalone === true ||
    (typeof window.matchMedia === 'function' &&
      window.matchMedia('(display-mode: standalone)').matches)
  );
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export interface SwipeOptions {
  enabled: boolean;
  /** Which way the finger moves to make progress. */
  direction: 'right' | 'left';
  /** When set, the touch must start within this many px of the left edge. */
  edgePx?: number;
  /** Where to listen. The document when omitted. */
  target?: RefObject<HTMLElement | null>;
  /** The distance in px that counts as 100%. */
  extent: () => number;
  /** Release at or past this fraction (0..1) commits. */
  commitAt: number;
  /** The direction is locked: the gesture is a swipe from here on. Not called with reduced motion. */
  onStart?: () => void;
  /** Progress 0..1 while the finger moves. Not called with reduced motion. */
  onDrag?: (progress: number) => void;
  /** Released past the threshold or flicked. */
  onCommit: () => void;
  /** Released short of the threshold, or the browser took the touch. Only after `onStart`. */
  onCancel?: () => void;
}

interface Track {
  id: number;
  /** Which event stream drives this gesture. Touch events win when the browser sends both. */
  via: 'pointer' | 'touch';
  x0: number;
  y0: number;
  locked: boolean;
  baseX: number;
  samples: { t: number; x: number }[];
  progress: number;
}

/**
 * One horizontal swipe with no dependency. Touch events drive it where the browser has them
 * (iOS Safari ignores `touch-action: pan-y`, so pointer events alone get cancelled as soon as iOS
 * starts its own scroll or bounce); the `touchmove` listener is non-passive and calls
 * `preventDefault()` once the move is sideways, so the page does not scroll under the finger.
 * Pointer events (touch only) are the fallback. The direction locks after `SWIPE_LOCK_PX`: mostly
 * vertical, or the wrong way, and the gesture is dropped so the page scrolls as usual. With
 * `prefers-reduced-motion` nothing follows the finger: only the final commit is reported. While
 * enabled on the document it also sets `touch-action: pan-y pinch-zoom` on <html> (index.css) for
 * browsers that honour it; an element target needs `touch-action: pan-y` (`touch-pan-y`) itself.
 */
export function useSwipe(options: SwipeOptions): void {
  const opts = useRef(options);
  opts.current = options;
  const { enabled, target } = options;

  useEffect(() => {
    if (!enabled) return;
    const root: HTMLElement | Document = target?.current ?? document;
    const sign = opts.current.direction === 'right' ? 1 : -1;
    let track: Track | null = null;
    if (root === document) document.documentElement.classList.add('swipe-nav');

    const progressAt = (x: number) =>
      Math.min(
        1,
        Math.max(0, (sign * (x - (track?.baseX ?? 0))) / Math.max(1, opts.current.extent())),
      );
    const drop = () => {
      track = null;
    };

    function begin(id: number, via: Track['via'], x: number, y: number) {
      const edge = opts.current.edgePx;
      if (edge !== undefined && x > edge) return;
      track = { id, via, x0: x, y0: y, locked: false, baseX: x, samples: [], progress: 0 };
    }

    /** Returns true when the move belongs to a sideways swipe (the caller may block scrolling). */
    function moveTo(x: number, y: number): boolean {
      if (!track) return false;
      const dx = x - track.x0;
      const dy = y - track.y0;
      if (!track.locked) {
        if (Math.hypot(dx, dy) < SWIPE_LOCK_PX) return Math.abs(dx) > Math.abs(dy) && dx * sign > 0;
        if (Math.abs(dy) >= Math.abs(dx) || dx * sign <= 0) {
          drop();
          return false;
        }
        track.locked = true;
        track.baseX = x;
        if (!prefersReducedMotion()) opts.current.onStart?.();
      }
      const now = performance.now();
      track.samples.push({ t: now, x });
      while (track.samples.length > 2 && now - (track.samples[0]?.t ?? now) > SAMPLE_WINDOW_MS) {
        track.samples.shift();
      }
      track.progress = progressAt(x);
      if (!prefersReducedMotion()) opts.current.onDrag?.(track.progress);
      return true;
    }

    function finish() {
      if (!track) return;
      const done = track;
      drop();
      if (!done.locked) return;
      const first = done.samples[0];
      const last = done.samples[done.samples.length - 1];
      const speed =
        first && last && last.t > first.t ? (sign * (last.x - first.x)) / (last.t - first.t) : 0;
      const flick = speed >= FLICK_SPEED && done.progress * opts.current.extent() >= FLICK_MIN_PX;
      if (done.progress >= opts.current.commitAt || flick) opts.current.onCommit();
      else if (!prefersReducedMotion()) opts.current.onCancel?.();
    }

    function abort() {
      if (!track) return;
      const was = track.locked;
      drop();
      if (was && !prefersReducedMotion()) opts.current.onCancel?.();
    }

    // Pointer events (fallback; touch only).
    function pDown(ev: Event) {
      const e = ev as PointerEvent;
      if (e.pointerType !== 'touch') return;
      if (track) {
        if (track.via === 'pointer') drop(); // a second finger: not a swipe
        return;
      }
      if (e.isPrimary === false) return;
      begin(e.pointerId, 'pointer', e.clientX, e.clientY);
    }
    function pMove(e: PointerEvent) {
      if (track?.via === 'pointer' && e.pointerId === track.id) moveTo(e.clientX, e.clientY);
    }
    function pUp(e: PointerEvent) {
      if (track?.via === 'pointer' && e.pointerId === track.id) finish();
    }
    function pCancel(e: PointerEvent) {
      if (track?.via === 'pointer' && e.pointerId === track.id) abort();
    }

    // Touch events (preferred where they exist). They follow pointerdown in Chrome, so a touch
    // that starts a pointer-driven gesture takes it over.
    function tStart(ev: Event) {
      const e = ev as TouchEvent;
      if (e.touches.length > 1) return drop();
      const t = e.changedTouches[0];
      if (!t) return;
      if (track) {
        track.via = 'touch';
        track.id = t.identifier;
        return;
      }
      begin(t.identifier, 'touch', t.clientX, t.clientY);
    }
    function tMove(ev: Event) {
      const e = ev as TouchEvent;
      if (track?.via !== 'touch') return;
      const t = [...e.changedTouches].find((c) => c.identifier === track?.id);
      if (!t) return;
      if (moveTo(t.clientX, t.clientY) && e.cancelable) e.preventDefault();
    }
    function tEnd(ev: Event) {
      const e = ev as TouchEvent;
      if (track?.via !== 'touch') return;
      if ([...e.changedTouches].some((c) => c.identifier === track?.id)) finish();
    }
    function tCancel() {
      if (track?.via === 'touch') abort();
    }

    root.addEventListener('pointerdown', pDown);
    window.addEventListener('pointermove', pMove);
    window.addEventListener('pointerup', pUp);
    window.addEventListener('pointercancel', pCancel);
    root.addEventListener('touchstart', tStart, { passive: true });
    window.addEventListener('touchmove', tMove, { passive: false });
    window.addEventListener('touchend', tEnd);
    window.addEventListener('touchcancel', tCancel);
    return () => {
      root.removeEventListener('pointerdown', pDown);
      window.removeEventListener('pointermove', pMove);
      window.removeEventListener('pointerup', pUp);
      window.removeEventListener('pointercancel', pCancel);
      root.removeEventListener('touchstart', tStart);
      window.removeEventListener('touchmove', tMove);
      window.removeEventListener('touchend', tEnd);
      window.removeEventListener('touchcancel', tCancel);
      drop();
      if (root === document) document.documentElement.classList.remove('swipe-nav');
    };
  }, [enabled, target]);
}

/** Animates an element's transform and opacity to `to`, then clears the transition. CSSOM only (the CSP forbids style attributes). Returns the timer. */
export function settleTo(
  el: HTMLElement | null,
  to: { transform: string; opacity?: string },
  done?: () => void,
  ms = 200,
  ease = 'var(--ease-standard)',
): number {
  if (!el) {
    done?.();
    return 0;
  }
  const t = prefersReducedMotion() ? 0 : ms;
  el.style.transition = `transform ${t}ms ${ease}, opacity ${t}ms ${ease}`;
  el.style.transform = to.transform;
  if (to.opacity !== undefined) el.style.opacity = to.opacity;
  return window.setTimeout(() => {
    el.style.transition = '';
    done?.();
  }, t);
}
