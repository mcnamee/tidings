import { ValidationError } from './errors';

/** Keyset position in an entries list: `published_at` and entry id of the last row served (spec §8.6). */
export interface Cursor {
  p: number;
  i: number;
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('bad alphabet');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
    Uint8Array.from(bin, (c) => c.charCodeAt(0)),
  );
}

export function encodeCursor(cursor: Cursor): string {
  return toBase64Url(JSON.stringify({ p: cursor.p, i: cursor.i }));
}

/** Decodes a cursor. Any malformation throws {@link ValidationError}. */
export function decodeCursor(value: string): Cursor {
  const fail = () => new ValidationError('Malformed cursor', { field: 'cursor' });
  if (value.length === 0 || value.length > 200) throw fail();
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(value));
  } catch {
    throw fail();
  }
  if (typeof parsed !== 'object' || parsed === null) throw fail();
  const { p, i } = parsed as Record<string, unknown>;
  if (
    !Number.isSafeInteger(p) ||
    !Number.isSafeInteger(i) ||
    (p as number) < 0 ||
    (i as number) < 0
  ) {
    throw fail();
  }
  return { p: p as number, i: i as number };
}

/** Opaque cursor of another shape (the recommended sort, TID-067): base64url of a JSON object. */
export function encodeJsonCursor(value: Record<string, number | string>): string {
  return toBase64Url(JSON.stringify(value));
}

/** The JSON object inside a cursor, unvalidated. Any malformation throws {@link ValidationError}. */
export function decodeJsonCursor(value: string): Record<string, unknown> {
  const fail = () => new ValidationError('Malformed cursor', { field: 'cursor' });
  if (value.length === 0 || value.length > 200) throw fail();
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(value));
  } catch {
    throw fail();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw fail();
  return parsed as Record<string, unknown>;
}
