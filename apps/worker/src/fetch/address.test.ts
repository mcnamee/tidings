import { describe, expect, it } from 'vitest';
import { createFakeFetch } from '@tidings/test-utils';
import { checkUrl, isBlockedIPv4, isBlockedIPv6, parseIPv6 } from './address';
import { safeFetch } from './safe-fetch';

const APP_ORIGIN = 'https://tidings.mcn.am';

// TID-010 AC1: the full SSRF list from the story.
const SSRF_LIST: [string, 'blocked_address' | 'invalid_url'][] = [
  ['http://127.0.0.1/', 'blocked_address'],
  ['http://[::1]/', 'blocked_address'],
  ['http://169.254.169.254/latest/meta-data', 'blocked_address'],
  ['http://0x7f000001/', 'blocked_address'],
  ['http://2130706433/', 'blocked_address'],
  ['http://10.0.0.1/', 'blocked_address'],
  ['http://192.168.1.1/', 'blocked_address'],
  ['http://172.16.0.1/', 'blocked_address'],
  ['http://100.64.0.1/', 'blocked_address'],
  ['http://[fd00::1]/', 'blocked_address'],
  ['http://[::ffff:127.0.0.1]/', 'blocked_address'],
  ['http://localhost/', 'blocked_address'],
  ['http://localhost./', 'blocked_address'],
  ['http://printer/', 'blocked_address'],
  ['http://foo.internal/', 'blocked_address'],
  [`${APP_ORIGIN}/`, 'blocked_address'],
  ['ftp://example.com/', 'invalid_url'],
  ['http://user:pw@example.com/', 'invalid_url'],
  ['http://example.com:22/', 'blocked_address'],
];

// Extra forms beyond the story list (spec §10.6 rule 3).
const EXTRA: string[] = [
  'http://0177.0.0.1/', // octal
  'http://127.1/', // short form
  'http://0/',
  'http://0.0.0.0/',
  'http://[::]/',
  'http://[::ffff:7f00:1]/',
  'http://[::ffff:a00:1]/',
  'http://[::ffff:169.254.169.254]/',
  'http://[fe80::1]/',
  'http://[fc00::1]/',
  'http://[fd00:ec2::254]/',
  'http://[ff02::1]/',
  'http://[64:ff9b::7f00:1]/',
  'http://[2002:7f00:1::]/',
  'http://224.0.0.1/',
  'http://255.255.255.255/',
  'http://printer.local/',
  'http://a.localhost/',
  'http://router.home.arpa/',
  'http://foo.internal./',
  'http://LOCALHOST/',
  'http://TIDINGS.MCN.AM./',
  'https://example.com:8000/',
  'http://example.com:8081/',
  'https://example.com:0/',
];

describe('safeFetch refuses internal addresses without calling fetch (AC1)', () => {
  it.each(SSRF_LIST)('%s -> %s', async (url, code) => {
    const f = createFakeFetch();
    const res = await safeFetch(url, { fetch: f.fetch, appOrigin: APP_ORIGIN });
    expect(res.kind).toBe('error');
    if (res.kind === 'error') expect(res.code).toBe(code);
    expect(f.calls).toHaveLength(0);
  });

  it.each(EXTRA)('%s is refused', async (url) => {
    const f = createFakeFetch();
    const res = await safeFetch(url, { fetch: f.fetch, appOrigin: APP_ORIGIN });
    expect(res.kind).toBe('error');
    expect(f.calls).toHaveLength(0);
  });

  it('garbage is invalid_url', async () => {
    const f = createFakeFetch();
    const res = await safeFetch('not a url', { fetch: f.fetch, appOrigin: APP_ORIGIN });
    expect(res).toMatchObject({ kind: 'error', code: 'invalid_url' });
    expect(f.calls).toHaveLength(0);
  });
});

describe('checkUrl accepts public URLs', () => {
  it.each([
    'http://example.com/feed.xml',
    'https://example.com/feed',
    'https://example.com:443/feed',
    'http://example.com:8080/feed',
    'https://example.com:8443/feed',
    'https://blog.example.co.uk/rss',
    'http://93.184.216.34/',
    'http://[2606:2800:220:1:248:1893:25c8:1946]/',
    'http://172.15.0.1/',
    'http://172.32.0.1/',
    'http://100.63.0.1/',
    'http://100.128.0.1/',
    'http://[::ffff:8.8.8.8]/',
  ])('%s', (url) => {
    expect(checkUrl(url, APP_ORIGIN, []).ok).toBe(true);
  });
});

describe('address helpers', () => {
  it('parses IPv6 forms', () => {
    expect(parseIPv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x102, 0x304]);
    expect(parseIPv6('1:2:3:4:5:6:7:8')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parseIPv6('1::2::3')).toBeNull();
    expect(parseIPv6('zz::1')).toBeNull();
  });
  it('classifies boundaries', () => {
    expect(isBlockedIPv4([172, 16, 0, 0])).toBe(true);
    expect(isBlockedIPv4([172, 31, 255, 255])).toBe(true);
    expect(isBlockedIPv4([172, 32, 0, 0])).toBe(false);
    expect(isBlockedIPv6([0x2606, 0x2800, 0x220, 1, 0, 0, 0, 1])).toBe(false);
  });
});
