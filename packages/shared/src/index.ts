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
  | 'invalid_link'
  | 'last_passkey'
  | 'internal'
  | 'config_error';

export interface ApiError {
  error: { code: ErrorCode; message: string; details?: unknown };
}

// ── Auth (spec 8.2, 8.3) ───────────────────────────────────────

/**
 * Spec 6.2 (`users.settings_json`). The stored document may lack any key, so every field is
 * optional here and each reader applies the default (`apps/web/src/lib/settings.ts`).
 * `markReadOnScroll` was added by TID-026 (default on).
 */
export interface UserSettings {
  theme?: 'system' | 'light' | 'dark';
  unreadOnly?: boolean;
  markReadOnOpen?: boolean;
  markReadOnScroll?: boolean;
  textSize?: 's' | 'm' | 'l';
  hideReadFeeds?: boolean;
  /** TID-067: the list order, default newest first. Remembered across devices. */
  listSort?: EntrySort;
}

export const THEMES = ['system', 'light', 'dark'] as const;
export const TEXT_SIZES = ['s', 'm', 'l'] as const;

/** `PATCH /api/me` (spec 8.3, TID-022). */
export interface UpdateMeRequest {
  displayName?: string;
  settings?: UserSettings;
}

export interface PasskeysResponse {
  items: Passkey[];
}

export interface RecoveryCodesResponse {
  recoveryCodes: string[];
}

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
  /** TID-009: unused recovery codes left. Present only on a recovery-code session (it feeds the banner). */
  recoveryCodesRemaining?: number;
  /** TID-053: true when emailed sign-in links are configured and usable (ADR 0016). */
  emailSignIn: boolean;
}

/** TID-053. The same `202 {}` is returned whatever the address. */
export interface EmailRequestRequest {
  email: string;
}
export interface EmailVerifyRequest {
  token: string;
}
export const EMAIL_MAX = 254;
export const MAGIC_LINK_TTL_SECONDS = 15 * 60;

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

// ── Recover (spec 8.3, TID-009) ────────────────────────────────

/** The code as typed; the server normalises it (spec 10.1). */
export interface RecoverRequest {
  code: string;
}

export interface RecoverResponse {
  user: User;
  mustAddPasskey: true;
  /** Unused codes left after this one was burned. */
  recoveryCodesRemaining: number;
}

// ── Add a passkey to a signed-in account (spec 8.3, TID-009) ───

export interface PasskeyVerifyRequest {
  response: RegistrationResponse;
  name: string;
}

