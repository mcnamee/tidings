/**
 * Spec section 8 as data: every route, and whether it is Public. `api-guard.test.ts` generates
 * one test per row (TID-008 AC6) and fails when the app registers a route that is not listed
 * here, so a new story cannot add a route without deciding whether it is public.
 */
export interface RouteRow {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** With `:param` segments as the spec writes them. */
  path: string;
  public: boolean;
}

const pub = (method: RouteRow['method'], path: string): RouteRow => ({
  method,
  path,
  public: true,
});
const session = (method: RouteRow['method'], path: string): RouteRow => ({
  method,
  path,
  public: false,
});

export const ROUTE_TABLE: readonly RouteRow[] = [
  // 8.3 Auth and account
  pub('GET', '/api/auth/session'),
  pub('POST', '/api/auth/setup/options'),
  pub('POST', '/api/auth/setup/verify'),
  pub('POST', '/api/auth/login/options'),
  pub('POST', '/api/auth/login/verify'),
  pub('POST', '/api/auth/recover'),
  session('POST', '/api/auth/logout'),
  session('POST', '/api/auth/logout-all'),
  session('GET', '/api/auth/passkeys'),
  session('POST', '/api/auth/passkeys/options'),
  session('POST', '/api/auth/passkeys/verify'),
  session('PATCH', '/api/auth/passkeys/:id'),
  session('DELETE', '/api/auth/passkeys/:id'),
  session('POST', '/api/auth/recovery-codes'),
  session('GET', '/api/me'),
  session('PATCH', '/api/me'),
  // 8.4 Folders and subscriptions
  session('GET', '/api/folders'),
  session('POST', '/api/folders'),
  session('PATCH', '/api/folders/:id'),
  session('DELETE', '/api/folders/:id'),
  session('GET', '/api/subscriptions'),
  session('POST', '/api/subscriptions'),
  session('PATCH', '/api/subscriptions/:id'),
  session('DELETE', '/api/subscriptions/:id'),
  session('POST', '/api/subscriptions/:id/refresh'),
  // 8.5 Entries and counts
  session('GET', '/api/entries'),
  session('GET', '/api/entries/:id'),
  session('PATCH', '/api/entries/:id'),
  session('POST', '/api/entries/read-state'),
  session('POST', '/api/entries/mark-all-read'),
  session('GET', '/api/counts'),
  // 8.7 Import/export
  session('POST', '/api/import/opml'),
  session('GET', '/api/export/opml'),
  // 8.8 Health
  pub('GET', '/api/health'),
];

/** `/api/folders/:id` becomes `/api/folders/some-id`. */
export function concretePath(path: string): string {
  return path.replace(/:[A-Za-z]+/g, 'some-id');
}
