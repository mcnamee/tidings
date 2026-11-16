const MAX_URL_LENGTH = 2048;

/**
 * Pure URL canonicalisation (spec §6.4): lower-case scheme and host, default ports and fragment
 * dropped, path and query untouched, IDN to punycode (all via `new URL()`). `feed://` and
 * `feed:https://` become `https://`. Only http(s) is accepted.
 *
 * Returns the reason for rejection instead of throwing so each caller can map it to its own
 * error type (the Worker to a `ValidationError`, the feed parser to `null`).
 */
export type CanonicalUrlResult =
  { ok: true; url: string } | { ok: false; reason: 'invalid' | 'scheme' };

export function canonicalizeHttpUrl(input: string): CanonicalUrlResult {
  let raw = input.trim();
  if (raw.length === 0 || raw.length > MAX_URL_LENGTH) return { ok: false, reason: 'invalid' };
  if (/^feed:\/\//i.test(raw)) raw = 'https://' + raw.slice('feed://'.length);
  else if (/^feed:(?=https?:)/i.test(raw)) raw = raw.slice('feed:'.length);

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'scheme' };
  }
  if (url.hostname === '') return { ok: false, reason: 'invalid' };
  url.hash = '';
  return { ok: true, url: url.href };
}
