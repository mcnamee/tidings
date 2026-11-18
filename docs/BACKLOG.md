# Tidings Backlog

Owner: product-manager. Last updated 2026-11-17 (TID-053 email sign-in added, ADR 0016; MVP feature stories accepted, ADR 0015; reorganised into releases: MVP, R2, R3, ADR 0014).

- **Releases (ADR 0014):** MVP gets the owner reading their feeds on their phone as soon as possible; R2 and R3 follow over the next couple of weeks. Old "M1" stories are split across MVP, R2 and R3; M2 and M3 are unchanged.
- Stories are in priority order within each release. Build top to bottom unless dependencies allow parallel work.
- Each acceptance criterion (AC) must map to at least one automated test unless it is marked *(manual)*.
- "Agents" lists who works on the story: **SE** software-engineer, **QA** tester, **UX** ux-engineer, **PM** product-manager.
- References like FR-RD-8 or §7.3 point to `docs/PRODUCT_SPEC.md`.
- **Standing rule (ADR 0012): per-user isolation grows with each story.** Any story that adds a route taking an ID (in the path, query string or body) adds a B-against-A case for each ID input to the isolation suite (two users seeded in D1; user B gets `404 not_found`, or the ID is ignored where the spec says so, and A's data is unchanged). The route-table guard from TID-013 AC11 fails the build if one is missing.
- Status values: `Ready`, `Blocked`, `In progress`, `In review`, `In verification` (built; tester and UX checking, fixes in flight), `Done`, `Later`.

## Summary

| ID | Title | Release | Status | Depends on |
|---|---|---|---|---|
| TID-001 | Monorepo scaffolding, tooling and CI | M0 | Done | – |
| TID-002 | Spike: feed parse CPU on Workers Free | M0 | Done | TID-001 |
| TID-003 | Spike: fan-out isolation, WebAuthn CPU, rate-limit binding | M0 | Done | TID-001 |
| TID-004 | D1 schema v1 and data-access layer | M0 | Done | TID-001 |
| TID-005 | Test infrastructure and fixture corpus | M0 | Done | TID-001 |
| TID-006 | Design system and app shell with theming | M0 | Done | TID-001 |
| TID-007 | First-run setup with a passkey and recovery codes | MVP | Done | TID-003, 004, 005, 006 |
| TID-008 | Passkey sign-in, sessions, sign-out and API security middleware | MVP | Done | TID-007 |
| TID-010 | SSRF-safe fetcher | MVP | Done | TID-004 |
| TID-011 | Feed parser and normalisation | MVP | Done | TID-002 |
| TID-012 | Background refresh pipeline | MVP | Done (AC13 moved to TID-039) | TID-003, 010, 011 |
| TID-013 | Subscribe to a feed | MVP | Done (ADR 0015) | TID-008, 012 |
| TID-046 | GUID churn guard and per-feed daily cap (DEF-013) | MVP | Done (ADR 0015) | TID-012 |
| TID-014 | Folders and subscription management | MVP | Done (ADR 0015) | TID-013 |
| TID-018 | Article lists, navigation and unread counts | MVP | Done with conditions (AC5 folder bound moves to TID-049, DEF-050; ADR 0015) | TID-013 |
| TID-016 | Import subscriptions from OPML | MVP | Done (ADR 0015) | TID-014, 046 |
| TID-019 | Article view and read state | MVP | Done (ADR 0015) | TID-018 |
| TID-020 | Mark all as read | MVP | Done (ADR 0015) | TID-018 |
| TID-024 | Production deployment and runbook (MVP scope, ADR 0014) | MVP | Done (live at tidings.mcn.am 2026-11-17; manual "Deploy now" workflow; CI on main only) | all MVP stories |
| TID-053 | Sign in with an emailed link (ADR 0016; Resend amendment) | R2 | Built and deployed; AC15 (real email) pending the owner's first sign-in | TID-008 |
| TID-009 | Sign in with a recovery code | R2 | Done (deployed 2026-11-18) | TID-008 |
| TID-017 | Export subscriptions as OPML | R2 | Ready (also shows the hidden Export OPML link in Settings) | TID-014 |
| TID-015 | Feed health and "Refresh now" (now includes problem feeds first in Manage) | R2 | Ready | TID-014 |
| TID-022 | Settings: theme, reading, account | R2 | Done (deployed 2026-11-18; UX review of Settings pending) | TID-008, 009 |
| TID-048 | Mark read or unread from a list row (FR-RD-8) | R2 | Ready | TID-019 |
| TID-049 | Folder view read cost (DEF-050) | R2 | Done (deployed 2026-11-17; QA in the next test batch) | TID-018 |
| TID-050 | Tell me which OPML folders weren't created | R2 | Ready | TID-016 |
| TID-021 | Retention and maintenance job | R2 | Done (deployed 2026-11-18) | TID-012 |
| TID-047 | Post-launch budget and CPU check (TID-024 AC3, AC4, AC6, AC7; replaces TID-039 as a gate) | R2 | Ready (48 h after launch, from 2026-11-19) | TID-024 |
| TID-054 | Article title opens the original | R2 | Done (deployed 2026-11-18) | TID-019 |
| TID-026 | Mark as read on scroll (owner ruling: on by default) | R2 | Done (deployed 2026-11-18) | TID-019 |
| TID-035 | Swipe the drawer closed; edge-swipe to open in the installed app | R2 | Done (deployed 2026-11-18) | TID-006 |
| TID-055 | Edge-swipe back on the article view in the installed app | R2 | Done (deployed 2026-11-18) | TID-019 |
| TID-058 | Pinned header on pull, app-style article slide-in | R2 | Done (deployed 2026-11-18) | TID-055 |
| TID-059 | Launch splash screen (min 2 s) | R2 | Done (deployed 2026-11-18) | TID-057 |
| TID-060 | News-style list rows and sans-serif article text | R2 | Done (deployed 2026-11-18) | TID-018 |
| TID-061 | Hide duplicate articles across feeds (same URL or headline) | R2 | Ready (owner request 2026-11-18) | TID-012, TID-021 |
| TID-057 | Logo, app icons, and installable full-screen app (TID-023 AC4 and AC6) | R2 | Done (deployed 2026-11-18) | TID-006 |
| TID-023 | Persisted client cache and installable PWA shell | R3 | Ready | TID-018, 019 |
| TID-036 | SSRF guard hardening (TID-010 follow-up) | R3 | Ready | TID-010 |
| TID-037 | Design-token drift and contrast check in CI (TID-006 follow-up) | R3 | Ready | TID-006 |
| TID-038 | E2E harness stability: host sleep and shared local state (now includes DEF-090) | R3 | Ready | TID-005 |
| TID-051 | Mark all as read skips late arrivals with old dates | R3 | Ready | TID-020 |
| TID-052 | Focus the screen title on first load of a deep link | R3 | Ready | TID-016 |
| TID-039 | Deployed CPU gate (TID-012 AC13) | Later | Deferred (ADR 0014; run only if TID-047 shows CPU trouble) | TID-012 |
| TID-025 … TID-035 | Comfort features | M2 | Later | R3 |
| TID-040 … TID-045 | Later features | M3 | Later | M2 |

---

## M0: Foundations and spikes

### TID-001: Monorepo scaffolding, tooling and CI

- **Agents:** SE (build), QA (reviews CI test stages), PM (accept)
- **Depends on:** –
- **Status:** Done (accepted 2026-11-16; merged to `main`, CI green)

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
- **Status:** Done (accepted 2026-11-16 with AC2 restated; see Outcome)

**User story:** As the PM, I want measured CPU costs for parsing real feeds inside a Free-plan Worker, so that we pick a parser and set body/item caps that keep refreshes under 10 ms.

**Method:** Deploy a throwaway Worker to a Free-plan account. Endpoints parse fixture feeds embedded in the bundle (no network) with (a) htmlparser2 streaming + minimal mapper, (b) feedsmith. Fixtures: small RSS (~20 KB, 20 items), typical RSS (~150 KB, 50 items with `content:encoded`), Atom (~100 KB), RDF (~30 KB), large (~1 MB), huge (~3 MB, 500 items). Call each ≥ 200 times. Read CPU time from Cloudflare (Workers Logs / Observability `cpuTimeMs`, or dashboard CPU percentiles), not from `performance.now()` (it doesn't advance during execution). Also measure the cold-start effect of each library's bundle.

**Acceptance criteria**

1. Given the spike Worker, when each fixture is parsed 200+ times per library, then a results table records p50/p95/p99 CPU ms and the count of `exceededCpu` outcomes, in `docs/decisions/0006-feed-parsing-and-sanitisation.md` (Results section).
2. Given the results, when the PM reviews them, then the ADR names the chosen library and sets `MAX_BODY_BYTES` and `MAX_ITEMS_PER_FETCH` so that the "typical" fixture's p99 is ≤ 8 ms. **Amended 2026-11-16:** no option met p99 ≤ 8 ms because the tail is GC/JIT, not size. The target is restated as zero `exceededCpu` plus p95 (ADR 0006 PM decision).
3. Given the chosen settings, when the "huge" fixture is parsed, then the outcome is documented (either succeeds within caps or is rejected as `too_large` before parsing).
4. Given the spike is done, then the throwaway Worker is deleted and no spike code is merged into `main` except fixtures (moved to `e2e/fixtures/feeds/`). **Amended 2026-11-16:** the spike fixtures are not merged; `e2e/fixtures/generate-feeds.ts` generates the same sizes (ADR 0006 decision 10).

**Out of scope:** production parser code (TID-011).

**Outcome (2026-11-16):** htmlparser2 12 chosen; `MAX_ITEMS_PER_FETCH` 50 with true early stop; `MAX_BODY_BYTES` 1 MiB; refresh CPU gate = zero `exceededCpu` and p95 ≤ 8 ms for the whole invocation (parse p95 ≤ 6 ms); the huge feed is rejected as `too_large` before parsing. Unmeasured costs (body read, hash, dedup, D1) move to TID-012 AC13. All three spike Workers were deleted.

---

### TID-003: Spike: fan-out isolation, WebAuthn CPU and rate-limit binding (time-box: 1 day)

- **Agents:** SE (run), PM (decide, update ADR 0004, spec §9.1)
- **Depends on:** TID-001
- **Status:** Done (accepted 2026-11-16; AC3 measured the same day)

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

**Outcome (2026-11-16):** `ctx.exports` fan-out confirmed: each callee has its own CPU and subrequest budget, and the RPC calls don't use the dispatcher's 50 subrequests. `REFRESH_BATCH_SIZE` stays 20. Callee invocations **do** count toward 100k requests/day (GraphQL: 21 per tick = 1 cron + 20 callees), so the budget uses the "callees count" case (spec §9.3). The Rate Limiting binding works on Free (approximate) and is adopted for the API backstop. WebAuthn: warm p99 3 ms, cold up to 10 ms; lazy import (ADR 0002). Every spike Worker is deleted.

---

### TID-004: D1 schema v1 and data-access layer

- **Agents:** SE, QA, PM
- **Depends on:** TID-001
- **Status:** Done (accepted 2026-11-16; merged to `main`, CI green; DEF-001 ruled below)

**User story:** As an engineer, I want the schema and typed query helpers in place, so that features can be built on a consistent, budget-aware data layer.

**Scope:** `apps/worker/migrations/0001_init.sql` exactly as spec §6.1; `apps/worker/src/db/` with a typed wrapper over `env.DB` (prepare/bind/batch, `meta` exposed to tests), ID and time helpers, cursor encode/decode (§8.6), URL canonicalisation (§6.4); `npm run db:migrate:local`, `npm run db:seed:local` (a user, 3 folders, 10 feeds, 500 entries).

**Acceptance criteria**

1. Given an empty local D1, when I run `npm run db:migrate:local`, then every table and index in spec §6.1 exists (integration test reads `sqlite_master`).
2. Given the migration, when I insert two `entries` with the same `(feed_id, guid_hash)`, then the second is rejected or ignored with `ON CONFLICT DO NOTHING`.
3. Given the canonicaliser, when given `HTTP://Example.com:80/feed#x`, `feed://example.com/rss`, `https://例え.jp/feed`, `javascript:alert(1)`, then it returns `http://example.com/feed`, `https://example.com/rss`, the punycode URL, and an error respectively (unit tests, plus the rest of §6.4's rules).
4. Given a cursor `{p, i}`, when encoded and decoded, then it round-trips; when a malformed cursor is decoded, then it throws a validation error that maps to `400 validation_failed`.
5. Given the seeded DB, when the "All unread" list query (§8.6) runs with `limit 50`, then D1 `meta.rows_read` ≤ 102 (NFR-7). **Amended 2026-11-16 (DEF-001, ADR 0008):** ≤ 102 on page 1; on continuation pages ≤ 102 + T, where T is the number of the user's rows in the view sharing the cursor's `published_at` (T = 1 on the seed data, so ≤ 103). DEF-001 → Won't fix (budget relaxed); the tester updates DEFECTS.md and the test comment. A tied-timestamp case is added in TID-018 AC5.
6. Given a lint rule or unit test, when SQL is built with template-literal interpolation inside `prepare()`, then lint fails.

**Out of scope:** API routes.

---

### TID-005: Test infrastructure and fixture corpus

- **Agents:** QA (owns), SE (support), PM
- **Depends on:** TID-001
- **Status:** Done (accepted 2026-11-16; merged to `main`, CI green)

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
- **Status:** Done (accepted 2026-11-17 on `tid-006-defect-fixes`; merge to `main` next)

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
8. *(Added 2026-11-16.)* Given I open `/manage/add` or `/manage/import` from inside the app, when I tap the header Back, then I return one history entry (for example to `/all`); given I open either route directly in a new tab, then header Back goes to `/manage` with `replace` (E2E for both cases).
9. *(Added 2026-11-16.)* Given an article route opened inside the app, header Back goes one history entry back; opened directly, it goes to the list in its own route (`/all`, `/folders/:id`, `/feeds/:id`) (E2E; already built, keep the test).

**Out of scope:** the settings screen (TID-022), real data, swipe-to-close on the drawer (TID-035), PWA icons (TID-023).

**PM rulings (2026-11-16)**, ratified as built or designed, recorded in spec §11:
- Placeholder titles "Set up Tidings" and "Use a recovery code" accepted. "Folder" and "Feed" are acceptable only as the loading `document.title` fallback; TID-018 replaces the header text with a skeleton.
- Ratified: serif article body; in-flow sticky bottom bar; no edge-swipe to open and no swipe-to-close in MVP; the drawer pushes a history entry; the sticky header doesn't hide on scroll; no split view in MVP; in unread-only mode read rows stay until the user leaves; `theme-init` also applies `data-text-size`; no favicons in MVP.
- The offline banner on the `offline` event alone is accepted for TID-006; the failed-request trigger is TID-018 AC12.

**Acceptance (2026-11-17): Accepted.** AC1-AC9 pass, with 376 E2E tests green across the four Playwright projects. The UX review's majors and minors are fixed and mutation-tested. DEF-002 to DEF-005 are closed by the tester, who recommends acceptance.
- **AC7 evidence ruled sufficient.** The AC is marked "UX verifies". `docs/ux/check-contrast.mjs` computes all 74 pairs from the tokens in `DESIGN_SYSTEM.md` (74/74 pass), and AC5's axe runs (including `color-contrast`) cover the rendered placeholders in both themes. The remaining gap is that the shipped CSS tokens could drift from the documented ones. TID-037 closes it in CI.
- **Follow-up:** the failed-Undo copy "Couldn't undo. Your change was kept." goes to TID-020 AC7, the only MVP undo.

---

## MVP, R2 and R3 (formerly M1, "switch from Inoreader")

Story details below keep their original order. The summary table gives each story's release and build order (ADR 0014).

### TID-007: First-run setup with a passkey and recovery codes

- **Agents:** UX, SE, QA, PM
- **Depends on:** TID-003, TID-004, TID-005, TID-006
- **Spec:** FR-AU-1, FR-AU-2, FR-AU-8, §8.3, §10.1, §10.7
- **Status:** Done (accepted 2026-11-17 on `tid-007-first-run-setup`, tip `8908166`; merge to `main` next)

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
9. Given the Worker source, then `@simplewebauthn/server` is imported only via `await import()` in `apps/worker/src/auth/webauthn.ts`, and no other module imports it statically (a unit test scans `apps/worker/src`, or a lint rule) (ADR 0002).
10. *(Added 2026-11-17, ADR 0010.)* Given the recovery-codes step, when I tap "Download .txt", then in every Playwright project a download named `tidings-recovery-codes.txt` occurs containing all 10 codes in the UX format, and no CSP violation is logged. The CSP is not changed. If any project blocks the download, stop and raise it with the PM.
11. *(Added 2026-11-17.)* Given `setup/verify` with `passkeyName` missing, empty, whitespace-only or 65+ characters, then setup still succeeds and the passkey's name is the trimmed value capped at 64 characters, or "Passkey". The new session has `auth_method = 'setup'`.
12. *(Added 2026-11-17.)* Given the codes from setup, then none of them contains I, L, O or U (Crockford alphabet), and they are never written to the query cache, IndexedDB, `localStorage`, `sessionStorage`, history state or the URL (E2E inspects storage after Continue).

**Out of scope:** adding more passkeys (TID-022), invites.

**UX rulings ratified 2026-11-17** (`docs/ux/screens/auth-common.md`, `setup.md`, `login.md`, `recover.md` on `ux-m0-updates`; these apply to TID-007 to TID-009): no auto-start of the passkey prompt on `/login`; a cancelled prompt is an info banner with the recovery-code hint; after a recovery-code sign-in, go to the default view with the persistent "Add a new passkey" banner; session expiry keeps the IndexedDB cache and only an explicit sign-out clears it (with the user-ID guard, TID-023 AC7); `passkeyName` is a client best-effort label; auth errors are inline, not toasts. There is no "Lost your codes too?" link (ADR 0010).

**Acceptance (2026-11-17): Accepted.** AC1-AC12 pass. The tester's 35 attack tests found nothing exploitable: parallel setups yield exactly one owner, replayed or cross-purpose challenges are refused, spoofed IP headers don't evade the rate limit, nothing leaks into logs or bodies, and a D1 failure mid-setup leaves no partial rows. Nine code mutations were each caught by a test. DEF-012 (`no-store` on `config_error`) is fixed and closed. The UX review fixes (M1 sticky footer at large text, m1-m3, Copy and Download above the codes) are in, with E2E tests. The tester recommends acceptance.
- **E2E run:** 543 passed, 1 failed. The failure was a Playwright context-setup stall that didn't reproduce (168/168 on re-running the spec). Stalls have hit different tests in earlier runs, so they're harness flakiness, not a product defect. TID-038 fixes them.
- **Deviations ratified (ADR 0011):** migration 0002 shipped here, not in TID-009; accessible names include the visible label (WCAG 2.5.3); zod runs in the Worker only (`@tidings/shared/schemas`) because of the CSP; auth rate limits count failures (slot claimed on arrival, refunded on success); a missing or short `SETUP_TOKEN` returns `500 config_error`; the WebAuthn user handle is the new user's ID, held in `webauthn_challenges.user_id`; the E2E resting state is "owner exists".
- **Follow-ups:** CSRF and Content-Type on the setup routes (TID-008 AC14); capping setup challenge rows and not refunding `login/options` (TID-008 AC15); purging expired challenges (TID-021 AC6); accepted griefing of the global setup limit (risk R12, runbook in TID-024 AC8); Playwright stalls (TID-038).

---

### TID-008: Passkey sign-in, sessions, sign-out and API security middleware

- **Agents:** UX, SE, QA, PM
- **Depends on:** TID-007
- **Spec:** FR-AU-3, FR-AU-5, §8.1, §10.2, §10.3, §10.4, §10.7, §10.8, ADR 0011
- **Status:** Done (accepted 2026-11-17 on `tid-008-verification`, tip `f38e3fa`; merge to `main` next)

**User story:** As the owner, I want to sign in with my passkey on any of my devices and stay signed in, so that opening the app is instant and my data stays mine.

**Acceptance criteria**

1. Given I'm signed out, when I tap "Sign in with a passkey" and complete the platform prompt, then I land on my default view (spec §11.1: the last list viewed on this device, else `/all`) with a new session cookie.
2. Given an assertion with a wrong signature, unknown credential, or wrong origin/RP ID, when `login/verify` is called, then it returns `401 webauthn_failed` and no session is created.
3. Given a valid session, when 23+ days remain on it, then requests don't write to `sessions`; when fewer than 23 days remain, then the next request extends `expires_at` to now + 30 days (fixed-clock integration test).
4. Given a session past `expires_at` or `absolute_expires_at`, when any authenticated route is called, then it returns `401 unauthenticated` and the SPA routes to `/login`.
5. Given I tap "Sign out", then `POST /api/auth/logout` deletes my session row, clears the cookie, and the SPA shows `/login`; the old cookie value then gets `401`.
6. Given **every** route in spec §8 not marked Public, when called with no cookie, then it returns `401 unauthenticated` (one generated test per route from the route table).
7. Given a valid session, when a mutating request has `Origin: https://evil.example`, or no `Origin` and no `Sec-Fetch-Site: same-origin`, or a non-JSON `Content-Type`, then it returns `403 csrf_failed`.
8. Given any API response, then it carries `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and `Cross-Origin-Resource-Policy: same-origin`, and no `Access-Control-Allow-Origin` header.
9. Given user B's session and user A's folder/subscription/entry/passkey IDs, when B calls any route with those IDs, then the response is `404 not_found` and A's data is unchanged (isolation suite). *(Accepted as partial 2026-11-17, ADR 0012: no route takes an ID yet, and a tripwire fails when the first one appears. The suite is built in TID-013 AC11 and extended by every later story with an ID input.)*
10. Given 10 failed sign-ins from one IP in 10 minutes, when an 11th is attempted, then `429 rate_limited`.
11. Given the `API_RL` Rate Limiting binding (spec §4.6, §10.7) reports the limit exceeded for my user ID, when I call any authenticated route, then it returns `429 rate_limited` with `Retry-After: 60`; auth routes never consult it (integration test with a stubbed binding).
12. *(Added 2026-11-17.)* Given the shared `ErrorCode` type, then it matches spec §8.1 exactly, including `internal` (rename the current `internal_error`) and `config_error`, and an unhandled exception returns `500 internal` with a fixed message (no exception text).
13. *(Added 2026-11-17, ADR 0010.)* Given a passkey sign-in, then the new session has `auth_method = 'passkey'`. Given a `401` on any request, then the SPA routes to `/login` with the "Your session ended" banner and keeps the persisted cache, without painting it behind the login card. Given an explicit Sign out, then the persisted cache is cleared (E2E checks IndexedDB).
14. *(Added 2026-11-17, ADR 0011.)* Given the Public auth routes `setup/options`, `setup/verify`, `login/options`, `login/verify` and `recover`, when called with a `text/plain` body, or `Origin: https://evil.example`, or no `Origin` and no `Sec-Fetch-Site: same-origin`, then each returns `403 csrf_failed` and creates no rows (one test per route and case). The TID-007 E2E suite still passes unchanged.
15. *(Added 2026-11-17, ADR 0011.)* Given 5 unexpired `setup` challenges, when `setup/options` is called with the valid token, then `429 rate_limited` and no new challenge row; given expired `setup` challenges, then that call deletes them. Given 11 calls to `login/options` from one IP within 10 minutes with no verify, then the 11th is `429 rate_limited` and the table holds at most 10 new `login` challenges; given a successful `login/verify`, then only its own slot is refunded, so 10 consecutive full sign-ins from one IP succeed.

**Out of scope:** session list (M2).

**Acceptance (2026-11-17): Accepted.** AC1-AC8 and AC10-AC15 pass. AC9 is accepted as partial (above). The tester's 28 guard mutations were all caught, and an 80-test attack suite found no bypass. Rulings are in ADR 0012:
- **Deviations ratified:** deny by default for unknown routes; `GET /api/auth/session` slides the session; two login counters; `wrangler dev --infer-origin-from-routes=false`; the `tidings.hasSession` localStorage hint; a stand-in Sign out on the `/settings` placeholder until TID-022; the IndexedDB name `tidings-cache` for TID-023; no index on `webauthn_challenges(purpose, expires_at)`. The spec (§8.1, §8.3, §10.3, §10.7, §11.3, §14.1) says so.
- **Engineer's questions:** the E2E base `request` fixture sending the app `Origin` is fine (`bareRequest` covers CSRF). A bodyless `DELETE` must send `Content-Type: application/json` (§10.3).
- **DEF-018 (S4, `HEAD /api/health` is 401):** `HEAD /api/health` becomes Public, answered like GET with no body. Built in TID-009 AC6.
- **DEF-019 (E2E "stalls"):** host sleep, not a product defect. It feeds TID-038.
- **UX review of `/login`:** doesn't gate this story, because the E2E suite covered it at 375 px in both themes. UX reviews `/login` with `/recover` in TID-009 AC7.

---

### TID-053: Sign in with an emailed link

- **Agents:** UX, SE, QA, PM
- **Depends on:** TID-008 (built and tested locally before TID-024; AC15 needs production and the owner's setup)
- **Release:** R2, scheduled **next**, before the rest of R2 (owner's request, 2026-11-17)
- **Spec:** FR-AU-9, §8.3, §9.4, §10.1, §10.2, §10.7, ADR 0016 (amends ADR 0002)
- **Status:** Ready

**User story:** As the owner signing in from a work computer that has neither my phone nor my password safe, I want Tidings to email me a one-time sign-in link, so that I can read my feeds there without a passkey or recovery code.

**Acceptance criteria**

1. **Disabled unless configured.** Given the `RESEND_API_KEY` secret (non-empty), the `MAGIC_LINK_EMAIL` secret (non-empty, contains `@`) or the `MAGIC_LINK_FROM` var is missing, or the user count isn't exactly 1, then `GET /api/auth/session` returns `emailSignIn: false`, `/login` doesn't show "Email me a sign-in link", both `/api/auth/email/*` routes return `404 not_found`, and `send` is never called (one test per missing item). Given all are present, `emailSignIn` is `true`.
2. **Request a link.** Given the feature is on, when I tap "Email me a sign-in link" on `/login`, type my address in any case or with surrounding spaces, and submit, then `POST /api/auth/email/request` returns `202 {}`, one `magic_links` row exists for the owner, and the sender is called once with from `MAGIC_LINK_FROM` and to `MAGIC_LINK_EMAIL`, inside `ctx.waitUntil`. In production that is one `fetch` POST to `https://api.resend.com/emails` with a 5 s timeout (unit-tested with an injected `fetch`: URL, headers, JSON body, timeout, non-2xx). The screen shows the "Check your email" state (UX copy).
3. **No enumeration.** Given an address that doesn't match, then the response is byte-for-byte the same `202 {}` with the same headers. No row is written, no email is sent, and the screen shows the same "Check your email" state. A test asserts that the handler awaits nothing that depends on the match before it responds. Malformed bodies (not JSON, missing or non-string `email`, over 254 characters) get `400 validation_failed`, whether or not the address matches.
4. **Email content.** Given a sent email, then it is plain text (a `text` field only, no HTML, no remote images), with subject "Your Tidings sign-in link". The body contains exactly one URL, `APP_ORIGIN + "/login/email#token=" + token`, plus the expiry ("expires in 15 minutes"), the request time in UTC, and "If you didn't ask for this, ignore this email. Nobody can sign in without the link." The token is not in the subject. Snapshot test of the built message.
5. **Token.** Given a request, then the token is 32 bytes from `crypto.getRandomValues`, base64url-encoded (43 characters). Only its SHA-256 hex is stored, and `expires_at = created_at + 15 min`. A new request deletes the owner's earlier unused links, so at most one is live.
6. **GET has no effect.** Given a link, when `/login/email#token=…` is fetched with GET (as a mail scanner would), then the server returns the SPA shell, no `magic_links` or `sessions` row changes, and the token still works afterwards. The landing page removes the fragment from the address bar (`history.replaceState`) before it shows anything, and it makes no API call that consumes the token until I tap "Sign in" (E2E).
7. **Sign in.** Given a valid link, when I tap "Sign in" on the landing page, then `POST /api/auth/email/verify { token }` returns `200 { user }`, sets `__Host-tid_session` as in §10.2, creates a session with `auth_method = 'email'` and `authenticated_at = now`, sets the link's `used_at`, and the app goes (`replace`) to the default view.
8. **Single use and expiry.** Given a used token, an expired one (15 min + 1 s, fake clock), one superseded by a newer request, or a made-up one, then verify returns `401 invalid_link` and no session is created. The landing page shows the "link expired or used" state with a button back to `/login`. Two concurrent verifies of one token create exactly one session (atomic `UPDATE … WHERE used_at IS NULL AND expires_at > ?`).
9. **Rate limits.** Given 5 requests from one IP in 10 minutes, the 6th returns `429 rate_limited` with `Retry-After`. Given 100 requests in an hour from any IPs, the next returns `429`. Given 10 emails sent in a UTC day, a further matching request returns `202` and sends nothing (logged `send_capped`). A non-matching request never uses a send slot. For verify, 10 failures per IP per 10 minutes or 30 a global hour return `429`, and a success refunds its own slots. Every `429` is returned before the address is compared or the token looked up.
10. **CSRF.** Given either POST with a cross-site `Origin`, no `Origin` and no `Sec-Fetch-Site: same-origin`, or a non-JSON `Content-Type`, then `403 csrf_failed`, and nothing is written or sent.
11. **Step-up for email sessions.** Given a session with `auth_method = 'email'`, when it calls `POST /api/auth/passkeys/options`, `POST /api/auth/passkeys/verify`, `DELETE /api/auth/passkeys/:id` or `POST /api/auth/recovery-codes`, then `403 reauth_required` and nothing changes. Feed, entry and settings routes work as for a passkey session. Renaming a passkey is allowed.
12. **Migration.** Given `0004_email_sign_in.sql`, then `magic_links` exists and `sessions.auth_method` accepts `'email'` and still rejects unknown values. Existing sessions, their `auth_method` and the `sessions_user` index survive the rebuild (migration test on a seeded database).
13. **Secrets stay secret, isolation holds.** Given any request or verify, then logs contain no token, no link URL and no email address (the log-capture test, extended). Given the route table (`apps/worker/test/support/route-table.ts`), both routes are listed as Public with no ID inputs. The "every non-Public route returns 401" guard still passes. The token resolves the user server-side only, and a token issued for user A never creates a session for anyone else (two-user test: verify returns A's ID only).
14. **Screens at 375 px, both themes.** Given `/login` (with the email option open, sending, sent, rate-limited and offline) and `/login/email` (ready, signing in, invalid or expired, offline) at 375 × 812 in light and dark themes, then UX reviews them against `docs/ux/FLOWS.md` §2.1a and `screens/auth-common.md`, and files findings in `docs/testing/DEFECTS.md`. S1 to S3 findings are fixed in this story *(UX review)*. Axe finds no serious or critical violations (E2E).
15. **Production check** *(manual, after TID-024 and the owner's setup).* Given production, then a link requested from `/login` arrives at the owner's inbox from `signin@tidings.mcn.am` within 2 minutes, signs in once, and fails on the second use. `dig MX mcn.am` still shows only Google Workspace, and `https://tidings.mcn.am` still serves the app. Record the result, and the date, in ADR 0016 (this also checks ADR 0016's unverified Resend free-tier numbers).

**Owner setup (Resend, once; ADR 0016 amendment 2026-11-17; the agents can't do this because it needs your accounts):**

1. Create a Resend account (free tier: 3,000 emails/month, 100/day).
2. In Resend, **Domains > Add Domain**, enter `tidings.mcn.am`, and add the DNS records it lists in the `mcn.am` zone. They all sit under `tidings.mcn.am` (for example `send.tidings.mcn.am` and `resend._domainkey.tidings.mcn.am`). Add nothing on the apex `mcn.am`, and leave its Google Workspace MX records alone. Wait until Resend shows the domain as Verified.
3. In Resend, **API Keys > Create API Key**: permission **Sending access**, domain **`tidings.mcn.am`** only. Copy the key once.
4. In GitHub, **Settings > Secrets and variables > Actions**, add `RESEND_API_KEY` (the key) and `MAGIC_LINK_EMAIL` (your own address). The next deploy to `main` copies them to Workers secrets; nothing is printed. (Without CI: in `apps/worker`, run `npx wrangler secret put RESEND_API_KEY` and `npx wrangler secret put MAGIC_LINK_EMAIL`. Never put either in a file.) `MAGIC_LINK_FROM` is already in `wrangler.jsonc`.
5. Check: `dig MX mcn.am` still shows only Google, and `https://tidings.mcn.am` still loads. Then request a link from `/login`.
6. To turn the feature off at any time, run `npx wrangler secret delete MAGIC_LINK_EMAIL` (or `RESEND_API_KEY`), and remove the GitHub secret too or the next deploy puts it back.

**Out of scope:** more than one user and per-user addresses (M3, needs a provider decision, ADR 0016); sending to any address that isn't the configured secret; HTML email; binding the link to the requesting browser; a "remember this device" option; the sessions list UI (TID-032 shows the method when built).

---

### TID-009: Sign in with a recovery code

- **Agents:** UX, SE, QA, PM
- **Depends on:** TID-008
- **Spec:** FR-AU-4, §10.1, §8.8, ADR 0012
- **Status:** Ready (TID-008 accepted; merge `tid-008-verification` to `main` first)

**User story:** As the owner who has lost my passkey, I want to sign in with a recovery code and add a new passkey, so that I'm never locked out of my reader.

**Acceptance criteria**

1. Given a valid unused code (any case, with or without dashes or spaces, and with O typed for 0 or I/L typed for 1), when I submit it on `/recover`, then I'm signed in, the code's `used_at` is set, and a persistent banner "Add a new passkey" links to settings until a passkey has been registered since this session began (ADR 0010).
2. Given the same code again, when submitted, then `401 invalid_recovery_code`.
3. Given an invalid code, when submitted, then `401 invalid_recovery_code` and the response time doesn't differ by code validity by more than noise (single hashed lookup; no early return before hashing).
4. Given 10 attempts from one IP in 10 minutes or 30 globally in an hour, when another is made, then `429 rate_limited`.
5. *(Added 2026-11-17, ADR 0010; amended by ADR 0011.)* Given the `sessions.auth_method` column (migration `0002_session_auth_method.sql`, already shipped in TID-007; don't add another migration for it), when I sign in with a recovery code, then the session has `auth_method = 'recovery'` and `GET /api/auth/session` returns `mustAddPasskey: true`, so the banner is still there after a reload (E2E reloads). Given a passkey is then registered from any session, then the next session fetch returns `mustAddPasskey: false` and the banner is gone. Given a passkey or setup session, `mustAddPasskey` is always false, and computing it adds no D1 writes.
6. *(Added 2026-11-17, DEF-018, ADR 0012.)* Given no session, when `HEAD /api/health` is called, then it returns `200` with the same headers as GET and an empty body; `HEAD` on any other route without a session still returns `401`. The `it.fails` test "HEAD /api/health is answered like GET" in `security-attack.test.ts` becomes `it`.
7. *(Added 2026-11-17, ADR 0012.)* Given the built `/login` and `/recover` screens at 375 × 812 in light and dark themes (including the session-ended, cancelled-prompt and "Add a new passkey" banners), then UX reviews them against `docs/ux/screens/login.md`, `recover.md` and `auth-common.md` and files any findings in `docs/testing/DEFECTS.md`. S1-S3 findings are fixed in this story *(UX review)*.

---

### TID-010: SSRF-safe fetcher

- **Agents:** SE, QA, PM
- **Depends on:** TID-004
- **Spec:** §10.6, §7.3 step 1, §7.4 redirects

- **Status:** Done (accepted 2026-11-17 on `tid-010-safe-fetch`; merge to `main` next)

**User story:** As the owner, I want feed fetching to refuse internal and private addresses, so that my instance can't be used to probe networks or metadata services.

**Acceptance criteria**

1. Given each URL in the SSRF list (`http://127.0.0.1/`, `http://[::1]/`, `http://169.254.169.254/latest/meta-data`, `http://0x7f000001/`, `http://2130706433/`, `http://10.0.0.1/`, `http://192.168.1.1/`, `http://172.16.0.1/`, `http://100.64.0.1/`, `http://[fd00::1]/`, `http://[::ffff:127.0.0.1]/`, `http://localhost/`, `http://localhost./`, `http://printer/`, `http://foo.internal/`, `http://<APP_ORIGIN host>/`, `ftp://example.com/`, `http://user:pw@example.com/`, `http://example.com:22/`), when `safeFetch` is called, then it returns `blocked_address` (or `invalid_url`) without calling the injected `fetch`.
2. Given a public URL that redirects (301) to `http://127.0.0.1/`, when fetched, then the redirect is not followed and the result is `blocked_address`.
3. Given a chain of 4 redirects, when fetched, then it stops after 3 with `too_many_redirects`.
4. Given a response body of 1 MiB + 1 byte (`MAX_BODY_BYTES` = 1,048,576, ADR 0006), when fetched, then the read is aborted and the result is `too_large`; given a server that stalls, then the result is `timeout` after 10 s (fake timers).
5. Given ETag/Last-Modified inputs, when fetched, then `If-None-Match` and `If-Modified-Since` are sent and the `User-Agent` matches spec §7.3; no cookies or auth headers are ever sent, including on redirects.
6. Given `ALLOW_FETCH_HOSTS` is set while `APP_ORIGIN` isn't `http://localhost:*`, when the Worker handles any request, then it refuses with a logged configuration error (unit test of the guard).
7. Given a 200 response, then the fetcher returns the body bytes and its SHA-256 computed while streaming.

**Acceptance (2026-11-17): Accepted.** All 7 ACs pass. The tester found no defects after about 85 hostile encodings, about 25 hostile redirects, a gzip bomb, a lying `Content-Length` and a slow drip.
- **Hardening observations** (reserved names `.lan`, `.localdomain`, `.corp`, `.intranet`, `.test`, `.invalid`; IPv6 `2001::/23` and `3fff::/20`; empty `ALLOW_FETCH_HOSTS` treated as unset; `isLocalDevOrigin` accepting a path) go to **TID-036**. None is exploitable from the internet today: the names don't resolve publicly, and the config gaps need a misconfigured deploy.
- **The 1 MiB cap is on decoded bytes**, which is the intent: it bounds what we hash and parse (spec §7.3 step 4). TID-024 AC7 verifies deployed workerd behaviour.
- **`config_error`** (500) is added to spec §8.1 and §10.6.
- **Static assets aren't guarded**, and that is fine: they never fetch. The guard must also wrap the `FeedRefresher` entrypoint (TID-012 AC16).
- **Blind-SSRF oracle:** `safeFetch`'s raw outputs stay internal. TID-012 AC15, TID-013 AC10 and TID-015 AC5 require that users see only fixed messages (FR-FH-1, §10.6 rule 8).

---

### TID-011: Feed parser and normalisation

- **Agents:** SE, QA, PM
- **Depends on:** TID-002 (done: htmlparser2 12, 50 items, 1 MiB; ADR 0006)
- **Spec:** §6.3, §6.5, ADR 0006

- **Status:** Done (accepted 2026-11-17 on `tid-011-feed-parser`, tip `e4c0d94`; merge to `main` next). Rejected earlier the same day over DEF-006 to DEF-010 (rulings in ADR 0009).

**User story:** As the owner, I want my RSS, Atom and RDF feeds read correctly, with no duplicate articles, so that my reading list is accurate.

**Acceptance criteria**

1. Given the fixture corpus (RSS 2.0, Atom 1.0, RSS 1.0/RDF, CDATA, HTML entities, namespaced `content:encoded`, `media:thumbnail`, `dc:date`), when parsed, then title, link, guid, author, published date, content, summary (≤ 300 chars plain text) and image URL match the expected JSON snapshot per fixture.
2. Given an item without a guid, when its key is computed, then it falls back to canonical link, then to title+date+enclosure (§6.3); the same item parsed twice yields the same `guid_hash`.
3. Given a feed with 200 items, when parsed with `MAX_ITEMS_PER_FETCH = 50`, then exactly the first 50 items in document order are returned and the parser stops consuming input after them. Proven two ways: (a) a fixture whose 51st item onward is malformed garbage still parses successfully with 50 items; (b) a spy shows no parser callbacks after the 50th item closes.
4. Given malformed XML (unclosed tags, stray `&`, wrong encoding declaration), when parsed, then either a best-effort result with ≥ 1 item or a `parse_error`, never an uncaught exception.
5. Given a published date in the future or missing, then `published_at` equals the fetch time; given `javascript:` or `data:` links or image URLs, then they are null.
6. Given an entity-expansion payload (billion laughs) or a 5 MB single attribute, when parsed, then it completes within the caps without expanding custom entities (unit test asserts output size).
7. Given `content_html` over 100 KB, then it is truncated to 100 KB.
8. Given an HTML page with `<link rel="alternate" type="application/rss+xml" href="/feed">`, when discovery runs (HTMLRewriter), then it returns the absolute feed URL; JSON Feed links are returned with `supported: false`.
9. Given an item whose content is 5 MB of text, when parsed, then the text accumulated for that item stops growing at 100 KB (the cap is applied during accumulation, not after; a unit test asserts the accumulator length never exceeds the cap).
10. Given `npm run bench -w @tidings/feed-parser`, when run, then it prints p50/p95 parse time for each `generate-feeds.ts` fixture (`rss-small`, `rss-typical`, `atom-typical`, `rdf-typical`, `rss-large`, `rss-huge`) with the 50-item cap. The output is pasted into the PR. Informational, not a CI gate: Node timings don't predict Workers CPU.
11. Given `packages/feed-parser/package.json`, then its only XML dependency is `htmlparser2` 12.x (no feedsmith, no fast-xml-parser).
12. *(Added 2026-11-17, DEF-006, ADR 0009 §1.)* Given Atom `content`/`summary` with `type="text"` (plain or CDATA) containing `&lt;script&gt;alert(1)&lt;/script&gt;`, then `contentHtml` is `&lt;script&gt;alert(1)&lt;/script&gt;`. Given an untyped one with the same text, then it is escaped too. Given an untyped one containing `&lt;p&gt;Hi &lt;a href="/x"&gt;x&lt;/a&gt;&lt;/p&gt;`, then it is stored as HTML `<p>Hi <a href="/x">x</a></p>`.
13. *(Added 2026-11-17, DEF-007, ADR 0009 §3.)* Given an item containing 300,000 nested unclosed elements (about 900 KB), then parsing finishes in ≤ 50 ms in Node and the open-element depth never exceeds 64 (a spy asserts it). Given that nesting after 2 good items, then the result is those 2 items with `truncated: 'too_deep'`. Given it in the first item, then `parse_error`. A real-world fixture nested 40 deep parses normally.
14. *(Added 2026-11-17, DEF-008, ADR 0009 §4.)* Given an Atom entry with `xml:base="https://b.example.test/dir/"` and `<link href="p1"/>` parsed with `baseUrl: 'https://a.example.test/feed'`, then the link is `https://b.example.test/dir/p1`. Nested `xml:base` on `feed` and `entry` compose, and a non-http(s) result is null.
15. *(Added 2026-11-17, DEF-009, ADR 0009 §5.)* Given `pubDate`s with every zone in ADR 0009's table, then each parses to the correct UTC instant. Given `IST`, an unknown alphabetic zone, or no zone, then the time is read as UTC. The suite passes with `TZ=Pacific/Auckland` and `TZ=UTC`.
16. *(Added 2026-11-17, DEF-010, ADR 0009 §2.)* Given titles `5 &lt; 6 and 7 &gt; 3`, `I &lt;3 RSS feeds`, `<![CDATA[Vec<T> in Rust]]>` and `&lt;b&gt;Bold&lt;/b&gt; title`, then the titles are `5 < 6 and 7 > 3`, `I <3 RSS feeds`, `Vec<T> in Rust` and `Bold title`. The `rss2-cdata-entities` snapshot is regenerated to keep `<angle>`. The dedup fallback key uses the corrected title.
17. *(Added 2026-11-17, ADR 0009 §6.)* Given an item with `itunes:image href` and no media/enclosure image, then `imageUrl` is that URL. Given a source containing U+0000 or a lone surrogate in any field, then the stored string has no U+0000 and is well-formed UTF-16. Given the Worker and the parser, then both import the canonicaliser and `guidHash` from `@tidings/shared`, with no second copy (a unit test or lint rule).

**Engineer's choices ruled (2026-11-17, ADR 0009 §6):** content cap = 102,400 UTF-16 code units (confirmed; spec §6.5 and §9.6 updated); unprefixed Atom namespace only (accepted for MVP); relative links resolve only with `baseUrl` (accepted; TID-012 AC14 always passes it); channel fields after item 50 aren't read (accepted); `itunes:image` added (AC17); NUL and lone surrogates cleaned (AC17); shared-package move confirmed.

**To accept:** AC12-AC17 pass, the five `it.fails` tests flip to passing `it`, DEF-006 to DEF-010 are closed by the tester, and the AC10 bench output is re-pasted (AC13's depth counter must not move the p95).

**Acceptance (2026-11-17): Accepted.** AC1-AC17 pass, with 181 parser tests green. The tester verified and closed DEF-006 to DEF-010 and DEF-011, found during retest: stripping tags in one pass could re-form a tag. The fix strips to a fixed point and ends with a fallback that is provably final. DEF-001 is closed as Won't fix (ADR 0008). The tester recommends acceptance. Parse CPU on real Workers is still gated by TID-012 AC13.

---

### TID-012: Background refresh pipeline

- **Agents:** SE, QA, PM
- **Depends on:** TID-003, TID-010, TID-011
- **Spec:** FR-RF-1 to FR-RF-5, §7.1 to §7.4, ADR 0004
- **Status:** Done (accepted 2026-11-17 on `tid-012-gate-closure`, tip `5f01e52`; merge to `main` next). AC13 moved to TID-039 (ADR 0013).

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
10. Given a callee that rejects, when the dispatcher's `allSettled` sees the rejection, then it records `last_error_code = 'cpu_limit'` if the message is `Worker exceeded CPU time limit.` (the message observed in TID-003) and `'internal'` otherwise, increments `error_count` and applies backoff (one test per case).
11. Given a feed with no subscriptions, then it is never leased (parked at `next_fetch_at = 253402300799`).
12. Given `npm run dev`, when I call `/cdn-cgi/local/scheduled?cron=*+*+*+*+*`, then the dispatcher runs against the fixture server *(manual check documented in README)*.
13. *(Moved to TID-039 on 2026-11-17, ADR 0013. Kept here for reference.)* **Deployed CPU gate (ADR 0006, spec §9.7).** Given a time-boxed benchmark deployment of this branch on the Workers Free plan (a separate throwaway Worker name, fixtures from `generate-feeds.ts` served over HTTPS from a separate throwaway origin, both deleted afterwards), when the real `FeedRefresher.refresh` runs ≥ 200 times per fixture with new-item content every time, then CPU read from Cloudflare GraphQL Analytics (never `performance.now()`) shows:
    - for `rss-small`, `rss-typical`, `atom-typical` and `rdf-typical`: **zero `exceededCpu`** and **p95 ≤ 8 ms** for the whole invocation;
    - for unchanged bodies (hash match) and for `rss-large`/`rss-huge` (rejected as `too_large` at 1 MiB): zero `exceededCpu` and p95 ≤ 2 ms;
    - recorded but not gated: p50, p99, p99.9, cold first refresh, and the body-read + SHA-256 cost at a 1 MiB body and at a 2 MiB body (with the cap temporarily raised in the benchmark only).
    The results table goes in ADR 0006 under "Results (TID-012)". If the gate fails, the engineer stops and the PM applies ADR 0006's ladder. *(manual deployment, PM reviews the table)*

14. *(Added 2026-11-17, ADR 0009.)* Given a feed fetched through one or more redirects, then the parser is called with `baseUrl` = the final URL, and relative item links resolve against it (integration test with a redirecting fixture). A parse result with `truncated: 'too_deep'` is stored as normal and logs one structured warning.
15. *(Added 2026-11-17, §10.6 rule 8.)* Given an origin whose error responses carry a distinctive body, headers, `statusText` and a redirect `Location`, and a fetch that throws with a distinctive message, then none of those strings appears in `feeds` columns other than `last_status`, nor in any API response. `last_error_code` is from the fixed set and `errorMessage` comes from the fixed table (test greps the responses for the markers).
16. *(Added 2026-11-17.)* Given `ALLOW_FETCH_HOSTS` set with a non-localhost `APP_ORIGIN`, when the `FeedRefresher` entrypoint is invoked directly, then it makes no fetch and logs the configuration error.

**Out of scope:** adaptive intervals (M2), first-fetch-for-user behaviour (TID-013), raising `MAX_BODY_BYTES` (PM decision after AC13).

**Acceptance (2026-11-17): Accepted without AC13.** AC1-AC12 and AC14-AC16 pass. DEF-014, DEF-016 and DEF-017 are fixed and closed by the tester, and the benchmark gate can no longer pass vacuously. Rulings are in ADR 0013:
- **AC13** (deployed CPU gate) moves to **TID-039**, Blocked on the user's approval (Q12), and must be Done before TID-024. TID-039 also takes the DEF-016 S4 residuals. 3 new items per `changed` call is accepted for the gate, plus one recorded all-new run. Runner warnings give NEEDS PM, not FAIL (confirmed).
- **DEF-013 (GUID churn):** new story **TID-046**: a secondary dedup key checked against the previous fetch, plus a cap of 200 new entries per feed per UTC day, with no new reads or rows written.
- **DEF-015 (import cost):** §9.8 corrected to about 209 rows per imported feed (≈ 52,250 for 250). TID-016 caps import first fetches at 250 per UTC day (AC3 and AC8 changed, AC9 added).
- **Dead feeds:** 20 consecutive failures only, about 15 days. FR-RF-3 and §7.4 amended; no `failing_since` column.
- **Reads:** about 121 per changed fetch. §9.5 is now 20% (A) and 40% (B).
- **`http_304` message:** the code is confirmed. UX rewords it and reviews the whole draft table in `packages/shared/src/feed-errors.ts` in TID-015 AC6.
- **Resubscribing** to a parked, dead or gone feed resets it (TID-013 AC12; the `it.todo` becomes a test).
- **Concurrent-vitest 409s:** TID-038.

**Engineer's notes (2026-11-17)**

- Code: `apps/worker/src/refresh/` (`backoff.ts`, `store.ts`, `refresh-feed.ts`, `dispatcher.ts`, `entrypoint.ts`, `scheduled.ts`); the fixed error table is `packages/shared/src/feed-errors.ts` (`feedErrorMessage(code)` is what TID-013 and TID-015 must use). `src/index.ts` only re-exports `FeedRefresher` and calls `handleScheduled`.
- **Measured D1 numbers (local D1 `meta`, tests in `apps/worker/test/refresh-feed.test.ts`):** a 304 or identical body writes 0 rows and reads 1; a changed fetch with 3 new items, 50 parsed keys and 2 subscribers writes 40 (= 3x3 + 3x5x2 + 1, exactly the AC4 bound) and reads 121. The dedup lookup reads about **2 per key** (D1 counts every key of the `IN` list plus every hit: 97 for 50 keys with 47 known), not the "<= 50" in §9.5. That raises refresh reads per changed fetch from about 51 to about 121: baseline A about +126,000 reads/day (total about 19% of the 5 M quota instead of 17%), heavy B about +226,000 (about 40% instead of 35%). Writes match §9.4. PM to update §9.5.
- First fetch: a feed that has never succeeded (`last_success_at IS NULL`) stores all parsed items but links only the newest 10 to its subscribers (FR-SU-3). TID-013 still owns linking for a feed row that already has entries.
- "Failing for 7 days" (FR-RF-3, §7.4) is **not** implemented: no column records when failures began, and `last_success_at` is stale on healthy 304s, so any proxy would mark quiet feeds dead. Only AC8 (20 consecutive failures) is. With the 24 h cap that is about 14 days of failing, not 7. Options for the PM: lower the count to 12 (about 7 days on the backoff schedule) or add a `failing_since` column in a migration.
- Unsubscribed feeds are parked by the refresher itself (the first thing it checks, one row read), so the lease stays a single statement. Deleting subscriptions (TID-014/015) should still park in the same transaction as §7.1 says.
- `enable_ctx_exports` in `wrangler.jsonc` now prints a warning in `wrangler dev` and tests (it became the default on 2025-11-17, before our compatibility date). Left as the spec excerpt has it.

**AC13 runbook (not run: needs the user's approval to deploy and a Cloudflare API token for Analytics)**

What it deploys, all under throwaway names, all deleted afterwards: `tidings-bench-origin` (serves `e2e/fixtures/generate-feeds.ts` over HTTPS), `tidings-bench` (the production `FeedRefresher` as its own Worker; its only extra is a benchmark-only body cap for the 2 MiB case), `tidings-bench-driver` (calls `tidings-bench` through a service binding, 20 sequential calls per request), and a D1 database `tidings-bench`. The real `tidings` Worker and its database are never touched. Files: `apps/worker/bench/` (`*.wrangler.jsonc`, `origin-worker.ts`, `bench-worker.ts`, `driver-worker.ts`, `run-benchmark.ts`, `analyze.ts`). Every analytics row for the script `tidings-bench` is one `refresh()` invocation.

What it measures: 12 scenarios, 200 measured calls each plus one `first` call, after one `cold` call (the first refresh after deploy). `changed:*` (rss-small, rss-typical, atom-typical, rdf-typical): gate: every invocation `success` (any other status fails) and p95 <= 8 ms. `unchanged:*` for the same four, and `too_large:rss-large` and `too_large:rss-huge`: every invocation `success` and p95 <= 2 ms (10 gated scenarios in all, not 8). `info:body-1mib` and `info:body-2mib` (read + SHA-256 only): recorded. p50, p99, p99.9 and cold are in the table, not gated.

Decisions for the PM before running:
1. **New items per `changed` call default to 3** (47 known), AC4's typical case, not "every item new". Reason: D1's 100,000 rows written/day is account-wide. 3 new items cost 25 rows per call, so the whole run writes about 25,000 rows (25% of a day). All-new items (`--new-items 50`) cost about 400 rows per call, so 200 calls of one fixture would use 80% of the day. The parse, hash, dedup-lookup and statement-building work is the same either way except the insert chunking. Say if you want a heavier run, for example `--new-items 50 --only changed:rss-typical --runs 100` on another UTC day.
2. **p95 may not be readable from Analytics.** `workersInvocationsAdaptive` is known to offer p25 to p99.9 but possibly no p95. `analyze.ts` introspects the schema, then uses in order: an exact p95; the share of invocations above the ceiling (needs a `cpuTimeUs_gt` filter, <= 5% means p95 <= ceiling); a p90 check that can only fail the gate, otherwise the row says PROVISIONAL and the PM judges from p90 and p99. I could not check the schema offline.
3. Cost: about 5,000 Worker requests (callee, origin and driver: 5% of a day) and about 25,000 D1 rows written.

Steps (from `apps/worker`; macOS `sed`; Node 22.18+; nothing here reads or prints a credential):

```sh
export WRANGLER_SEND_METRICS=false
BENCH_TOKEN=$(openssl rand -hex 16)            # keep it in this shell only

# 1. Throwaway database; paste its id into both configs (do not commit that edit).
npx wrangler d1 create tidings-bench           # prints database_id
sed -i '' 's/REPLACE_WITH_DATABASE_ID/<database_id>/' bench/bench.wrangler.jsonc bench/driver.wrangler.jsonc
npx wrangler d1 migrations apply tidings-bench --remote --config bench/bench.wrangler.jsonc

# 2. Deploy, in this order. Note the three workers.dev URLs it prints.
npx wrangler deploy --config bench/origin.wrangler.jsonc
npx wrangler deploy --config bench/bench.wrangler.jsonc
npx wrangler deploy --config bench/driver.wrangler.jsonc --var BENCH_TOKEN:$BENCH_TOKEN

# 3. Drive the load (about 10 to 20 minutes). It writes bench/results/run-<time>.json.
cd ../..
node apps/worker/bench/run-benchmark.ts --driver https://tidings-bench-driver.<sub>.workers.dev \
  --origin https://tidings-bench-origin.<sub>.workers.dev --token "$BENCH_TOKEN"
#    It exits 1 and lists WARNINGs if any call did not do what its scenario expects. The warnings
#    and --runs are saved in the run file; analyze.ts will not PASS a run that has warnings.
#    Use the defaults (200 runs, all scenarios) for the gate: --only or --runs below 200 gives
#    a PARTIAL result.

# 4. Wait at least 5 minutes, then read CPU. The token needs only "Account Analytics: Read".
CLOUDFLARE_API_TOKEN=<token> CLOUDFLARE_ACCOUNT_ID=<account id> \
  node apps/worker/bench/analyze.ts apps/worker/bench/results/run-<time>.json
#    Prints the table (with per-status counts) and "Overall: PASS | FAIL | NEEDS PM", or
#    "PARTIAL: not a gate result" when a gated scenario is missing or has under 200 calls (or the
#    recorded --runs, if higher). FAIL = any non-success status or a p95 over the ceiling.
#    NEEDS PM = provisional p95, runner warnings, or Analytics saw under 98% of a window's calls.
#    Writes run-<time>.md beside the JSON.
#    node apps/worker/bench/analyze.ts --introspect shows which quantile fields exist.

# 5. Delete everything.
cd apps/worker
npx wrangler delete --config bench/driver.wrangler.jsonc
npx wrangler delete --config bench/bench.wrangler.jsonc
npx wrangler delete --config bench/origin.wrangler.jsonc
npx wrangler d1 delete tidings-bench
git checkout bench/bench.wrangler.jsonc bench/driver.wrangler.jsonc
```

Then paste the table into ADR 0006 under "Results (TID-012)". If any gated row fails, stop: the PM applies ADR 0006's ladder; do not tune the benchmark.

Known risks: (a) a Worker fetching another workers.dev Worker on the same account can get error 1042, which `tidings-bench` avoids with the `global_fetch_strictly_public` flag; if `run-benchmark.ts` still reports `network_error`, serve the fixtures from any other public HTTPS host instead (the scenario paths are fixed). (b) The first call to `rss-huge` on the origin builds a 3 MB string and may be CPU-killed once; the runner warms every URL first. (c) Analytics lags, and the adaptive dataset may sample at high volume; a window showing fewer than 98% of its calls makes the result NEEDS PM, not PASS.

---

### TID-013: Subscribe to a feed

- **Agents:** UX, SE, QA, PM
- **Depends on:** TID-008, TID-012
- **Spec:** FR-SU-1 to FR-SU-4, FR-SU-7, FR-SU-8, §7.1, §7.5, §8.4, §10.8, ADR 0012, ADR 0013
- **Status:** Done (accepted 2026-11-17, ADR 0015). Rulings: an unreachable or mistyped address becomes a `failing` subscription (AC5 as written); the double origin fetch on subscribe is accepted.
- **Status:** Ready (merge `tid-008-verification` and `tid-012-gate-closure` to `main` first)

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
10. *(Added 2026-11-17, §10.6 rule 8.)* Given a URL whose origin returns an error, a redirect or a non-feed page with distinctive markers in the body, headers and `Location`, then the `POST /api/subscriptions` response (any status) and the UI contain only the error code and the fixed plain-language message, and no marker. The same holds for discovery's `422 no_feed_found`, and for `feed_choice_required` candidates, which show only the URL and title parsed from `<link>` tags.
11. *(Added 2026-11-17, TID-008 AC9, ADR 0012.)* Given the route table in `apps/worker/test/support/route-table.ts`, then each route lists its ID inputs (path params, query params, body fields), and the guard test fails for any route with an ID input but no isolation case. This replaces the `no registered route takes an ID yet` tripwire. Given two users seeded in D1 and user B's session, when B calls `POST /api/subscriptions` with A's `folderId`, then it returns `404 not_found`, creates nothing, and A's folders and subscriptions are unchanged. Given B subscribes to a feed A already has, then B's response and `GET /api/subscriptions` contain only B's subscription, and A's `user_entries` are unchanged.
12. *(Added 2026-11-17, ADR 0013 decision 7, spec §7.1.)* Given an existing feed that is parked (`next_fetch_at = 253402300799`), `dead` or `gone`, when I subscribe to it, then `next_fetch_at` is reset to now (within 60 s of jitter), and a `dead` or `gone` feed returns to `pending` with `error_count = 0` before the first fetch runs. The `it.todo` in `apps/worker/test/refresh-adversarial.test.ts` becomes a passing test.

---

### TID-014: Folders and subscription management

- **Agents:** UX, SE, QA, PM
- **Depends on:** TID-013
- **Spec:** FR-FO-1 to FR-FO-5, FR-SU-5, FR-SU-6, §8.4
- **Status:** Done (accepted 2026-11-17, ADR 0015). AC9 met by the end-of-MVP UX review (`docs/ux/reviews/mvp-review.md`). DEF-040 won't fix (ASCII-only case folding; AC2 reads as ASCII case).

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
5. *(Added 2026-11-17, §10.6 rule 8, FR-FH-1.)* Given each `last_error_code`, then Manage and the `refresh` response show only the message from the fixed table (HTTP errors as "The server returned {status} {reason}" with the reason from our own table, never upstream `statusText`). A test asserts that every code in the set has a message and that unknown codes fall back to "Something went wrong fetching this feed".
6. *(Added 2026-11-17, ADR 0013 decision 6.)* Given the engineer's draft table in `packages/shared/src/feed-errors.ts`, then UX reviews every message, including `http_304` (today "The server returned 304 Not Modified", which reads like success) and the `new_item_cap` warning from TID-046, and the shipped table matches the UX copy doc exactly (a unit test compares them). `feedErrorMessage` returns the fallback message, not null, for an unknown code.
7. *(Added 2026-11-17, ADR 0015, MVP UX review item 6.)* Given feeds in `failing`, `dead` or `gone` and others `ok` or `pending`, when I open `/manage`, then the problem feeds are listed first (alphabetical within each group), and the Import screen's "See which" link lands on that list.

---

### TID-016: Import subscriptions from OPML

- **Agents:** UX, SE, QA, PM
- **Depends on:** TID-014
- **Spec:** FR-OP-1 to FR-OP-4, §8.7
- **Status:** Done (accepted 2026-11-17, ADR 0015). The preview counts only what the server will save. Carried over: folders refused by the 200-folder limit are reported in TID-050 (R2).

**User story:** As someone leaving Inoreader, I want to import my OPML export with folders intact, so that I can switch in one sitting.

**Acceptance criteria**

1. Given the 250-feed Inoreader fixture, when I pick it on `/manage/import`, then the preview shows feed and folder counts, how many are already subscribed, how many are invalid, and how many feeds appeared in more than one folder, before anything is sent.
2. Given I confirm, then the SPA sends ≤ 100 feeds per `POST /api/import/opml` and, when done, all valid feeds are subscribed in folders matching the top-level OPML folders (nested folders flattened; first folder wins for duplicates).
3. Given the import completes, then no feed was fetched during the import requests (integration test: injected `fetch` not called) and every new feed has `next_fetch_at` within the next `ceil(n / 20)` minutes, except feeds deferred by AC9.
4. Given import progress, then the screen shows "Fetched X of N feeds" updating every 5 s until all new feeds have left `pending` (or the user navigates away).
5. Given I import the same file again, then `created = 0`, no folders are duplicated, and `existing` equals the number of feeds.
6. Given an OPML file with an invalid URL and a private-address URL, then they're reported as `invalid_url` and `blocked_address` and the rest import.
7. Given a malformed (non-XML) file, then the UI shows an error and sends nothing.
8. *(Corrected 2026-11-17, DEF-015, ADR 0013.)* Given the import's write cost, then a 250-feed import (every fixture feed serving 50 items) followed by first fetches writes ≤ 55,000 rows in total (53,000 before the TID-021 `ue_entry` index), about 220 per feed (integration test with fixtures summing `rows_written`; the test prints the actual total).
9. *(Added 2026-11-17, ADR 0013 decision 5.)* Given 250 new feeds already have a first fetch scheduled from imports in the current UTC day, when another import creates more new feeds, then those are scheduled from 00:05 UTC the next day (staggered at 20 a minute), the response's `deferred` counts them (spec §8.7), and the import screen says how many feeds will start fetching tomorrow (UX copy). Given a 300-feed import, then 250 are scheduled today and `deferred = 50`.

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
- **Status:** Done with conditions (accepted 2026-11-17, ADR 0015). AC5's folder-view bullet is not met (DEF-050, open); it moves to TID-049 (R2). Every other AC passes.

**User story:** As the owner, I want to browse all my articles, a folder or a single feed, newest first with unread counts, so that I can catch up quickly on my phone.

**Acceptance criteria**

1. Given seeded data, when I open `/all`, `/folders/:id` and `/feeds/:id`, then each shows the matching articles newest first, 50 per page, with feed title, title, relative time, summary and thumbnail when present. While the folder or feed name is loading, the header shows a skeleton bar, never the word "Folder" or "Feed".
2. Given "Unread only", then only unread articles appear; toggling to "All articles" shows read ones too, and the toggle's default comes from my settings.
3. Given I scroll to the end of a page, then the next page loads via `nextCursor`; given 3 new entries are inserted between page 1 and page 2, then page 2 contains no duplicates and skips nothing (integration test).
4. Given `GET /api/counts`, then totals per subscription, per folder (sum of its subscriptions) and overall match the number of unread `user_entries` (integration test), and `rows_read` ≤ unread rows + subscriptions + 10.
5. Given the list queries with `limit=50` (NFR-7, ADR 0008):
    - "All" and "Feed" views, unread and all: page 1 `rows_read` ≤ 102; continuation pages ≤ 102 + T (T = rows in the view sharing the cursor's `published_at`), including a seeded case where 60 entries share one `published_at` and the cursor lands inside that group;
    - folder view: `rows_read` ≤ M + 51 + S + 10 (M = matching rows in the folder at or below the cursor, S = subscriptions in the folder), for both unread and all states.
6. Given the drawer, then it shows All, folders (expandable) and unfiled feeds with unread counts, and zero-count items are dimmed.
7. Given a view with no subscriptions / no unread / a never-fetched feed / a failing feed, then the matching empty state from UX is shown.
8. Given `?view=feed&id=<another user's subscription>`, then `404 not_found`.
9. Given pull-to-refresh on a list, then the list and counts are refetched from the API and no feed fetch is triggered.
10. Given 375 × 812 in both themes, the lists match the UX spec and pass axe *(E2E + UX review)*.
11. Given I last viewed `/folders/:id` on this device, when I open `/`, then I'm redirected to that folder; given nothing is stored, the stored value is malformed, or that folder or feed no longer exists, then I'm redirected to `/all` (spec §11.1).
12. Given the app is online per `navigator.onLine`, when an API request fails with no response (network error), then the offline banner appears within 1 s; when the next API request succeeds or the `online` event fires, then it disappears (spec FR-PW-3; E2E with request interception).
13. Given unread-only mode, when I open an unread article and come back with Back, then its row is still in the list, shown as read; it disappears only after I leave the list and return, or pull to refresh (FR-RD-4).
14. *(Added 2026-11-17, §10.5, ADR 0009.)* Given an entry whose title is `Vec<T> & <b>x</b>` and whose summary is `<script>alert(1)</script><img src=x onerror=alert(2)>` (as stored text), when the list renders, then both show those exact characters as text, no element is created from them, and no dialog fires (E2E).

---

### TID-019: Article view and read state

- **Agents:** UX, SE, QA, PM
- **Depends on:** TID-018
- **Spec:** FR-RD-7, FR-RD-8, §10.5, NFR-5
- **Status:** Done (accepted 2026-11-17, ADR 0015). Next and Previous are disabled on a direct link (no list context; AC7 needs a list view). Carried over: Mark read or unread on list rows (FR-RD-8) is TID-048 (R2).

**User story:** As the owner, I want to read an article comfortably and have it marked as read, so that my unread list reflects what I've actually seen.

**Acceptance criteria**

1. Given I tap a list item, then the article view shows title, feed, author, date and the sanitised content, with "Open original" opening the entry URL in a new tab with `rel="noopener noreferrer"`.
2. Given "Mark as read when opened" is on, when I open an unread article, then it shows as read in the list and the counts drop by one within 100 ms (optimistic), and `PATCH /api/entries/:id {isRead:true}` is sent.
3. Given the API returns an error for that PATCH, then the UI rolls back the read state and counts and shows a toast.
4. Given I tap "Mark as unread", then it becomes unread again (list and counts).
5. Given the XSS payload corpus as `content_html` (script tags, `onerror`, `javascript:` links, `<iframe>`, `<svg onload>`, `<style>`, `<form>`, `srcdoc`, `<base>`, `<meta http-equiv>`), when rendered, then no script executes (E2E listens for dialogs/console errors and checks a global canary), forbidden elements are absent from the DOM, and iframes are replaced with an "Open embedded content" link.
6. Given content with relative links and images, then they're resolved against the entry URL; every image has `loading="lazy"` and `referrerpolicy="no-referrer"` and never overflows the viewport at 375 px.
7. Given I'm in a list view, when I tap "Next"/"Previous" in the article, then I move through that list's order (loading the next page if needed) using history `replace`; "Back" returns to the list at the same scroll position, after any number of Next/Previous taps (spec §11.1).
8. Given `dangerouslySetInnerHTML` appears anywhere except `ArticleContent`, then lint fails (from TID-001; regression check).
9. Given `GET /api/entries/:id` for another user's entry, then `404`.
10. Given `POST /api/entries/read-state` with 1,001 IDs, then `400 validation_failed`; with IDs including another user's, then only mine change.
11. *(Added 2026-11-17, §10.5.)* Given an entry whose title, author and summary contain literal `<script>` and `<img onerror>` text, when the article view renders, then they appear as text in the header and meta, and only `contentHtml` goes through `ArticleContent` (E2E with a dialog listener).

---

### TID-020: Mark all as read

- **Agents:** UX, SE, QA, PM
- **Depends on:** TID-018
- **Spec:** FR-RD-9, §8.5
- **Status:** Done (accepted 2026-11-17, ADR 0015). The confirm count is the view's cached unread count (approximate); the toast states the exact number. Carried over: backdated arrivals after `asOf` are TID-051 (R3).

**User story:** As the owner, I want to mark everything in a view as read in one tap, so that I can clear out a busy folder.

**Acceptance criteria**

1. Given a view loaded at `asOf = T`, when I mark all as read, then every unread entry in that view with `published_at ≤ T` becomes read, and entries in other views are unaffected.
2. Given an entry arrives in the view after `T`, then it stays unread.
3. Given more than 20 entries would be affected, then a confirm dialog states the number first; with 20 or fewer, no dialog.
4. Given ≤ 1,000 entries were affected, then an "Undo" toast appears for 5 s and undo restores exactly those entries to unread; with more than 1,000, no undo is offered.
5. Given a folder view, then only entries from subscriptions in that folder are affected.
6. Given 2,000 unread entries, when marked, then the request completes in one call and `rows_written` ≤ 2,000 × 3 (integration test).
7. *(Added 2026-11-17, from TID-006.)* Given I tap Undo and the undo request fails, then the toast reads exactly "Couldn't undo. Your change was kept.", the entries stay read, and the counts match the server (E2E with request interception).

---

### TID-021: Retention and maintenance job

- **Agents:** SE, QA, PM
- **Depends on:** TID-012
- **Spec:** FR-RF-6, §6.3 tombstones, §7.6
- **Status:** Ready (merge `tid-012-gate-closure` to `main` first)

**User story:** As the owner, I want old articles cleaned up automatically, so that the database stays within the free storage limit without me doing anything.

**Acceptance criteria**

1. Given read, unstarred `user_entries` older than 30 days and unread ones older than 90 days, when the hourly job runs (fixed clock), then they're deleted; newer ones and starred ones are kept.
2. Given an entry older than 30 days with no remaining `user_entries`, then its `content_html` and `summary` become NULL and `purged_at` is set; the row remains.
3. Given a purged entry still present in the feed XML, when the feed is refreshed, then it is not re-inserted and no new `user_entries` appear.
4. Given tombstones older than 180 days, then they're deleted.
5. Given 5,000 rows eligible, when the job runs once, then it deletes at most 500 per statement and 10 statements per run, and the remainder is handled on later runs.
6. Given expired sessions, expired `webauthn_challenges` of every purpose (including orphaned setup and login challenges that were never verified) and stale rate-limit windows, then they're deleted, and unexpired ones are kept (fixed clock, one test per table) (ADR 0011).
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
2. Given I change "Unread only by default", "Mark as read when opened" or text size, then the change persists across reloads and takes effect in lists and the article view. Text size is mirrored to `localStorage['tidings.textSize']` and `<html data-text-size>` is correct before first paint on reload (E2E checks the attribute at `DOMContentLoaded`).
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

**Scope note (2026-11-16):** UX designs the app icon set and the wordmark treatment in `docs/ux/` before SE builds: 192 and 512 px, a maskable 512 px with safe zone, 180 px `apple-touch-icon`, an SVG favicon, all legible on light and dark home screens.

**User story:** As the owner, I want the app to open instantly from my home screen showing what I last saw, so that it feels like a native reader.

**Acceptance criteria**

1. Given I've used the app, when I reload with the network throttled to Slow 4G and 4× CPU slowdown, then the last view's list renders from IndexedDB within 1.0 s of navigation start (median of 5, NFR-1), then revalidates.
2. Given the network is offline, when I launch the app, then the shell and cached lists, counts and up to 50 recently opened articles render, an "Offline" indicator shows, and a mutation shows an error toast.
3. Given a new app version is deployed, then the persisted cache is discarded (buster = app version) and the service worker updates on next launch.
4. Given the manifest, then Lighthouse's installability check passes and icons from UX exist for 192 and 512 px, a maskable icon, a 180 px `apple-touch-icon` and an SVG favicon. The manifest's single `theme_color`/`background_color` use the light surface values, and the `<meta name="theme-color">` matches the resolved theme (light and dark E2E). Known limitation, accepted 2026-11-16: an Android dark-mode launch splash may briefly show light.
5. Given the production build, then initial JS ≤ 170 KB gzipped and CSS ≤ 30 KB gzipped (CI size check, NFR-3).
6. Given an iPhone with iOS 17+, when I "Add to Home Screen" and open it, then it launches standalone and I stay signed in *(manual, PM sign-off)*.
7. *(Added 2026-11-17, ADR 0010.)* Given a persisted cache written for user A, when user B signs in on the same browser, then A's cache is discarded before anything paints and no A data is visible at any point (E2E with two seeded users). Given a `401`, then the cache is kept. Given an explicit Sign out, then it is cleared.

---

### TID-024: Production deployment, runbook and budget check

- **Agents:** SE, QA, PM
- **Depends on:** all other MVP stories. TID-039 is no longer a gate (ADR 0014).
- **MVP scope (ADR 0014):** AC1, AC2, AC5 and AC8 only. AC3, AC4, AC6 and AC7 move to TID-047 (post-launch check, R2).
- **Spec:** §9, §14.3, §10.1 break-glass, Q2
- **Status:** Ready. Every other MVP story is Done (ADR 0015). Needs the owner's approval and Cloudflare setup before any deploy.

**User story:** As the owner, I want Tidings deployed on my Cloudflare account with automatic deploys and a runbook, so that I can rely on it daily and fix it if something goes wrong.

**Acceptance criteria**

1. Given a push to `main` with CI green, then the workflow applies remote D1 migrations and deploys the Worker; a failed migration stops the deploy.
2. Given the README, then it documents: first-time setup (create D1, set `SETUP_TOKEN`, choose the hostname per Q2, custom domain route), local dev, where to see Workers/D1 usage, the break-glass passkey recovery procedure, and how to roll back a deploy.
3. Given production with the owner's real OPML imported, after 48 hours, then the PM records actual daily requests, D1 rows read/written, storage, refresh CPU p95/p99 and `exceededCpu` counts in spec §9 ("Measured" column) and they're within 70% of each free limit *(manual, PM)*.
4. Given production, then `exceededCpu` outcomes are < 1% of refresh invocations, and any feed affected shows `cpu_limit` or `too_large` in Manage *(manual check of logs)*.
5. Given the production origin, then the response headers match spec §10.4 including HSTS (custom domain) *(automated header check script run against production)*.
6. Given 10 cold sign-ins in production (each after a deploy or idle period), then auth-route CPU is recorded; if any shows `exceededCpu`, or 2 or more exceed 10 ms, a follow-up story moves WebAuthn verification behind `ctx.exports` (ADR 0002) *(manual, PM)*.
7. *(Added 2026-11-17.)* Given a deployed fixture served with `Content-Encoding: gzip` that is 200 KB compressed and 1.5 MiB decoded, then the refresh records `too_large`; given one that is 900 KB decoded, then it parses. This confirms the cap applies to decoded bytes in real workerd (spec §7.3 step 4) *(manual check, results in ADR 0006)*.
8. *(Added 2026-11-17, ADR 0011.)* Given the README runbook, then it explains how to clear setup and recover lockouts (the `wrangler d1 execute` command that deletes the relevant `rate_limits` rows) and warns that this resets the protection *(PM review)*.

**Notes**
- Cloudflare's per-account `workers.dev` TLS certificate can take about 10 minutes to provision after the first deploy. Allow for it before the first smoke check, and don't treat early TLS errors as a failed deploy.
- The TID-003 spike Worker `tidings-spike-fanout` was deleted on 2026-11-16 after AC3 was read. Check the account's Workers list holds no `tidings-spike-*` scripts before the production deploy.

**MVP exit criteria:** every MVP story Done; full suite green; one UX review of all MVP screens at 375 px in both themes; the owner can sign in, import their OPML and read on their phone. Budget measurement and "cancel Inoreader" confirmation move to R2 (TID-047).

---

### TID-036: SSRF guard hardening (TID-010 follow-up)

- **Agents:** SE, QA, PM
- **Depends on:** TID-010
- **Status:** Ready (small; can run in parallel with TID-011 fixes)
- **Spec:** §10.6 rules 3 and the `ALLOW_FETCH_HOSTS` paragraph

**User story:** As the owner, I want the fetcher to refuse every reserved or non-public destination, not just the common ones, so that misconfiguration or odd DNS can't turn it into a probe.

**Acceptance criteria**

1. Given hosts `printer.lan`, `nas.localdomain`, `wiki.corp`, `hr.intranet`, `a.test`, `a.invalid`, `a.example`, `router.home` and `x.private` (any case, with or without a trailing dot), when `safeFetch` is called, then `blocked_address` without calling `fetch`.
2. Given IPv6 literals in `2001::/23` (for example `[2001:2::1]`, `[2001:20::1]`, `[2001:1ff::1]`) and `3fff::/20` (`[3fff::1]`, `[3fff:fff::1]`), then `blocked_address`; `[2001:4860:4860::8888]` is allowed. A table-driven test lists every range from the IANA IPv4 and IPv6 Special-Purpose Address Registries that isn't globally reachable (checked against iana.org on the build date, which is recorded in the test file), with one address inside and one just outside each range.
3. Given `ALLOW_FETCH_HOSTS` is present but empty or whitespace and `APP_ORIGIN` isn't local, then the guard refuses with `500 config_error` (it is no longer treated as unset).
4. Given `APP_ORIGIN` values `http://localhost:8787/x`, `http://localhost:8787/?a`, `http://localhost:8787/#f` and `https://localhost:8787`, then `isLocalDevOrigin` is false. `http://localhost:8787` and `http://localhost:8787/` are true.

**Out of scope:** DNS resolution checks (residual risk R5).

---

### TID-037: Design-token drift and contrast check in CI (TID-006 follow-up)

- **Agents:** SE, UX, PM
- **Depends on:** TID-006
- **Status:** Ready (small)

**User story:** As the owner, I want contrast to stay readable in both themes as the design evolves, so that night reading never regresses.

**Acceptance criteria**

1. Given the shipped token CSS in `apps/web`, when `npm test` runs, then a test asserts that every `--c-*` token in both themes equals the value documented in `docs/ux/DESIGN_SYSTEM.md`, and fails with the token name on any mismatch.
2. Given the same run, then the pair list from `docs/ux/check-contrast.mjs` is evaluated against the **shipped** CSS values and every pair meets its WCAG 2.2 AA threshold (4.5:1 body, 3:1 large text and UI).
3. Given a deliberately lowered token in a test fixture, then both checks fail (mutation check, recorded in the PR).

---

### TID-038: E2E harness stability: host sleep and shared local state (time-box: 1 day)

- **Agents:** QA (owner), SE if a config change touches app code, PM
- **Depends on:** TID-005
- **Status:** Ready (small, tester; rewritten 2026-11-17 from DEF-019, ADR 0012; DEF-090 added by ADR 0015)

**User story:** As the team, I want the E2E suite to finish quickly and fail only on real defects, so that its results can be trusted at acceptance time.

**Context:** The "Playwright stalls" were the Mac going to sleep mid-run (DEF-019). Each stall matched a `pmset -g log` sleep to the second, every process was idle and healthy during it, and the test in flight failed because the wall clock jumped past its timeout. The same tests passed 16 of 16 under `caffeinate -ims`. Separately, the TID-007 setup tests intermittently get `409` instead of `201` when several vitest processes run at once, which points to local state (D1 or `.wrangler` persistence) shared between processes.

**Acceptance criteria**

1. Given macOS, when I run `npm run test:e2e:full`, then the full E2E suite runs under `caffeinate -ims` (on other platforms the script runs the suite directly), and `docs/testing/TEST_STRATEGY.md` says to use it for every full local run.
2. Given a run in which the time between two consecutive test events exceeds the per-test timeout by more than 30 s, then the run summary prints a "host slept or stalled: N s gap before <test>" note naming the test. A unit test of the detector feeds it synthetic timestamps; a deliberate `sleep`-style gap proves it end to end once, then is removed or skipped with a reason.
3. Given `e2e/playwright.config.ts`, then it sets an explicit global timeout, per-test timeout, action and navigation timeouts, and a browser launch timeout, and a test that fails from a fixture or teardown error doesn't stop the remaining tests (shown once with a deliberate failure, then removed or skipped with a reason).
4. Given 3 vitest processes for `@tidings/worker` started at the same time, then all pass with no `409` in the setup tests, or the tester documents the shared state that causes it and the SE isolates it (for example, a per-process persistence directory or database name). Proven by a script that runs 3 in parallel 5 times.
5. Given 3 consecutive full E2E runs via `npm run test:e2e:full` on an unattended machine, then the tester records pass counts, wall time and any gap notes in `TEST_STRATEGY.md`. The target is zero failures not caused by a product defect.
6. Given CI, then E2E retries stay at the current setting or lower, so flakiness isn't hidden, and any retry that passes is reported as flaky in the run summary.

7. *(Added 2026-11-17, ADR 0015.)* Given DEF-090 (the toast-offset test at 200% text and the offline-banner check in the shell console test, each failing about once per full run under load), then each is fixed by waiting on the app state it checks (the bottom-bar observer has settled; the app has seen the `offline` event), not by a longer timeout, and the 3 runs in AC5 show neither failing.

**Out of scope:** per-worker databases for parallel E2E (a later story if run time demands it); retrying tests locally after a clock jump (the gap note is enough).

---

### TID-047: Post-launch budget and CPU check

- **Agents:** PM (owner), QA
- **Depends on:** TID-024
- **Release:** R2
- **Status:** Blocked

**User story:** As the owner, I want to confirm that real use fits the free tier, so that I can cancel Inoreader with confidence.

**Acceptance criteria:** TID-024 AC3, AC4, AC6 and AC7 as written, run against production after 48 hours of real use with the owner's OPML imported. If `exceededCpu` is 1% of refresh invocations or more, or any budget is above 70% of its free limit, the PM schedules TID-039 or applies ADR 0006's ladder before R3.

---

### TID-048: Mark read or unread from a list row (FR-RD-8)

- **Agents:** UX, SE, QA
- **Depends on:** TID-019
- **Release:** R2
- **Spec:** FR-RD-8, §8.5 (`PATCH /api/entries/:id`)
- **Status:** Ready (carried over from TID-019, ADR 0015)

**User story:** As the owner, I want to mark an article read or unread from the list without opening it, so that I can skip or keep articles quickly, as I do in Inoreader.

**Acceptance criteria**

1. Given a list row, then it offers "Mark as read" (unread row) or "Mark as unread" (read row) through a control that UX specifies, at least 44 x 44 px at 375 px, with an accessible name that includes the article title.
2. Given I use it, then the row's read styling and the counts change within 100 ms (optimistic) and one `PATCH /api/entries/:id` is sent; on an API error both roll back and a toast shows (same copy as TID-019 AC3).
3. Given unread-only mode, when I mark a row read, then it stays in the list, shown as read, until I leave and return or pull to refresh (same rule as TID-018 AC13).
4. Given 375 px in both themes and 200% text, then the row layout has no horizontal overflow and axe is clean *(E2E + UX review)*.

**Out of scope:** swipe gestures (M2, TID-027 family); multi-select.

---

### TID-049: Folder view read cost (DEF-050)

- **Agents:** SE, QA
- **Depends on:** TID-018
- **Release:** R2
- **Spec:** NFR-7, §8.5, ADR 0008
- **Status:** Built (owner approved option a). Bound restated as M + 3 × (limit + 1) + S + 20 (the +10 left 4 rows short on two seed cases), see ADR 0008 amendment. Awaiting QA.

**User story:** As the owner, I want folder views to cost a predictable number of D1 reads, so that the read budget stays safe as my folders grow.

**Acceptance criteria**

1. Given the folder view query, then it selects the page's keys from `ue_unread_feed` / `ue_feed` for the folder's feeds first, then joins `user_entries` and `entries` for those keys only. No migration.
2. Given the seeded folders in DEF-050 (unread and all, page 1 and a continuation page), then `rows_read` ≤ M + 3 × (limit + 1) + S + 10 (+ T on continuation pages; the tester's proposed restatement of M + 2 × (limit + 1) + S + 10 + 51), and is lower than today's 303 for the sparse seed-folder-3. The DEF-050 `it.fails` becomes a passing test against the restated bound.
3. Given the TID-018 AC3 duplicate-and-skip test and the AC5 tie test with 60 rows sharing one `published_at`, then both still pass for the folder view.
4. Given the change, then NFR-7 in the spec and ADR 0008 state the new folder bound, and the integration test prints the measured `rows_read` for each seeded case.

**Out of scope:** the denormalised folder index (ADR 0008 option 1); it needs a migration and extra writes.

---

### TID-050: Tell me which OPML folders weren't created

- **Agents:** UX, SE, QA
- **Depends on:** TID-016
- **Release:** R2
- **Spec:** §8.7, FR-OP-2
- **Status:** Ready (carried over from TID-016, ADR 0015)

**User story:** As someone importing a large OPML file, I want to know when a folder couldn't be created, so that I'm not surprised to find its feeds unfiled.

**Acceptance criteria**

1. Given I have 199 folders and import a file with 3 new folders, then 1 folder is created, the feeds in the other 2 are subscribed with no folder, and the `POST /api/import/opml` response lists the 2 folder names in a new `unfiledFolders: string[]` field (spec §8.7 updated).
2. Given that response, then the import result screen says how many folders couldn't be created and that their feeds are unfiled, with UX copy, and names up to 5 of them.
3. Given an import under the limit, then `unfiledFolders` is an empty array and no message shows.

---

### TID-051: Mark all as read skips late arrivals with old dates

- **Agents:** SE, QA
- **Depends on:** TID-020
- **Release:** R3
- **Spec:** FR-RD-9, §8.5
- **Status:** Ready (carried over from TID-020, ADR 0015)

**User story:** As the owner, I want articles that arrive after I loaded a list to stay unread when I mark all as read, even if the publisher backdated them, so that I never lose an article I haven't seen.

**Acceptance criteria**

1. Given a list loaded at `asOf = T`, when an entry with `published_at` before T is linked to me after T, and I then mark all as read, then that entry stays unread. Everything TID-020 AC1 to AC7 covers still passes.
2. Given the fix, then `rows_written` per refresh is unchanged from TID-046 AC4's measurements, and mark-all-read's `rows_written` stays ≤ 3 per affected entry.
3. Given the implementation, then the engineer records the choice in an ADR: an entry-ID watermark (no migration; only if `entries.id` is proven never to reuse a value at or below the watermark, for example via `AUTOINCREMENT`) or an `added_at` column on `user_entries` (a numbered migration, no new index unless the query plan needs one).

**Out of scope:** the 10 existing entries linked when subscribing to a feed another user already has (TID-013 AC4) count as arrivals only if the chosen watermark naturally covers them.

---

### TID-052: Focus the screen title on first load of a deep link

- **Agents:** SE, UX
- **Depends on:** TID-016
- **Release:** R3
- **Status:** Ready (MVP UX review item 7, ADR 0015)

**User story:** As a keyboard or screen-reader user, I want a page I open directly to start at its title, so that I hear where I am first.

**Acceptance criteria**

1. Given I load `/manage/import` or `/manage/add` directly, then focus is on the shell `h1`, not the in-page `h2`, and no focus ring shows for a pointer load.
2. Given I move between import steps, then focus still moves to the step heading as now (unit test for both cases).

---

### TID-039: Deployed CPU gate (TID-012 AC13)

- **Agents:** SE (runs it), QA (checks the analysis), PM (reads the table)
- **Depends on:** TID-012
- **Status:** Blocked until the user approves the throwaway deployment and provides an Analytics token (spec Q12). Must be Done before TID-024.
- **Spec:** §7.3 CPU budget, §9.7, ADR 0006, ADR 0013; runbook in TID-012's engineer's notes (on `tid-012-gate-closure`)

**User story:** As the owner, I want proof on the real Free plan that refreshing a typical feed stays within its CPU limit, so that I don't deploy a reader that silently drops feeds.

**Acceptance criteria**

1. *(Before the run, DEF-016 residuals.)* Given a run file, then `analyze.ts` takes each scenario's ceiling from the current plan by scenario ID, not from the run file (a run file with a looser ceiling still fails against the plan's); a run file without `runs` and `warnings` fields is refused; and a measured window where Analytics saw more than 102% of the calls made gives NEEDS PM. Each has a unit test in `bench-gate.test.ts`.
2. Given the benchmark deployment described in TID-012 AC13 (throwaway Worker names, fixtures served from a throwaway origin, 3 new items per `changed` call, ≥ 200 calls per scenario), when `analyze.ts` runs, then it prints "Overall: PASS": for `rss-small`, `rss-typical`, `atom-typical` and `rdf-typical` every invocation `success` and p95 ≤ 8 ms; for the four unchanged and two `too_large` scenarios every invocation `success` and p95 ≤ 2 ms. NEEDS PM goes to the PM for a ruling; FAIL stops the story and the PM applies ADR 0006's ladder *(manual deployment, PM reviews)*.
3. Given one extra run of `--new-items 50 --only changed:rss-typical --runs 50` (on a different UTC day from AC2's run if together they would exceed 50,000 rows written), then its p50, p95, p99 and status counts are recorded. Any non-success invocation goes to the PM *(manual)*.
4. Given the runs are finished, then the results table (both runs, plus the recorded p50, p99, p99.9, cold and 1 MiB and 2 MiB body-read figures) is in ADR 0006 under "Results (TID-012)", and the account's Workers and D1 lists show no `tidings-bench*` resources *(PM checks)*.

**Out of scope:** raising `MAX_BODY_BYTES` (a PM decision after the results).

---

### TID-046: GUID churn guard and per-feed daily cap (DEF-013)

- **Agents:** SE, QA, PM (UX copy for the warning lands in TID-015 AC6)
- **Depends on:** TID-012
- **Status:** Done (accepted 2026-11-17, ADR 0015). DEF-020 fixed: the first unchanged refresh of a new UTC day clears the warning.
- **Spec:** §6.3 "GUID churn guard", §6.5 planned migration, §8.2 `health.warning`, §9.8, ADR 0013 decision 2

**User story:** As the owner, I want a feed that reissues its article IDs on every fetch to show each article once, so that one badly built feed can't bury my reading list or use up the free plan.

**Acceptance criteria**

1. Given a feed serving the same 50 items (same links and titles) with new GUIDs on every fetch, when it is refreshed 10 times after its first fetch, then no new `entries` or `user_entries` are created after the first fetch, and each of those refreshes writes exactly 1 row (the feed `UPDATE`).
2. Given a feed whose 50 items all link to the same URL (for example the homepage) and have new GUIDs and new titles, when 3 new items appear, then exactly those 3 are inserted (the shared secondary key is ignored). Given 3 items with new GUIDs whose link and title match an item from the previous fetch, then they're treated as known.
3. Given a feed whose GUIDs, links and titles all change every fetch, then it gets at most 200 new entries per UTC day; once the cap is reached, further items aren't stored, `warning_code = 'new_item_cap'`, and the subscription's `health.warning` is the fixed message. On the first refresh in a new UTC day that stays under the cap, the warning clears. A fixed-clock test crosses midnight UTC.
4. Given normal feeds (the TID-012 fixtures with 3 new items in 50), then rows written and rows read per refresh are unchanged from TID-012's measurements (40 written and 121 read for 2 subscribers; a test asserts both). The guard adds no D1 statement to the refresh.
5. Given migration `0003_feed_churn_guard.sql`, then it adds only the columns in spec §6.5, with no index, and applies cleanly to a database at migration 0002.
6. Given a first fetch (`last_success_at IS NULL`), then the guard doesn't drop items (there is no previous fetch to compare against), and the 200 cap counts its inserted entries.

**Out of scope:** detecting churn across non-consecutive fetches; merging entries already duplicated before this ships; a UI to override the cap.

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
- **AC:** Given settings, then I see my sessions (device hint, sign-in method: passkey, recovery code, email link or setup; created, last seen) and can end any one except the current one. *(Method added 2026-11-17, ADR 0016.)*

### TID-033: Manual folder and feed ordering
- **AC:** Given the manage screen, when I reorder folders (drag or move up/down buttons), then the drawer order persists via `folders.position`.

### TID-034: Storage warning
- **AC:** Given DB size > 70% of 500 MB (from the daily maintenance metric), then Settings shows a warning with the size and a link to the retention docs.

### TID-035: Swipe to close the navigation drawer
- **User story:** As a one-handed phone reader, I want to swipe the open drawer away, so that I can close it without reaching for the Close button.
- **AC:** Given the drawer is open on a touch device, when I swipe it left past 40% of its width or flick it, then it closes and the history entry it pushed is popped; `prefers-reduced-motion` removes the follow-the-finger animation. No edge-swipe to open (it collides with iOS back). **Depends on:** TID-006. **Agents:** UX, SE, QA.

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


### Owner requests, 2026-11-18 (R2, built under the lighter workflow)

- **TID-054: Article title opens the original.** Given an article with a URL, when I tap its title in the article view, then the original opens in a new tab (`rel="noopener noreferrer"`); with no URL the title is plain text.
- **TID-026 (amended): Mark as read on scroll.** Owner ruling: the setting `markReadOnScroll` defaults to **on** (Settings UI comes with TID-022). Batched `read-state` calls at most every 2 s, flushed on page hide; rows marked this way stay until the list is left.
- **TID-035 (amended): Drawer swipes.** Swipe the open drawer left to close (all modes). In the installed (standalone) app only, a swipe from the left screen edge on a list opens the drawer; in Safari the edge belongs to the browser's back gesture, so it is not used there.
- **TID-055: Edge-swipe back on the article (installed app only).** A swipe from the left edge drags the article and, past 35% or on a flick, goes back one history step. Vertical scrolling is never hijacked; `prefers-reduced-motion` removes the follow-the-finger animation.
- **TID-057: Logo, icons and full-screen app.** An original slanted, rounded "T" mark (construction in `docs/ux/brand.md`), favicon, 192/512/maskable/180 icons, web manifest with `display: standalone`, Apple web-app meta tags, safe-area insets. Covers TID-023 AC4 and AC6; the IndexedDB cache (AC1-AC3) stays in TID-023.

### TID-035 / TID-055 fix, 2026-11-18 (owner report from a real iPhone)
- **Drawer double jump:** the peeking drawer is now kept (same element) until the open lands, then switches to open in place: no remount, no entrance animation. Swipe-close was already one element and now has a test.
- **Swipe back from an article was blank:** the article is a full-screen layer above its list, which stays mounted (inert, aria-hidden). The list moves from -30% to 0 and un-dims as the article is dragged away; after Back it is the same list at the same scroll position, so the manual scroll restore and `lists/returning.ts` are gone. Pull to refresh and mark-read-on-scroll are off while the list is covered.


### TID-059: Launch screen (owner request 2026-11-18)
- **Splash on full loads.** On every full page load, including launching the installed app, a full-screen splash shows the accent mark (72 px) over the wordmark "Tidings" on the theme surface (light or dark), painted from `index.html` and the render-blocking CSS before any JS. It stays at least **2 s from navigation start** and until the session has resolved and the first screen (or its skeleton) has painted, then fades out over 250 ms and is removed (no fade with reduced motion). Never shown on in-app navigation. `aria-hidden` and `inert`; a 10 s failsafe in `theme-init.js` removes it if the app never starts. Automation (`navigator.webdriver`) skips the minimum.
- **Known trade-off (owner ruling):** the 2 s minimum knowingly overrides NFR-1 (cached article list within 1.0 s of navigation start) for the visible screen: the list is rendered underneath within 1 s but is covered until 2 s. NFR-1 measurement should run with the splash minimum skipped (`navigator.webdriver`, the default under Playwright).


### TID-060: List layouts and sans-serif article body (owner request 2026-11-18)
- **Three row layouts**, chosen per entry: thumbnail row (image on the LEFT, text beside it; flip with `flex-row-reverse`), text-only row (full width), and hero row (full-width 16:9 image on top, larger title below). Hero is about 1 in 5 image entries, chosen from a hash of the entry id (`lists/rowLayout.ts`), so it never changes between renders; a hero straight after a would-be hero becomes a thumbnail row. An image that fails to load falls back to the text-only layout.
- **Meta line:** feed name in the accent colour, then "· 4m ago" muted. Titles are `text-lg` semibold (hero `text-xl`), meta 15 px. The summary line is dropped (the reference has none). Read rows stay dimmed; the unread dot stays in the meta line.
- **Article body is sans-serif** (the UI stack); `docs/ux/DESIGN_SYSTEM.md` updated.

### TID-061: Hide duplicate articles across feeds (owner request 2026-11-18)

- **Agents:** PM (refine), SE, QA
- **Depends on:** TID-012 (refresh pipeline), TID-021 (retention, so the lookup window stays small)
- **Release:** R2
- **Status:** Ready

**User story:** As a reader who subscribes to overlapping feeds (for example BBC Top Stories and BBC Business), I want each story to appear only once in my lists, so that I don't read the same article twice.

**Context:** Today dedup is per feed only (GUID, plus TID-046's link-and-title key within one feed). The same story published in two of my feeds becomes two entries and two rows. Matching must be per user (another user may follow only one of the feeds) and cheap enough for the free-tier write and read budgets (spec §9).

**Acceptance criteria**

1. Given I subscribe to feeds A and B and both publish an item with the same canonical article URL (spec §6.4 canonicalisation, ignoring tracking parameters such as `utm_*`, `at_medium`, `at_campaign`, and `http` vs `https`), when both are fetched, then the article appears once in All, once in a folder holding both feeds, and once per feed view is not required: it appears in the feed view of the feed it arrived from first.
2. Given two items with different URLs but the same headline after normalisation (case, whitespace, punctuation and quote styles folded; empty or very short headlines (under 4 words) never match), published within 48 hours of each other, then only the first one is shown.
3. Given the duplicate arrives after I've read the first copy, then it does not appear as a new unread article. Given I mark the visible copy read or unread, then the hidden copy follows (or simply never existed for me), and unread counts count the story once.
4. Given a different user who follows only feed B, then they still see B's copy (dedup is per user).
5. Given an article that is genuinely updated (same URL, new content), then it is not shown twice (the existing copy stands; TID-045 handles in-place updates later).
6. Given the matching lookup, then it is bounded and indexed: at most one indexed lookup per new candidate entry, comparing only against my entries from the last 7 days, and the extra D1 cost per refresh is measured and recorded in spec §9 (target: under 10% extra rows written per day at the spec's assumed load). If a new column or index is needed, it goes through a numbered migration and the write cost is justified in an ADR.
7. Given a duplicate is hidden, then nothing is lost: it is either not linked to me at all, or linked and marked as a duplicate so it's excluded from lists and counts. The choice is recorded in the ADR.

**Out of scope:** fuzzy matching of near-identical headlines (edit distance), clustering "related coverage" from different publishers, and showing "also in: Business" on the row (could be a later nicety).

