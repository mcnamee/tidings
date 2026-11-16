/** Small Web Crypto helpers for auth. No Node APIs, so they run in workerd and in tests alike. */

const encoder = new TextEncoder();

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256(input: string | Uint8Array): Promise<Uint8Array> {
  const data = typeof input === 'string' ? encoder.encode(input) : input;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));
}

/** Lower-case hex SHA-256, the form stored in `sessions.id_hash` and `recovery_codes.code_hash`. */
export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  return toHex(await sha256(input));
}

/** 32 random bytes, base64url. Used for session tokens and challenge IDs. */
export function randomToken(bytes = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/**
 * Constant-time string comparison. Both sides are hashed first so the comparison runs over
 * fixed-length data whatever the input length (no length leak either).
 */
export async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= (ha[i] ?? 0) ^ (hb[i] ?? 0);
  return diff === 0;
}
