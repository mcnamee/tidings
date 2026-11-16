# Tidings: Product Spec

| | |
|---|---|
| Status | Draft v1, ready for build of M0 |
| Owner | product-manager |
| Last updated | 2026-11-16 |
| Cloudflare limits checked | **2026-11-16** against developers.cloudflare.com (see §9.1 for sources) |

This document is the single source of truth for what we build. Stories live in `docs/BACKLOG.md`. Decisions live in `docs/decisions/`. If code and this spec disagree, the spec wins until the PM changes it.

---

## 1. Problem, user and goals

### 1.1 Problem

The user pays for Inoreader to read a few hundred RSS/Atom feeds, mostly on a phone. They want to stop paying and own their data, without giving up what makes Inoreader usable day to day: feeds grouped in folders, unread counts, a fast mobile reading flow and a fresh feed list when they open the app.

### 1.2 Target user

- **Primary:** one person (the owner). Technical enough to deploy to Cloudflare from a repo. Reads in short sessions on a phone, often one-handed and in the dark. Has 150 to 300 feeds in about 10 to 25 folders, exported from Inoreader as OPML.
- **Secondary (later):** a few invited people (family or friends) on the same deployment. Not in MVP, but the data model is multi-tenant from day one.

### 1.3 Goals

1. **Switch in one sitting.** Import the Inoreader OPML and be reading within 15 minutes, with folders preserved.
2. **Fast on a phone.** Opening the app shows cached articles immediately. No waiting on feed fetches.
3. **Fresh without effort.** Feeds refresh in the background every 30 minutes.
4. **Near-zero cost.** Runs entirely on the Cloudflare Workers Free plan at the target load, with measured headroom.
5. **Private and secure.** Only the owner can see their account. Feed content can't run script in the app.

### 1.4 Non-goals

- Native iOS/Android apps. (The SPA is installable as a PWA.)
- Social features, sharing, comments, public profiles.
- Two-way sync with Inoreader or migration of Inoreader read state or starred items.
- Full-text article extraction (readability), AI summaries, translations.
- Podcast playback beyond a link to the enclosure.
- Server-rendered pages. (Hard constraint: SPA + JSON API.)

### 1.5 Success measures (first 30 days after switch)

- The owner cancels Inoreader.
- ≥ 95% of healthy feeds are fetched within 35 minutes of their previous fetch (§7).
- Zero days on which a Cloudflare free-plan quota is exhausted (§9).
- Article list for any view renders from cache within 1 s of app launch on a mid-range phone (§12).

---

## 2. Scope by milestone

| Milestone | Theme | Contents |
|---|---|---|
| **M0 Foundations** | De-risk and scaffold | Monorepo, CI, test harness, D1 schema, design system and app shell, two time-boxed spikes (parser CPU, fan-out isolation). |
| **M1 MVP: "switch from Inoreader"** | Everything needed to cancel Inoreader | Passkey auth with recovery codes; subscribe by URL with autodiscovery; folders; OPML import and export; background refresh with caching, conditional GET and backoff; article lists for All, Folder and Feed with unread-only filter and cursor pagination; unread counts; article view with sanitised content; mark read on open, toggle unread, mark all as read; feed health and manual refresh; retention cleanup; settings (theme, passkeys, recovery codes, sign out); persisted client cache and installable PWA shell; production deploy. |
| **M2 Comfort** | Inoreader parity for daily use | Star / "Saved" view; mark-read-on-scroll; swipe to next/previous article; oldest-first sort; "mark older than X as read"; adaptive refresh interval (honour `ttl`, `sy:updatePeriod`, back off quiet feeds); feed favicons; desktop keyboard shortcuts; active sessions list; reorder folders. |
| **M3 Later** | Nice to have | Offline reading of article bodies; full-text search (D1 FTS5, after a budget check); invite-only multi-user; multiple folders per feed (tags); filter rules; update-in-place for edited articles. |
| **Won't do** | | Native apps, Inoreader API sync, social, readability extraction, AI features, image proxying (see open question Q9). |

MVP is deliberately tight. Starring is M2 even though the `is_starred` column exists from the first migration, so adding it later is UI and API work only.

---

## 3. Functional requirements

Requirement IDs (`FR-xx-n`) are referenced from backlog acceptance criteria.

### 3.1 Authentication (AU)

Decision: **passkeys (WebAuthn) with single-use recovery codes**, opaque server-side sessions. Single owner in MVP. See ADR 0002 and §10.

- **FR-AU-1 First-run setup.** When no user exists, the app shows a setup screen. The owner enters a display name and the `SETUP_TOKEN` (a deploy-time secret) and registers a passkey. Setup is impossible once any user exists.
- **FR-AU-2 Recovery codes.** On successful setup, the app shows 10 single-use recovery codes once, with "copy" and "download as .txt". The owner must tick "I've saved these" to continue.
- **FR-AU-3 Sign in.** A single "Sign in with a passkey" button uses discoverable credentials (no username field). Success creates a session and lands on the default view.
- **FR-AU-4 Recover.** "Lost your passkey?" accepts a recovery code. A valid unused code signs the user in, burns the code, and shows a persistent banner "Add a new passkey" linking to settings.
- **FR-AU-5 Sessions.** Sessions last 30 days since last use (sliding) with a 180-day absolute cap. Sign out ends the current session. "Sign out everywhere" ends all sessions for the user.
- **FR-AU-6 Passkey management.** In settings the user can list passkeys (name, created, last used), add another, rename one, and remove one. Removing the last passkey is refused.
- **FR-AU-7 Regenerate recovery codes.** Replaces all codes. Requires a sign-in within the last 15 minutes, otherwise the API returns `reauth_required` and the UI runs a passkey sign-in first.
- **FR-AU-8 Closed sign-up.** There is no public registration. Additional users are M3 (invites).

### 3.2 Subscriptions (SU)

