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

/** Height the bar occupies above the safe-area inset; toasts sit above it. */
const BAR_HEIGHT = '3.5rem';

export function BottomBar({ children }: { children: ReactNode }) {
  const { bottomBar } = useContext(ShellSlotsContext);
  useEffect(() => {
    if (!bottomBar) return;
    document.documentElement.style.setProperty('--bottom-offset', BAR_HEIGHT);
    return () => {
      document.documentElement.style.removeProperty('--bottom-offset');
    };
  }, [bottomBar]);
  return bottomBar
    ? createPortal(
        <div className="mx-auto flex min-h-14 max-w-2xl items-center gap-2">{children}</div>,
        bottomBar,
      )
    : null;
}
