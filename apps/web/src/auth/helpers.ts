/** Pure helpers for the auth screens (docs/ux/screens/auth-common.md, setup.md). */

/** auth-common.md 3.1: wait text from `Retry-After` seconds, computed once. */
export function waitText(retryAfterSeconds: number | null): string {
  if (retryAfterSeconds === null || !Number.isFinite(retryAfterSeconds)) {
    return 'Try again in a few minutes';
  }
  if (retryAfterSeconds < 60) return 'Try again in less than a minute';
  const m = Math.ceil(retryAfterSeconds / 60);
  if (m === 1) return 'Try again in 1 minute';
  if (m <= 54) return `Try again in ${m} minutes`;
  return 'Try again in about an hour';
}

/** setup.md 1: a best-effort label so the Settings passkey list is readable. */
export function passkeyLabel(userAgent: string): string {
  if (/iPhone|iPod/.test(userAgent)) return 'Passkey on iPhone';
  if (/Android/.test(userAgent)) return 'Passkey on Android';
  if (/Windows/.test(userAgent)) return 'Passkey on Windows';
  if (/Macintosh|Mac OS X/.test(userAgent)) return 'Passkey on Mac';
  return 'Passkey';
}

export type PasskeySupport = 'ok' | 'no-webauthn' | 'insecure';

/** auth-common.md 5: known before the user acts. */
export function detectPasskeySupport(
  win: Pick<Window, 'isSecureContext'> & { PublicKeyCredential?: unknown } = window,
): PasskeySupport {
  if (!('PublicKeyCredential' in win) || !win.PublicKeyCredential) return 'no-webauthn';
  if (!win.isSecureContext) return 'insecure';
  return 'ok';
}

export const RECOVERY_FILE_NAME = 'tidings-recovery-codes.txt';

/** setup.md 5.2: the Download .txt content, UTF-8, `\n` line endings. */
export function recoveryCodesFile(codes: readonly string[], date: Date, host: string): string {
  return [
    'Tidings recovery codes',
    `Created ${date.toISOString().slice(0, 10)} for ${host}`,
    '',
    'Each code works once. Keep this file somewhere safe and private.',
    '',
    ...codes.map((code, i) => `${i + 1}. ${code}`),
    '',
  ].join('\n');
}

/**
 * Saves text through a `blob:` URL and an `<a download>` click. No request is made, and CSP fetch
 * directives do not govern anchor downloads, so the policy is unchanged (ADR 0010 item 3).
 */
export function downloadTextFile(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    a.hidden = true;
    document.body.append(a);
    a.click();
    a.remove();
  } finally {
    // Revoked just after the click: some browsers cancel a download whose blob is revoked in the
    // same task.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
