# Tidings Backlog

Owner: product-manager. Last updated 2026-11-16.

- Stories are in priority order within each milestone. Build top to bottom unless dependencies allow parallel work.
- Each acceptance criterion (AC) must map to at least one automated test unless it is marked *(manual)*.
- "Agents" lists who works on the story: **SE** software-engineer, **QA** tester, **UX** ux-engineer, **PM** product-manager.
- References like FR-RD-8 or §7.3 point to `docs/PRODUCT_SPEC.md`.
- Status values: `Ready`, `Blocked`, `In progress`, `In review`, `Done`, `Later`.

## Summary

| ID | Title | Milestone | Status | Depends on |
|---|---|---|---|---|
| TID-001 | Monorepo scaffolding, tooling and CI | M0 | Ready | – |
| TID-002 | Spike: feed parse CPU on Workers Free | M0 | Ready | TID-001 |
| TID-003 | Spike: fan-out isolation, WebAuthn CPU, rate-limit binding | M0 | Ready | TID-001 |
| TID-004 | D1 schema v1 and data-access layer | M0 | Ready | TID-001 |
| TID-005 | Test infrastructure and fixture corpus | M0 | Ready | TID-001 |
| TID-006 | Design system and app shell with theming | M0 | Ready | TID-001 |
| TID-007 | First-run setup with a passkey and recovery codes | M1 | Blocked | TID-003, 004, 005, 006 |
| TID-008 | Passkey sign-in, sessions, sign-out and API security middleware | M1 | Blocked | TID-007 |
| TID-009 | Sign in with a recovery code | M1 | Blocked | TID-008 |
| TID-010 | SSRF-safe fetcher | M1 | Blocked | TID-004 |
| TID-011 | Feed parser and normalisation | M1 | Blocked | TID-002 |
| TID-012 | Background refresh pipeline | M1 | Blocked | TID-003, 010, 011 |
| TID-013 | Subscribe to a feed | M1 | Blocked | TID-008, 012 |
| TID-014 | Folders and subscription management | M1 | Blocked | TID-013 |
| TID-015 | Feed health and "Refresh now" | M1 | Blocked | TID-014 |
| TID-016 | Import subscriptions from OPML | M1 | Blocked | TID-014 |
| TID-017 | Export subscriptions as OPML | M1 | Blocked | TID-014 |
| TID-018 | Article lists, navigation and unread counts | M1 | Blocked | TID-013 |
| TID-019 | Article view and read state | M1 | Blocked | TID-018 |
| TID-020 | Mark all as read | M1 | Blocked | TID-018 |
| TID-021 | Retention and maintenance job | M1 | Blocked | TID-012 |
| TID-022 | Settings: theme, reading, account | M1 | Blocked | TID-008, 009 |
| TID-023 | Persisted client cache and installable PWA shell | M1 | Blocked | TID-018, 019 |
| TID-024 | Production deployment, runbook and budget check | M1 | Blocked | all M1 |
| TID-025 … TID-034 | Comfort features | M2 | Later | M1 |
| TID-040 … TID-045 | Later features | M3 | Later | M2 |

---

## M0: Foundations and spikes

### TID-001: Monorepo scaffolding, tooling and CI

- **Agents:** SE (build), QA (reviews CI test stages), PM (accept)
- **Depends on:** –
- **Status:** Ready

**User story:** As the team, we want a working monorepo with the agreed stack, scripts and CI, so that every later story starts from the same foundation.

**Scope:** layout in spec §4.3; ADRs 0001, 0005, 0007. `apps/web` (Vite + React + Tailwind 4 + React Router + TanStack Query, a placeholder page), `apps/worker` (Hono, `GET /api/health`, empty `scheduled()` that logs, `wrangler.jsonc` per spec §4.6 with placeholder D1 ID), `packages/shared`, `packages/feed-parser` (empty export + one test), ESLint/Prettier/TS strict, `.github/workflows/ci.yml` (spec §14.2, E2E stage may be a placeholder until TID-005), README with local dev steps.

**Acceptance criteria**

1. Given a fresh clone, when I run `npm install` then `npm run typecheck`, `npm run lint` and `npm test`, then all three exit 0.
2. Given `npm run dev`, when I open `http://localhost:5173`, then the placeholder SPA renders and a call it makes to `/api/health` returns `200 {"ok":true,"version":...}` via the Vite proxy to `wrangler dev`.
3. Given `npm run build`, when it finishes, then `apps/web/dist` exists and `wrangler deploy --dry-run` from `apps/worker` succeeds with assets from `../web/dist`.
4. Given the Worker running locally, when I request `/some/client/route` with `Sec-Fetch-Mode: navigate`, then I get `index.html` with status 200; when I `fetch('/api/nope')`, then I get a JSON `404 {"error":{"code":"not_found",...}}` from the Worker.
5. Given any TypeScript package, when I inspect its tsconfig, then it extends `tsconfig.base.json` with `strict: true`.
6. Given a push to a branch, when CI runs, then it executes install, typecheck, lint, test, build and `npm audit --audit-level=high` and fails the run if any step fails.
7. Given the ESLint config, when a file other than `ArticleContent.tsx` uses `dangerouslySetInnerHTML`, then lint fails. (Test with a fixture file in the lint test or a documented rule test.)

**Out of scope:** auth, DB tables, real UI, deployment to Cloudflare.

---

### TID-002: Spike: feed parse CPU on Workers Free (time-box: 1.5 days)

- **Agents:** SE (run), PM (decide, update ADR 0006 and spec §7.3/§9.7)
- **Depends on:** TID-001
- **Status:** Ready

**User story:** As the PM, I want measured CPU costs for parsing real feeds inside a Free-plan Worker, so that we pick a parser and set body/item caps that keep refreshes under 10 ms.

