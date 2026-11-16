/** API contract shared by the SPA and the Worker. */
import { z } from 'zod';

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

export const DISPLAY_NAME_MAX = 64;

/** Spec 8.3: `displayName` is 1 to 64 characters after trimming. */
export const displayNameSchema = z.string().trim().min(1).max(DISPLAY_NAME_MAX);

export const setupOptionsRequestSchema = z.object({
  setupToken: z.string().min(1).max(512),
  displayName: displayNameSchema,
});
export type SetupOptionsRequest = z.infer<typeof setupOptionsRequestSchema>;

/** The browser's `RegistrationResponseJSON`. The WebAuthn library does the deep validation. */
export const registrationResponseSchema = z.looseObject({
  id: z.string().min(1).max(1024),
  rawId: z.string().min(1).max(1024),
  type: z.literal('public-key'),
  response: z.looseObject({
    clientDataJSON: z.string().min(1).max(8192),
    attestationObject: z.string().min(1).max(65536),
    transports: z.array(z.string().max(32)).max(8).optional(),
  }),
  clientExtensionResults: z.looseObject({}).default({}),
  authenticatorAttachment: z.string().max(32).optional(),
});
export type RegistrationResponse = z.infer<typeof registrationResponseSchema>;

/**
 * `passkeyName` is a best-effort client label: any junk (wrong type, empty, too long) is
 * normalised by the server, never rejected (ADR 0010 item 6).
 */
export const setupVerifyRequestSchema = z.object({
  setupToken: z.string().min(1).max(512),
  displayName: displayNameSchema,
  response: registrationResponseSchema,
  passkeyName: z.unknown().optional(),
});
export interface SetupVerifyRequest {
  setupToken: string;
  displayName: string;
  response: RegistrationResponse;
  passkeyName?: string;
}

/** PublicKeyCredentialCreationOptionsJSON. The SPA passes it straight to the browser library. */
export interface CreationOptionsJSON {
  challenge: string;
  rp: { name: string; id?: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: Array<{ type: 'public-key'; alg: number }>;
  [key: string]: unknown;
}

export interface SetupVerifyResponse {
  user: User;
  recoveryCodes: string[];
}

export const PASSKEY_NAME_MAX = 64;
export const PASSKEY_NAME_DEFAULT = 'Passkey';
/** Recovery codes: 10 codes of XXXX-XXXX-XXXX-XXXX in the Crockford alphabet (no I, L, O, U). */
export const RECOVERY_CODE_COUNT = 10;
export const RECOVERY_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/;
