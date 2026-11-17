import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { createFixedClock, type FixedClock } from '@tidings/test-utils';
import type { SetupVerifyResponse } from '@tidings/shared';
import { createApp, type AppDeps } from '../../src/api/app';
import {
  fakeRegistration,
  type FakeAssertionOptions,
  type FakeRegistration,
  type FakeRegistrationOptions,
} from './virtual-authenticator';

/** Bound in vitest.config.ts. */
export const SETUP_TOKEN = env.SETUP_TOKEN ?? '';

export interface Harness {
  clock: FixedClock;
  /** Waits for every `ctx.waitUntil` job started by earlier calls (the email send, TID-053). */
  settle(): Promise<void>;
  call(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    init?: {
      body?: unknown;
      cookies?: Record<string, string>;
      ip?: string;
      rawBody?: string;
      /** Extra request headers; a null value removes a default (Origin, Content-Type). */
      headers?: Record<string, string | null>;
    },
  ): Promise<Response>;
}

/**
 * `envOverrides` replaces bindings for this harness only (`undefined` removes one), for the
 * "configuration item missing" tests. By default `RESEND_API_KEY` is a fake key (the sender is injected, so nothing is sent).
 */
export function createHarness(
  deps?: Partial<AppDeps>,
  envOverrides: Record<string, unknown> = {},
): Harness {
  const clock = createFixedClock();
  const app = createApp({ clock: () => clock.now(), ...deps });

  const contexts: ExecutionContext[] = [];
  return {
    clock,
    async settle() {
      for (const ctx of contexts.splice(0)) await waitOnExecutionContext(ctx);
    },
    call(method, path, init = {}) {
      // A same-origin browser request: Origin is set by the browser on every POST (spec 10.3).
      const headers = new Headers({ 'User-Agent': 'vitest', Origin: env.APP_ORIGIN });
      if (init.body !== undefined || init.rawBody !== undefined) {
        headers.set('Content-Type', 'application/json');
      }
      if (init.ip) headers.set('CF-Connecting-IP', init.ip);
      for (const [k, v] of Object.entries(init.headers ?? {})) {
        if (v === null) headers.delete(k);
        else headers.set(k, v);
      }
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
      // Built per call so a test that changes `env` mid-test (a missing secret) is honoured.
      const testEnv = {
        ...env,
        RESEND_API_KEY: 're_test_not_a_real_key',
        ...envOverrides,
      } as unknown as typeof env;
      const ctx = createExecutionContext();
      contexts.push(ctx);
      return Promise.resolve(
        app.fetch(new Request(`${env.APP_ORIGIN}${path}`, { method, headers, body }), testEnv, ctx),
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
    'magic_links',
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
  /** The software passkey, for signing in afterwards. */
  passkey: FakeRegistration;
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
  return {
    optionsRes,
    verifyRes,
    options,
    body,
    cookies,
    credentialId: reg.credentialId,
    passkey: reg,
  };
}

export interface LoginResult {
  optionsRes: Response;
  verifyRes: Response;
  cookies: Record<string, ParsedCookie>;
  /** The session cookie value, when sign-in succeeded. */
  sessionToken: string | undefined;
}

/** Sign-in against a harness: options, an assertion from the passkey, verify. */
export async function runLogin(
  h: Harness,
  passkey: FakeRegistration,
  extra: { assertion?: FakeAssertionOptions; ip?: string; skipChallengeCookie?: boolean } = {},
): Promise<LoginResult> {
  const optionsRes = await h.call('POST', '/api/auth/login/options', {
    body: {},
    ...(extra.ip ? { ip: extra.ip } : {}),
  });
  const options =
    optionsRes.status === 200 ? ((await optionsRes.clone().json()) as { challenge: string }) : null;
  const chal = setCookies(optionsRes)['__Host-tid_chal'];
  const response = await passkey.assert(options?.challenge ?? 'none', extra.assertion);
  const verifyRes = await h.call('POST', '/api/auth/login/verify', {
    body: { response },
    cookies: chal && !extra.skipChallengeCookie ? { '__Host-tid_chal': chal.value } : {},
    ...(extra.ip ? { ip: extra.ip } : {}),
  });
  const cookies = setCookies(verifyRes);
  return {
    optionsRes,
    verifyRes,
    cookies,
    sessionToken: cookies['__Host-tid_session']?.value,
  };
}
