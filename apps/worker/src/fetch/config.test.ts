import { describe, expect, it } from 'vitest';
import { createFakeFetch } from '@tidings/test-utils';
import wranglerConfig from '../../wrangler.jsonc?raw';
import { FetchConfigError, isLocalDevOrigin, resolveFetchPolicy } from './config';
import { safeFetch } from './safe-fetch';

const PROD = 'https://tidings.mcn.am';
const LOCAL = 'http://localhost:8788';

// TID-010 AC6: ALLOW_FETCH_HOSTS can never take effect outside http://localhost:*.
describe('ALLOW_FETCH_HOSTS guard', () => {
  it('is empty when the var is absent or blank', () => {
    expect(resolveFetchPolicy({ APP_ORIGIN: PROD }).allowHosts).toEqual([]);
    expect(resolveFetchPolicy({ APP_ORIGIN: PROD, ALLOW_FETCH_HOSTS: '  ' }).allowHosts).toEqual(
      [],
    );
  });

  it('is accepted when APP_ORIGIN is http://localhost:*', () => {
    expect(
      resolveFetchPolicy({ APP_ORIGIN: LOCAL, ALLOW_FETCH_HOSTS: '127.0.0.1:8790, Foo:1' })
        .allowHosts,
    ).toEqual(['127.0.0.1:8790', 'foo:1']);
    expect(
      resolveFetchPolicy({ APP_ORIGIN: 'http://localhost', ALLOW_FETCH_HOSTS: 'a:1' }).allowHosts,
    ).toEqual(['a:1']);
  });

  it.each([
    PROD,
    'https://localhost:8788', // https is not the dev origin
    'http://127.0.0.1:8788',
    'http://localhost.evil.com',
    'http://localhost@evil.com',
    'http://evil.com/?http://localhost',
    'not a url',
    '',
  ])('throws a configuration error when APP_ORIGIN is %j', (origin) => {
    expect(() =>
      resolveFetchPolicy({ APP_ORIGIN: origin, ALLOW_FETCH_HOSTS: '127.0.0.1:8790' }),
    ).toThrow(FetchConfigError);
  });

  it('rejects malformed entries', () => {
    expect(() => resolveFetchPolicy({ APP_ORIGIN: LOCAL, ALLOW_FETCH_HOSTS: 'a b/c' })).toThrow(
      FetchConfigError,
    );
  });

  it('isLocalDevOrigin is exact', () => {
    expect(isLocalDevOrigin(LOCAL)).toBe(true);
    expect(isLocalDevOrigin(PROD)).toBe(false);
  });
});

describe('production config ignores the allow-list', () => {
  it('safeFetch refuses the fixture host when appOrigin is not localhost, even if allowHosts is passed', async () => {
    const f = createFakeFetch();
    f.route(/./, { body: 'x' });
    const res = await safeFetch('http://127.0.0.1:8790/feeds/a.xml', {
      fetch: f.fetch,
      appOrigin: PROD,
      allowHosts: ['127.0.0.1:8790'],
    });
    expect(res).toMatchObject({ kind: 'error', code: 'blocked_address' });
    expect(f.calls).toHaveLength(0);
  });

  it('safeFetch honours the allow-list only for exact entries on the local dev origin', async () => {
    const f = createFakeFetch();
    f.route(/./, { body: 'x' });
    const opts = { fetch: f.fetch, appOrigin: LOCAL, allowHosts: ['127.0.0.1:8790'] };
    expect((await safeFetch('http://127.0.0.1:8790/feeds/a.xml', opts)).kind).toBe('ok');
    expect(await safeFetch('http://127.0.0.1:8791/feeds/a.xml', opts)).toMatchObject({
      code: 'blocked_address',
    });
    expect(await safeFetch('http://127.0.0.1/', opts)).toMatchObject({ code: 'blocked_address' });
    expect(await safeFetch('http://169.254.169.254/', opts)).toMatchObject({
      code: 'blocked_address',
    });
    // Credentials stay refused even for an allowed host.
    expect(await safeFetch('http://u:p@127.0.0.1:8790/', opts)).toMatchObject({
      code: 'invalid_url',
    });
  });

  it('wrangler.jsonc (the production config) never sets ALLOW_FETCH_HOSTS', () => {
    expect(wranglerConfig).not.toContain('ALLOW_FETCH_HOSTS');
    expect(wranglerConfig).toContain('"APP_ORIGIN": "https://tidings.mcn.am"');
  });
});