export interface Passkey {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
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

/** `POST /api/subscriptions/:id/url` (TID-068). */
export interface ChangeFeedUrlRequest {
  url: string;
}

/** `changed` is false when the address resolves to the feed the subscription already follows. */
export interface ChangeFeedUrlResponse {
  subscription: Subscription;
  fetch: SubscribeFetchOutcome;
  changed: boolean;
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

/** Spec 8.7, FR-OP-1: feeds per `POST /api/import/opml`. */
export const IMPORT_CHUNK_SIZE = 100;
/** ADR 0013 decision 5: import first fetches per UTC day; the rest start from 00:05 UTC the next day. */
export const IMPORT_FIRST_FETCH_DAILY_CAP = 250;

export interface ImportFeed {
  xmlUrl: string;
  title?: string;
  htmlUrl?: string;
}

/** `POST /api/import/opml` (spec 8.7). Folders are matched by name; the server never sees IDs. */
export interface ImportOpmlRequest {
  folders: { name: string; feeds: ImportFeed[] }[];
  feeds: ImportFeed[];
}

export type ImportInvalidReason = 'invalid_url' | 'blocked_address' | 'limit_reached';

export interface ImportOpmlResponse {
  created: number;
  existing: number;
  deferred: number;
  invalid: { url: string; reason: ImportInvalidReason }[];
}

/** FR-FO-1 and FR-FO-5. */
export const FOLDER_NAME_MAX = 64;
export const FOLDER_LIMIT = 200;

/** `POST` and `PATCH /api/folders` (spec 8.4). */
export interface FolderRequest {
  name: string;
}

/** `PATCH /api/subscriptions/:id`. Omitted fields are unchanged; a null or blank title clears it. */
export interface UpdateSubscriptionRequest {
  title?: string | null;
  folderId?: string | null;
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

/** TID-067: `recommended` orders unread entries by the interest profile (spec 8.5). */
export type EntrySort = 'newest' | 'recommended';
export const ENTRY_SORTS = ['newest', 'recommended'] as const;
/** Why a recommended list came back newest first: too few signals so far, or no Workers AI. */
export type SortNote = 'cold_start' | 'unavailable';

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
  /** TID-077: topic slugs, most relevant first, at most 3. `[]` when untagged or no topic fits. */
  topics: string[];
}

/** `GET /api/entries/:id`. `contentHtml` is raw feed HTML: the client must sanitise it (spec 10.5). */
export interface Entry extends EntrySummary {
  contentHtml: string | null;
}

/** `PATCH /api/entries/:id` (spec 8.5). `isStarred` arrives with M2. */
export interface PatchEntryRequest {
  isRead: boolean;
}

/** `POST /api/entries/:id/engagement` (spec 8.5, ADR 0018). `open` = 1 point, `click` = 2. */
export type EngagementKind = 'open' | 'click';
export interface EngagementRequest {
  kind: EngagementKind;
}
export interface EngagementResponse {
  /** False when that kind was already recorded for the entry (a repeat is harmless and free). */
  recorded: boolean;
}

/** `POST /api/entries/read-state`: 1 to 1,000 IDs. */
export const READ_STATE_MAX_IDS = 1000;
export interface ReadStateRequest {
  entryIds: string[];
  isRead: boolean;
}
export interface ReadStateResponse {
  /** Entries whose state actually changed; IDs that are not the caller's are ignored. */
  updated: number;
}

/** `POST /api/entries/mark-all-read` (spec 8.5, FR-RD-9). `id` is a folder ID or subscription ID. */
export interface MarkAllReadRequest {
  view: EntryListView;
  id?: string;
  /** The list's `asOf`: only entries published at or before it are marked. */
  before: string;
}
export interface MarkAllReadResponse {
  updated: number;
  /** The entries that changed, for Undo; null when more than `MARK_ALL_UNDO_MAX` changed. */
  entryIds: string[] | null;
}
/** Above this many entries the SPA asks first (FR-RD-9). */
export const MARK_ALL_CONFIRM_OVER = 20;
/** Above this many entries no Undo is offered; it is also the read-state batch limit. */
export const MARK_ALL_UNDO_MAX = READ_STATE_MAX_IDS;

export interface EntriesResponse {
  items: EntrySummary[];
  nextCursor: string | null;
  /** Server time of this response; the SPA keeps the first page's value as the mark-all-read watermark. */
  asOf: string;
  /** The order actually used. `newest` when `recommended` was asked for but could not be applied. */
  sort: EntrySort;
  /** Set with `sort: 'newest'` when `recommended` was requested but not applied (spec 8.5). */
  sortNote?: SortNote;
}

/** Unread only. A subscription or folder with nothing unread is 0 or absent. */
export interface Counts {
  total: number;
  folders: Record<string, number>;
  subscriptions: Record<string, number>;
}

/** A topic as the API shows it (TID-077). `id` is the slug for system topics; a string so user topics can follow. */
export interface Topic {
  id: string;
  name: string;
}

/** `GET /api/topics`: the active system topics in display order. */
export interface TopicsResponse {
  items: Topic[];
  version: number;
}

export { TOPICS, TOPICS_VERSION, RETIRED_TOPIC_IDS, type SystemTopic } from './topics';

export {
  feedErrorMessage,
  feedWarningMessage,
  type FeedWarningCode,
  httpErrorCode,
  isFeedErrorCode,
  type FeedErrorCode,
} from './feed-errors';
