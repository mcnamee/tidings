import { useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, RefreshCw, X } from 'lucide-react';
import { DESKTOP_QUERY, useMediaQuery } from '../lib/hooks';
import { prefersReducedMotion, settleTo, useSwipe } from '../lib/useSwipe';
import { placeReveal, revealOpenness, settleReveal } from '../shell/reveal';
import { RevealContext } from '../shell/slots';

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
 * The list's filter panel (TID-074): a modal panel on the right, the mirror of the navigation
 * drawer. Local state only (no history entry), so the installed app's edge swipe can never
 * navigate away from it. Escape, a tap on the page strip, the close button and a swipe right close
 * it, and each slides it out (no animation with reduced motion).
 *
 * TID-075: below lg it is revealed like the drawer, mirrored: the panel is fixed underneath, at
 * its final position, and the page card slides LEFT to uncover it (the shell owns the card, its
 * shade and the page's inertness; it is told the panel's state through RevealContext). From lg the
 * page is a wide column beside the sidebar, which a sliding card would read badly against, so
 * there it stays the TID-074 overlay: a sheet over a scrim in a portal on <body>, the rest of the
 * page inert while it is up.
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
  const reveal = useContext(RevealContext);
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  // Without a shell around it (no RevealContext) or from lg: the overlay.
  const revealed = !!reveal && !isDesktop;
  const setPanel = reveal?.setPanel;
  const tap = reveal?.tap;
  // The shell has detached the page; only now may the panel animate.
  const held = revealed && reveal?.side === 'right';
  const [mounted, setMounted] = useState(open);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const timer = useRef(0);
  // A swipe already slid the panel out: the close that follows has nothing left to animate.
  const parked = useRef(false);
  const titleId = useId();
  const closing = mounted && !open;

  const width = () => panel.current?.offsetWidth || 320;
  const parts = () => ({
    page: reveal?.page.current ?? null,
    shade: reveal?.shade.current ?? null,
    panel: panel.current,
  });

  useEffect(() => {
    if (!open) return;
    setMounted(true);
    // Overlay: reopened while still sliding out, carry on from where it is, back in.
    if (!revealed && panel.current) {
      settleTo(scrim.current, { transform: '', opacity: '1' }, () => {
        if (scrim.current) scrim.current.style.opacity = '';
      });
      settleTo(panel.current, { transform: 'translateX(0)' }, () => {
        if (panel.current) panel.current.style.transform = '';
      });
    }
  }, [open, revealed]);

  // Overlay: slide out on every close; a swipe has already moved it off screen, so that one is instant.
  useEffect(() => {
    if (revealed || open || !mounted) return;
    const p = panel.current;
    if (!p || prefersReducedMotion() || p.style.transform === 'translateX(100%)') {
      setMounted(false);
      return;
    }
    settleTo(scrim.current, { transform: '', opacity: '0' });
    timer.current = settleTo(p, { transform: 'translateX(100%)' }, () => setMounted(false));
    return () => window.clearTimeout(timer.current);
  }, [open, mounted, revealed]);

  // Revealed: tell the shell what the panel is doing (it detaches the page, shades it, makes it
  // inert while open, and puts it back once the panel is gone). Layout effects, so the shell's
  // answer lands before the first paint.
  useLayoutEffect(() => {
    if (!revealed) return;
    setPanel?.(!mounted ? 'off' : open ? 'open' : 'closing');
  }, [revealed, setPanel, mounted, open]);
  useLayoutEffect(() => {
    if (!revealed) return;
    return () => setPanel?.('off');
  }, [revealed, setPanel]);

  // Revealed: the page slides aside from wherever it is (a reopen during the slide-out carries on
  // from there).
  useLayoutEffect(() => {
    if (!held || !open || !mounted) return;
    window.clearTimeout(timer.current);
    parked.current = false;
    placeReveal(
      parts(),
      'right',
      revealOpenness(reveal?.page.current ?? null, 'right', width()),
      width(),
    );
    void panel.current?.getBoundingClientRect(); // commit the start before the transition
    timer.current = settleReveal(parts(), 'right', true, width());
  }, [held, open, mounted]);

  // Revealed: every close slides the page back (a swipe already did).
  useEffect(() => {
    if (!revealed || open || !mounted) return;
    if (!held || prefersReducedMotion() || parked.current) {
      setMounted(false);
      return;
    }
    timer.current = settleReveal(parts(), 'right', false, width(), () => setMounted(false));
    return () => window.clearTimeout(timer.current);
  }, [revealed, held, open, mounted]);

  // Revealed: a tap on the visible strip of the page closes.
  useEffect(() => {
    if (!revealed || !tap || !open) return;
    tap.current = onClose;
    return () => {
      if (tap.current === onClose) tap.current = null;
    };
  }, [revealed, tap, open, onClose]);

  // Revealed: a turned phone changes the panel's width; keep the open page against its edge.
  useEffect(() => {
    if (!held || !open) return;
    const onResize = () => placeReveal(parts(), 'right', 1, width());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [held, open]);

  useSwipe({
    enabled: open && mounted && (!revealed || held),
    direction: 'right',
    // Revealed: anywhere on the page strip or the panel (the document). Overlay: the sheet's own box.
    target: revealed ? undefined : root,
    extent: width,
    commitAt: 0.4,
    onDrag: (p) => {
      if (revealed) {
        placeReveal(parts(), 'right', 1 - p, width());
        return;
      }
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
      if (revealed) {
        window.clearTimeout(timer.current);
        timer.current = settleReveal(parts(), 'right', false, width(), () => {
          parked.current = true;
          onClose();
        });
        return;
      }
      settleTo(scrim.current, { transform: '', opacity: '0' });
      timer.current = settleTo(panel.current, { transform: 'translateX(100%)' }, onClose);
    },
    onCancel: () => {
      if (revealed) {
        window.clearTimeout(timer.current);
        timer.current = settleReveal(parts(), 'right', true, width());
        return;
      }
      settleTo(scrim.current, { transform: '', opacity: '1' });
      settleTo(panel.current, { transform: 'translateX(0)' }, () => {
        if (panel.current) panel.current.style.transform = '';
        if (scrim.current) scrim.current.style.opacity = '';
      });
    },
  });

  // Focus moves in, the page behind goes inert, the document stops scrolling. (Revealed: the shell
  // makes the page's contents inert; here the other children of <body> are.)
  useEffect(() => {
    if (!open || !mounted || (revealed && !held)) return;
    closeButton.current?.focus({ preventScroll: true });
    document.documentElement.classList.add('scroll-locked');
    const others = revealed
      ? []
      : Array.from(document.body.children).filter(
          (el) => el !== root.current && !el.hasAttribute('inert'),
        );
    for (const el of others) el.setAttribute('inert', '');
    return () => {
      document.documentElement.classList.remove('scroll-locked');
      for (const el of others) el.removeAttribute('inert');
    };
  }, [open, mounted, revealed, held]);

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
  const content = (
    <>
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
    </>
  );
  if (revealed) {
    return createPortal(
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-hidden={closing || undefined}
        inert={closing}
        className="fixed inset-y-0 right-0 z-0 flex w-[min(86vw,20rem)] touch-pan-y flex-col bg-canvas pb-[env(safe-area-inset-bottom)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)]"
      >
        {content}
      </div>,
      document.body,
    );
  }
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
        {content}
      </div>
    </div>,
    document.body,
  );
}
