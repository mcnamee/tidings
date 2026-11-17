const AUTH_PATHS = new Set(['/setup', '/login', '/login/email', '/recover']);
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * auth-common.md 7: `from` is restored after sign-in only if it is a same-origin path that starts
 * with a single `/` and is not one of the auth screens. Anything else returns null, which means
 * "use the default view".
 */
export function safeReturnPath(from: unknown): string | null {
  if (typeof from !== 'string' || from.length > 2048) return null;
  if (!from.startsWith('/') || from.startsWith('//') || from.includes('\\')) return null;
  if (CONTROL_CHARS.test(from)) return null;
  const path = from.split(/[?#]/, 1)[0] ?? '';
  if (AUTH_PATHS.has(path.replace(/\/+$/, ''))) return null;
  return from;
}
