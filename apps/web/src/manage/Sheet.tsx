import { useEffect, useId, useRef, type ReactNode } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal sheet in the lower half of the screen (docs/ux/FLOWS.md 2.4), centred on wider screens.
 * Focus moves in on open, Tab stays inside, Escape and the scrim close it, and focus returns to
 * what opened it. Colours are tokens only.
 */
export function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // A confirm sheet marks its safe choice with data-autofocus so Enter can't delete by accident.
    const first =
      panel.current?.querySelector<HTMLElement>('[data-autofocus]') ??
      panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel.current)?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  // Document-level, so Escape and Tab work wherever focus is while the sheet is open.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div aria-hidden="true" onClick={onClose} className="absolute inset-0 bg-scrim" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative max-h-[85dvh] w-full max-w-md overflow-y-auto overscroll-contain rounded-t-lg bg-raised p-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-fg shadow-overlay sm:rounded-lg"
      >
        <h2 id={titleId} className="text-lg font-semibold text-fg">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

export const SHEET_BUTTON =
  'flex min-h-12 w-full items-center justify-center gap-2 rounded-md border border-line-strong bg-surface px-4 text-base font-medium text-fg';
export const SHEET_DANGER =
  'flex min-h-12 w-full items-center justify-center gap-2 rounded-md bg-danger px-4 text-base font-medium text-danger-fg';
