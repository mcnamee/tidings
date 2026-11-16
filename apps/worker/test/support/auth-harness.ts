import { env } from 'cloudflare:workers';
import { createFixedClock, type FixedClock } from '@tidings/test-utils';
import type { SetupVerifyResponse } from '@tidings/shared';
import { createApp } from '../../src/api/app';
import type { AuthDeps } from '../../src/auth/routes';
import { fakeRegistration, type FakeRegistrationOptions } from './virtual-authenticator';

/** Bound in vitest.config.ts. */
export const SETUP_TOKEN = env.SETUP_TOKEN ?? '';

export interface Harness {
  clock: FixedClock;
  call(
    method: 'GET' | 'POST',
    path: string,
    init?: { body?: unknown; cookies?: Record<string, string>; ip?: string; rawBody?: string },
  ): Promise<Response>;
}

export function createHarness(deps?: Partial<AuthDeps>): Harness {
  const clock = createFixedClock();
  const app = createApp({ clock: () => clock.now(), ...deps });
  return {
    clock,
    call(method, path, init = {}) {
      const headers = new Headers({ 'User-Agent': 'vitest' });
      if (init.body !== undefined || init.rawBody !== undefined) {
        headers.set('Content-Type', 'application/json');
      }
      if (init.ip) headers.set('CF-Connecting-IP', init.ip);
      if (init.cookies) {
        headers.set(
          'Cookie',
          Object.entries(init.cookies)
            .map(([k, v]) => `${k}=${v}`)
            .join('; '),
        );
      }
      const body =
        init.rawBody ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
      return Promise.resolve(
        app.fetch(new Request(`${env.APP_ORIGIN}${path}`, { method, headers, body }), env),
      );
    },
  };
}

export interface ParsedCookie {
  value: string;
  /** Lower-cased attribute names mapped to their values ('' for flags). */
  attrs: Record<string, string>;
}

export function setCookies(res: Response): Record<string, ParsedCookie> {
  const out: Record<string, ParsedCookie> = {};
  for (const line of res.headers.getSetCookie()) {
    const [pair = '', ...rest] = line.split(';').map((s) => s.trim());
    const eq = pair.indexOf('=');
    const attrs: Record<string, string> = {};
    for (const a of rest) {
      const i = a.indexOf('=');
      attrs[(i < 0 ? a : a.slice(0, i)).toLowerCase()] = i < 0 ? '' : a.slice(i + 1);
    }
    out[pair.slice(0, eq)] = { value: pair.slice(eq + 1), attrs };
  }
  return out;
}

export async function resetAuthTables(): Promise<void> {
  for (const t of [
    'sessions',
    'recovery_codes',
    'passkeys',
    'webauthn_challenges',
    'rate_limits',
    'users',
  ]) {
    await env.DB.exec(`DELETE FROM ${t}`);
  }
}

export interface SetupResult {
  optionsRes: Response;
  verifyRes: Response;
  options: { challenge: string; rp: { id: string }; user: { id: string } };
  body: SetupVerifyResponse;
  cookies: Record<string, ParsedCookie>;
  credentialId: string;
}

/** The whole happy path against a harness: options, a software passkey, verify. */
export async function runSetup(
  h: Harness,
  extra: {
    verifyBody?: Record<string, unknown>;
    authenticator?: Partial<FakeRegistrationOptions>;
    ip?: string;
    displayName?: string;
  } = {},
): Promise<SetupResult> {
  const displayName = extra.displayName ?? 'Matt';
  const optionsRes = await h.call('POST', '/api/auth/setup/options', {
    body: { setupToken: SETUP_TOKEN, displayName },
    ...(extra.ip ? { ip: extra.ip } : {}),
  });
  const options = (await optionsRes.clone().json()) as SetupResult['options'];
  const challengeCookie = setCookies(optionsRes)['__Host-tid_chal'];
  const reg = await fakeRegistration(options, { origin: env.APP_ORIGIN, ...extra.authenticator });
  const verifyRes = await h.call('POST', '/api/auth/setup/verify', {
    body: { setupToken: SETUP_TOKEN, displayName, response: reg.response, ...extra.verifyBody },
    cookies: challengeCookie ? { '__Host-tid_chal': challengeCookie.value } : {},
    ...(extra.ip ? { ip: extra.ip } : {}),
  });
  const cookies = setCookies(verifyRes);
  const body =
    verifyRes.status === 201
      ? ((await verifyRes.clone().json()) as SetupVerifyResponse)
      : (undefined as never);
  return { optionsRes, verifyRes, options, body, cookies, credentialId: reg.credentialId };
}
