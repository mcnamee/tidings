import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, RefreshCw, X } from 'lucide-react';
import { prefersReducedMotion, settleTo, useSwipe } from '../lib/useSwipe';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function Switch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <li>
      <label className="flex min-h-12 cursor-pointer items-center gap-3 py-1">
        <span className="min-w-0 flex-1 text-base text-fg">{label}</span>
        <input
          type="checkbox"
          role="switch"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="size-6 shrink-0 accent-accent"
        />
      </label>
    </li>
  );
}

/**
 * The list's filter panel (TID-074): a modal sheet that slides in from the right, the mirror of the
 * navigation drawer. Local state only (no history entry), so the installed app's edge swipe can
 * never navigate away from it. Escape, the scrim, the close button and a swipe right close it, and
 * each slides it out (no animation with reduced motion). Rendered in a portal on <body>, with the
 * rest of the page inert while it is up.
 */
export function FilterPanel({
  open,
  onClose,
  unreadOnly,
  onUnreadOnly,
  recommended,
  onRecommended,
  refreshing,
  onRefresh,
}: {
  open: boolean;
  onClose: () => void;
  unreadOnly: boolean;
  onUnreadOnly: (next: boolean) => void;
  /** Whether Recommended order is on; null when it does not apply (the list is not unread only). */
  recommended: boolean | null;
  onRecommended: (next: boolean) => void;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const [mounted, setMounted] = useState(open);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const timer = useRef(0);
  const titleId = useId();
  const closing = mounted && !open;

  useEffect(() => {
    if (!open) return;
    setMounted(true);
    // Reopened while still sliding out: carry on from where it is, back in.
    if (panel.current) {
      settleTo(scrim.current, { transform: '', opacity: '1' }, () => {
        if (scrim.current) scrim.current.style.opacity = '';
      });
      settleTo(panel.current, { transform: 'translateX(0)' }, () => {
        if (panel.current) panel.current.style.transform = '';
      });
    }
  }, [open]);

  // Slide out on every close; a swipe has already moved it off screen, so that one is instant.
  useEffect(() => {
    if (open || !mounted) return;
    const p = panel.current;
    if (!p || prefersReducedMotion() || p.style.transform === 'translateX(100%)') {
      setMounted(false);
      return;
    }
    settleTo(scrim.current, { transform: '', opacity: '0' });
    timer.current = settleTo(p, { transform: 'translateX(100%)' }, () => setMounted(false));
    return () => window.clearTimeout(timer.current);
  }, [open, mounted]);

  useSwipe({
    enabled: open && mounted,
    direction: 'right',
    target: root,
    extent: () => panel.current?.offsetWidth || 320,
    commitAt: 0.4,
    onDrag: (p) => {
      if (panel.current) {
        panel.current.style.transition = '';
        panel.current.style.transform = `translateX(${p * 100}%)`;
      }
      if (scrim.current) {
        scrim.current.style.transition = '';
        scrim.current.style.opacity = String(1 - p);
      }
    },
    onCommit: () => {
      settleTo(scrim.current, { transform: '', opacity: '0' });
      timer.current = settleTo(panel.current, { transform: 'translateX(100%)' }, onClose);
    },
    onCancel: () => {
      settleTo(scrim.current, { transform: '', opacity: '1' });
      settleTo(panel.current, { transform: 'translateX(0)' }, () => {
        if (panel.current) panel.current.style.transform = '';
        if (scrim.current) scrim.current.style.opacity = '';
      });
    },
  });

  // Focus moves in, the page behind goes inert, the document stops scrolling.
  useEffect(() => {
    if (!open || !mounted) return;
    closeButton.current?.focus();
    document.documentElement.classList.add('scroll-locked');
    const others = Array.from(document.body.children).filter(
      (el) => el !== root.current && !el.hasAttribute('inert'),
    );
    for (const el of others) el.setAttribute('inert', '');
    return () => {
      document.documentElement.classList.remove('scroll-locked');
      for (const el of others) el.removeAttribute('inert');
    };
  }, [open, mounted]);

  // Escape closes; Tab cycles inside the panel.
  useEffect(() => {
    if (!open || !mounted) return;
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
  }, [open, mounted, onClose]);

  if (!mounted) return null;
  return createPortal(
    <div
      ref={root}
      aria-hidden={closing || undefined}
      inert={closing}
      className="fixed inset-0 z-50 touch-pan-y"
    >
      <div
        ref={scrim}
        className="drawer-scrim absolute inset-0 bg-scrim"
        aria-hidden="true"
        data-testid="filter-scrim"
        onClick={onClose}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="filter-panel absolute inset-y-0 right-0 flex w-[min(86vw,20rem)] flex-col border-l border-line bg-raised pb-[env(safe-area-inset-bottom)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)] shadow-raised"
      >
        <div className="flex min-h-14 items-center justify-between pl-4 pr-1">
          <h2 id={titleId} className="text-lg font-semibold text-fg">
            Filters
          </h2>
          <button
            ref={closeButton}
            type="button"
            aria-label="Close filters"
            onClick={onClose}
            className="inline-flex size-11 items-center justify-center rounded-md text-fg"
          >
            <X aria-hidden="true" className="size-6" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 pb-4">
          <ul>
            <Switch label="Unread only" checked={unreadOnly} onChange={onUnreadOnly} />
            {recommended !== null && (
              <Switch label="Recommended order" checked={recommended} onChange={onRecommended} />
            )}
          </ul>
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-line-strong bg-surface px-4 text-base font-medium text-fg active:bg-sunken disabled:text-fg-muted"
          >
            {refreshing ? (
              <Loader2 aria-hidden="true" className="size-5 animate-spin" />
            ) : (
              <RefreshCw aria-hidden="true" className="size-5" strokeWidth={1.75} />
            )}
            Refresh
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
