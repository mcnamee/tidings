import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { FeedNav } from './FeedNav';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Modal navigation drawer (docs/ux/screens/app-shell.md 2.2). Rendered only while open. */
export function Drawer({ onClose }: { onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  // Initial focus on Close; body scroll lock via a class on <html> (CSP forbids inline styles).
  useEffect(() => {
    closeButton.current?.focus();
    document.documentElement.classList.add('scroll-locked');
    return () => document.documentElement.classList.remove('scroll-locked');
  }, []);

  // Escape closes; Tab and Shift+Tab cycle inside the drawer. A document-level listener keeps
  // the trap working even if focus has somehow escaped the panel.
  useEffect(() => {
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
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50">
      <div
        className="drawer-scrim absolute inset-0 bg-scrim"
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
        className="drawer-panel absolute inset-y-0 left-0 flex w-[min(86vw,20rem)] flex-col border-r border-line bg-raised pb-0 pl-[env(safe-area-inset-left)] pt-[env(safe-area-inset-top)] shadow-raised"
      >
        <div className="flex min-h-14 items-center justify-between pl-4 pr-1">
          <span className="text-lg font-semibold text-fg">Tidings</span>
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
