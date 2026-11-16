export interface Env {
  DB: D1Database;
  APP_ORIGIN: string;
  RP_ID: string;
  RP_NAME: string;
  SETUP_TOKEN?: string;
  /** Test-only (E2E fixture server). Refused unless APP_ORIGIN is http://localhost:*; see src/fetch/config.ts. */
  ALLOW_FETCH_HOSTS?: string;
}
