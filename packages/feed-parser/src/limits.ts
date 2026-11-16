/** Caps from ADR 0006 / spec §7.3 and §6.5. */
export const MAX_ITEMS_PER_FETCH = 50;
/** Per-item content cap, in UTF-16 code units, applied while text accumulates. */
export const MAX_CONTENT_CHARS = 100 * 1024;
/** Titles, authors, ids and other short fields. */
export const MAX_SHORT_FIELD_CHARS = 2048;
/** Summary: plain text, at most this many characters (spec §6.5). */
export const MAX_SUMMARY_CHARS = 300;
/** Summary is derived from the first 4 KB of source markup (spec §6.5). */
export const SUMMARY_SOURCE_CHARS = 4096;
/** Image fallback scans the first 8 KB of content (spec §6.5). */
export const IMAGE_SCAN_CHARS = 8192;
/** Open XML elements, counted from the document root (ADR 0009 section 3). Real feeds stay under 30. */
export const MAX_DEPTH = 64;
