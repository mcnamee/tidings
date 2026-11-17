import type { Env } from '../../env';

/**
 * Outgoing sign-in mail (TID-053, ADR 0016, amended 2026-11-17). One fixed plain-text template,
 * sent through Resend's HTTP API with one `fetch` (no MIME, no library).
 */
export interface OutgoingMail {
  from: string;
  to: string;
  subject: string;
  /** Plain text only; the one URL in it is the sign-in link. */
  text: string;
}

/** Injected in tests. Production uses `defaultSender`. */
export type EmailSender = (env: Env, mail: OutgoingMail) => Promise<void>;

export const MAGIC_LINK_SUBJECT = 'Your Tidings sign-in link';

/** Addresses go into headers, so refuse anything that could add one (CR, LF, angle brackets, spaces). */
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const SAFE_ADDRESS = /^[^\s<>"(),;:\\[\]\x00-\x1f]+@[^\s<>"(),;:\\[\]\x00-\x1f]+$/;

export function isSafeAddress(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && SAFE_ADDRESS.test(value);
}

export interface MagicLinkMailInput {
  from: string;
  to: string;
  /** `APP_ORIGIN + "/login/email#token=" + token`, the only URL in the message. */
  link: string;
  now: Date;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Plain text only: no HTML and no remote images (AC4). The token never appears in the subject. */
export function buildMagicLinkMail(input: MagicLinkMailInput): OutgoingMail {
  const d = input.now;
  const requested = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
  const text = [
    'Use this link to sign in to Tidings:',
    '',
    input.link,
    '',
    `It works once and expires in 15 minutes (requested ${requested}).`,
    '',
    "If you didn't ask for this, ignore this email. Nobody can sign in without the link.",
    '',
  ].join('\n');
  return { from: input.from, to: input.to, subject: MAGIC_LINK_SUBJECT, text };
}

/**
 * Capture mode, for the E2E run only: the message is recorded in a D1 table that no migration
 * creates, and nothing is sent. It is honoured only when APP_ORIGIN is a plain `http://localhost`
 * origin, which production never is (it is https://tidings.mcn.am).
 */
export function captureEnabled(env: Pick<Env, 'E2E_CAPTURE_EMAIL' | 'APP_ORIGIN'>): boolean {
  return env.E2E_CAPTURE_EMAIL === '1' && /^http:\/\/localhost(:\d+)?$/.test(env.APP_ORIGIN);
}

async function capture(env: Env, mail: OutgoingMail): Promise<void> {
  await env.DB.exec(
    'CREATE TABLE IF NOT EXISTS e2e_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, to_addr TEXT, raw TEXT)',
  );
  await env.DB.prepare('INSERT INTO e2e_outbox (to_addr, raw) VALUES (?, ?)')
    .bind(mail.to, `Subject: ${mail.subject}\n\n${mail.text}`)
    .run();
}

export const RESEND_URL = 'https://api.resend.com/emails';
export const RESEND_TIMEOUT_MS = 5000;

/** Thrown for a non-2xx answer. The caller logs only its name; the status is logged here. */
export class ResendError extends Error {
  constructor() {
    super('Resend rejected the request');
    this.name = 'ResendError';
  }
}

/**
 * One POST to Resend. The address, token and key never reach a log line: failures are logged by
 * status or error class only, and the response body (which may echo the address) is not read.
 */
export function createResendSender(
  fetchFn: typeof fetch = (input, init) => fetch(input, init),
  timeoutMs: number = RESEND_TIMEOUT_MS,
): EmailSender {
  return async (env, mail) => {
    if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY missing');
    const res = await fetchFn(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `Tidings <${mail.from}>`,
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.body?.cancel();
    if (!res.ok) {
      console.error('email_send_rejected', JSON.stringify({ status: res.status }));
      throw new ResendError();
    }
  };
}

const resendSender = createResendSender();

export const defaultSender: EmailSender = async (env, mail) => {
  if (captureEnabled(env)) return capture(env, mail);
  return resendSender(env, mail);
};
