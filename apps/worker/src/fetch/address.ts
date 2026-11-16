/**
 * Address and URL validation for `safeFetch` (spec §10.6 rules 1 to 3).
 * Pure functions, no I/O. `new URL()` has already normalised decimal, octal and hex IPv4
 * forms (`0x7f000001`, `2130706433`) to dotted quads by the time we look at a hostname.
 */

export type BlockReason = 'invalid_url' | 'blocked_address';

export interface UrlCheck {
  ok: boolean;
  code?: BlockReason;
  message?: string;
  url?: URL;
}

const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);

const BLOCKED_SUFFIXES = ['localhost', 'local', 'internal', 'home.arpa'];

export function parseIPv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.every((o) => o <= 255) ? octets : null;
}

/** Parses an IPv6 literal (no brackets) into 8 16-bit groups. */
export function parseIPv6(host: string): number[] | null {
  if (!host.includes(':')) return null;
  let text = host;
  // Trailing dotted quad (::ffff:1.2.3.4) becomes two hex groups.
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (tail) {
    const quad = tail[1] as string;
    const v4 = parseIPv4(quad);
    if (!v4) return null;
    const hi = ((v4[0] as number) << 8) | (v4[1] as number);
    const lo = ((v4[2] as number) << 8) | (v4[3] as number);
    text = `${text.slice(0, -quad.length)}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const toGroups = (s: string): number[] | null => {
    if (s === '') return [];
    const out: number[] = [];
    for (const part of s.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
      out.push(parseInt(part, 16));
    }
    return out;
  };
  const head = toGroups(halves[0] as string);
  if (!head) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const rest = toGroups(halves[1] as string);
  if (!rest) return null;
  const fill = 8 - head.length - rest.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...rest];
}

export function isBlockedIPv4(o: number[]): boolean {
  const a = o[0] as number;
  const b = o[1] as number;
  const c = o[2] as number;
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, incl. 169.254.169.254 metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // documentation
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 // multicast and reserved, incl. 255.255.255.255
  );
}

function embeddedV4(hi: number, lo: number): number[] {
  return [hi >> 8, hi & 255, lo >> 8, lo & 255];
}

export function isBlockedIPv6(g: number[]): boolean {
  const first = g[0] as number;
  const zeroUpTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  // ::, ::1, IPv4-compatible (::/96) and IPv4-mapped (::ffff:0:0/96): judge the embedded v4.
  if (zeroUpTo(5) && (g[5] === 0xffff || g[5] === 0)) {
    return isBlockedIPv4(embeddedV4(g[6] as number, g[7] as number)) || zeroUpTo(6);
  }
  // Only global unicast 2000::/3 is accepted. That already excludes fc00::/7, fe80::/10, ff00::/8,
  // fd00:ec2::254 and the NAT64 prefix 64:ff9b::/96.
  if (first < 0x2000 || first > 0x3fff) return true;
  if (first === 0x2002) return isBlockedIPv4(embeddedV4(g[1] as number, g[2] as number)); // 6to4
  if (first === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) return true; // Teredo, documentation
  return false;
}

/** Returns why `rawHost` (as `URL#hostname` reports it) must be refused, or null if it is fine. */
export function blockedHostReason(rawHost: string, appHost: string | null): string | null {
  let host = rawHost.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) {
    const v6 = parseIPv6(host.slice(1, -1));
    if (!v6) return 'unparseable IPv6 literal';
    return isBlockedIPv6(v6) ? 'IPv6 address is not public' : null;
  }
  host = host.replace(/\.+$/, '');
  if (host === '') return 'empty host';
  const v4 = parseIPv4(host);
  if (v4) return isBlockedIPv4(v4) ? 'IPv4 address is not public' : null;
  if (!host.includes('.')) return 'single-label host';
  if (BLOCKED_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) {
    return 'reserved host name';
  }
  if (appHost && host === appHost.replace(/\.+$/, '').toLowerCase()) return "the app's own host";
  return null;
}

/**
 * Validates one URL (the initial one or a redirect target). `allowHosts` holds exact `host:port`
 * entries that skip the host and port rules (test-only; the caller has already vetted the config).
 */
export function checkUrl(raw: string, appOrigin: string, allowHosts: readonly string[]): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, code: 'invalid_url', message: 'Not a valid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, code: 'invalid_url', message: 'Only http and https are allowed' };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, code: 'invalid_url', message: 'Credentials in URLs are not allowed' };
  }
  if (allowHosts.includes(url.host.toLowerCase())) return { ok: true, url };
  if (!ALLOWED_PORTS.has(url.port)) {
    return { ok: false, code: 'blocked_address', message: `Port ${url.port} is not allowed` };
  }
  let appHost: string | null = null;
  try {
    appHost = new URL(appOrigin).hostname;
  } catch {
    appHost = null;
  }
  const why = blockedHostReason(url.hostname, appHost);
  if (why) return { ok: false, code: 'blocked_address', message: why };
  return { ok: true, url };
}
