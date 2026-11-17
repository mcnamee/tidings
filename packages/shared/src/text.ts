/**
 * Text clean-up shared by the API schemas and the OPML parser, so the preview and the server
 * agree on what a name is.
 */

/** Invisible format characters `trim()` leaves behind: zero-width, bidi marks, word joiner, BOM. */
const INVISIBLE =
  '\\u00AD\\u180E\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF';
const EDGES = new RegExp(`^[\\s${INVISIBLE}]+|[\\s${INVISIBLE}]+$`, 'g');

/**
 * Trims whitespace and invisible characters from both ends. A value with nothing visible becomes
 * ''. Invisible characters inside a name are kept (a zero-width joiner holds an emoji together).
 */
export function tidyText(text: string): string {
  return text.replace(EDGES, '');
}

/** The first `max` code points of `text`, so a surrogate pair is never cut in half. */
export function clipCodePoints(text: string, max: number): string {
  if (text.length <= max) return text; // at most `max` code points
  return Array.from(text).slice(0, max).join('');
}

/** Tidy, then clip by code point, then tidy again in case the cut left a trailing space. */
export function cleanName(text: string, max: number): string {
  return tidyText(clipCodePoints(tidyText(text), max));
}
