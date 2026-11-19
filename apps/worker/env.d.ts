export interface Env {
  DB: D1Database;
  /** Workers Rate Limiting binding: 600 requests per minute per user, a backstop (spec 10.7). */
  API_RL: RateLimit;
  /**
   * Workers AI (TID-067, ADR 0018). Optional on purpose: without it (local dev, E2E, tests) nothing is
   * embedded, no profile is built and "Recommended" falls back to newest first.
   */
  AI?: AiBinding;
  APP_ORIGIN: string;
  RP_ID: string;
  RP_NAME: string;
  SETUP_TOKEN?: string;
  /** Test-only (E2E fixture server). Refused unless APP_ORIGIN is http://localhost:*; see src/fetch/config.ts. */
  ALLOW_FETCH_HOSTS?: string;
  /** TID-053 secret: Resend API key (sending-only, restricted to tidings.mcn.am). Absent means email sign-in is off. */
  RESEND_API_KEY?: string;
  /** TID-053: sender address, e.g. signin@tidings.mcn.am. */
  MAGIC_LINK_FROM?: string;
  /** TID-053 secret: the owner's verified address, the only recipient. Delete it to turn the feature off. */
  MAGIC_LINK_EMAIL?: string;
  /** Test-only: "1" records the message in D1 instead of sending. Ignored unless APP_ORIGIN is http://localhost:*. */
  E2E_CAPTURE_EMAIL?: string;
}

/** The one Workers AI method used: `run(model, input)`. Typed here so tests can supply a fake. */
export interface AiBinding {
  run(model: string, input: unknown): Promise<unknown>;
}
