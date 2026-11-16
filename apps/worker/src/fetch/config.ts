/**
 * Fetch policy derived from the Worker env (spec §10.6, TID-010 AC6).
 *
 * `ALLOW_FETCH_HOSTS` exists only so E2E can reach the local fixture feed server. It is accepted
 * only when `APP_ORIGIN` is `http://localhost[:port]`. Anywhere else (production) its mere presence
 * is a configuration error, and `safeFetch` independently ignores it. It is never set in
 * `wrangler.jsonc` (a test asserts that).
 */

export interface FetchEnv {
  APP_ORIGIN: string;
  ALLOW_FETCH_HOSTS?: string;
}

export interface FetchPolicy {
  appOrigin: string;
  /** Lower-case `host:port` entries. Empty in production. */
  allowHosts: string[];
}

export class FetchConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FetchConfigError';
  }
}

/** `http://localhost` with any port, exactly. Rejects look-alikes such as `http://localhost.evil.com`. */
export function isLocalDevOrigin(appOrigin: string): boolean {
  try {
    const u = new URL(appOrigin);
    return u.protocol === 'http:' && u.hostname === 'localhost' && u.username === '';
  } catch {
    return false;
  }
}

export function resolveFetchPolicy(env: FetchEnv): FetchPolicy {
  const raw = env.ALLOW_FETCH_HOSTS;
  if (raw === undefined || raw.trim() === '') {
    return { appOrigin: env.APP_ORIGIN, allowHosts: [] };
  }
  if (!isLocalDevOrigin(env.APP_ORIGIN)) {
    throw new FetchConfigError(
      'ALLOW_FETCH_HOSTS is set but APP_ORIGIN is not http://localhost:*; refusing to run',
    );
  }
  const allowHosts = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== '');
  for (const entry of allowHosts) {
    if (!/^[a-z0-9.[\]:-]+$/.test(entry)) {
      throw new FetchConfigError(`ALLOW_FETCH_HOSTS has a malformed entry: ${entry}`);
    }
  }
  return { appOrigin: env.APP_ORIGIN, allowHosts };
}
