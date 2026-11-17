import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script without type declarations
import { checkHeaders } from '../scripts/check-prod-headers.mjs';

const spaHeaders: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; frame-ancestors 'none'; object-src 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=31536000',
};
const apiHeaders: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

async function serve(spa: Record<string, string>, api: Record<string, string>) {
  const s = createServer((req, res) => {
    const isApi = req.url?.startsWith('/api/');
    res.writeHead(isApi && req.url !== '/api/health' ? 404 : 200, isApi ? api : spa);
    res.end('{}');
  });
  server = s;
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

describe('production header check (TID-024 AC5)', () => {
  it('passes when every spec 10.4 header is present', async () => {
    expect(await checkHeaders(await serve(spaHeaders, apiHeaders))).toEqual([]);
  });

  it('fails when HSTS is missing from the SPA shell', async () => {
    const spa = { ...spaHeaders };
    delete spa['Strict-Transport-Security'];
    const failures = await checkHeaders(await serve(spa, apiHeaders));
    expect(failures).toEqual(['/: missing strict-transport-security']);
  });

  it('fails on a short HSTS max-age and on a missing API header', async () => {
    const api = { ...apiHeaders };
    delete api['Cache-Control'];
    const failures = await checkHeaders(
      await serve({ ...spaHeaders, 'Strict-Transport-Security': 'max-age=60' }, api),
    );
    expect(failures.some((f: string) => f.includes('strict-transport-security'))).toBe(true);
    expect(failures.filter((f: string) => f.includes('missing cache-control'))).toHaveLength(2);
  });

  it('fails when an API response allows cross-origin reads', async () => {
    const failures = await checkHeaders(
      await serve(spaHeaders, { ...apiHeaders, 'Access-Control-Allow-Origin': '*' }),
    );
    expect(
      failures.some((f: string) => f.includes('access-control-allow-origin must not be present')),
    ).toBe(true);
  });
});
