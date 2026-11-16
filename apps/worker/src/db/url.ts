import { ValidationError } from './errors';

const MAX_URL_LENGTH = 2048;

/**
 * Canonicalises a feed or link URL (spec §6.4): lower-case scheme and host, default ports and
 * fragment dropped, path and query untouched, IDN to punycode (all via `new URL()`).
 * `feed://` and `feed:https://` become `https://`. Only http(s) is accepted.
 * Throws {@link ValidationError} otherwise.
 */
export function canonicalizeUrl(input: string): string {
  let raw = input.trim();
  if (raw.length === 0 || raw.length > MAX_URL_LENGTH) {
    throw new ValidationError('Invalid URL', { field: 'url' });
  }
  if (/^feed:\/\//i.test(raw)) raw = 'https://' + raw.slice('feed://'.length);
  else if (/^feed:(?=https?:)/i.test(raw)) raw = raw.slice('feed:'.length);

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError('Invalid URL', { field: 'url' });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ValidationError('Only http and https URLs are allowed', { field: 'url' });
  }
  if (url.hostname === '') throw new ValidationError('Invalid URL', { field: 'url' });
  url.hash = '';
  return url.href;
}

/** Like {@link canonicalizeUrl} but returns null instead of throwing (for optional link fields). */
export function tryCanonicalizeUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  try {
    return canonicalizeUrl(input);
  } catch {
    return null;
  }
}