**Method:** Deploy a throwaway Worker to a Free-plan account. Endpoints parse fixture feeds embedded in the bundle (no network) with (a) htmlparser2 streaming + minimal mapper, (b) feedsmith. Fixtures: small RSS (~20 KB, 20 items), typical RSS (~150 KB, 50 items with `content:encoded`), Atom (~100 KB), RDF (~30 KB), large (~1 MB), huge (~3 MB, 500 items). Call each ≥ 200 times. Read CPU time from Cloudflare (Workers Logs / Observability `cpuTimeMs`, or dashboard CPU percentiles), not from `performance.now()` (it doesn't advance during execution). Also measure the cold-start effect of each library's bundle.

**Acceptance criteria**

1. Given the spike Worker, when each fixture is parsed 200+ times per library, then a results table records p50/p95/p99 CPU ms and the count of `exceededCpu` outcomes, in `docs/decisions/0006-feed-parsing-and-sanitisation.md` (Results section).
2. Given the results, when the PM reviews them, then the ADR names the chosen library and sets `MAX_BODY_BYTES` and `MAX_ITEMS_PER_FETCH` so that the "typical" fixture's p99 is ≤ 8 ms.
3. Given the chosen settings, when the "huge" fixture is parsed, then the outcome is documented (either succeeds within caps or is rejected as `too_large` before parsing).
4. Given the spike is done, then the throwaway Worker is deleted and no spike code is merged into `main` except fixtures (moved to `e2e/fixtures/feeds/`).

**Out of scope:** production parser code (TID-011).

---

### TID-003: Spike: fan-out isolation, WebAuthn CPU and rate-limit binding (time-box: 1 day)

- **Agents:** SE (run), PM (decide, update ADR 0004, spec §9.1)
- **Depends on:** TID-001
- **Status:** Ready

**User story:** As the PM, I want to know whether a per-feed loopback RPC gets its own CPU and subrequest budget on the Free plan, so that the refresh design (ADR 0004) is safe to build.

**Method:** Throwaway Worker on a Free account with `enable_ctx_exports`, a `WorkerEntrypoint` that burns ~8 ms CPU (e.g. hashing in a loop) and makes 3 `fetch()` calls to a public endpoint. A cron/HTTP dispatcher calls it 20 times via `ctx.exports` and, separately, via a normal service binding to a second Worker.

**Acceptance criteria**

1. Given the dispatcher calls 20 callees that each use ~8 ms CPU, when it runs, then the result (each callee succeeds independently, or the dispatcher is killed for exceeding 10 ms) is recorded for both `ctx.exports` and a two-Worker service binding.
2. Given 20 callees each doing 3 `fetch()` calls (60 total), when it runs, then we record whether callee subrequests count against the dispatcher's 50-subrequest limit.
3. Given a day of the spike running, when we check the dashboard, then we record whether callee invocations count toward the 100,000 requests/day quota.
4. Given a deployed WebAuthn verify endpoint using `@simplewebauthn/server` (registration and authentication with a virtual authenticator), when called 50 times, then p99 CPU and cold-start CPU are recorded; if p99 > 8 ms the ADR 0002 consequences are updated with the fallback (spec R9).
5. Given a `ratelimits` binding in `wrangler.jsonc`, when deployed on the Free plan, then we record whether it deploys and enforces a limit.
6. Given the findings, then ADR 0004 is updated to "Accepted" with the chosen fan-out mechanism (or the next rung of the fallback ladder), `REFRESH_BATCH_SIZE` is confirmed, and spec §9.1's "Unverified" rows are updated with dates.

**Out of scope:** production refresh code.

---

### TID-004: D1 schema v1 and data-access layer

- **Agents:** SE, QA, PM
- **Depends on:** TID-001
- **Status:** Ready

**User story:** As an engineer, I want the schema and typed query helpers in place, so that features can be built on a consistent, budget-aware data layer.

**Scope:** `apps/worker/migrations/0001_init.sql` exactly as spec §6.1; `apps/worker/src/db/` with a typed wrapper over `env.DB` (prepare/bind/batch, `meta` exposed to tests), ID and time helpers, cursor encode/decode (§8.6), URL canonicalisation (§6.4); `npm run db:migrate:local`, `npm run db:seed:local` (a user, 3 folders, 10 feeds, 500 entries).

**Acceptance criteria**

1. Given an empty local D1, when I run `npm run db:migrate:local`, then every table and index in spec §6.1 exists (integration test reads `sqlite_master`).
2. Given the migration, when I insert two `entries` with the same `(feed_id, guid_hash)`, then the second is rejected or ignored with `ON CONFLICT DO NOTHING`.
3. Given the canonicaliser, when given `HTTP://Example.com:80/feed#x`, `feed://example.com/rss`, `https://例え.jp/feed`, `javascript:alert(1)`, then it returns `http://example.com/feed`, `https://example.com/rss`, the punycode URL, and an error respectively (unit tests, plus the rest of §6.4's rules).
4. Given a cursor `{p, i}`, when encoded and decoded, then it round-trips; when a malformed cursor is decoded, then it throws a validation error that maps to `400 validation_failed`.
5. Given the seeded DB, when the "All unread" list query (§8.6) runs with `limit 50`, then D1 `meta.rows_read` ≤ 102 (NFR-7).
6. Given a lint rule or unit test, when SQL is built with template-literal interpolation inside `prepare()`, then lint fails.

**Out of scope:** API routes.

---

### TID-005: Test infrastructure and fixture corpus

- **Agents:** QA (owns), SE (support), PM
- **Depends on:** TID-001
- **Status:** Ready

**User story:** As the tester, I want integration and E2E harnesses with deterministic fixtures, so that every story can prove its acceptance criteria automatically.

**Scope:** `docs/testing/TEST_STRATEGY.md`; `@cloudflare/vitest-pool-workers` config with migrations applied per test file; a fake `fetch` helper and fixed-clock helper; Playwright config with projects `mobile-light`, `mobile-dark` (375 × 812), `desktop-light`, `desktop-dark` (1280 × 800), using `colorScheme`; a local fixture feed server; a Chromium virtual WebAuthn authenticator helper; `@axe-core/playwright` helper; fixture corpus in `e2e/fixtures/` (feeds per spec §13, an Inoreader-style OPML with ~250 feeds in ~18 folders including a feed in two folders and one nested folder, an XSS payload set).

**Acceptance criteria**

1. Given `npm test`, when it runs, then Worker integration tests execute inside workerd against a migrated local D1 and a sample test passes.
2. Given `npm run test:e2e`, when it runs, then all four Playwright projects run a smoke test against the local app and an axe check reports zero serious/critical violations on the placeholder page.
3. Given the virtual authenticator helper, when an E2E test calls it, then a passkey registration and assertion can complete in Chromium (verified once TID-007 lands; until then a unit test of the helper).
4. Given the fixture server, when a test requests `/feeds/atom-basic.xml` with a matching `If-None-Match`, then it returns 304, and it can be scripted to return 404/410/500/429 with `Retry-After`, redirects, slow responses and oversized bodies.
5. Given `docs/testing/TEST_STRATEGY.md`, then it lists every layer, tool, command and the criterion-to-test traceability convention.

**Out of scope:** feature tests (written with each story).

---

### TID-006: Design system and app shell with theming

- **Agents:** UX (design first), SE (build), QA, PM
- **Depends on:** TID-001
- **Status:** Ready

**User story:** As the owner, I want the app to look right in light and dark mode from the first screen and to follow my phone's setting, so that reading at night is comfortable.

**Scope:** UX produces `docs/ux/DESIGN_SYSTEM.md` (tokens with contrast ratios for both themes, type scale, spacing, radii, motion, icons) and `docs/ux/FLOWS.md` (navigation model). SE implements tokens as CSS variables + Tailwind theme, `theme-init.js`, the app shell (header, navigation drawer at < 1024 px and sidebar at ≥ 1024 px, main area, toast region, safe-area insets), route skeletons from spec §11.1 rendering placeholders, `_headers` with CSP (§10.4).

**Acceptance criteria**

1. Given the OS is in dark mode and no preference is stored, when the app loads, then `<html data-theme="dark">` is set before first paint (E2E checks the attribute in a `DOMContentLoaded`-time script and compares a screenshot with no light flash).
2. Given `localStorage['tidings.theme'] = 'light'` and the OS in dark mode, when the app loads, then the light theme is used.
3. Given the theme is "system", when the OS scheme changes while the app is open, then the theme follows without reload.
4. Given the shell at 375 × 812, when I open the navigation drawer, then it is reachable by a control in the header, traps focus while open, closes on Escape and on backdrop tap, and every tap target is ≥ 44 × 44 px.
5. Given every route in spec §11.1 rendered as a placeholder, when axe runs in all four Playwright projects, then there are zero serious/critical violations.
6. Given the production build served locally, when I load any SPA route, then the response has the CSP and other headers from spec §10.4 and the console shows no CSP violations.
7. Given the design tokens, when I check text/background pairs listed in `DESIGN_SYSTEM.md`, then each meets WCAG 2.2 AA (4.5:1 body, 3:1 large text and UI) in both themes *(UX verifies; tokens file lists ratios)*.

**Out of scope:** the settings screen (TID-022), real data.

---

## M1: MVP, "switch from Inoreader"

### TID-007: First-run setup with a passkey and recovery codes

- **Agents:** UX, SE, QA, PM
- **Depends on:** TID-003, TID-004, TID-005, TID-006
- **Spec:** FR-AU-1, FR-AU-2, FR-AU-8, §8.3, §10.1, §10.7

**User story:** As the owner deploying Tidings for the first time, I want to create my account with a passkey using a setup token only I know, so that nobody else can claim my instance.

**Acceptance criteria**

1. Given no users exist, when the SPA loads, then `GET /api/auth/session` returns `{user:null, setupRequired:true}` and the app routes to `/setup`.
2. Given no users exist and a correct setup token, when I enter a display name and complete passkey registration, then a user with role `owner` and one passkey exist, a session cookie `__Host-tid_session` (HttpOnly, Secure, SameSite=Lax, Path=/) is set, and the response contains 10 distinct recovery codes in `XXXX-XXXX-XXXX-XXXX` format.
3. Given the recovery codes screen, when I haven't ticked "I've saved these", then I can't continue; when I tick it, then I land on `/all` (empty state). "Copy" and "Download .txt" both produce all 10 codes.
4. Given a wrong setup token, when I call `setup/options` or `setup/verify`, then I get `403 invalid_setup_token` and no user is created.
5. Given a user already exists, when anyone calls either setup endpoint (even with the right token), then they get `409 setup_unavailable`, and `/setup` in the SPA redirects to `/login`.
6. Given 10 failed setup attempts from one IP in 10 minutes, when an 11th is made, then it gets `429 rate_limited` with `Retry-After`.
7. Given the DB after setup, when I inspect `recovery_codes` and `sessions`, then only SHA-256 hashes are stored (no plaintext codes or tokens).
8. Given a challenge older than 5 minutes or already used, when `setup/verify` is called with it, then it fails with `401 webauthn_failed`.

**Out of scope:** adding more passkeys (TID-022), invites.

---

### TID-008: Passkey sign-in, sessions, sign-out and API security middleware

- **Agents:** UX, SE, QA, PM
- **Depends on:** TID-007
- **Spec:** FR-AU-3, FR-AU-5, §8.1, §10.2, §10.3, §10.4, §10.8

**User story:** As the owner, I want to sign in with my passkey on any of my devices and stay signed in, so that opening the app is instant and my data stays mine.

**Acceptance criteria**

1. Given I'm signed out, when I tap "Sign in with a passkey" and complete the platform prompt, then I land on my default view with a new session cookie.
2. Given an assertion with a wrong signature, unknown credential, or wrong origin/RP ID, when `login/verify` is called, then it returns `401 webauthn_failed` and no session is created.
3. Given a valid session, when 23+ days remain on it, then requests don't write to `sessions`; when fewer than 23 days remain, then the next request extends `expires_at` to now + 30 days (fixed-clock integration test).
4. Given a session past `expires_at` or `absolute_expires_at`, when any authenticated route is called, then it returns `401 unauthenticated` and the SPA routes to `/login`.
5. Given I tap "Sign out", then `POST /api/auth/logout` deletes my session row, clears the cookie, and the SPA shows `/login`; the old cookie value then gets `401`.
6. Given **every** route in spec §8 not marked Public, when called with no cookie, then it returns `401 unauthenticated` (one generated test per route from the route table).
7. Given a valid session, when a mutating request has `Origin: https://evil.example`, or no `Origin` and no `Sec-Fetch-Site: same-origin`, or a non-JSON `Content-Type`, then it returns `403 csrf_failed`.
8. Given any API response, then it carries `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and `Cross-Origin-Resource-Policy: same-origin`, and no `Access-Control-Allow-Origin` header.
9. Given user B's session and user A's folder/subscription/entry/passkey IDs, when B calls any route with those IDs, then the response is `404 not_found` and A's data is unchanged (isolation suite).
10. Given 10 failed sign-ins from one IP in 10 minutes, when an 11th is attempted, then `429 rate_limited`.

**Out of scope:** session list (M2).

---

### TID-009: Sign in with a recovery code

- **Agents:** UX, SE, QA, PM
- **Depends on:** TID-008
- **Spec:** FR-AU-4, §10.1

**User story:** As the owner who has lost my passkey, I want to sign in with a recovery code and add a new passkey, so that I'm never locked out of my reader.

**Acceptance criteria**

1. Given a valid unused code (any case, with or without dashes), when I submit it on `/recover`, then I'm signed in, the code's `used_at` is set, and a persistent banner "Add a new passkey" links to settings until I've registered a passkey in this session.
2. Given the same code again, when submitted, then `401 invalid_recovery_code`.
3. Given an invalid code, when submitted, then `401 invalid_recovery_code` and the response time doesn't differ by code validity by more than noise (single hashed lookup; no early return before hashing).
4. Given 10 attempts from one IP in 10 minutes or 30 globally in an hour, when another is made, then `429 rate_limited`.

---

### TID-010: SSRF-safe fetcher

- **Agents:** SE, QA, PM
- **Depends on:** TID-004
- **Spec:** §10.6, §7.3 step 1, §7.4 redirects

**User story:** As the owner, I want feed fetching to refuse internal and private addresses, so that my instance can't be used to probe networks or metadata services.

**Acceptance criteria**

1. Given each URL in the SSRF list (`http://127.0.0.1/`, `http://[::1]/`, `http://169.254.169.254/latest/meta-data`, `http://0x7f000001/`, `http://2130706433/`, `http://10.0.0.1/`, `http://192.168.1.1/`, `http://172.16.0.1/`, `http://100.64.0.1/`, `http://[fd00::1]/`, `http://[::ffff:127.0.0.1]/`, `http://localhost/`, `http://localhost./`, `http://printer/`, `http://foo.internal/`, `http://<APP_ORIGIN host>/`, `ftp://example.com/`, `http://user:pw@example.com/`, `http://example.com:22/`), when `safeFetch` is called, then it returns `blocked_address` (or `invalid_url`) without calling the injected `fetch`.
2. Given a public URL that redirects (301) to `http://127.0.0.1/`, when fetched, then the redirect is not followed and the result is `blocked_address`.
3. Given a chain of 4 redirects, when fetched, then it stops after 3 with `too_many_redirects`.
4. Given a response body of 2 MB + 1 byte, when fetched, then the read is aborted and the result is `too_large`; given a server that stalls, then the result is `timeout` after 10 s (fake timers).
5. Given ETag/Last-Modified inputs, when fetched, then `If-None-Match` and `If-Modified-Since` are sent and the `User-Agent` matches spec §7.3; no cookies or auth headers are ever sent, including on redirects.
6. Given `ALLOW_FETCH_HOSTS` is set while `APP_ORIGIN` isn't `http://localhost:*`, when the Worker handles any request, then it refuses with a logged configuration error (unit test of the guard).
7. Given a 200 response, then the fetcher returns the body bytes and its SHA-256 computed while streaming.

---

### TID-011: Feed parser and normalisation

- **Agents:** SE, QA, PM
- **Depends on:** TID-002 (library and caps decided)
- **Spec:** §6.3, §6.5, ADR 0006

**User story:** As the owner, I want my RSS, Atom and RDF feeds read correctly, with no duplicate articles, so that my reading list is accurate.

**Acceptance criteria**

1. Given the fixture corpus (RSS 2.0, Atom 1.0, RSS 1.0/RDF, CDATA, HTML entities, namespaced `content:encoded`, `media:thumbnail`, `dc:date`), when parsed, then title, link, guid, author, published date, content, summary (≤ 300 chars plain text) and image URL match the expected JSON snapshot per fixture.
2. Given an item without a guid, when its key is computed, then it falls back to canonical link, then to title+date+enclosure (§6.3); the same item parsed twice yields the same `guid_hash`.
3. Given a feed with 200 items, when parsed with `MAX_ITEMS_PER_FETCH = 50`, then exactly the first 50 items in document order are returned and the parser stops consuming input after them.
4. Given malformed XML (unclosed tags, stray `&`, wrong encoding declaration), when parsed, then either a best-effort result with ≥ 1 item or a `parse_error`, never an uncaught exception.
5. Given a published date in the future or missing, then `published_at` equals the fetch time; given `javascript:` or `data:` links or image URLs, then they are null.
6. Given an entity-expansion payload (billion laughs) or a 5 MB single attribute, when parsed, then it completes within the caps without expanding custom entities (unit test asserts output size).
7. Given `content_html` over 100 KB, then it is truncated to 100 KB.
8. Given an HTML page with `<link rel="alternate" type="application/rss+xml" href="/feed">`, when discovery runs (HTMLRewriter), then it returns the absolute feed URL; JSON Feed links are returned with `supported: false`.

---

### TID-012: Background refresh pipeline

- **Agents:** SE, QA, PM
- **Depends on:** TID-003, TID-010, TID-011
- **Spec:** FR-RF-1 to FR-RF-5, §7.1 to §7.4, ADR 0004

**User story:** As the owner, I want my feeds refreshed in the background every 30 minutes, so that new articles are already there when I open the app.

**Acceptance criteria**

1. Given 50 feeds due and `REFRESH_BATCH_SIZE = 20`, when the dispatcher runs once, then exactly 20 feeds (oldest `next_fetch_at` first) are leased with `next_fetch_at = now + fetch_interval_s` and refreshed; two concurrent dispatcher runs lease 40 distinct feeds (no feed twice).
2. Given a feed whose origin returns 304, when refreshed with `state='ok'` and `error_count=0`, then no row is written to D1 by the refresh (assert `rows_written = 0` for the refresh step).
3. Given a 200 response byte-identical to the last one, then no parse happens and no row is written.
4. Given a 200 with 3 new items and 47 known items, then exactly 3 `entries` and 3 `user_entries` per subscriber are inserted, `feeds.etag/last_modified/body_hash/last_new_entry_at` are updated, and the refresh's total `rows_written` ≤ 3×3 + 3×5×subscribers + 1.
5. Given a feed returning 500 three times in a row, then `error_count = 3`, `state = 'failing'`, and `next_fetch_at` is `now + min(1800 × 2³, 86400)` ±10%.
6. Given 429 with `Retry-After: 7200`, then `next_fetch_at = now + 7200`.
7. Given 410, then `state = 'gone'` and the feed is never leased again.
8. Given 20 consecutive failures, then `state = 'dead'` and later failures schedule `now + 86400`.
9. Given a 301 to a new valid URL that no other feed uses, then on success `feeds.url` is updated to the canonical new URL.
10. Given a callee that throws (simulated CPU-limit kill), when the dispatcher's `allSettled` sees the rejection, then the dispatcher records `last_error_code = 'internal'` (or `cpu_limit` when detectable), increments `error_count` and applies backoff.
11. Given a feed with no subscriptions, then it is never leased (parked at `next_fetch_at = 253402300799`).
12. Given `npm run dev`, when I call `/cdn-cgi/local/scheduled?cron=*+*+*+*+*`, then the dispatcher runs against the fixture server *(manual check documented in README)*.

**Out of scope:** adaptive intervals (M2), first-fetch-for-user behaviour (TID-013).

---

### TID-013: Subscribe to a feed

- **Agents:** UX, SE, QA, PM
- **Depends on:** TID-008, TID-012
- **Spec:** FR-SU-1 to FR-SU-4, FR-SU-7, FR-SU-8, §7.5, §8.4

**User story:** As the owner, I want to paste a feed or website URL and see its articles straight away, so that adding a source feels instant.

**Acceptance criteria**

1. Given a direct feed URL, when I add it on `/manage/add`, then `POST /api/subscriptions` returns 201 with the subscription, `fetch.ok = true`, and the feed's newest ≤ 10 items appear in `/feeds/:id`; items published > 7 days ago are already read.
2. Given a website URL with one discoverable feed, then I'm subscribed to that feed; with several, then the API returns `422 feed_choice_required` with candidates and the UI lets me pick one; with none, then `422 no_feed_found` and the UI shows the copy from UX.
3. Given a URL I'm already subscribed to (after canonicalisation), then `409 already_subscribed` with the existing ID, and the UI offers to open it.
4. Given a feed that another user already has, fetched within the last 30 minutes, when I subscribe, then no origin fetch happens and the newest 10 existing entries are linked to me.
5. Given a feed whose first fetch fails or exceeds 10 s, then the subscription is still created with `health.state` `pending` or `failing` and the UI explains it will retry.
6. Given a private-address URL, then `422 blocked_address` and nothing is created.
7. Given I already have 1,000 subscriptions, then `422 limit_reached`.
8. Given I choose a folder and custom title while adding, then the subscription is created with them.
9. Given the first fetch runs, then it runs via the `FeedRefresher` entrypoint (integration test asserts the entrypoint was called, not in-request parsing).

---

### TID-014: Folders and subscription management

- **Agents:** UX, SE, QA, PM
- **Depends on:** TID-013
- **Spec:** FR-FO-1 to FR-FO-5, FR-SU-5, FR-SU-6, §8.4

**User story:** As the owner, I want to group feeds into folders and rename, move or remove them, so that I can browse by topic like I do in Inoreader.

**Acceptance criteria**

1. Given `/manage`, when I create a folder "Tech", then it appears in the manage list and the navigation drawer, sorted case-insensitively.
2. Given a folder "Tech" exists, when I create "tech", then `409 conflict` and the UI shows an inline error.
3. Given a name of 0 or 65 characters, then `400 validation_failed`.
4. Given a subscription, when I move it to "Tech", then it appears under Tech in the drawer and in Tech's folder view; when I move it to "No folder", then it appears at the top level.
5. Given I rename a subscription to "My Blog", then it shows "My Blog" everywhere; clearing the name restores the feed's title.
6. Given a folder with 5 subscriptions, when I delete it and confirm, then the folder is gone and all 5 subscriptions remain with `folderId = null`.
7. Given I unsubscribe from a feed and confirm, then the subscription and all my `user_entries` for that feed are deleted; if I was the last subscriber, the feed is parked (§7.1).
8. Given 200 folders, when I create another, then `422 limit_reached`.
9. Given 375 × 812 in both themes, the manage screen matches the UX spec *(UX review)*.

---

### TID-015: Feed health and "Refresh now"

- **Agents:** UX, SE, QA, PM
- **Depends on:** TID-014
- **Spec:** FR-FH-1, FR-FH-2, FR-RF-7

**User story:** As the owner, I want to see which feeds are broken and why, and refresh a feed on demand, so that I can fix or drop dead sources.

**Acceptance criteria**

1. Given feeds in each state (`pending`, `ok`, `failing`, `dead`, `gone`), when I open `/manage`, then each shows its state, last successful fetch (relative time) and, for failures, a plain-language message mapped from `last_error_code` (mapping table in UX copy).
2. Given a failing, dead or gone feed, then the navigation drawer shows a warning marker with an accessible label.
3. Given I tap "Refresh now", then `POST /api/subscriptions/:id/refresh` fetches it immediately and the UI updates its state and counts.
4. Given I tap "Refresh now" again within 5 minutes, then `429 rate_limited` and the button shows when it'll be available.

---

### TID-016: Import subscriptions from OPML

- **Agents:** UX, SE, QA, PM
- **Depends on:** TID-014
- **Spec:** FR-OP-1 to FR-OP-4, §8.7

**User story:** As someone leaving Inoreader, I want to import my OPML export with folders intact, so that I can switch in one sitting.

**Acceptance criteria**

1. Given the 250-feed Inoreader fixture, when I pick it on `/manage/import`, then the preview shows feed and folder counts, how many are already subscribed, how many are invalid, and how many feeds appeared in more than one folder, before anything is sent.
2. Given I confirm, then the SPA sends ≤ 100 feeds per `POST /api/import/opml` and, when done, all valid feeds are subscribed in folders matching the top-level OPML folders (nested folders flattened; first folder wins for duplicates).
3. Given the import completes, then no feed was fetched during the import requests (integration test: injected `fetch` not called) and every new feed has `next_fetch_at` within the next `ceil(n / 20)` minutes.
4. Given import progress, then the screen shows "Fetched X of N feeds" updating every 5 s until all new feeds have left `pending` (or the user navigates away).
5. Given I import the same file again, then `created = 0`, no folders are duplicated, and `existing` equals the number of feeds.
6. Given an OPML file with an invalid URL and a private-address URL, then they're reported as `invalid_url` and `blocked_address` and the rest import.
7. Given a malformed (non-XML) file, then the UI shows an error and sends nothing.
8. Given the import's write cost, then a 250-feed import followed by first fetches writes ≤ 25,000 rows in total (integration test with fixtures summing `rows_written`).

---

### TID-017: Export subscriptions as OPML

- **Agents:** SE, QA, PM
- **Depends on:** TID-014
- **Spec:** FR-OP-5, §8.7

**User story:** As the owner, I want to export my subscriptions, so that I'm never locked in to Tidings either.

**Acceptance criteria**

1. Given subscriptions in folders and without folders, when I call `GET /api/export/opml`, then I get a valid OPML 2.0 document (`text/x-opml`, attachment filename `tidings-YYYY-MM-DD.opml`) with one `<outline>` per folder containing its feeds, and unfiled feeds at the top level, each with `type="rss"`, `text`, `title`, `xmlUrl` and `htmlUrl` when known.
2. Given titles containing `&`, `<` and quotes, then they're correctly escaped.
3. Given the exported file, when re-imported into a fresh account via TID-016, then the same folders and subscriptions result (round-trip test).

---

### TID-018: Article lists, navigation and unread counts

- **Agents:** UX, SE, QA, PM
- **Depends on:** TID-013
- **Spec:** FR-RD-1 to FR-RD-6, FR-RD-10 to FR-RD-12, §8.5, §8.6, NFR-1, NFR-7

**User story:** As the owner, I want to browse all my articles, a folder or a single feed, newest first with unread counts, so that I can catch up quickly on my phone.

**Acceptance criteria**

1. Given seeded data, when I open `/all`, `/folders/:id` and `/feeds/:id`, then each shows the matching articles newest first, 50 per page, with feed title, title, relative time, summary and thumbnail when present.
2. Given "Unread only", then only unread articles appear; toggling to "All articles" shows read ones too, and the toggle's default comes from my settings.
3. Given I scroll to the end of a page, then the next page loads via `nextCursor`; given 3 new entries are inserted between page 1 and page 2, then page 2 contains no duplicates and skips nothing (integration test).
4. Given `GET /api/counts`, then totals per subscription, per folder (sum of its subscriptions) and overall match the number of unread `user_entries` (integration test), and `rows_read` ≤ unread rows + subscriptions + 10.
5. Given the "All unread" and "Feed unread" list queries with `limit=50`, then `rows_read` ≤ 102 (NFR-7).
6. Given the drawer, then it shows All, folders (expandable) and unfiled feeds with unread counts, and zero-count items are dimmed.
7. Given a view with no subscriptions / no unread / a never-fetched feed / a failing feed, then the matching empty state from UX is shown.
8. Given `?view=feed&id=<another user's subscription>`, then `404 not_found`.
9. Given pull-to-refresh on a list, then the list and counts are refetched from the API and no feed fetch is triggered.
10. Given 375 × 812 in both themes, the lists match the UX spec and pass axe *(E2E + UX review)*.

---

### TID-019: Article view and read state

- **Agents:** UX, SE, QA, PM
- **Depends on:** TID-018
- **Spec:** FR-RD-7, FR-RD-8, §10.5, NFR-5

**User story:** As the owner, I want to read an article comfortably and have it marked as read, so that my unread list reflects what I've actually seen.

**Acceptance criteria**

1. Given I tap a list item, then the article view shows title, feed, author, date and the sanitised content, with "Open original" opening the entry URL in a new tab with `rel="noopener noreferrer"`.
2. Given "Mark as read when opened" is on, when I open an unread article, then it shows as read in the list and the counts drop by one within 100 ms (optimistic), and `PATCH /api/entries/:id {isRead:true}` is sent.
3. Given the API returns an error for that PATCH, then the UI rolls back the read state and counts and shows a toast.
4. Given I tap "Mark as unread", then it becomes unread again (list and counts).
5. Given the XSS payload corpus as `content_html` (script tags, `onerror`, `javascript:` links, `<iframe>`, `<svg onload>`, `<style>`, `<form>`, `srcdoc`, `<base>`, `<meta http-equiv>`), when rendered, then no script executes (E2E listens for dialogs/console errors and checks a global canary), forbidden elements are absent from the DOM, and iframes are replaced with an "Open embedded content" link.
6. Given content with relative links and images, then they're resolved against the entry URL; every image has `loading="lazy"` and `referrerpolicy="no-referrer"` and never overflows the viewport at 375 px.
7. Given I'm in a list view, when I tap "Next"/"Previous" in the article, then I move through that list's order (loading the next page if needed); "Back" returns to the list at the same scroll position.
8. Given `dangerouslySetInnerHTML` appears anywhere except `ArticleContent`, then lint fails (from TID-001; regression check).
9. Given `GET /api/entries/:id` for another user's entry, then `404`.
10. Given `POST /api/entries/read-state` with 1,001 IDs, then `400 validation_failed`; with IDs including another user's, then only mine change.

---

### TID-020: Mark all as read

- **Agents:** UX, SE, QA, PM
- **Depends on:** TID-018
- **Spec:** FR-RD-9, §8.5

**User story:** As the owner, I want to mark everything in a view as read in one tap, so that I can clear out a busy folder.

**Acceptance criteria**

1. Given a view loaded at `asOf = T`, when I mark all as read, then every unread entry in that view with `published_at ≤ T` becomes read, and entries in other views are unaffected.
2. Given an entry arrives in the view after `T`, then it stays unread.
3. Given more than 20 entries would be affected, then a confirm dialog states the number first; with 20 or fewer, no dialog.
4. Given ≤ 1,000 entries were affected, then an "Undo" toast appears for 5 s and undo restores exactly those entries to unread; with more than 1,000, no undo is offered.
5. Given a folder view, then only entries from subscriptions in that folder are affected.
6. Given 2,000 unread entries, when marked, then the request completes in one call and `rows_written` ≤ 2,000 × 3 (integration test).

---

### TID-021: Retention and maintenance job

- **Agents:** SE, QA, PM
- **Depends on:** TID-012
- **Spec:** FR-RF-6, §6.3 tombstones, §7.6

**User story:** As the owner, I want old articles cleaned up automatically, so that the database stays within the free storage limit without me doing anything.

**Acceptance criteria**

1. Given read, unstarred `user_entries` older than 30 days and unread ones older than 90 days, when the hourly job runs (fixed clock), then they're deleted; newer ones and starred ones are kept.
2. Given an entry older than 30 days with no remaining `user_entries`, then its `content_html` and `summary` become NULL and `purged_at` is set; the row remains.
3. Given a purged entry still present in the feed XML, when the feed is refreshed, then it is not re-inserted and no new `user_entries` appear.
4. Given tombstones older than 180 days, then they're deleted.
5. Given 5,000 rows eligible, when the job runs once, then it deletes at most 500 per statement and 10 statements per run, and the remainder is handled on later runs.
6. Given expired sessions, challenges and rate-limit windows, then they're deleted.
7. Given a parked feed with no subscriptions whose `last_attempt_at` is older than 7 days, then it and its entries are deleted (in chunks).
8. Given the 03:17 UTC run, then a structured log line records DB size and the previous day's counts.

---

### TID-022: Settings: theme, reading and account

- **Agents:** UX, SE, QA, PM
- **Depends on:** TID-008, TID-009
- **Spec:** FR-ST-1 to FR-ST-4, FR-AU-5 to FR-AU-7, §8.3

**User story:** As the owner, I want to choose my theme and reading preferences and manage my passkeys and recovery codes, so that the app works the way I like and I stay in control of access.

**Acceptance criteria**

1. Given I pick Light, Dark or System, then the theme changes immediately, `PATCH /api/me` stores it, `localStorage['tidings.theme']` is updated, and a fresh load on another device (new browser context with the same account) uses it.
2. Given I change "Unread only by default", "Mark as read when opened" or text size, then the change persists across reloads and takes effect in lists and the article view.
3. Given the passkeys section, then I can add a passkey (virtual authenticator), rename it, and remove one; removing the last one returns `409 last_passkey` and the UI explains why.
4. Given my session's `authenticated_at` is older than 15 minutes, when I regenerate recovery codes, then the API returns `403 reauth_required`, the UI runs a passkey sign-in, then retries and shows 10 new codes; the old codes no longer work.
5. Given I tap "Sign out everywhere", then all my sessions are deleted and every browser context gets `401` on the next request.
6. Given the data section, then "Import OPML" opens `/manage/import` and "Export OPML" downloads the file.
7. Given 375 × 812 in both themes, the screen passes axe and matches the UX spec *(E2E + UX review)*.

---

### TID-023: Persisted client cache and installable PWA shell

- **Agents:** UX, SE, QA, PM
- **Depends on:** TID-018, TID-019
- **Spec:** FR-PW-1 to FR-PW-3, NFR-1, NFR-3

**User story:** As the owner, I want the app to open instantly from my home screen showing what I last saw, so that it feels like a native reader.

**Acceptance criteria**

1. Given I've used the app, when I reload with the network throttled to Slow 4G and 4× CPU slowdown, then the last view's list renders from IndexedDB within 1.0 s of navigation start (median of 5, NFR-1), then revalidates.
2. Given the network is offline, when I launch the app, then the shell and cached lists, counts and up to 50 recently opened articles render, an "Offline" indicator shows, and a mutation shows an error toast.
3. Given a new app version is deployed, then the persisted cache is discarded (buster = app version) and the service worker updates on next launch.
4. Given the manifest, then Lighthouse's installability check passes and icons exist for 192 and 512 px plus a maskable icon; `theme-color` is set for both schemes.
5. Given the production build, then initial JS ≤ 170 KB gzipped and CSS ≤ 30 KB gzipped (CI size check, NFR-3).
6. Given an iPhone with iOS 17+, when I "Add to Home Screen" and open it, then it launches standalone and I stay signed in *(manual, PM sign-off)*.

---

### TID-024: Production deployment, runbook and budget check

- **Agents:** SE, QA, PM
- **Depends on:** all other M1 stories
- **Spec:** §9, §14.3, §10.1 break-glass, Q2

**User story:** As the owner, I want Tidings deployed on my Cloudflare account with automatic deploys and a runbook, so that I can rely on it daily and fix it if something goes wrong.

**Acceptance criteria**

1. Given a push to `main` with CI green, then the workflow applies remote D1 migrations and deploys the Worker; a failed migration stops the deploy.
2. Given the README, then it documents: first-time setup (create D1, set `SETUP_TOKEN`, choose the hostname per Q2, custom domain route), local dev, where to see Workers/D1 usage, the break-glass passkey recovery procedure, and how to roll back a deploy.
3. Given production with the owner's real OPML imported, after 48 hours, then the PM records actual daily requests, D1 rows read/written, storage and refresh CPU p99 in spec §9 ("Measured" column) and they're within 70% of each free limit *(manual, PM)*.
4. Given production, then `exceededCpu` outcomes are < 1% of refresh invocations, and any feed affected shows `cpu_limit` or `too_large` in Manage *(manual check of logs)*.
5. Given the production origin, then the response headers match spec §10.4 including HSTS (custom domain) *(automated header check script run against production)*.

**M1 exit criteria:** every M1 story Done; full suite green; real-iPhone manual pass in both themes; budget measured; the owner confirms they can cancel Inoreader.

---

## M2: Comfort (to be refined before scheduling)

### TID-025: Star articles and "Saved" view
- **Agents:** UX, SE, QA, PM. **Depends on:** M1.
- **User story:** As the owner, I want to save articles for later, so that I can come back to them after they'd normally be cleaned up.
- **AC:** (1) Given an article, when I tap Star, then `isStarred = true` and it appears in a "Saved" view sorted by star time. (2) Given a starred article older than 90 days, when maintenance runs, then it is kept with its content. (3) Given the new starred index, then the write budget in §9.4 is updated before release.

### TID-026: Mark as read on scroll
- **User story:** As the owner, I want articles I scroll past in a list to be marked read, so that I can skim headlines fast.
- **AC:** (1) Given the setting is on, when an item scrolls fully above the viewport, then it's marked read in a batched `read-state` call at most every 2 s. (2) Given the setting is off (default), nothing changes. **Agents:** UX, SE, QA. **Depends on:** TID-019.

### TID-027: Swipe between articles
- **User story:** As a one-handed phone reader, I want to swipe left/right to the next/previous article.
- **AC:** Given the article view on touch devices, when I swipe horizontally > 30% width, then the next/previous article opens; `prefers-reduced-motion` disables the animation. **Depends on:** TID-019.

### TID-028: Oldest-first sort and "mark older than" read
- **AC:** (1) Given "Oldest first", then lists sort ascending with a correct cursor. (2) Given "Mark older than 1 day / 1 week as read", then only matching entries in the view change. Needs new ascending query plans checked against NFR-7.

### TID-029: Adaptive refresh intervals
- **User story:** As the owner, I want quiet feeds checked less often, so that the app stays well within free limits as I add feeds.
- **AC:** (1) Given 10 consecutive fetches with no new items, then the interval doubles up to 4 h; any new item resets it to 30 min. (2) Given `<ttl>` or `sy:updatePeriod`, then the interval respects them within [20 min, 4 h]. (3) The measured lease writes drop and §9 is updated.

### TID-030: Feed favicons
- **AC:** Given a subscription with a site URL, then the drawer and list show its favicon loaded by the browser from the site (no Worker proxy), with a lettered fallback; CSP unchanged (`img-src https:`).

### TID-031: Desktop keyboard shortcuts
- **AC:** Given a desktop width, then `j/k` next/previous, `m` toggle read, `o` open original, `shift+a` mark all read, `?` shows help; shortcuts are disabled while typing in inputs.

### TID-032: Active sessions list
- **AC:** Given settings, then I see my sessions (device hint, created, last seen) and can end any one except the current one.

### TID-033: Manual folder and feed ordering
- **AC:** Given the manage screen, when I reorder folders (drag or move up/down buttons), then the drawer order persists via `folders.position`.

### TID-034: Storage warning
- **AC:** Given DB size > 70% of 500 MB (from the daily maintenance metric), then Settings shows a warning with the size and a link to the retention docs.

---

## M3: Later (refine before scheduling)

| ID | Title | User story (short) | First AC |
|---|---|---|---|
| TID-040 | Offline reading | As a commuter, I want my unread articles available offline. | Given I was online in the last 24 h, when offline, then the newest 200 unread articles' content is readable. |
| TID-041 | Spike: full-text search budget | As the PM, I want to know whether D1 FTS5 fits the write budget. | Given 30 days of entries, then FTS insert cost per entry and DB size growth are measured and an ADR is written. |
| TID-042 | Invite-only multi-user | As the owner, I want to invite a family member. | Given an owner-generated single-use invite link, when redeemed within 7 days, then a `member` user is created with their own passkey and no access to the owner's data. |
| TID-043 | Multiple folders per feed (tags) | As a former Inoreader user, I want a feed in several folders. | Given a feed tagged in two folders, then it appears in both folder views and counts. |
| TID-044 | Filter rules | As the owner, I want to auto-mark-read articles matching keywords. | Given a rule "title contains 'sponsored'", then matching new entries are inserted as read. |
| TID-045 | Update edited articles | As a reader, I want corrected articles to show their latest content. | Given an existing entry whose content hash changes, then content updates in place without becoming unread. |

## Won't do

Native apps; Inoreader API sync or starred-item migration (Q7); social features; readability/full-article extraction; AI features; image proxying (Q9).