- **FR-SU-1 Add by URL.** The user pastes a feed URL or a website URL. If the URL returns a feed (RSS 2.0, RSS 1.0/RDF, Atom 1.0), subscribe to it. If it returns HTML, discover `<link rel="alternate">` feeds with types `application/rss+xml`, `application/atom+xml`, `application/feed+json` (JSON Feed is discovered but only RSS/Atom/RDF are supported in MVP, so JSON Feed candidates are shown as unsupported). One candidate: subscribe. Several: return them for the user to pick. None: error `no_feed_found`.
- **FR-SU-2 Immediate first fetch.** A new subscription's feed is fetched before the API responds (or within 10 s if the fetch is slow), so the user sees articles straight away. If the feed already exists in the system and was fetched in the last 30 minutes, no fetch happens; the newest stored entries are linked to the user instead.
- **FR-SU-3 First-fetch policy.** For a new subscription, at most the newest 10 items are added for the user. Items published more than 7 days ago are added as already read. (Prevents a 10,000-unread flood after import.)
- **FR-SU-4 Optional folder and title at add time.**
- **FR-SU-5 Edit.** Rename (custom title, empty resets to the feed's title) and move to a folder or to "no folder".
- **FR-SU-6 Unsubscribe.** Removes the subscription and the user's article state for that feed. Confirmation required.
- **FR-SU-7 Limits.** Max 1,000 subscriptions per user (error `limit_reached`).
- **FR-SU-8 Duplicates.** Subscribing to a feed the user already has (after URL canonicalisation, §6.4) returns `already_subscribed` with the existing subscription ID.

### 3.3 Folders (FO)

- **FR-FO-1** Create, rename and delete folders. Names are 1 to 64 characters, unique per user, case-insensitive.
- **FR-FO-2** A subscription is in **zero or one** folder in MVP. Feeds without a folder appear at the top level of the navigation.
- **FR-FO-3** Deleting a folder moves its subscriptions to "no folder". It never unsubscribes. Confirmation required.
- **FR-FO-4** Folders and feeds within the navigation are sorted alphabetically (case-insensitive) in MVP. Manual ordering is M2.
- **FR-FO-5** Max 200 folders per user.

### 3.4 OPML import and export (OP)

- **FR-OP-1 Import.** The user picks an `.opml`/`.xml` file. The **browser** parses it (`DOMParser`) and shows a preview: "Found 243 feeds in 18 folders. 3 already subscribed. 1 invalid." On confirm, the SPA sends the feeds to the API in chunks of up to 100.
- **FR-OP-2 Inoreader structure.** Top-level `<outline>` elements with children become folders (name from `title`, falling back to `text`). `<outline>` elements with `xmlUrl` become feeds. Nested folders deeper than one level are flattened into their top-level folder. A feed that appears in several folders goes in the first one; the preview says how many were affected.
- **FR-OP-3 No synchronous fetch on import.** Imported feeds are scheduled for immediate background fetch (`next_fetch_at = now`, staggered). The import screen shows progress: "Fetched 120 of 243 feeds", polling `GET /api/subscriptions` every 5 s until done or the user leaves.
- **FR-OP-4 Idempotent.** Re-importing the same file creates nothing new; existing folders are matched by name.
- **FR-OP-5 Export.** `GET /api/export/opml` downloads an OPML 2.0 file of the user's folders and subscriptions that Inoreader (and this importer) can read back.

### 3.5 Background refresh and caching (RF)

Full design in §7.

- **FR-RF-1** Every active feed is fetched every 30 minutes (`fetch_interval_s = 1800`) regardless of whether anyone has the app open.
- **FR-RF-2** Fetches use conditional GET (`If-None-Match`, `If-Modified-Since`) and skip parsing if the body is byte-identical to the last one.
- **FR-RF-3** Failing feeds back off exponentially, capped at 24 hours. `410 Gone` stops fetching. Feeds that fail for 7 days are marked `dead` and retried daily.
- **FR-RF-4** All fetches go through the SSRF-safe fetcher (§10.6).
- **FR-RF-5** Articles are stored once per feed and deduplicated by a stable key (§6.3), however many users subscribe.
- **FR-RF-6** Retention: read, unstarred articles older than 30 days and unread articles older than 90 days are removed for the user; stored content of articles nobody needs is purged. Starred articles are kept forever (M2).
- **FR-RF-7 Manual refresh.** "Refresh now" on a single feed fetches it immediately. Limited to once per 5 minutes per feed per user (`rate_limited`).

### 3.6 Reading experience (RD)

- **FR-RD-1 Views.** Three list views: **All** (every subscription), **Folder** (subscriptions in one folder, merged), **Feed** (one subscription).
- **FR-RD-2 Navigation.** A drawer (or sidebar at ≥ 1024 px) lists All, then folders (expandable to their feeds), then feeds without a folder, each with its unread count. Folders and feeds with zero unread are shown dimmed in unread-only mode and hidden if "Hide read feeds" is on (default off).
- **FR-RD-3 Sort.** Newest first by `published_at` (clamped to never be later than the time we fetched it). Oldest first is M2.
- **FR-RD-4 Filter.** "Unread only" (default) or "All articles", per the user's setting, toggleable from the list header.
- **FR-RD-5 List item.** Feed title, article title (max 3 lines, ellipsis), relative time, up to 2 lines of summary text, thumbnail if `imageUrl` exists, and a read/unread visual state. Exact layout: UX.
- **FR-RD-6 Pagination.** Infinite scroll in pages of 50 using an opaque cursor. New articles that arrive while scrolling never cause duplicates or skips (keyset pagination, §8.6).
- **FR-RD-7 Article view.** Title, feed title, author, date, sanitised content (§10.5), "Open original" (new tab, `noopener noreferrer`), next/previous article within the current list, back to the list at the same scroll position.
- **FR-RD-8 Read state.** Opening an article marks it read (setting "Mark as read when opened", default on). The article view and list item have "Mark as unread"/"Mark as read". Updates are optimistic: UI reflects the change within 100 ms and rolls back with a toast on API failure.
- **FR-RD-9 Mark all as read.** Available on every list view. Marks only articles that were in the view when the user loaded it (`before` watermark, §8.5), with a confirm step when more than 20 articles would be affected. Shows "Undo" for 5 s (undo calls the batch mark-unread endpoint with the returned IDs; if more than 1,000 were affected, undo is not offered).
- **FR-RD-10 Unread counts.** Shown for All, each folder and each feed. Refetched on app focus, after any read-state mutation (debounced 2 s), and every 5 minutes while the app is visible.
- **FR-RD-11 Pull to refresh.** On a list, pull-to-refresh refetches the list and counts from the API (cached server data). It does not fetch feeds from origin.
- **FR-RD-12 Empty states.** No subscriptions; no unread in this view ("All caught up"); feed never fetched yet; feed failing. Copy: UX.

### 3.7 Feed health (FH)

- **FR-FH-1** The Manage screen lists every subscription with its folder, state (`ok`, `pending`, `failing`, `dead`, `gone`), last successful fetch time, and the last error in plain language (for example "The server returned 404 Not Found", "Timed out after 10 s", "Too large (over 2 MB)", "Couldn't parse the feed").
- **FR-FH-2** A failing feed shows a warning marker in the navigation drawer.

### 3.8 Settings and theme (ST)

- **FR-ST-1 Theme.** System (default), Light, Dark. Applies without a flash of the wrong theme on load. Stored on the server (follows the user across devices) and mirrored in `localStorage` for first paint.
- **FR-ST-2 Reading.** "Show unread only by default" (on), "Mark as read when opened" (on), "Hide feeds with no unread" (off), article text size (S / M / L, default M).
- **FR-ST-3 Account.** Display name; passkeys (FR-AU-6); regenerate recovery codes (FR-AU-7); sign out; sign out everywhere.
- **FR-ST-4 Data.** Import OPML; export OPML; storage note ("Articles are kept for 30 days after you read them").

### 3.9 PWA and client cache (PW)

- **FR-PW-1** Web app manifest (name "Tidings", icons, `display: standalone`, theme colours for light and dark) so the app installs to the home screen on iOS and Android.
- **FR-PW-2** A service worker precaches the app shell (HTML, JS, CSS, icons) so the app opens with no network.
- **FR-PW-3** The TanStack Query cache (lists, counts, folders, subscriptions, the last 50 opened articles) is persisted to IndexedDB and restored on launch, then revalidated in the background. When offline, the app shows cached data with an "Offline" indicator and queues nothing (mutations fail with a toast; offline mutation queue is M3).

---

## 4. System architecture

### 4.1 Overview

```
 Phone / desktop browser
 ┌───────────────────────────────────────────┐
 │ React SPA (Vite build)                    │
 │  TanStack Query ── persisted to IndexedDB │
 │  DOMPurify (sanitises article HTML)       │
 │  Service worker (app shell precache)      │
 └───────────────┬───────────────────────────┘
                 │ HTTPS, same origin, cookie session
 ┌───────────────▼────────────────────────────────────────────────┐
 │ Cloudflare Worker "tidings" (one deployable)                    │
 │                                                                 │
 │  Static assets  ── SPA files, not_found_handling = SPA,         │
 │                    _headers (CSP etc.). Worker NOT invoked.     │
 │  fetch()        ── /api/* only (run_worker_first), Hono router  │
 │  scheduled()    ── cron "* * * * *": refresh dispatcher         │
 │                    cron "17 * * * *": maintenance/cleanup       │
 │  FeedRefresher  ── WorkerEntrypoint, called per feed via         │
 │                    ctx.exports loopback RPC (own invocation)    │
 └──────┬───────────────────────────────┬──────────────────────────┘
        │ binding                        │ fetch() (SSRF-guarded)
 ┌──────▼───────┐                 ┌──────▼──────────┐
 │ D1 "tidings" │                 │ Feed origins    │
 └──────────────┘                 └─────────────────┘
```

### 4.2 Cloudflare products used

| Product | Used for | Why |
|---|---|---|
| **Workers** (Free) | JSON API, cron handlers, per-feed refresh entrypoint | Required runtime. One Worker keeps deploys and bindings simple. |
| **Workers Static Assets** | Serving the SPA build | Asset requests don't invoke the Worker when they match a file or are navigations with `not_found_handling = "single-page-application"`; only `/api/*` runs the Worker (`run_worker_first: ["/api/*"]`). `_headers` sets CSP on SPA responses. |
| **D1** (Free) | All persistent data: users, auth, feeds, articles, read state | Relational queries (counts, keyset pagination, joins) and the highest free write allowance of the storage options. |
| **Cron Triggers** | Two triggers: refresh dispatcher every minute; hourly maintenance | Free plan allows 5 per account. We use 2 and can add up to 3 more dispatchers if needed. |
| **Service binding via `ctx.exports`** | Loopback RPC from the dispatcher (and the subscribe API) to `FeedRefresher`, one call per feed | Gives each feed its own invocation so one big feed can't blow the whole tick's 10 ms CPU budget. **To be confirmed by spike TID-003.** Fallback ladder in ADR 0004. |
| **Rate Limiting binding** | Coarse per-user API limit | Only if TID-003 confirms it works on the Free plan. Auth endpoints use a D1 counter regardless. |

**Deliberately not used in MVP**

| Product | Reason |
|---|---|
| **KV** | Free plan allows 1,000 writes/day. Nothing we'd cache in KV is worth a second consistency model; D1 is fast enough and TanStack Query caches on the client. |
| **Queues** | Free plan allows 10,000 operations/day and a message costs 3 operations (write, read, delete), so about 3,300 messages/day. Our baseline is 12,000 feed fetches/day. One message per feed doesn't fit. |
| **Durable Objects** | Not needed for one owner. Kept as a fallback for fan-out (ADR 0004). |
| **R2, Images, Email** | No need in MVP. |

### 4.3 Repository layout (npm workspaces monorepo)

```
tidings/
├── package.json              # workspaces, root scripts: dev, build, typecheck, lint, test, test:e2e
├── tsconfig.base.json        # strict: true
├── eslint.config.js          # flat config, typescript-eslint, react-hooks, jsx-a11y
├── .prettierrc
├── .github/workflows/ci.yml
├── apps/
│   ├── web/                  # React SPA
│   │   ├── index.html
│   │   ├── public/           # _headers, manifest icons, theme-init.js
│   │   ├── src/
│   │   │   ├── main.tsx, routes/, components/, features/{auth,reader,manage,settings}/
│   │   │   ├── api/          # typed client built on packages/shared
│   │   │   └── lib/sanitize.ts  # the ONLY place DOMPurify is called
│   │   └── vite.config.ts
│   └── worker/               # Cloudflare Worker
│       ├── wrangler.jsonc    # assets.directory = "../web/dist"
│       ├── migrations/       # 0001_init.sql, 0002_..., applied by wrangler d1 migrations
│       ├── src/
│       │   ├── index.ts      # default export {fetch, scheduled}; export class FeedRefresher
│       │   ├── api/          # Hono app, routes per resource, middleware (auth, csrf, errors)
│       │   ├── auth/         # webauthn, sessions, recovery codes
│       │   ├── refresh/      # dispatcher, refreshFeed, backoff, maintenance
│       │   ├── fetcher/      # safeFetch (SSRF guard, redirects, caps)
│       │   └── db/           # typed query functions; every user-data function takes userId first
│       └── test/             # integration tests (vitest-pool-workers)
├── packages/
│   ├── shared/               # API types + zod schemas shared by web and worker; error codes; constants
│   └── feed-parser/          # pure TS: parse RSS/Atom/RDF → NormalisedFeed; dedup key; summary/image extraction
├── e2e/                      # Playwright (owned by tester), fixture feed server
│   └── fixtures/feeds/, fixtures/opml/
└── docs/
```

`packages/feed-parser` has no Workers-specific APIs so it can be unit-tested and benchmarked in Node, and swapped if the spike picks a different library.

### 4.4 Backend stack

| Concern | Choice (version current on 2026-11-16) | Why |
|---|---|---|
| Language | TypeScript, `strict` | Constraint. |
| Router / middleware | **Hono 4.x** (4.13.18) | Built for Workers, zero dependencies, small, typed routes and middleware. |
| Validation | **zod 4.x** (4.6.7) + `@hono/zod-validator` | One schema per request body/query in `packages/shared`, reused by the SPA for typing. |
| DB access | **Raw SQL via the D1 binding** (`prepare().bind()`, `batch()`) behind typed functions in `apps/worker/src/db` | Our free-tier budget is measured in rows read/written; explicit SQL keeps every query and index visible and testable (`meta.rows_read`). No ORM. |
| WebAuthn | **@simplewebauthn/server 14.x** (14.1.0) | Maintained, documents Cloudflare Workers support, uses Web Crypto. Cold-start and CPU cost measured in TID-003. |
| Feed parsing | **htmlparser2 12.x** (12.0.0) in `xmlMode`, streaming callbacks, with our own RSS/Atom/RDF mapper (provisional) | Streaming and tolerant of malformed XML; lets us stop after N items and skip elements we don't store, which bounds CPU. Alternative under test: **feedsmith 3.x** (3.0.1, built on fast-xml-parser). Spike TID-002 decides; ADR 0006. |
| HTML discovery | Workers **HTMLRewriter** (native) | Finds `<link rel="alternate">` in website HTML without JS parsing cost. |
| Hashing | Web Crypto `SHA-256`, Workers `crypto.DigestStream` for the body hash while streaming | Native, cheap. |

### 4.5 Frontend stack

| Concern | Choice (version current on 2026-11-16) | Why |
|---|---|---|
| Build | **Vite 8.x** (8.3.8) | Fast dev server, standard for React SPAs, proxy `/api` to `wrangler dev`. |
| UI | **React 19.x** (19.3.1) | Constraint. |
| Styling | **Tailwind CSS 4.x** (4.3.5) via `@tailwindcss/vite` | Constraint. CSS-first config; design tokens as CSS variables; dark mode via `@custom-variant dark` keyed on a `data-theme` attribute on `<html>` so "System/Light/Dark" all work. |
| Routing | **React Router 8.x** (8.5.1), declarative/data mode, no framework/SSR mode | Mature, nested routes for list → article, scroll restoration. |
| Server state | **TanStack Query 5.x** (5.107.1): `useInfiniteQuery` for cursor lists, optimistic mutations | Caching, background revalidation, optimistic updates and rollback out of the box. |
| Persistence | `@tanstack/react-query-persist-client` + `@tanstack/query-async-storage-persister` + **idb-keyval 6.x** | Restores the last-seen lists and counts from IndexedDB on launch: the "instant open" goal. Max age 7 days; cache buster = app version. |
| Sanitising | **DOMPurify 3.x** (3.4.18) | The standard HTML sanitiser; runs in the browser where CPU is free. |
| PWA | **vite-plugin-pwa 2.x** (2.0.0, Workbox) | Manifest + app-shell precache with no hand-written service worker. |
| Passkeys (client) | **@simplewebauthn/browser 14.x** (14.0.0) | Pairs with the server library. |
| Icons | `lucide-react` | Tree-shakeable, consistent stroke icons. UX may substitute. |

No other runtime libraries without PM approval (state management, UI kits, date libraries: use `Intl.RelativeTimeFormat` / `Intl.DateTimeFormat`).

### 4.6 Wrangler configuration (normative excerpt)

```jsonc
{
  "name": "tidings",
  "main": "src/index.ts",
  "compatibility_date": "<date of scaffolding>",
  "compatibility_flags": ["enable_ctx_exports"], // loopback RPC; confirmed or replaced by TID-003
  "assets": {
    "directory": "../web/dist",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"]
  },
  "d1_databases": [{ "binding": "DB", "database_name": "tidings", "database_id": "<id>", "migrations_dir": "migrations" }],
  "triggers": { "crons": ["* * * * *", "17 * * * *"] },
  "vars": { "APP_ORIGIN": "https://<host>", "RP_ID": "<host>", "RP_NAME": "Tidings" }
  // secrets: SETUP_TOKEN (wrangler secret put)
}
```

`run_worker_first` needs Wrangler ≥ 4.20. Add `nodejs_compat` only if a chosen library needs it, and say so in the story report.

---

## 5. Users, roles and tenancy

- **MVP is single-user**: one `owner` created by first-run setup. No sign-up endpoint exists.
- **The data model is multi-tenant**: every user-owned row has `user_id`; feeds and entries are shared, deduplicated infrastructure that no user can read except through their own `subscriptions` and `user_entries`. Adding invited users (M3) needs no schema change to these tables.
- Feed URLs and article content are not secret (they're public), but *which* feeds a user follows and *what* they've read is private and always scoped by `user_id`.

---

## 6. Data model (D1)

Conventions: times are `INTEGER` Unix epoch **seconds** (UTC) in the DB and ISO-8601 strings in the API. User-facing IDs for users, folders, subscriptions and passkeys are random `TEXT` (`crypto.randomUUID()`); feeds and entries use `INTEGER PRIMARY KEY` to keep the hot indexes small. Booleans are `INTEGER` 0/1. All schema changes are numbered migrations in `apps/worker/migrations/`.

### 6.1 Tables (migration `0001_init.sql`, normative)

```sql
-- ── Users & auth ─────────────────────────────────────────────
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','member')),
  settings_json TEXT NOT NULL DEFAULT '{}',   -- validated by zod (UserSettings)
  created_at    INTEGER NOT NULL
);

CREATE TABLE passkeys (
  id            TEXT PRIMARY KEY,             -- credential ID, base64url
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key    BLOB NOT NULL,
  counter       INTEGER NOT NULL DEFAULT 0,
  transports    TEXT,                         -- JSON array
  device_type   TEXT,                         -- 'singleDevice' | 'multiDevice'
  backed_up     INTEGER NOT NULL DEFAULT 0,
  name          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);
CREATE INDEX passkeys_user ON passkeys(user_id);

CREATE TABLE webauthn_challenges (
  id          TEXT PRIMARY KEY,               -- also stored in a short-lived __Host- cookie
  user_id     TEXT,                           -- NULL for setup and sign-in
  purpose     TEXT NOT NULL CHECK (purpose IN ('setup','login','add_passkey')),
  challenge   TEXT NOT NULL,
  expires_at  INTEGER NOT NULL                -- now + 300
);

CREATE TABLE recovery_codes (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL UNIQUE,           -- hex SHA-256 of normalised code
  used_at     INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX recovery_codes_user ON recovery_codes(user_id);

CREATE TABLE sessions (
  id_hash          TEXT PRIMARY KEY,          -- hex SHA-256 of the cookie token; raw token never stored
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at       INTEGER NOT NULL,
  authenticated_at INTEGER NOT NULL,          -- last passkey/recovery auth, for step-up checks
  expires_at       INTEGER NOT NULL,          -- sliding, see §10.2
  absolute_expires_at INTEGER NOT NULL,
  user_agent       TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE rate_limits (                    -- fixed-window counters for auth endpoints
  key           TEXT PRIMARY KEY,             -- e.g. 'recover:ip:203.0.113.9'
  window_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL
);

-- ── Feeds (shared) ───────────────────────────────────────────
CREATE TABLE feeds (
  id                 INTEGER PRIMARY KEY,
  url                TEXT NOT NULL UNIQUE,    -- canonical, §6.4
  site_url           TEXT,
  title              TEXT,
  description        TEXT,
  etag               TEXT,
  last_modified      TEXT,
  body_hash          TEXT,                    -- SHA-256 of last 200 body
  fetch_interval_s   INTEGER NOT NULL DEFAULT 1800,
  next_fetch_at      INTEGER NOT NULL,        -- deliberately NOT indexed, see §9.4
  last_attempt_at    INTEGER,
  last_success_at    INTEGER,                 -- last 200 or 304 after an error, or last 200 with changes
  last_new_entry_at  INTEGER,
  error_count        INTEGER NOT NULL DEFAULT 0,
  last_error_code    TEXT,                    -- 'http_404','timeout','too_large','parse_error','cpu_limit','blocked_address',...
  last_status        INTEGER,
  state              TEXT NOT NULL DEFAULT 'pending'
                     CHECK (state IN ('pending','ok','failing','dead','gone')),
  created_at         INTEGER NOT NULL
);

-- ── Per-user organisation ───────────────────────────────────
CREATE TABLE folders (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL COLLATE NOCASE,
  position    INTEGER NOT NULL DEFAULT 0,     -- unused in MVP (alphabetical), used in M2
  created_at  INTEGER NOT NULL,
  UNIQUE (user_id, name)
);

CREATE TABLE subscriptions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feed_id       INTEGER NOT NULL REFERENCES feeds(id),
  folder_id     TEXT REFERENCES folders(id) ON DELETE SET NULL,
  title_override TEXT,
  created_at    INTEGER NOT NULL,
  UNIQUE (user_id, feed_id)
);
CREATE INDEX subscriptions_feed ON subscriptions(feed_id);          -- fan-out to subscribers
CREATE INDEX subscriptions_user_folder ON subscriptions(user_id, folder_id);

-- ── Articles (shared) ────────────────────────────────────────
CREATE TABLE entries (
  id            INTEGER PRIMARY KEY,
  feed_id       INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  guid_hash     TEXT NOT NULL,                -- dedup key, §6.3
  url           TEXT,                         -- http(s) only, else NULL
  title         TEXT,
  author        TEXT,
  summary       TEXT,                         -- plain text, ≤ 300 chars
  content_html  TEXT,                         -- raw, UNSANITISED, ≤ 100 KB; NULL after purge
  image_url     TEXT,                         -- http(s) only
  published_at  INTEGER NOT NULL,             -- clamped to ≤ fetched_at
  fetched_at    INTEGER NOT NULL,
  purged_at     INTEGER,                      -- content removed; row kept as dedup tombstone
  UNIQUE (feed_id, guid_hash)
);
CREATE INDEX entries_published ON entries(published_at);           -- cleanup scans

-- ── Per-user article state ───────────────────────────────────
CREATE TABLE user_entries (
  user_id      TEXT NOT NULL,
  entry_id     INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  feed_id      INTEGER NOT NULL,              -- denormalised for view filters
  published_at INTEGER NOT NULL,              -- denormalised for ordering
  is_read      INTEGER NOT NULL DEFAULT 0,
  is_starred   INTEGER NOT NULL DEFAULT 0,    -- M2 UI; column exists now
  read_at      INTEGER,
  PRIMARY KEY (user_id, entry_id)
) WITHOUT ROWID;
CREATE INDEX ue_all        ON user_entries(user_id, published_at DESC, entry_id DESC);
CREATE INDEX ue_feed       ON user_entries(user_id, feed_id, published_at DESC, entry_id DESC);
CREATE INDEX ue_unread_all ON user_entries(user_id, published_at DESC, entry_id DESC) WHERE is_read = 0;
CREATE INDEX ue_unread_feed ON user_entries(user_id, feed_id, published_at DESC, entry_id DESC) WHERE is_read = 0;
```

Every index costs one extra row written per insert (and per update that touches its columns). The four `user_entries` indexes are the minimum for the four list queries (All/Feed × all/unread); partial indexes mean marking read *removes* rows from the unread indexes rather than rewriting them. Starred indexes are added in M2.

### 6.2 Settings document (`users.settings_json`)

```ts
type UserSettings = {
  theme: 'system' | 'light' | 'dark';     // default 'system'
  unreadOnly: boolean;                     // default true
  markReadOnOpen: boolean;                 // default true
  textSize: 's' | 'm' | 'l';               // default 'm'
  hideReadFeeds: boolean;                  // default false
};
```

### 6.3 Article deduplication

For each parsed item the dedup key is `guid_hash = base64url(SHA-256(feedId + "\n" + key)).slice(0, 22)` where `key` is the first non-empty of:

1. RSS `<guid>` / Atom `<id>` / RDF `rdf:about`, trimmed, verbatim (case-sensitive).
2. The item link, canonicalised (§6.4).
3. `title + "\n" + (published date ISO or "") + "\n" + (enclosure URL or "")`.

`UNIQUE(feed_id, guid_hash)` enforces it. Insert uses `INSERT … ON CONFLICT(feed_id, guid_hash) DO NOTHING`. Before inserting, the refresher looks up which of the parsed keys already exist (`SELECT guid_hash FROM entries WHERE feed_id = ? AND guid_hash IN (…)`, ≤ 50 keys) so it only writes genuinely new items and their `user_entries`.

**Tombstones prevent resurrection.** When cleanup removes content, it sets `content_html = NULL, summary = NULL, purged_at = now` and keeps the row (≈ 100 bytes) for 180 days, so an old item still present in the feed XML is recognised and not re-added as unread. Tombstones older than 180 days are deleted.

Edited articles (same key, changed content) are **not** updated in MVP. Cross-feed duplicates (the same story in two feeds) are not merged.

### 6.4 URL canonicalisation (feeds and links)

Lower-case scheme and host; drop default ports (`:80` for http, `:443` for https); drop the fragment; keep path and query exactly; percent-encoding left as is; IDN hosts converted to punycode via `new URL()`. `feed://` and `feed:https://` are rewritten to `https://`. Only `http` and `https` are accepted.

### 6.5 Other rules

- `published_at`: from `pubDate` / `published` / `updated` / `dc:date`. Missing or unparseable → `fetched_at`. Later than `fetched_at` → `fetched_at`.
- `summary`: plain text derived from description or content: strip tags with a bounded regex over the first 4 KB, decode entities, collapse whitespace, truncate to 300 characters at a word boundary.
- `image_url`: first of `media:thumbnail`, `media:content[medium=image]`, an image `enclosure`, or the first `<img src>` in the first 8 KB of content. Must be http(s).
- `content_html`: `content:encoded`, Atom `content`, else `description`/`summary`. Truncated to 100 KB (the client sanitiser repairs any broken markup).
- Per-user limits: 1,000 subscriptions, 200 folders.

---

## 7. Background refresh design

### 7.1 Scheduling

- **Dispatcher** (`scheduled`, cron `* * * * *`, 1,440 runs/day). One statement leases due feeds:

  ```sql
  UPDATE feeds
     SET next_fetch_at = ?now + fetch_interval_s,
         last_attempt_at = ?now
   WHERE id IN (SELECT id FROM feeds
                 WHERE next_fetch_at <= ?now AND state != 'gone'
                 ORDER BY next_fetch_at
                 LIMIT ?batch)
  RETURNING id, url, etag, last_modified, body_hash, error_count, state;
  ```

  Feeds with no subscribers are parked rather than filtered here (a per-row `EXISTS` would double the scan's reads): when the last subscription to a feed is deleted, the same transaction sets `next_fetch_at = 253402300799` (year 9999); a new subscription resets it to `now`.

  Because the lease moves `next_fetch_at` forward atomically, overlapping ticks (or a second dispatcher cron) never fetch the same feed twice. If a refresh crashes, the feed is simply retried at its next interval.

- **Batch size `B = 20`** feeds per tick (constant `REFRESH_BATCH_SIZE`). It's bounded by: the 50 external subrequests per invocation (if the callees' fetches count against the dispatcher, 20 feeds + up to 1 redirect each = 40, leaving headroom) and the 32-invocation cap per request for service-binding calls. TID-003 may raise it to 25.
- **Capacity:** 1,440 ticks × 20 = **28,800 feed fetches/day**. At 30-minute intervals that's 600 feeds. Each extra dispatcher cron adds the same again (max 3 more; 5 cron triggers per account).
- **Jitter.** New feeds get `next_fetch_at = now + random(0, 60)` s; imports stagger over `ceil(n / B)` minutes so they don't all land in one tick.

### 7.2 Fan-out

For each leased feed the dispatcher calls `ctx.exports.FeedRefresher.refresh(job)` (RPC to a `WorkerEntrypoint` in the same Worker) and awaits all with `Promise.allSettled`. Each RPC is a separate invocation, so **each feed gets its own 10 ms CPU budget** and a crash or CPU-limit kill affects only that feed. *This isolation is the central assumption of the design and is unverified; TID-003 proves it.* If it's false, ADR 0004's fallback ladder applies.

When an RPC rejects (exception, CPU limit, timeout), the dispatcher records the failure itself (`error_count + 1`, `last_error_code = 'cpu_limit' | 'internal'`, backoff), because the killed callee can't.

### 7.3 Refreshing one feed (`refreshFeed(job)`)

1. **Fetch** via `safeFetch` (§10.6): `GET`, `User-Agent: Tidings/1.0 (+<APP_ORIGIN>)`, `Accept: application/rss+xml, application/atom+xml, application/rdf+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1`, `If-None-Match: etag`, `If-Modified-Since: last_modified`. Timeout 10 s. Redirects followed manually, max 3, each hop re-validated.
2. **304** → if `error_count > 0` or `state != 'ok'`: write `state='ok', error_count=0, last_success_at=now`. Otherwise **no write**. Done.
3. **Non-2xx** → handle per §7.4. Done.
4. **200** → stream the body through `crypto.DigestStream` and into a buffer, aborting at **2 MB** (`too_large`). If `SHA-256(body) == body_hash` → same as 304. Done.
5. **Parse** with `packages/feed-parser`, stopping after the first **50 items** in document order (`MAX_ITEMS_PER_FETCH`; first fetch for a new subscription: 10 items are linked to the user, FR-SU-3). Parse errors → `parse_error`.
6. **Dedup** (§6.3): compute keys, query existing, keep new items only.
7. **Write** in one `DB.batch()`: multi-row `INSERT … ON CONFLICT DO NOTHING RETURNING id` into `entries` (chunked to stay within 100 bound parameters per statement), then `INSERT INTO user_entries … SELECT` for every subscriber (`subscriptions_feed` index), then `UPDATE feeds SET etag, last_modified, body_hash, title (if changed), site_url, last_success_at, last_new_entry_at, state='ok', error_count=0`. Total statements per refresh ≤ 15 (D1 free limit is 50 queries per invocation).

**CPU budget for one refresh invocation:** target p95 ≤ 5 ms, p99 ≤ 8 ms (limit 10 ms). The spike (TID-002) sets the real caps (`MAX_BODY_BYTES`, `MAX_ITEMS_PER_FETCH`) to meet this. Heavy work we deliberately keep out of the Worker: HTML sanitisation (client), OPML parsing (client), thumbnails (none generated).

### 7.4 Errors and backoff

| Result | Action |
|---|---|
| Network error, timeout, 5xx, 429, `too_large`, `parse_error`, `cpu_limit` | `error_count += 1`; `next_fetch_at = now + min(fetch_interval_s × 2^error_count, 86,400) × (0.9..1.1 jitter)`; `state = 'failing'`; store `last_error_code`, `last_status`. |
| 429 or 503 with `Retry-After` | As above but `next_fetch_at = now + clamp(Retry-After, 1800, 86,400)`. |
| 404, 401, 403 | As the first row (some recover). |
| 410 Gone | `state = 'gone'`; never fetched again. User sees it in Manage and can unsubscribe. |
| 301 / 308 to a valid URL | Fetch the target; on success, update `feeds.url` to the new canonical URL unless another feed already has it (then keep the old URL; merging feeds is M3). |
| `blocked_address` (SSRF guard) | `state = 'failing'`, `error_count += 1`; same backoff. |
| `error_count` reaches 20, or failing for 7 days | `state = 'dead'`; `next_fetch_at = now + 86,400` on every subsequent failure. |
| Any success | `error_count = 0`, `state = 'ok'`. |

### 7.5 Newly added feeds

`POST /api/subscriptions` canonicalises and validates the URL, upserts the `feeds` row, then **awaits** `ctx.exports.FeedRefresher.refresh(job, {firstFetchForUser})` with a 10 s timeout, so the first fetch runs in its own invocation and CPU budget rather than the API request's. The API responds 201 with the subscription and the fetch outcome. If the fetch failed or timed out, the subscription still exists, `state` is `pending` or `failing`, and the dispatcher will retry.

If the feed row already exists and `last_success_at` is within 30 minutes, no fetch happens: the newest 10 existing `entries` are linked to the user (FR-SU-3).

### 7.6 Maintenance (cron `17 * * * *`, hourly)

Each run does bounded chunks (≤ 500 rows per statement, ≤ 10 statements per run) so a single invocation stays within CPU and query limits; leftovers are handled next hour.

1. Delete `user_entries` where `is_read = 1 AND is_starred = 0 AND published_at < now − 30 d`.
2. Delete `user_entries` where `is_read = 0 AND is_starred = 0 AND published_at < now − 90 d`.
3. Purge content (`content_html = NULL, summary = NULL, purged_at = now`) of entries older than 30 days that no `user_entries` row references.
4. Delete tombstones (`purged_at IS NOT NULL AND published_at < now − 180 d`).
5. Delete feeds with no subscriptions for 7 days (and their entries via cascade, in chunks).
6. Delete expired `sessions`, `webauthn_challenges`, stale `rate_limits` windows.
7. Once a day (the 03:17 UTC run): record DB size (`PRAGMA page_count × page_size`) and yesterday's counts to the log so the owner can watch the budget.

SQLite `DELETE … LIMIT` isn't available by default, so chunked deletes use `WHERE rowid IN (SELECT rowid … LIMIT 500)` (or the primary key for `WITHOUT ROWID` tables).

---

## 8. API

### 8.1 Conventions

- Base path `/api`. JSON in and out (`Content-Type: application/json`), except OPML export.
- Auth: session cookie `__Host-tid_session`. **Every route requires a session except those marked Public.** Missing/invalid session → `401 unauthenticated`.
- Mutating methods (`POST`, `PATCH`, `PUT`, `DELETE`) must pass the CSRF check (§10.3) → otherwise `403 csrf_failed`.
- Objects owned by another user return **404 `not_found`** (never 403), so existence isn't leaked.
- Timestamps: ISO-8601 UTC strings. IDs: strings (entry IDs are numeric strings).
- Responses carry `Cache-Control: no-store`.
- Errors:

```ts
type ApiError = { error: { code: ErrorCode; message: string; details?: unknown } };
type ErrorCode =
  | 'unauthenticated' | 'reauth_required' | 'csrf_failed' | 'forbidden' | 'not_found'
  | 'validation_failed' | 'rate_limited' | 'limit_reached' | 'conflict'
  | 'already_subscribed' | 'feed_choice_required' | 'no_feed_found' | 'fetch_failed'
  | 'blocked_address' | 'setup_unavailable' | 'invalid_setup_token'
  | 'webauthn_failed' | 'invalid_recovery_code' | 'last_passkey' | 'internal';
```

  `validation_failed` → 400 with zod issues in `details`; `rate_limited` → 429 with `Retry-After`; `conflict`/`already_subscribed` → 409; `limit_reached`, `feed_choice_required`, `no_feed_found`, `fetch_failed`, `blocked_address` → 422; `setup_unavailable` → 409.

- **Pagination** (entries only): `limit` (1–100, default 50) and opaque `cursor`. Response `{ items, nextCursor }`; `nextCursor: null` means the end. Other collections are bounded by per-user limits and returned whole.

### 8.2 Shared types

```ts
type User = { id: string; displayName: string; role: 'owner' | 'member'; settings: UserSettings };

type Folder = { id: string; name: string };

type FeedState = 'pending' | 'ok' | 'failing' | 'dead' | 'gone';
type Subscription = {
  id: string; folderId: string | null;
  title: string;                // override ?? feed title ?? feed URL host
  customTitle: string | null;
  feedUrl: string; siteUrl: string | null;
  createdAt: string;
  health: { state: FeedState; lastSuccessAt: string | null; lastAttemptAt: string | null;
            errorCode: string | null; errorMessage: string | null; nextFetchAt: string };
};

type EntrySummary = {
  id: string; subscriptionId: string; feedTitle: string;
  title: string | null; author: string | null; url: string | null;
  summary: string | null; imageUrl: string | null;
  publishedAt: string; isRead: boolean; isStarred: boolean;
};
type Entry = EntrySummary & { contentHtml: string | null };   // raw; client MUST sanitise

type Counts = { total: number; folders: Record<string, number>; subscriptions: Record<string, number> };
type Passkey = { id: string; name: string; createdAt: string; lastUsedAt: string | null; backedUp: boolean };
```

### 8.3 Auth and account

| Method & path | Auth | Request | Response |
|---|---|---|---|
| `GET /api/auth/session` | Public | – | `200 { user: User \| null, setupRequired: boolean }` |
| `POST /api/auth/setup/options` | Public, rate-limited | `{ setupToken: string, displayName: string (1–64) }` | `200 PublicKeyCredentialCreationOptionsJSON`; sets challenge cookie. `409 setup_unavailable` if a user exists; `403 invalid_setup_token`. |
| `POST /api/auth/setup/verify` | Public, rate-limited | `{ setupToken, displayName, response: RegistrationResponseJSON, passkeyName?: string }` | `201 { user: User, recoveryCodes: string[10] }`; sets session cookie. |
| `POST /api/auth/login/options` | Public, rate-limited | `{}` | `200 PublicKeyCredentialRequestOptionsJSON` (empty `allowCredentials`, `userVerification: 'required'`); sets challenge cookie. |
| `POST /api/auth/login/verify` | Public, rate-limited | `{ response: AuthenticationResponseJSON }` | `200 { user: User }`; sets session cookie; `401 webauthn_failed`. |
| `POST /api/auth/recover` | Public, rate-limited | `{ code: string }` | `200 { user: User, mustAddPasskey: true }`; sets session cookie; `401 invalid_recovery_code`. |
| `POST /api/auth/logout` | Session | `{}` | `204`; clears cookie. |
| `POST /api/auth/logout-all` | Session | `{}` | `204`; deletes all the user's sessions. |
| `GET /api/auth/passkeys` | Session | – | `200 { items: Passkey[] }` |
| `POST /api/auth/passkeys/options` | Session | `{}` | `200 PublicKeyCredentialCreationOptionsJSON` (`excludeCredentials` = existing) |
| `POST /api/auth/passkeys/verify` | Session | `{ response: RegistrationResponseJSON, name: string (1–64) }` | `201 Passkey` |
| `PATCH /api/auth/passkeys/:id` | Session | `{ name }` | `200 Passkey` |
| `DELETE /api/auth/passkeys/:id` | Session | – | `204`; `409 last_passkey` |
| `POST /api/auth/recovery-codes` | Session + `authenticated_at` within 15 min | `{}` | `200 { recoveryCodes: string[10] }`; `403 reauth_required` |
| `GET /api/me` | Session | – | `200 User` |
| `PATCH /api/me` | Session | `{ displayName?: string, settings?: Partial<UserSettings> }` | `200 User` |

Rate limits for Public routes: 10 requests / 10 min per IP per route family (setup, login, recover), plus 30 / hour global for `recover` and `setup` (D1 `rate_limits`, §10.7).

### 8.4 Folders and subscriptions

| Method & path | Request | Response |
|---|---|---|
| `GET /api/folders` | – | `200 { items: Folder[] }` (alphabetical) |
| `POST /api/folders` | `{ name }` | `201 Folder`; `409 conflict` on duplicate; `422 limit_reached` |
| `PATCH /api/folders/:id` | `{ name }` | `200 Folder`; `409 conflict` |
| `DELETE /api/folders/:id` | – | `204` (subscriptions move to no folder) |
| `GET /api/subscriptions` | – | `200 { items: Subscription[] }` |
| `POST /api/subscriptions` | `{ url: string, folderId?: string \| null, title?: string }` | `201 { subscription: Subscription, fetch: { ok: boolean, newEntries: number, errorCode?: string } }`; `422 feed_choice_required` with `details.candidates: { url, title, type, supported }[]`; `422 no_feed_found`; `422 blocked_address`; `409 already_subscribed` with `details.subscriptionId`; `422 limit_reached` |
| `PATCH /api/subscriptions/:id` | `{ title?: string \| null, folderId?: string \| null }` | `200 Subscription` |
| `DELETE /api/subscriptions/:id` | – | `204` |
| `POST /api/subscriptions/:id/refresh` | `{}` | `200 { subscription, fetch: {...} }`; `429 rate_limited` (once per 5 min per feed per user) |

### 8.5 Entries and counts

| Method & path | Request | Response |
|---|---|---|
| `GET /api/entries` | Query: `view=all\|folder\|feed`, `id` (folder or subscription ID; required unless `view=all`), `state=unread\|all` (default from settings), `limit`, `cursor` | `200 { items: EntrySummary[], nextCursor: string \| null, asOf: string }` |
| `GET /api/entries/:id` | – | `200 Entry` |
| `PATCH /api/entries/:id` | `{ isRead?: boolean, isStarred?: boolean }` (`isStarred` accepted from M2) | `200 EntrySummary` |
| `POST /api/entries/read-state` | `{ entryIds: string[] (1–1000), isRead: boolean }` | `200 { updated: number }` (IDs not owned are ignored silently) |
| `POST /api/entries/mark-all-read` | `{ view, id?, before: string (ISO, the list's asOf) }` | `200 { updated: number, entryIds: string[] \| null }` (`entryIds` only when `updated ≤ 1000`, for undo) |
| `GET /api/counts` | – | `200 Counts` (unread only; folders aggregate their subscriptions) |

`asOf` is the server time of the first page. The SPA keeps it and passes it as `before` to mark-all-read so that articles that arrive after the user loaded the list stay unread.

### 8.6 Cursor format and list queries

Cursor = base64url of `{"p": published_at, "i": entry_id}`. Malformed cursor → `400 validation_failed`. Query shape (All, unread):

```sql
SELECT ue.entry_id, ue.feed_id, ue.published_at, ue.is_read, ue.is_starred,
       e.title, e.author, e.url, e.summary, e.image_url
  FROM user_entries ue INDEXED BY ue_unread_all
  JOIN entries e ON e.id = ue.entry_id
 WHERE ue.user_id = ?1 AND ue.is_read = 0
   AND (ue.published_at, ue.entry_id) < (?2, ?3)
 ORDER BY ue.published_at DESC, ue.entry_id DESC
 LIMIT ?4 + 1;
```

Feed views add `AND ue.feed_id = ?`. Folder views use `ue.feed_id IN (SELECT feed_id FROM subscriptions WHERE user_id = ?1 AND folder_id = ?)`; SQLite can't use the index order across an `IN` list, so a folder page reads every matching row in that folder (≈ folder size, bounded by retention). This is accounted for in §9.4; if it becomes a problem we denormalise `folder_id` into `user_entries` (M2+). `feedTitle` and `subscriptionId` are joined in from a per-request map of the user's subscriptions, not per row.

### 8.7 Import/export

| Method & path | Request | Response |
|---|---|---|
| `POST /api/import/opml` | `{ folders: { name: string, feeds: ImportFeed[] }[], feeds: ImportFeed[] }` where `ImportFeed = { xmlUrl: string, title?: string, htmlUrl?: string }`; total feeds ≤ 100 per request | `200 { created: number, existing: number, invalid: { url: string, reason: 'invalid_url' \| 'blocked_address' \| 'limit_reached' }[] }` |
| `GET /api/export/opml` | – | `200 text/x-opml; charset=utf-8`, `Content-Disposition: attachment; filename="tidings-YYYY-MM-DD.opml"` |

### 8.8 Health

| `GET /api/health` | Public | `200 { ok: true, version: string }` (no DB access) |
|---|---|---|

---

## 9. Free-tier budget

### 9.1 Limits (checked 2026-11-16)

Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) (updated 2026-11-13), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) (updated 2026-10-30), [KV limits](https://developers.cloudflare.com/kv/platform/limits/), [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/) and [limits](https://developers.cloudflare.com/queues/platform/limits/), [Service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/), [Static assets SPA routing](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/), [`_headers`](https://developers.cloudflare.com/workers/static-assets/headers/), [Rate limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), [`ctx.exports` changelog](https://developers.cloudflare.com/changelog/2025-09-26-ctx-exports/).

| Limit (Workers Free) | Value | Status |
|---|---|---|
| Worker requests | 100,000 / day (resets 00:00 UTC) | Verified |
| CPU time per invocation (HTTP and Cron) | **10 ms** (I/O wait not counted) | Verified |
| Wall time, Cron / Queue consumer | 15 min | Verified |
| Subrequests per invocation | **50 external**, 1,000 to Cloudflare services; each redirect hop counts | Verified |
| Simultaneous outbound connections | 6 per invocation | Verified |
| Memory | 128 MB per isolate | Verified |
| Cron Triggers | 5 per account | Verified |
| Service-binding invocations per request | 32 | Verified |
| Does a service-binding/`ctx.exports` callee get its own CPU and subrequest budget? | Not stated | **Unverified → TID-003** |
| Do service-binding callee invocations count toward the 100k requests/day? | Not stated for Free | **Unverified → TID-003** (budget assumes they do) |
| Do static-asset requests count toward 100k/day? | "Requests are only billable if a Worker script is invoked" | Assumed no (budget doesn't need it) |
| Static assets | 20,000 files / version, 25 MiB / file | Verified |
| D1 rows read | **5,000,000 / day** | Verified |
| D1 rows written | **100,000 / day** (each index updated adds one row written) | Verified |
| D1 storage | **500 MB per database**, 5 GB per account, 10 databases | Verified |
| D1 queries per invocation | 50 | Verified (assume each statement in a `batch()` counts: unverified) |
| D1 bound parameters per statement | 100 | Verified |
| D1 max row / string size | 2 MB | Verified |
| D1 on exceeding daily limit | Queries fail until 00:00 UTC | Verified |
| KV | 100,000 reads, 1,000 writes / day, 1 GB | Verified (not used) |
| Queues | 10,000 operations / day; ≈ 3 ops per message; 24 h retention | Verified (not used) |
| Rate Limiting binding on Free | Not stated | **Unverified → TID-003** |
| `_headers` | 100 rules, 2,000 chars/line; not applied to Worker responses | Verified |
| PBKDF2 iterations in Workers | 100,000 max (workerd issue #1346, 2023) | Unverified for 2026 production; relevant only to the rejected password option |

### 9.2 Assumed load

| | Baseline (A) | Heavy (B) |
|---|---|---|
| Users | 1 | 3 (all subscribed to the same feeds: worst case for per-user writes) |
| Feeds | 250 | 300 |
| Refresh interval | 30 min | 20 min |
| New articles / day | 400 | 800 |
| Fetches returning changed content (parse needed) | 15% | 15% |
| Fetches failing | 5% | 5% |
| Articles marked read individually / user / day | 300 | 300 |
| Articles marked read in bulk / user / day | 1,000 | 1,000 |
| API calls / user / day | 2,500 | 2,500 |
| Unread backlog per user | 1,000 | 1,000 |

### 9.3 Requests per day

| Source | A | B |
|---|---|---|
| Dispatcher cron (1/min) + maintenance (1/h) | 1,464 | 1,464 |
| Refresh invocations (one per fetch: 250 × 48; 300 × 72) | 12,000 | 21,600 |
| SPA API calls | 2,500 | 7,500 |
| Static assets | 0 (no Worker) | 0 |
| **Total** | **≈ 16,000 (16%)** | **≈ 30,600 (31%)** |

### 9.4 D1 rows written per day

| Source | Rows per event | A | B |
|---|---|---|---|
| Dispatcher lease (1 per fetch; `next_fetch_at` not indexed, so no index write) | 1 | 12,000 | 21,600 |
| Refresh state write (changed content or error; none on unchanged 304) | 1 | 2,400 | 4,320 |
| New `entries` (row + unique + `entries_published`) | 3 | 1,200 | 2,400 |
| New `user_entries` per subscriber (row + 4 indexes) | 5 | 2,000 | 12,000 |
| Individual mark read (row + 2 partial-index removals) | 3 | 900 | 2,700 |
| Bulk mark read | 3 | 3,000 | 9,000 |
| Cleanup (user_entries delete ×5, entry purge ×1, tombstone delete ×3) | – | 3,600 | 15,200 |
| Sessions, settings, auth | – | 50 | 150 |
| **Total** | | **≈ 25,000 (25%)** | **≈ 67,000 (67%)** |

**Why `feeds.next_fetch_at` has no index.** An index would add one write per lease (+12,000/day in A, +12% of the write quota). Without it the dispatcher scans the feeds table each minute: 250 rows × 1,440 = 360,000 reads/day (7% of the read quota). Writes are the scarcer resource, so we scan. Revisit above ~1,000 feeds.

### 9.5 D1 rows read per day

| Source | A | B |
|---|---|---|
| Dispatcher scan (feeds × 1,440) | 360,000 | 432,000 |
| Refresh dedup lookups (≤ 50 per changed fetch) + subscriber lookups | 92,000 | 166,000 |
| Unread counts (200 calls × 1,000 unread rows per user) | 200,000 | 600,000 |
| List pages (150 × ~150 rows) + folder pages (50 × ~3,000 rows) per user | 172,500 | 517,500 |
| Session lookups, misc | 5,000 | 15,000 |
| Cleanup (indexed) | 10,000 | 30,000 |
| **Total** | **≈ 840,000 (17%)** | **≈ 1,760,000 (35%)** |

### 9.6 Storage

Average stored article ≈ 6 KB (many feeds are summary-only at 1–2 KB; full-content feeds are 10–30 KB; content capped at 100 KB). A: 400 × 6 KB × 30 days ≈ 72 MB content + ~20% indexes + 180 days of tombstones (≈ 7 MB) ≈ **95 MB (19% of 500 MB)**. A full-content-heavy mix at 25 KB average ≈ 360 MB (72%). B with 800/day at 6 KB ≈ 180 MB (36%). Mitigations: 100 KB content cap, 30-day content retention, hourly cleanup, daily size log, warning in Settings above 70% (M2).

### 9.7 CPU per invocation

| Invocation | Expected work | Target |
|---|---|---|
| API request | Hono routing, 1 session lookup, 1–3 queries, JSON of ≤ 50 items | p99 ≤ 5 ms |
| WebAuthn verify | CBOR decode + ECDSA verify (native) | p99 ≤ 8 ms **unverified → TID-003** |
| Dispatcher | 1 query + 20 RPC calls (I/O wait isn't CPU) | p99 ≤ 3 ms |
| Refresh, 304/unchanged | header handling, native hash | p99 ≤ 2 ms |
| Refresh, changed, typical feed (≤ 300 KB, ≤ 50 items) | streaming XML parse + mapping + 2–3 queries | p95 ≤ 5 ms, p99 ≤ 8 ms **unverified → TID-002** |
| Refresh, large feed (1–2 MB) | parse dominates | **Likely to exceed 10 ms → TID-002 sets caps** |
| Maintenance | ≤ 10 bounded statements | p99 ≤ 3 ms |

### 9.8 Headline: first limit we'll hit

1. **First limit overall: 10 ms CPU per invocation, on large or verbose feeds.** It's per invocation, not daily, so a few big feeds will fail individually long before any daily quota is stressed. Mitigations, in order: per-feed fan-out (one feed per invocation); conditional GET and body-hash skip (most fetches never parse); streaming parse that stops after 50 items and ignores unused elements; 2 MB body cap; recording `cpu_limit` and backing off so a pathological feed costs one failed invocation per backoff period; showing the error in Manage. TID-002 measures real numbers and sets the caps before M1 refresh work starts.
2. **First daily quota: D1 rows written.** 25% at baseline (4× headroom), 67% in the heavy multi-user case (1.5×). Mitigations: no index on `next_fetch_at`; no write on unchanged fetches; first-fetch cap of 10 items per new subscription; adaptive refresh intervals for quiet feeds (M2; halves lease writes for typical feed mixes); denormalisation only where it saves reads without adding writes. **An OPML import of 250 feeds costs about 20,000 extra writes** (250 × 10 items × 8 rows), so import day in scenario A peaks near 45%.
3. Everything else is under 40% in both scenarios. KV and Queues are unused.

**Monitoring:** the maintenance job logs daily counts; the README (TID-021) documents where to see D1 and Workers usage in the dashboard. If writes exceed 70% on 3 days in a week, the PM opens an ADR (options: longer interval, adaptive scheduling, Workers Paid at $5/month: Q6).

---

## 10. Security model

### 10.1 Authentication choice

Options evaluated (full record in ADR 0002):

| Option | For | Against | Verdict |
|---|---|---|---|
| **Passkeys (WebAuthn)** + recovery codes | Phishing-resistant; no shared secret stored; verification is native ECDSA (cheap CPU); synced passkeys work across iPhone/Android/desktop; no email dependency | Needs a recovery path; RP ID ties credentials to the hostname | **Chosen** |
| Cloudflare Access (Zero Trust, free < 50 users) | Zero auth code; strong | SPA `fetch` calls get redirected to Access login on expiry (opaque CORS failures); installed-PWA flows are awkward; config lives outside the repo; harder to test locally and in E2E | Rejected (user may override: Q3) |
| Email + password | Familiar | Workers caps PBKDF2 at 100,000 iterations (below OWASP's 600,000) and that cost alone likely exceeds the 10 ms CPU budget; Argon2/bcrypt in WASM are slower still; needs reset-by-email | Rejected |
| Magic links | No password | Needs an email-sending service (another account/vendor or limited Cloudflare Email Routing); slow login on phone (switch apps) | Rejected |

Parameters: `rpID = RP_ID` (the production hostname), expected origin `APP_ORIGIN`; `residentKey: 'required'`, `userVerification: 'required'`, `attestationType: 'none'`; algorithms ES256 (−7), EdDSA (−8), RS256 (−257). Challenges are single-use, stored in `webauthn_challenges`, bound to a `__Host-tid_chal` cookie (HttpOnly, Secure, SameSite=Strict, Max-Age 300) and deleted on verify. The signature counter is stored and checked when non-zero.

**Bootstrap:** `SETUP_TOKEN` (≥ 32 random characters, set with `wrangler secret put`) is required for setup and compared in constant time. Setup endpoints return `setup_unavailable` once a user exists.

**Recovery codes:** 10 codes, each 80 random bits rendered as `XXXX-XXXX-XXXX-XXXX` (Crockford base32). Stored as SHA-256 of the normalised code (upper-case, no dashes). A fast hash is acceptable because the codes are high-entropy random values, not user-chosen passwords; this avoids needing a KDF in a 10 ms budget. Single use.

**Break-glass:** if the owner loses every passkey and code, they run a documented `wrangler d1 execute` command (README) that deletes their passkeys; setup is then *not* re-opened (a user exists), so the runbook instead inserts a one-time recovery code hash generated locally. Documented in TID-021.

### 10.2 Sessions

- Token: 32 random bytes, base64url, in cookie `__Host-tid_session`; `HttpOnly; Secure; SameSite=Lax; Path=/`; `Max-Age` = sliding expiry. DB stores only `SHA-256(token)`.
- Sliding: `expires_at = now + 30 d`, refreshed only when fewer than 23 days remain (≈ 1 write per session per week). Absolute cap 180 days.
- New session on every sign-in (no fixation). Logout deletes the row. Removing a passkey doesn't end sessions; "sign out everywhere" does.
- Step-up: regenerating recovery codes requires `authenticated_at` within 15 minutes (FR-AU-7). Other actions don't in MVP.

### 10.3 CSRF

The SPA and API share one origin, so no CORS headers are sent at all (cross-origin reads are blocked by default). For every mutating request the Worker requires **both**:
1. `Origin` header equal to `APP_ORIGIN` (if `Origin` is absent, `Sec-Fetch-Site: same-origin` is accepted instead; if both are absent, reject), and
2. `Content-Type: application/json` (forces a CORS preflight for any cross-site attempt, which we never approve).

Plus `SameSite=Lax` on the session cookie. Failing requests get `403 csrf_failed`.

### 10.4 Security headers

- SPA (via `apps/web/public/_headers` on `/*`):
  - `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; media-src https:; font-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests`
  - `Referrer-Policy: no-referrer` (feed image hosts don't learn what you're reading)
  - `X-Content-Type-Options: nosniff`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`, `Cross-Origin-Opener-Policy: same-origin`
  - `Strict-Transport-Security: max-age=31536000` (custom domain only)
- The flash-free theme script is an external file (`/theme-init.js`, loaded blocking in `<head>`) so no `'unsafe-inline'` is needed. If Tailwind/React need inline styles, the engineer raises it with the PM rather than loosening CSP.
- API responses (set in Worker middleware, since `_headers` doesn't apply to them): `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`.

### 10.5 Untrusted feed content (XSS)

- Feed titles, authors and summaries are rendered as **text** (React escaping). Never as HTML.
- `content_html` is stored raw and sanitised **only in the browser**, in one module (`apps/web/src/lib/sanitize.ts`) using DOMPurify, then inserted with `dangerouslySetInnerHTML` in exactly one component (`ArticleContent`). An ESLint `no-restricted-syntax` rule bans `dangerouslySetInnerHTML` everywhere else.
- DOMPurify config: allowlist of text/structure/media tags (`p, br, a, strong, em, b, i, u, s, blockquote, q, cite, code, pre, kbd, ul, ol, li, dl, dt, dd, h1–h6, hr, img, picture, source, figure, figcaption, table, thead, tbody, tfoot, tr, th, td, caption, sup, sub, small, abbr, time, mark, del, ins, details, summary, video, audio`); forbid `style`, `class`, `id`, all `on*` attributes, `iframe`, `form`, `input`, `svg`, `math`, `object`, `embed`; only `http:`, `https:`, `mailto:` URLs (relative URLs are resolved against the entry URL first). Hook: every `<a>` gets `target="_blank" rel="noopener noreferrer nofollow"`; every `<img>` gets `loading="lazy" decoding="async" referrerpolicy="no-referrer"`; `<video>`/`<audio>` get `controls` and `preload="none"`. Iframes are replaced by a link "Open embedded content".
- Entry `url` and `image_url` are accepted only if `http(s)`; anything else is stored as NULL, so a `javascript:` link can't reach an `href`.
- CSP (§10.4) is the second line of defence: even a sanitiser bypass can't run inline or third-party script.

### 10.6 SSRF protection (`safeFetch`)

All server-side fetches of user-supplied URLs (subscribe, discovery, refresh, redirects) go through `safeFetch`:

1. Scheme must be `http` or `https`; port must be default or 80/443/8080/8443.
2. Reject credentials in URL (`user:pass@`).
3. Reject hosts that are: `localhost`, single-label names, `*.local`, `*.localhost`, `*.internal`, `*.home.arpa`, the app's own hostname, and IP literals (v4, v6, decimal/octal/hex forms after `new URL()` normalisation) in loopback, private (10/8, 172.16/12, 192.168/16), CGNAT (100.64/10), link-local (169.254/16, fe80::/10), unique-local (fc00::/7), multicast, `0.0.0.0/8`, `::`, `::1`, IPv4-mapped IPv6 of any of these, and cloud metadata (`169.254.169.254`, `fd00:ec2::254`).
4. `redirect: 'manual'`; follow at most 3 redirects, re-applying 1–3 to each `Location`. Never forward cookies or auth headers.
5. 10 s total timeout (`AbortSignal.timeout`), 2 MB body cap (stream and abort).
6. Only `GET`. No user-controlled headers.

Residual risk: DNS names that resolve to private addresses (rebinding). Workers run on Cloudflare's edge with no access to a private network of ours, which limits impact; we accept this for MVP and record it in risks (R5). Tests: the tester's SSRF suite (`127.0.0.1`, `[::1]`, `169.254.169.254`, `0x7f000001`, `2130706433`, `localhost.`, redirects to these).

For automated tests only, an `ALLOW_FETCH_HOSTS` var can allow the local fixture server. The Worker refuses to start a request if that var is set and `APP_ORIGIN` is not `http://localhost:*` (so it can't be enabled in production by accident), and a unit test covers that guard.

### 10.7 Rate limiting

- **Auth routes** (setup, login, recover): D1 fixed-window counter in `rate_limits` keyed by route family and `CF-Connecting-IP`, plus a global counter for setup and recover (§8.3). Authoritative.
- **Authenticated API:** 600 requests/minute per user via the Workers Rate Limiting binding if TID-003 confirms availability on Free; otherwise none in MVP (single owner; the daily request cap is the backstop).
- **Manual feed refresh:** once per 5 minutes per feed per user (checked against `feeds.last_attempt_at`).

### 10.8 Per-user isolation

- Every function in `apps/worker/src/db` that touches user data takes `userId` as its first parameter and includes `user_id = ?` in SQL; IDs from the URL are always resolved *with* the user ID (`WHERE id = ? AND user_id = ?`). Cross-user access returns 404.
- `entries` are only reachable by joining through `user_entries` (or, for new subscriptions, through `subscriptions`).
- The tester's isolation suite creates two users directly in D1 and calls every route as user B against user A's IDs.

### 10.9 Other

- Parameterised SQL only (lint rule bans template literals in `prepare()`).
- Never log cookies, tokens, setup token, recovery codes or WebAuthn payloads.
- `npm audit --audit-level=high` runs in CI.

---

## 11. Frontend structure

### 11.1 Routes

| Path | Screen |
|---|---|
| `/setup` | First-run setup (only when `setupRequired`) |
| `/login`, `/recover` | Sign in; recovery code |
| `/` | Redirect to `/all` |
| `/all`, `/folders/:folderId`, `/feeds/:subscriptionId` | Article lists |
| `/all/a/:entryId`, `/folders/:folderId/a/:entryId`, `/feeds/:subscriptionId/a/:entryId` | Article view, keeping list context for next/previous and back |
| `/manage` | Subscriptions and folders (with health) |
| `/manage/add` | Add a feed |
| `/manage/import` | OPML import and progress |
| `/settings` | Theme, reading, account, data |

Unauthenticated users are redirected to `/login` (or `/setup`). The UX engineer owns layout, gestures and copy in `docs/ux/`.

### 11.2 Theme

`<html data-theme="light|dark">` is set before first paint by `/theme-init.js` from `localStorage['tidings.theme']` (default `system` → `matchMedia('(prefers-color-scheme: dark)')`), and updated live on system change while the setting is `system`. Tailwind's dark variant keys on `[data-theme=dark]`. `<meta name="theme-color">` is set for both schemes.

### 11.3 Query keys and caching

`['session']`, `['me']`, `['folders']`, `['subscriptions']`, `['counts']`, `['entries', view, id, state]` (infinite), `['entry', id]`. `staleTime`: 30 s for entries and counts, 5 min for folders and subscriptions. Mark-read mutations update the `entry` cache, every cached list containing the entry, and `counts` optimistically.

---

## 12. Non-functional requirements

| ID | Requirement | Target | How it's measured |
|---|---|---|---|
| NFR-1 | Cached start | With a populated cache, the article list for the last view renders within **1.0 s** of navigation start, offline or online | Playwright on Chromium with Moto G Power emulation (4× CPU throttle, Slow 4G), median of 5 runs |
| NFR-2 | Cold start | LCP ≤ **2.5 s**, INP ≤ 200 ms, CLS ≤ 0.1 on the article list | Lighthouse mobile preset in CI against a seeded preview, median of 3 |
| NFR-3 | Bundle size | Initial JS ≤ **170 KB** gzipped; CSS ≤ 30 KB gzipped | Build-time size check in CI |
| NFR-4 | API latency | p95 server time ≤ **200 ms** for `GET /api/entries` and `GET /api/counts` at baseline data size | Integration test timing on seeded local D1; Workers analytics in production |
| NFR-5 | Optimistic UI | Read-state change visible ≤ **100 ms** after tap | Playwright |
| NFR-6 | Worker CPU | p99 CPU per invocation ≤ 8 ms for every handler (§9.7); zero `exceededCpu` outcomes for feeds under the caps | Workers dashboard / logs, weekly check |
| NFR-7 | Query cost | Each list query reads ≤ (limit + 1) × 2 rows for All/Feed views; counts read ≤ unread rows + subscriptions | Integration tests assert D1 `meta.rows_read` |
| NFR-8 | Freshness | ≥ 95% of `ok` feeds have `last_attempt_at` within 35 min | Maintenance log |
| NFR-9 | Accessibility | WCAG 2.2 AA; **zero serious/critical** axe-core violations on every screen in both themes; tap targets ≥ 44 × 44 px; full keyboard use on desktop; respects `prefers-reduced-motion` and text zoom to 200% without horizontal scroll at 375 px | Playwright + `@axe-core/playwright`; UX review |
| NFR-10 | Dark mode | Every screen in light and dark; follows system by default; no flash of the wrong theme on load | E2E screenshot pairs; FOUC test checks `data-theme` before first paint |
| NFR-11 | Mobile first | All screens designed and tested at **375 × 812** first, then 768 and 1280 widths | Playwright projects |
| NFR-12 | Browser support | iOS/iPadOS Safari 17+, Chrome/Edge 120+ (Android and desktop), Firefox 121+, Samsung Internet 24+. Passkeys required (no fallback auth) | Playwright WebKit, Chromium, Firefox; manual check on a real iPhone before M1 sign-off |
| NFR-13 | Privacy | No third-party scripts, analytics or fonts; `Referrer-Policy: no-referrer` | CSP + review |
| NFR-14 | Cost | $0/month at baseline load | Cloudflare billing |

---

## 13. Test strategy (outline; the tester owns `docs/testing/TEST_STRATEGY.md`)

| Layer | Tool | Covers |
|---|---|---|
| Unit | Vitest (Node) | `feed-parser` against a fixture corpus (RSS 2.0, RSS 1.0/RDF, Atom, malformed, CDATA, entities, huge, no dates, duplicate GUIDs, hostile HTML), URL canonicalisation, dedup keys, SSRF guard, backoff maths, cursor encoding, OPML mapping, sanitiser config (XSS payload corpus run through DOMPurify in jsdom). |
| Integration (Worker) | Vitest + `@cloudflare/vitest-pool-workers` (workerd, local D1 with migrations applied) | Every API route: happy path, validation, unauthenticated, CSRF, cross-user isolation; dispatcher lease and fan-out with injected `fetch`; conditional GET; backoff; retention; `meta.rows_read`/`rows_written` budgets for key queries. |
| Component | Vitest + Testing Library + jsdom | Hooks and components with mock API (optimistic updates, rollback). |
| E2E | Playwright: projects `mobile-light`, `mobile-dark` (375 × 812), `desktop-light`, `desktop-dark` (1280 × 800); Chromium virtual WebAuthn authenticator via CDP | Golden paths: setup → import OPML → read → mark all read; sign-in; recovery; add feed; folders; theme; axe checks per screen. Feeds served from a local fixture server (allowed via `ALLOW_FETCH_HOSTS` in test only). |
| Deployed budget checks | Manual/scripted in spikes and before M1 sign-off | Real CPU per invocation on the Free plan (local workerd does not enforce CPU limits, and `performance.now()` doesn't advance during execution in Workers, so CPU must be read from Cloudflare's metrics/logs). |

No test touches the real network. Clocks are injected.

---

## 14. Local development, CI and deployment

### 14.1 Local

- Prereqs: Node 22 LTS+, npm 10+. `npm install` at the root.
- `npm run dev`: runs `wrangler dev` (Worker, local D1, cron testable via `/cdn-cgi/local/scheduled`) on :8787 and `vite` on :5173 with `/api` proxied to :8787.
- `npm run db:migrate:local` applies migrations; `npm run db:seed:local` loads sample folders, feeds and entries for a seed user. To sign in locally, run first-run setup against the local DB with the `SETUP_TOKEN` from `.dev.vars` (passkeys work on `localhost`). There is **no** auth bypass, in any environment.
- `.dev.vars` (gitignored) holds `SETUP_TOKEN` and dev flags.

### 14.2 CI (GitHub Actions, `.github/workflows/ci.yml`)

On every push and PR: `npm ci` → `npm run typecheck` → `npm run lint` → `npm test` (unit + integration) → `npm run build` (+ bundle size check) → `npm run test:e2e` (Playwright, 4 projects) → `npm audit --audit-level=high`. Artifacts: Playwright report on failure.

### 14.3 Deploy

On push to `main` after CI passes: `wrangler d1 migrations apply tidings --remote` then `wrangler deploy` (builds `apps/web` first). Secrets in GitHub: `CLOUDFLARE_API_TOKEN` (scoped to Workers + D1 edit for the one account), `CLOUDFLARE_ACCOUNT_ID`. Runtime secret `SETUP_TOKEN` set once with `wrangler secret put`. Migrations must be backward compatible with the previous Worker version (add columns, then use them in a later deploy).

---

## 15. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Feed parsing exceeds 10 ms CPU for typical feeds, not just large ones | Medium | High | Spike TID-002 before refresh work; streaming parser with early stop; caps; fallback to Workers Paid ($5/mo, Q6). |
| R2 | `ctx.exports`/service-binding callees share the caller's CPU or subrequest budget | Medium | High | Spike TID-003; ADR 0004 fallback ladder (two Workers; DO alarms; Queues with batched messages; lower batch size). |
| R3 | D1 write quota exhausted (e.g. multiple users, aggressive intervals, import day) | Low (A) / Medium (B) | High (DB read-only until 00:00 UTC) | Budget in §9; no unchanged-fetch writes; first-fetch cap; adaptive intervals (M2); daily usage log. |
| R4 | Some origins block Cloudflare Worker fetches (bot protection, `CF-Worker` header, 403/429) | Medium | Medium | Clear error in Manage; honest User-Agent; backoff. No proxying in MVP. |
| R5 | DNS-rebinding SSRF (hostname resolving to a private IP) | Low | Low–Medium | Workers have no private-network access; host/IP guards; documented residual risk. |
| R6 | Passkey lock-out (lost device, changed domain) | Low | High | Recovery codes; multiple passkeys; break-glass runbook; decide the domain before setup (Q2). |
| R7 | D1 storage grows past 500 MB with full-content feeds | Low | Medium | 100 KB cap, 30-day content retention, tombstones only, daily size log, Settings warning (M2). |
| R8 | Free-plan limits change | Low | Medium | Limits table dated; re-check each milestone; ADR if they change. |
| R9 | `@simplewebauthn/server` cold start / CPU too heavy for 10 ms | Low–Medium | Medium | Measured in TID-003; fallback: lighter verifier using Web Crypto directly for ES256/EdDSA only. |
| R10 | Malformed or hostile feeds (billion-laughs entity expansion, huge attributes) | Medium | Low | htmlparser2 doesn't expand custom DTD entities; body cap; item cap; fuzz fixtures. |

---

## 16. Open questions for the user

Each has a recommended default. Work proceeds on the default unless the user says otherwise.

| # | Question | Recommended default |
|---|---|---|
| Q1 | Single user, or will others use your deployment? | **Single owner in MVP**; invite-only multi-user in M3. Data model already supports it. |
| Q2 | Which hostname? Passkeys are bound to it, so changing it later means re-registering passkeys. | **A subdomain of a domain you already have on Cloudflare** (e.g. `tidings.yourdomain.com`), which is free. Otherwise `tidings.<account>.workers.dev`. Decide before first-run setup. |
| Q3 | Auth: passkeys in the app, or Cloudflare Access in front of it? | **Passkeys + recovery codes** (ADR 0002). |
| Q4 | Retention: how long to keep articles? | **Read: 30 days. Unread: 90 days. Starred (M2): forever.** |
| Q5 | Refresh interval? | **30 minutes** for every feed; adaptive per-feed intervals in M2. Fastest allowed: 20 minutes. |
| Q6 | If spikes show the Free plan can't parse your feeds within 10 ms CPU, would you pay **$5/month for Workers Paid**? | **Stay free and degrade** (skip or cap oversized feeds, show them as "too large") unless more than 5% of your feeds are affected; then ask again with numbers. |
| Q7 | Migrate Inoreader starred/saved items? (Not in OPML.) | **No.** Export them from Inoreader for safekeeping; Tidings starts fresh. |
| Q8 | Where is the repo hosted? CI assumes GitHub Actions. | **GitHub (private repo) + GitHub Actions.** |
| Q9 | Article images load directly from publishers' servers (they see your IP, not what you read, thanks to `no-referrer`). Proxy them instead? | **Load directly.** Proxying would cost a Worker request per image and blow the request budget. |
| Q10 | Inoreader lets a feed sit in several folders. OK to allow only one folder per feed in MVP? | **Yes, one folder**; on import the first folder wins. Multi-folder (tags) in M3. |
| Q11 | First fetch of a new feed: OK to bring in the 10 newest items, with items older than 7 days pre-marked read? | **Yes.** |
