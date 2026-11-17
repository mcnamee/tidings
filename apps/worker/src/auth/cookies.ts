import type { Context, Env as HonoEnv } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { SESSION_COOKIE } from './session';

/** `__Host-` cookies must be Secure, Path=/ and have no Domain (spec 10.2). */
export function setSecureCookie<E extends HonoEnv>(
  c: Context<E>,
  name: string,
  value: string,
  sameSite: 'Lax' | 'Strict',
  maxAge: number,
): void {
  setCookie(c, name, value, { httpOnly: true, secure: true, sameSite, path: '/', maxAge });
}

export function setSessionCookie<E extends HonoEnv>(
  c: Context<E>,
  token: string,
  maxAge: number,
): void {
  setSecureCookie(c, SESSION_COOKIE, token, 'Lax', maxAge);
}

export function clearSessionCookie<E extends HonoEnv>(c: Context<E>): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
}
