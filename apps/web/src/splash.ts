/**
 * Launch screen timing (TID-059). The markup is #splash in index.html and paints before any JS.
 * It stays until BOTH: 1 s has passed since navigation start, and the app has rendered its first
 * real screen (splashAppReady). Then it fades out (250 ms) and is removed; with reduced motion it
 * is just removed. Under automation (navigator.webdriver) the minimum is skipped unless
 * window.__TIDINGS_SPLASH_MIN__ is set, which lets one E2E prove the real timing.
 */
export const SPLASH_MIN_MS = 1000; // owner, 2026-11-19: 1 s now the native launch image covers the start
export const SPLASH_FADE_MS = 250;

export interface SplashDeps {
  el: HTMLElement | null;
  /** Milliseconds since navigation start (performance.now()). */
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  reducedMotion: boolean;
  skipMin: boolean;
}

export function createSplash(deps: SplashDeps) {
  const { el } = deps;
  let ready = false;
  let minElapsed = deps.skipMin;
  let started = false;

  function remove() {
    el?.remove();
  }
  function tryDismiss() {
    if (!el || started || !ready || !minElapsed) return;
    started = true;
    if (deps.reducedMotion) return remove();
    el.classList.add('splash-out');
    deps.setTimeout(remove, SPLASH_FADE_MS);
  }
  if (!minElapsed) {
    deps.setTimeout(
      () => {
        minElapsed = true;
        tryDismiss();
      },
      Math.max(0, SPLASH_MIN_MS - deps.now()),
    );
  }
  return {
    appReady() {
      ready = true;
      tryDismiss();
    },
  };
}

let current: ReturnType<typeof createSplash> | null = null;

/** Call once at startup, before rendering. A no-op on a repeat call. */
export function startSplash() {
  if (current) return;
  const force = (window as { __TIDINGS_SPLASH_MIN__?: boolean }).__TIDINGS_SPLASH_MIN__ === true;
  current = createSplash({
    el: document.getElementById('splash'),
    now: () => performance.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    skipMin: navigator.webdriver === true && !force,
  });
}

/** The app has painted its first real screen. Safe to call more than once, or without a splash. */
export function splashAppReady() {
  current?.appReady();
}
