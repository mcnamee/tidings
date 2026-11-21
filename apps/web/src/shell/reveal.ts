import { prefersReducedMotion } from '../lib/useSwipe';

/**
 * TID-075: the reveal style shared by the navigation drawer (left) and the filter panel (right).
 * The panel sits fixed underneath, at its final position; the page itself is a card that slides
 * aside to uncover it (and rounds the corners of the edge it uncovers, under a shade that fades
 * in). Everything is CSSOM (the CSP forbids style attributes), driven by one openness number:
 * 0 = closed (page at rest), 1 = open (page moved by the panel's width).
 */
export type RevealSide = 'left' | 'right';

/** Slide time for an open or close, and the iOS ease it uses (same as the article slide). */
export const REVEAL_MS = 300;
export const REVEAL_EASE = 'var(--ease-ios)';
/** The panel starts this fraction of its own width off to its side and slides to rest (parallax). */
export const PARALLAX = 0.3;
/** Opacity of the shade over the page at full openness (the scrim token is already translucent). */
export const SHADE_MAX = 0.7;
/** Corner radius in px of the page's revealing edge at full openness. */
export const CARD_RADIUS = 28;

export interface RevealParts {
  page: HTMLElement | null;
  shade: HTMLElement | null;
  panel: HTMLElement | null;
}

/** Which way the page moves: right to uncover the left drawer, left to uncover the right panel. */
const dir = (side: RevealSide) => (side === 'left' ? 1 : -1);

const transition = (props: string[], ms: number) =>
  ms > 0 ? props.map((p) => `${p} ${ms}ms ${REVEAL_EASE}`).join(', ') : '';

/** Puts page, shade and panel at openness `o` (0..1) for a panel `w` px wide, over `ms` (0 = now). */
export function placeReveal(
  { page, shade, panel }: RevealParts,
  side: RevealSide,
  o: number,
  w: number,
  ms = 0,
): void {
  const d = dir(side);
  const r = Math.round(o * CARD_RADIUS * 100) / 100;
  if (page) {
    page.style.transition = transition(['transform', 'border-radius'], ms);
    page.style.transform = `translateX(${d * o * w}px)`;
    page.style.borderRadius = side === 'left' ? `${r}px 0 0 ${r}px` : `0 ${r}px ${r}px 0`;
  }
  if (shade) {
    shade.style.transition = transition(['opacity'], ms);
    shade.style.opacity = String(Math.round(o * SHADE_MAX * 1000) / 1000);
  }
  if (panel) {
    panel.style.transition = transition(['transform'], ms);
    panel.style.transform = `translateX(${-d * (1 - o) * w * PARALLAX}px)`;
  }
}

/**
 * Animates to open or closed, then clears the transitions and calls `done`. Instant with reduced
 * motion. Returns the timer, so a caller can cancel it.
 */
export function settleReveal(
  parts: RevealParts,
  side: RevealSide,
  open: boolean,
  w: number,
  done?: () => void,
): number {
  const ms = prefersReducedMotion() ? 0 : REVEAL_MS;
  placeReveal(parts, side, open ? 1 : 0, w, ms);
  return window.setTimeout(() => {
    for (const el of [parts.page, parts.shade, parts.panel]) if (el) el.style.transition = '';
    done?.();
  }, ms);
}

/** How open the page is right now, read from its transform (mid-transition too), 0..1. */
export function revealOpenness(page: HTMLElement | null, side: RevealSide, w: number): number {
  if (!page || w <= 0) return 0;
  const t = getComputedStyle(page).transform || page.style.transform;
  const matrix = /matrix\(\s*[^,]+,[^,]+,[^,]+,[^,]+,\s*([-\d.e]+)/.exec(t);
  const plain = /translateX\(\s*([-\d.e]+)px/.exec(t);
  const x = parseFloat(matrix?.[1] ?? plain?.[1] ?? '0');
  return Math.min(1, Math.max(0, ((side === 'left' ? 1 : -1) * x) / w));
}
