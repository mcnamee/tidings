#!/usr/bin/env node
// Production header check (TID-024 AC5, spec §10.4).
// Usage: node scripts/check-prod-headers.mjs https://tidings.mcn.am
// Fetches the SPA shell, /api/health and an unknown API route and checks the
// security headers. Exits 0 when all pass, 1 otherwise. No credentials are sent.
import { pathToFileURL } from 'node:url';

const SPA_HEADERS = {
  'content-security-policy': (v) =>
    [
      "default-src 'self'",
      "script-src 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ].every((d) => v.includes(d)) ||
    'missing default-src, script-src, frame-ancestors or object-src',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'cross-origin-opener-policy': 'same-origin',
  'strict-transport-security': (v) => {
    const m = /max-age=(\d+)/i.exec(v);
    return (m && Number(m[1]) >= 31536000) || 'max-age must be at least 31536000';
  },
};

// API responses get these from Worker middleware (the _headers file does not apply to them).
const API_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'cross-origin-resource-policy': 'same-origin',
};

function check(res, expected, label, forbid = []) {
  const failures = [];
  for (const [name, rule] of Object.entries(expected)) {
    const value = res.headers.get(name);
    if (value === null) {
      failures.push(`${label}: missing ${name}`);
      continue;
    }
    const ok =
      typeof rule === 'function' ? rule(value) : value.toLowerCase() === rule.toLowerCase();
    if (ok !== true) {
      failures.push(
        `${label}: ${name} is "${value}"${typeof ok === 'string' ? ` (${ok})` : `, expected "${rule}"`}`,
      );
    }
  }
  for (const name of forbid) {
    if (res.headers.has(name)) failures.push(`${label}: ${name} must not be present`);
  }
  return failures;
}

export async function checkHeaders(origin, fetchImpl = fetch) {
  const base = origin.replace(/\/+$/, '');
  const failures = [];

  const spa = await fetchImpl(`${base}/`, { redirect: 'manual' });
  if (spa.status !== 200) failures.push(`/: status ${spa.status}, expected 200`);
  failures.push(...check(spa, SPA_HEADERS, '/'));

  for (const path of ['/api/health', '/api/__no_such_route__']) {
    const res = await fetchImpl(base + path, { redirect: 'manual' });
    if (path === '/api/health' && res.status !== 200) {
      failures.push(`${path}: status ${res.status}, expected 200`);
    }
    failures.push(...check(res, API_HEADERS, path, ['access-control-allow-origin']));
  }
  return failures;
}

async function main() {
  const origin = process.argv[2];
  if (!origin || !/^https?:\/\//.test(origin)) {
    console.error(
      'Usage: node scripts/check-prod-headers.mjs <origin>   e.g. https://tidings.mcn.am',
    );
    process.exit(2);
  }
  const failures = await checkHeaders(origin);
  if (failures.length) {
    console.error(`Header check FAILED for ${origin}`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`Header check passed for ${origin}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
