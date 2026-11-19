import type { EntryListState, EntrySort, SessionResponse } from '@tidings/shared';

// Spec 6.2 defaults. The stored document may be missing keys or hold junk, so each read is checked.
type Settings = NonNullable<SessionResponse['user']>['settings'];

export function unreadOnlyDefault(settings: Settings | undefined): boolean {
  return settings?.unreadOnly !== false;
}

/**
 * TID-067: the list order the person chose (`listSort`, default newest first), kept across devices.
 * Recommended orders unread lists only, so any other list asks for newest.
 */
export function listSortPref(settings: Settings | undefined): EntrySort {
  return settings?.listSort === 'recommended' ? 'recommended' : 'newest';
}

export function effectiveSort(settings: Settings | undefined, state: EntryListState): EntrySort {
  return state === 'unread' ? listSortPref(settings) : 'newest';
}

export function hideReadFeeds(settings: Settings | undefined): boolean {
  return settings?.hideReadFeeds === true;
}

/** Spec 6.2: `markReadOnOpen`, default true. */
export function markReadOnOpen(settings: Settings | undefined): boolean {
  return settings?.markReadOnOpen !== false;
}

/** TID-026: `markReadOnScroll`, default true (owner ruling 2026-11-18). */
export function markReadOnScroll(settings: Settings | undefined): boolean {
  return settings?.markReadOnScroll !== false;
}

export type ThemePref = 'system' | 'light' | 'dark';
export type TextSize = 's' | 'm' | 'l';

/** Spec 6.2: `theme`, default system. */
export function themePref(settings: Settings | undefined): ThemePref {
  const t = settings?.theme;
  return t === 'light' || t === 'dark' ? t : 'system';
}

/** Spec 6.2: `textSize`, default m. */
export function textSizePref(settings: Settings | undefined): TextSize {
  const t = settings?.textSize;
  return t === 's' || t === 'l' ? t : 'm';
}
