import { useEffect } from 'react';
import { textSizePref, themePref } from './settings';
import { useSession } from './session';

/**
 * FR-ST-1, FR-ST-2: the theme and text size live on the server (they follow the owner across
 * devices) and are mirrored in localStorage so `theme-init.js` can set them before first paint.
 * Writing the mirror and firing `tidings:theme` is all it takes for the page to change: the init
 * script re-reads both keys and updates `<html data-theme>`, `data-text-size` and the meta tags.
 */
export const THEME_KEY = 'tidings.theme';
export const TEXT_SIZE_KEY = 'tidings.textSize';

function mirror(key: string, value: string): boolean {
  try {
    if (localStorage.getItem(key) === value) return false;
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false; // private mode or blocked storage: the server copy still applies on the next load
  }
}

/**
 * Keeps this device's mirror in line with the account's stored settings, on sign-in and after a
 * change made elsewhere. An account that has never chosen (no stored key) leaves the device alone.
 */
export function useSyncAppearance(): void {
  const settings = useSession().data?.user?.settings;
  const theme = settings?.theme === undefined ? undefined : themePref(settings);
  const size = settings?.textSize === undefined ? undefined : textSizePref(settings);
  useEffect(() => {
    if (theme !== undefined) mirror(THEME_KEY, theme);
    if (size !== undefined) mirror(TEXT_SIZE_KEY, size);
    if (theme !== undefined || size !== undefined) window.dispatchEvent(new Event('tidings:theme'));
  }, [theme, size]);
}
