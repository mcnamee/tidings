import { EmailMessage } from 'cloudflare:email';
import type { Env } from '../../env';

/**
 * Outgoing sign-in mail (TID-053, ADR 0016). The MIME message is built by hand: it is one fixed
 * plain-text template, so a MIME library (and its bundle and CPU cost) is not needed.
 */
export interface OutgoingMail {
  from: string;
  to: string;
  /** The complete RFC 5322 message, CRLF line endings. */
  raw: string;
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

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

/** RFC 5322 date, always UTC. */
export function formatMailDate(d: Date): string {
  return (
    `${DAYS[d.getUTCDay()]}, ${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`
  );
}

export interface MagicLinkMailInput {
  from: string;
  to: string;
  /** `APP_ORIGIN + "/login/email#token=" + token`, the only URL in the message. */
  link: string;
  now: Date;
  /** Random, unguessable part of the Message-ID (the domain is taken from `from`). */
  messageIdLocal: string;
}

/** Plain text only: no HTML and no remote images (AC4). The token never appears in a header. */
export function buildMagicLinkMail(input: MagicLinkMailInput): OutgoingMail {
  const domain = input.from.slice(input.from.lastIndexOf('@') + 1);
  const requested = `${input.now.getUTCFullYear()}-${pad(input.now.getUTCMonth() + 1)}-${pad(input.now.getUTCDate())} ${pad(input.now.getUTCHours())}:${pad(input.now.getUTCMinutes())} UTC`;
  const headers = [
    `From: Tidings <${input.from}>`,
    `To: ${input.to}`,
    `Subject: ${MAGIC_LINK_SUBJECT}`,
    `Date: ${formatMailDate(input.now)}`,
    `Message-ID: <${input.messageIdLocal}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 7bit',
  ];
  const body = [
    'Use this link to sign in to Tidings:',
    '',
    input.link,
    '',
    `It works once and expires in 15 minutes (requested ${requested}).`,
    '',
    "If you didn't ask for this, ignore this email. Nobody can sign in without the link.",
    '',
  ];
  return { from: input.from, to: input.to, raw: [...headers, '', ...body].join('\r\n') };
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
    .bind(mail.to, mail.raw)
    .run();
}

export const defaultSender: EmailSender = async (env, mail) => {
  if (captureEnabled(env)) return capture(env, mail);
  if (!env.SIGNIN_EMAIL) throw new Error('SIGNIN_EMAIL binding missing');
  await env.SIGNIN_EMAIL.send(new EmailMessage(mail.from, mail.to, mail.raw));
};
