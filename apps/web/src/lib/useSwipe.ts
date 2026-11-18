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
  x0: number;
  y0: number;
  locked: boolean;
  baseX: number;
  samples: { t: number; x: number }[];
  progress: number;
}

/**
 * One horizontal swipe, with pointer events (touch only) and no dependency. The direction locks
 * after `SWIPE_LOCK_PX`: mostly vertical, or the wrong way, and the gesture is dropped so the page
 * scrolls as usual. With `prefers-reduced-motion` nothing follows the finger: only the final
 * commit is reported. While enabled on the document it sets `touch-action: pan-y pinch-zoom` on
 * <html> (index.css), so the browser leaves horizontal moves to us; an element target needs
 * `touch-action: pan-y` (Tailwind `touch-pan-y`) itself.
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
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };

    function down(ev: Event) {
      const e = ev as PointerEvent;
      if (track) return drop(); // a second finger: not a swipe
      if (e.pointerType !== 'touch' || e.isPrimary === false) return;
      const edge = opts.current.edgePx;
      if (edge !== undefined && e.clientX > edge) return;
      track = {
        id: e.pointerId,
        x0: e.clientX,
        y0: e.clientY,
        locked: false,
        baseX: e.clientX,
        samples: [],
        progress: 0,
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', cancel);
    }

    function move(e: PointerEvent) {
      if (!track || e.pointerId !== track.id) return;
      const dx = e.clientX - track.x0;
      const dy = e.clientY - track.y0;
      if (!track.locked) {
        if (Math.hypot(dx, dy) < SWIPE_LOCK_PX) return;
        if (Math.abs(dy) >= Math.abs(dx) || dx * sign <= 0) return drop();
        track.locked = true;
        track.baseX = e.clientX;
        if (!prefersReducedMotion()) opts.current.onStart?.();
      }
      const now = performance.now();
      track.samples.push({ t: now, x: e.clientX });
      while (track.samples.length > 2 && now - (track.samples[0]?.t ?? now) > SAMPLE_WINDOW_MS) {
        track.samples.shift();
      }
      track.progress = progressAt(e.clientX);
      if (!prefersReducedMotion()) opts.current.onDrag?.(track.progress);
    }

    function up(e: PointerEvent) {
      if (!track || e.pointerId !== track.id) return;
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

    function cancel(e: PointerEvent) {
      if (!track || e.pointerId !== track.id) return;
      const was = track.locked;
      drop();
      if (was && !prefersReducedMotion()) opts.current.onCancel?.();
    }

    root.addEventListener('pointerdown', down);
    return () => {
      root.removeEventListener('pointerdown', down);
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
): number {
  if (!el) {
    done?.();
    return 0;
  }
  const t = prefersReducedMotion() ? 0 : ms;
  el.style.transition = `transform ${t}ms var(--ease-standard), opacity ${t}ms var(--ease-standard)`;
  el.style.transform = to.transform;
  if (to.opacity !== undefined) el.style.opacity = to.opacity;
  return window.setTimeout(() => {
    el.style.transition = '';
    done?.();
  }, t);
}
