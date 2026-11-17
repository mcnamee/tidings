import { z } from 'zod';
import { DISPLAY_NAME_MAX, FOLDER_NAME_MAX, SUBSCRIPTION_TITLE_MAX } from './index';

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

/** `login/options` takes `{}`. Extra keys are ignored. */
export const loginOptionsRequestSchema = z.looseObject({});

/** The API envelope of the browser's `AuthenticationResponseJSON`. The WebAuthn library does the rest. */
export const authenticationResponseSchema = z.looseObject({
  id: z.string().min(1).max(1024),
  rawId: z.string().min(1).max(1024),
  type: z.literal('public-key'),
  response: z.looseObject({
    clientDataJSON: z.string().min(1).max(8192),
    authenticatorData: z.string().min(1).max(8192),
    signature: z.string().min(1).max(8192),
    userHandle: z.string().max(1024).optional(),
  }),
  clientExtensionResults: z.looseObject({}).default({}),
  authenticatorAttachment: z.string().max(32).optional(),
});

export const loginVerifyRequestSchema = z.object({
  response: authenticationResponseSchema,
});

/** `POST /api/subscriptions` (spec 8.4). A blank title means "no custom title". */
export const subscribeRequestSchema = z.object({
  url: z.string().trim().min(1).max(2048),
  folderId: z.string().min(1).max(64).nullish(),
  title: z
    .string()
    .trim()
    .max(SUBSCRIPTION_TITLE_MAX)
    .transform((t) => (t === '' ? undefined : t))
    .optional(),
});

/** `POST` and `PATCH /api/folders`: 1 to 64 characters after trimming (FR-FO-1). */
export const folderRequestSchema = z.object({
  name: z.string().trim().min(1).max(FOLDER_NAME_MAX),
});

/** `PATCH /api/subscriptions/:id`: at least one field; a blank title means "use the feed's". */
export const updateSubscriptionRequestSchema = z
  .object({
    title: z
      .string()
      .trim()
      .max(SUBSCRIPTION_TITLE_MAX)
      .transform((t) => (t === '' ? null : t))
      .nullable()
      .optional(),
    folderId: z.string().min(1).max(64).nullable().optional(),
  })
  .refine((v) => v.title !== undefined || v.folderId !== undefined, {
    message: 'Provide title or folderId',
  });

/** `GET /api/entries` query (spec 8.5). `state` is absent when the user's setting decides. */
export const entriesQuerySchema = z
  .object({
    view: z.enum(['all', 'folder', 'feed']),
    id: z.string().min(1).max(64).optional(),
    state: z.enum(['unread', 'all']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(200).optional(),
  })
  .refine((q) => q.view === 'all' || q.id !== undefined, {
    message: 'id is required unless view=all',
    path: ['id'],
  });
