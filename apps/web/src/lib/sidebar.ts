import { useCallback, useState } from 'react';

// TID-062: whether the desktop sidebar is hidden, remembered per device (not per account).
export const SIDEBAR_HIDDEN_KEY = 'tidings.sidebarHidden';

export function readSidebarHidden(storage?: Pick<Storage, 'getItem'>): boolean {
  try {
    // Read the global inside the try: merely touching it can throw SecurityError.
    return (storage ?? localStorage).getItem(SIDEBAR_HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveSidebarHidden(hidden: boolean, storage?: Pick<Storage, 'setItem'>): void {
  try {
    (storage ?? localStorage).setItem(SIDEBAR_HIDDEN_KEY, hidden ? '1' : '0');
  } catch {
    // storage blocked: the choice just lasts until reload
  }
}

export function useSidebarHidden(): [boolean, () => void] {
  const [hidden, setHidden] = useState(() => readSidebarHidden());
  const toggle = useCallback(() => {
    const next = !hidden;
    saveSidebarHidden(next);
    setHidden(next);
  }, [hidden]);
  return [hidden, toggle];
}
