import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
  type RefObject,
} from 'react';
import { Lockup } from './Logo';
import { X } from 'lucide-react';
import { useSwipe } from '../lib/useSwipe';
import { FeedNav } from './FeedNav';
import { placeReveal, revealOpenness, settleReveal } from './reveal';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The drawer's width: `min(86vw, 20rem)`, the same as the panel's class. */
export function drawerWidth(): number {
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  return Math.min(window.innerWidth * 0.86, 20 * rem);
}

/** Lets the shell drag the drawer in from the screen edge (TID-055) before it is "open". */
export interface DrawerControl {
  /** 0 = closed (page at rest), 1 = fully open (page moved aside). */
  setOpenness(o: number): void;
  /** Animates to open or closed, then calls `done`. */
  settle(open: boolean, done?: () => void): void;
}

/**
 * Modal navigation drawer (docs/ux/screens/app-shell.md 2.2), in the reveal style (TID-075): the
 * panel is fixed underneath the page at its final position, and opening slides the page card aside
 * (`page`, with its `shade`) to uncover it. Rendered only while open, or while the shell is
 * dragging it in from the screen edge (`peeking`: no focus move, no scroll lock, no taps, no
 * entrance animation). A swipe left anywhere closes it (TID-035), dragging the page back.
 */
export function Drawer({
  onClose,
  page,
  shade,
  peeking = false,
  closing = false,
  control,
}: {
  onClose: () => void;
  /** The page card that slides aside, and the shade over it. Both belong to the shell. */
  page: RefObject<HTMLElement | null>;
  shade: RefObject<HTMLElement | null>;
  peeking?: boolean;
  /** Sliding out after it closed: out of the accessibility tree and the tab order already. */
  closing?: boolean;
  control?: Ref<DrawerControl>;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  // Decided once: a drawer that starts as a peek must not play its entrance when it becomes open.
  const [animateIn] = useState(!peeking);
  const timer = useRef(0);

  const width = () => panel.current?.offsetWidth || drawerWidth();
  const parts = () => ({ page: page.current, shade: shade.current, panel: panel.current });
  const setOpenness = (o: number) => placeReveal(parts(), 'left', o, width());
  const settle = (open: boolean, done?: () => void) => {
    window.clearTimeout(timer.current);
    timer.current = settleReveal(parts(), 'left', open, width(), done);
  };
  useImperativeHandle(control, () => ({ setOpenness, settle }));
  useEffect(() => () => window.clearTimeout(timer.current), []);

  // Opened by a tap: the page slides aside from where it is (a reopen during a slide-out starts
  // from the page's current place, not from closed).
  useLayoutEffect(() => {
    setOpenness(revealOpenness(page.current, 'left', width()));
    if (!animateIn) return; // a peek: the drag takes it from here
    void panel.current?.getBoundingClientRect(); // commit the start before the transition
    settle(true);
    // Once, when it mounts.
  }, []);

  // A turned phone changes the panel's width: keep the open page against its edge.
  useEffect(() => {
    if (peeking || closing) return;
    const onResize = () => placeReveal(parts(), 'left', 1, width());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [peeking, closing]);

  useSwipe({
    enabled: !peeking && !closing,
    direction: 'left',
    extent: width,
    commitAt: 0.4,
    onDrag: (p) => setOpenness(1 - p),
    onCommit: () => settle(false, onClose),
    onCancel: () => settle(true),
  });

  // Initial focus on Close; body scroll lock via a class on <html> (CSP forbids inline styles).
  useEffect(() => {
    if (peeking) return;
    closeButton.current?.focus({ preventScroll: true });
    document.documentElement.classList.add('scroll-locked');
    return () => document.documentElement.classList.remove('scroll-locked');
  }, [peeking]);

  // Escape closes; Tab and Shift+Tab cycle inside the drawer. A document-level listener keeps
  // the trap working even if focus has somehow escaped the panel.
  useEffect(() => {
    if (peeking) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !panel.current) return;
      const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      const outside = !panel.current.contains(active);
      if (e.shiftKey && (active === first || outside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || outside)) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, peeking]);

  return (
    <div
      ref={panel}
      id="nav-drawer"
      role="dialog"
      aria-modal="true"
      aria-label="Navigation"
      aria-hidden={closing || undefined}
      inert={closing}
      className={`fixed inset-y-0 left-0 z-0 flex w-[min(86vw,20rem)] touch-pan-y flex-col bg-raised pb-0 pl-[env(safe-area-inset-left)] pt-[env(safe-area-inset-top)] ${peeking ? 'pointer-events-none' : ''}`}
    >
      <div className="flex min-h-14 items-center justify-between pl-4 pr-1">
        <Lockup />
        <button
          ref={closeButton}
          type="button"
          aria-label="Close navigation"
          onClick={onClose}
          className="inline-flex size-11 items-center justify-center rounded-md text-fg"
        >
          <X aria-hidden="true" className="size-6" />
        </button>
      </div>
      <FeedNav replace />
    </div>
  );
}
