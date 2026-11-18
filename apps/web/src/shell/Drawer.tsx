import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { Lockup } from './Logo';
import { X } from 'lucide-react';
import { settleTo, useSwipe } from '../lib/useSwipe';
import { FeedNav } from './FeedNav';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The drawer's width: `min(86vw, 20rem)`, the same as the panel's class. */
export function drawerWidth(): number {
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  return Math.min(window.innerWidth * 0.86, 20 * rem);
}

/** Lets the shell drag the drawer in from the screen edge (TID-055) before it is "open". */
export interface DrawerControl {
  /** 0 = fully off screen, 1 = fully open. */
  setOpenness(o: number): void;
  /** Animates to open or closed, then calls `done`. */
  settle(open: boolean, done?: () => void): void;
}

/**
 * Modal navigation drawer (docs/ux/screens/app-shell.md 2.2). Rendered only while open, or while
 * the shell is dragging it in from the edge (`peeking`: no focus move, no scroll lock, no taps, no
 * entrance animation). A swipe left anywhere on it closes it (TID-035).
 */
export function Drawer({
  onClose,
  peeking = false,
  control,
}: {
  onClose: () => void;
  peeking?: boolean;
  control?: Ref<DrawerControl>;
}) {
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  // Decided once: a drawer that starts as a peek must not play its entrance when it becomes open.
  const [animateIn] = useState(!peeking);
  const timer = useRef(0);

  const setOpenness = (o: number) => {
    if (panel.current) {
      panel.current.style.transition = '';
      panel.current.style.transform = `translateX(${(o - 1) * 100}%)`;
    }
    if (scrim.current) {
      scrim.current.style.transition = '';
      scrim.current.style.opacity = String(o);
    }
  };
  const settle = (open: boolean, done?: () => void) => {
    window.clearTimeout(timer.current);
    settleTo(scrim.current, { transform: '', opacity: open ? '1' : '0' });
    timer.current = settleTo(
      panel.current,
      { transform: open ? 'translateX(0)' : 'translateX(-100%)' },
      () => {
        // Back to the stylesheet's own position once it is there.
        if (open && panel.current) panel.current.style.transform = '';
        if (open && scrim.current) scrim.current.style.opacity = '';
        done?.();
      },
    );
  };
  useImperativeHandle(control, () => ({ setOpenness, settle }));
  useEffect(() => () => window.clearTimeout(timer.current), []);

  useSwipe({
    enabled: !peeking,
    direction: 'left',
    target: root,
    extent: () => panel.current?.offsetWidth || drawerWidth(),
    commitAt: 0.4,
    onDrag: (p) => setOpenness(1 - p),
    onCommit: () => settle(false, onClose),
    onCancel: () => settle(true),
  });

  // Initial focus on Close; body scroll lock via a class on <html> (CSP forbids inline styles).
  useEffect(() => {
    if (peeking) return;
    closeButton.current?.focus();
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
      ref={root}
      className={`fixed inset-0 z-50 touch-pan-y ${peeking ? 'pointer-events-none' : ''}`}
    >
      <div
        ref={scrim}
        className={`${animateIn ? 'drawer-scrim ' : ''}absolute inset-0 bg-scrim`}
        aria-hidden="true"
        data-testid="drawer-scrim"
        onClick={onClose}
      />
      <div
        ref={panel}
        id="nav-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        className={`${animateIn ? 'drawer-panel ' : ''}absolute inset-y-0 left-0 flex w-[min(86vw,20rem)] flex-col border-r border-line bg-raised pb-0 pl-[env(safe-area-inset-left)] pt-[env(safe-area-inset-top)] shadow-raised`}
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
    </div>
  );
}
