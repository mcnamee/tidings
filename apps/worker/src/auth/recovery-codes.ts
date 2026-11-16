import { RECOVERY_CODE_COUNT } from '@tidings/shared';
import { sha256Hex } from './crypto';

/** Crockford base32: digits and letters without I, L, O, U. */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** One code: 16 characters x 5 bits = 80 random bits, as XXXX-XXXX-XXXX-XXXX. */
export function generateRecoveryCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // 256 is a multiple of 32, so `& 31` is uniform (no modulo bias).
  const chars = Array.from(bytes, (b) => CROCKFORD_ALPHABET[b & 31]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join('')).join('-');
}

/** `count` distinct codes. */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) codes.add(generateRecoveryCode());
  return [...codes];
}

/**
 * ADR 0010 item 2 / spec 10.1: trim, remove spaces and dashes, upper-case, then map the
 * Crockford confusables O to 0 and I, L to 1. The generator never emits those letters, so a
 * typo can only be read as the one code that could have been meant.
 */
export function normalizeRecoveryCode(input: string): string {
  return input
    .trim()
    .replace(/[\s-]+/g, '')
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

/** Hex SHA-256 of the normalised code: the only form that is stored. */
export function hashRecoveryCode(input: string): Promise<string> {
  return sha256Hex(normalizeRecoveryCode(input));
}
