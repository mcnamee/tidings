import type { SessionResponse } from '@tidings/shared';

// Spec 6.2 defaults. The stored document may be missing keys or hold junk, so each read is checked.
type Settings = NonNullable<SessionResponse['user']>['settings'];

export function unreadOnlyDefault(settings: Settings | undefined): boolean {
  return settings?.unreadOnly !== false;
}

export function hideReadFeeds(settings: Settings | undefined): boolean {
  return settings?.hideReadFeeds === true;
}

/** Spec 6.2: `markReadOnOpen`, default true. */
export function markReadOnOpen(settings: Settings | undefined): boolean {
  return settings?.markReadOnOpen !== false;
}
