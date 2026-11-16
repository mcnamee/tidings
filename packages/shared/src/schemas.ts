import { z } from 'zod';
import { DISPLAY_NAME_MAX } from './index';

/** Request schemas for the auth routes (spec 8.3). Worker only: see the note in index.ts. */

export const displayNameSchema = z.string().trim().min(1).max(DISPLAY_NAME_MAX);

export const setupOptionsRequestSchema = z.object({
  setupToken: z.string().min(1).max(512),
  displayName: displayNameSchema,
});

/** The API envelope of the browser's `RegistrationResponseJSON`. The WebAuthn library does the rest. */
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

/**
 * `passkeyName` is deliberately `unknown`: any junk (wrong type, empty, too long) is normalised
 * by the server, never rejected (ADR 0010 item 6).
 */
export const setupVerifyRequestSchema = z.object({
  setupToken: z.string().min(1).max(512),
  displayName: displayNameSchema,
  response: registrationResponseSchema,
  passkeyName: z.unknown().optional(),
});
