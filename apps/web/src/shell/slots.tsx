import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// The header's right-hand actions and the bottom bar are the only parts of the shell a screen may
// fill (docs/ux/screens/app-shell.md 2.1). Screens render <HeaderActions> / <BottomBar>; the
// content is portalled into the shell's containers.
export interface ShellSlots {
  headerActions: HTMLElement | null;
  bottomBar: HTMLElement | null;
}

export const ShellSlotsContext = createContext<ShellSlots>({
  headerActions: null,
  bottomBar: null,
});

export function HeaderActions({ children }: { children: ReactNode }) {
  const { headerActions } = useContext(ShellSlotsContext);
  return headerActions ? createPortal(children, headerActions) : null;
}

/**
 * Publishes the bar's measured height as --bottom-offset so toasts sit 12 px above it, even when the
 * bar grows (large text, wrapped actions). The toast formula adds the safe-area inset itself, so the
 * bar's own bottom padding (that inset) is subtracted here. Removed when the bar unmounts.
 */
export function BottomBar({ children }: { children: ReactNode }) {
  const { bottomBar } = useContext(ShellSlotsContext);
  useEffect(() => {
    if (!bottomBar) return;
    const root = document.documentElement;
    const publish = () => {
      const inset = parseFloat(getComputedStyle(bottomBar).paddingBottom) || 0;
      root.style.setProperty('--bottom-offset', `${bottomBar.offsetHeight - inset}px`);
    };
    publish();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publish);
    observer?.observe(bottomBar);
    return () => {
      observer?.disconnect();
      root.style.removeProperty('--bottom-offset');
    };
  }, [bottomBar]);
  return bottomBar
    ? createPortal(
        <div className="mx-auto flex min-h-14 max-w-2xl flex-wrap items-center gap-2">
          {children}
        </div>,
        bottomBar,
      )
    : null;
}
