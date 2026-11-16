import { canonicalizeHttpUrl } from '@tidings/shared/url';
import { ValidationError } from './errors';

/**
 * Canonicalises a feed or link URL (spec §6.4): lower-case scheme and host, default ports and
 * fragment dropped, path and query untouched, IDN to punycode (all via `new URL()`).
 * `feed://` and `feed:https://` become `https://`. Only http(s) is accepted.
 * Throws {@link ValidationError} otherwise.
 */
export function canonicalizeUrl(input: string): string {
  const result = canonicalizeHttpUrl(input);
  if (result.ok) return result.url;
  throw new ValidationError(
    result.reason === 'scheme' ? 'Only http and https URLs are allowed' : 'Invalid URL',
    { field: 'url' },
  );
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
