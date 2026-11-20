import type { NavigationType } from 'react-router';

/**
 * How an article is opened (TID-070). In the installed app iOS's edge swipe-back walks the history
 * stack with its own animation (and a blank snapshot), so there the app never leaves entries: opening
 * an article replaces the list's entry and going back replaces the article's with the list's.
 * Because a REPLACE no longer tells "the user tapped" from anything else, a user-initiated open (a
 * tap on a row, Previous, Next) is marked in the navigation state instead, with an ID that is new
 * on every page load: a reload keeps history.state but not this ID, so it earns no engagement signal.
 */
const PAGE_ID = Math.random().toString(36).slice(2);

export interface OpenState {
  opened?: string;
  step?: -1 | 1;
}

/** Navigation state for opening an article from a list. */
export function openState(): OpenState {
  return { opened: PAGE_ID };
}

/** Navigation state for Previous / Next. */
export function stepState(step: -1 | 1): OpenState {
  return { opened: PAGE_ID, step };
}

function read(state: unknown): OpenState {
  return typeof state === 'object' && state !== null ? (state as OpenState) : {};
}

/** True when this location was reached by the user opening an article in this page life. */
export function isUserOpen(navType: NavigationType, state: unknown): boolean {
  return navType !== 'POP' && read(state).opened === PAGE_ID;
}

/** True for a tap on a list row (not Previous / Next): the layer slides in for it. */
export function isListOpen(navType: NavigationType, state: unknown): boolean {
  return isUserOpen(navType, state) && read(state).step === undefined;
}

/** The list an article was opened from: its path without the `/a/:id` tail. */
export function parentListPath(pathname: string): string {
  return pathname.replace(/\/a\/[^/]+$/, '');
}
