/**
 * API contract shared by the SPA and the Worker: types and constants only.
 *
 * The zod schemas live in `./schemas` (imported by the Worker only). Importing zod into the SPA
 * would add its runtime to the bundle, and zod's `Function('')` probe trips the CSP (which has no
 * 'unsafe-eval') with a violation report on every page load.
 */

export interface HealthResponse {
  ok: true;
  version: string;
}

export type ErrorCode =
  | 'not_found'
  | 'internal_error'
  | 'config_error'
  | 'validation_failed'
  | 'rate_limited'
  | 'setup_unavailable'
  | 'invalid_setup_token'
  | 'webauthn_failed';

export interface ApiError {
  error: { code: ErrorCode; message: string; details?: unknown };
}

// ── Auth (spec 8.2, 8.3) ───────────────────────────────────────

/** Spec 6.2. Only the stored document is typed here; defaults are applied by the settings story. */
export type UserSettings = Record<string, unknown>;

export interface User {
  id: string;
  displayName: string;
  role: 'owner' | 'member';
  settings: UserSettings;
}

export interface SessionResponse {
  user: User | null;
  setupRequired: boolean;
  mustAddPasskey: boolean;
}

/** Spec 8.3: a display name is 1 to 64 characters after trimming. */
export const DISPLAY_NAME_MAX = 64;
export const PASSKEY_NAME_MAX = 64;
export const PASSKEY_NAME_DEFAULT = 'Passkey';
/** Recovery codes: 10 codes of XXXX-XXXX-XXXX-XXXX in the Crockford alphabet (no I, L, O, U). */
export const RECOVERY_CODE_COUNT = 10;
export const RECOVERY_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/;

export interface SetupOptionsRequest {
  setupToken: string;
  displayName: string;
}

/** PublicKeyCredentialCreationOptionsJSON. The SPA passes it straight to the browser library. */
export interface CreationOptionsJSON {
  challenge: string;
  rp: { name: string; id?: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: Array<{ type: 'public-key'; alg: number }>;
  [key: string]: unknown;
}

/** The browser's `RegistrationResponseJSON`, as far as the API envelope is concerned. */
export interface RegistrationResponse {
  id: string;
  rawId: string;
  type: 'public-key';
  response: { clientDataJSON: string; attestationObject: string; transports?: string[] };
  clientExtensionResults: Record<string, unknown>;
  authenticatorAttachment?: string;
  [key: string]: unknown;
}

/** `passkeyName` is a best-effort client label; the server normalises it (ADR 0010 item 6). */
export interface SetupVerifyRequest {
  setupToken: string;
  displayName: string;
  response: RegistrationResponse;
  passkeyName?: string;
}

export interface SetupVerifyResponse {
  user: User;
  recoveryCodes: string[];
}

export {
  feedErrorMessage,
  httpErrorCode,
  isFeedErrorCode,
  type FeedErrorCode,
} from './feed-errors';
