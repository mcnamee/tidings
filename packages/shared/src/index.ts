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

/** Spec 8.1, exactly. */
export type ErrorCode =
  | 'unauthenticated'
  | 'reauth_required'
  | 'csrf_failed'
  | 'forbidden'
  | 'not_found'
  | 'validation_failed'
  | 'rate_limited'
  | 'limit_reached'
  | 'conflict'
  | 'already_subscribed'
  | 'feed_choice_required'
  | 'no_feed_found'
  | 'fetch_failed'
  | 'blocked_address'
  | 'setup_unavailable'
  | 'invalid_setup_token'
  | 'webauthn_failed'
  | 'invalid_recovery_code'
  | 'last_passkey'
  | 'internal'
  | 'config_error';

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

// ── Sign in (spec 8.3) ─────────────────────────────────────────

/** PublicKeyCredentialRequestOptionsJSON. `allowCredentials` is empty (discoverable credentials). */
export interface RequestOptionsJSON {
  challenge: string;
  rpId?: string;
  userVerification?: 'required' | 'preferred' | 'discouraged';
  allowCredentials?: Array<{ id: string; type: 'public-key' }>;
  [key: string]: unknown;
}

/** The browser's `AuthenticationResponseJSON`, as far as the API envelope is concerned. */
export interface AuthenticationResponse {
  id: string;
  rawId: string;
  type: 'public-key';
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string;
  };
  clientExtensionResults: Record<string, unknown>;
  authenticatorAttachment?: string;
  [key: string]: unknown;
}

export interface LoginVerifyRequest {
  response: AuthenticationResponse;
}

export interface LoginVerifyResponse {
  user: User;
}

// ── Folders and subscriptions (spec 8.2, 8.4) ──────────────────

export interface Folder {
  id: string;
  name: string;
}

export type FeedState = 'pending' | 'ok' | 'failing' | 'dead' | 'gone';

export interface Subscription {
  id: string;
  folderId: string | null;
  /** Custom title, else the feed's title, else the feed URL's host. */
  title: string;
  customTitle: string | null;
  feedUrl: string;
  siteUrl: string | null;
  createdAt: string;
  health: {
    state: FeedState;
    lastSuccessAt: string | null;
    lastAttemptAt: string | null;
    errorCode: string | null;
    /** The fixed message for `errorCode` (spec 10.6 rule 8); never anything from the origin. */
    errorMessage: string | null;
    nextFetchAt: string;
    /** Fixed message for `feeds.warning_code` (TID-046); null until a warning exists. */
    warning: string | null;
  };
}

/** FR-SU-7. */
export const SUBSCRIPTION_LIMIT = 1000;
export const SUBSCRIPTION_TITLE_MAX = 200;

export interface SubscribeRequest {
  url: string;
  folderId?: string | null;
  title?: string;
}

/** `newEntries` is how many articles the user has from this feed after the first fetch. */
export interface SubscribeFetchOutcome {
  ok: boolean;
  newEntries: number;
  errorCode?: string;
}

export interface SubscribeResponse {
  subscription: Subscription;
  fetch: SubscribeFetchOutcome;
}

/** One `<link rel="alternate">` found on a page. Only the URL and title come from the page. */
export interface FeedCandidate {
  url: string;
  title: string | null;
  type: 'rss' | 'atom' | 'json';
  /** False for JSON Feed: shown, but not subscribable in the MVP. */
  supported: boolean;
}

export interface FeedChoiceDetails {
  candidates: FeedCandidate[];
}

export interface AlreadySubscribedDetails {
  subscriptionId: string;
}

export interface FoldersResponse {
  items: Folder[];
}

export interface SubscriptionsResponse {
  items: Subscription[];
}

// ── Entries and counts (spec 8.2, 8.5) ─────────────────────────

export type EntryListView = 'all' | 'folder' | 'feed';
export type EntryListState = 'unread' | 'all';

/** Spec 8.1: `limit` is 1 to 100, default 50. */
export const ENTRIES_PAGE_SIZE = 50;

export interface EntrySummary {
  id: string;
  subscriptionId: string;
  feedTitle: string;
  title: string | null;
  author: string | null;
  url: string | null;
  summary: string | null;
  imageUrl: string | null;
  publishedAt: string;
  isRead: boolean;
  isStarred: boolean;
}

export interface EntriesResponse {
  items: EntrySummary[];
  nextCursor: string | null;
  /** Server time of this response; the SPA keeps the first page's value as the mark-all-read watermark. */
  asOf: string;
}

/** Unread only. A subscription or folder with nothing unread is 0 or absent. */
export interface Counts {
  total: number;
  folders: Record<string, number>;
  subscriptions: Record<string, number>;
}

export {
  feedErrorMessage,
  feedWarningMessage,
  type FeedWarningCode,
  httpErrorCode,
  isFeedErrorCode,
  type FeedErrorCode,
} from './feed-errors';
