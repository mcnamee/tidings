# Tidings test strategy

Owner: tester. Source of truth for what is tested where, with which tool, and how to run it. The product
spec's section 13 is the outline; this file is the working detail. Last updated for TID-006.

## Principles

- No test touches the real network. Feeds come from the fixture server (E2E) or an injected fake `fetch`
  (Worker and unit tests). An unmocked URL in a fake `fetch` throws.
- Clocks are injected (`now: () => number`), never read from `Date.now()` in code under test.
- Stable selectors only: ARIA roles and `data-testid`. No CSS-class or text-fragment selectors for logic.
- Mobile first: E2E runs at 375 x 812 before 1280 x 800, in light and dark schemes.
- A test is never weakened to make it pass. If a test is wrong, the defect report says why.
- Every acceptance criterion maps to at least one named test (traceability below). A criterion with no
  test is reported as a gap.

## Layers

| Layer                            | Tool                                                                    | Lives in                                                                     | Covers                                                                                                                                                                                                        |
| -------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit (Node)                      | Vitest                                                                  | `packages/*/src/*.test.ts`, `lint-tests/`                                    | feed parser against fixtures, URL canonicalisation, dedup keys, SSRF guard, backoff maths, cursors, OPML mapping, lint rules                                                                                  |
| Unit (components)                | Vitest + jsdom + Testing Library                                        | `apps/web/src/**/*.test.tsx`                                                 | hooks and components with a mock API                                                                                                                                                                          |
| Integration (Worker)             | Vitest + `@cloudflare/vitest-plugin` (workerd, local D1)                | `apps/worker/src/**/*.test.ts`, `apps/worker/test/**/*.test.ts`              | every API route (happy, validation, unauthenticated, CSRF, cross-user isolation), dispatcher and fan-out with injected `fetch`, conditional GET, backoff, retention, `rows_read`/`rows_written` budgets        |
| Test-support unit tests          | Vitest (Node)                                                           | `packages/test-utils/src`, `e2e/test`                                        | fake `fetch`, fixed clock, fixture server, virtual authenticator helper, fixture corpus integrity                                                                                                             |
| End to end                       | Playwright (Chromium), `@axe-core/playwright`                           | `e2e/specs/*.spec.ts`                                                        | golden paths, axe per screen, themes, WebAuthn via CDP virtual authenticator                                                                                                                                  |
| Deployed budget checks (manual)  | Cloudflare dashboard / logs                                             | runbook (TID-024)                                                            | real CPU per invocation on the Free plan. Local workerd does not enforce CPU limits and `performance.now()` does not advance during execution, so CPU cannot be asserted in automated tests.                  |

Worker tests all run inside workerd. There is no separate Node-mode Worker suite: if a test needs Node
(file system, a local HTTP server), it belongs in `packages/*` or `e2e/test`.

## Commands

| Command                                    | What it runs                                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                        | `tsc` in every workspace (including test code)                                                                                        |
| `npm run lint`                             | ESLint and Prettier check                                                                                                             |
| `npm test`                                 | Vitest in every workspace (Worker tests in workerd) and the lint-rule tests                                                           |
| `npm test -w @tidings/worker`              | Worker integration tests only                                                                                                         |
| `npm test -w @tidings/e2e`                 | Fixture server, helper and fixture-corpus tests (Node)                                                                                |
| `npm run test:e2e`                         | Playwright, four projects. Builds the SPA, migrates a throwaway local D1 in `e2e/.wrangler-state`, starts `wrangler dev` on :8788     |
| `npm run test:e2e -- --project=mobile-dark`| One project                                                                                                                           |
| `npm run test:e2e -- --ui`                 | Playwright UI mode (local debugging)                                                                                                  |
| `npm run install:browsers -w @tidings/e2e` | One-off Chromium install (CI does this itself)                                                                                        |
| `node e2e/fixtures/opml/generate-opml.ts`  | Regenerate the Inoreader OPML fixture (a test fails if the committed file drifts from the generator)                                  |

Ports: app 8788 (`E2E_APP_PORT`), fixture feed server 8790 (`E2E_FIXTURE_PORT`). E2E runs serially
(`workers: 1`) because every project shares one app instance, one local D1 and one fixture server port.
Locally an already-running app on 8788 is reused; in CI a fresh one is always started.

## Worker integration tests (workerd + D1)

- Config: `apps/worker/vitest.config.ts`. It reads `apps/worker/migrations/*.sql` and passes them to the
  test as `env.TEST_MIGRATIONS`; `apps/worker/test/setup.ts` applies them in a `beforeAll` for every test
  file. Storage is isolated per test file, so each file starts from a freshly migrated empty database and
  files can run in any order.
- It uses the real `wrangler.jsonc` (bindings, vars). Tests that need other vars or secrets override them
  per test, not in the shared config.
- Typed `env`: `import { env } from 'cloudflare:workers'` (typed through `apps/worker/test/env.d.ts`).
- Call the Worker in-process with `worker.fetch(request, env, ctx)` using `createExecutionContext()` and
  `waitOnExecutionContext()` from `cloudflare:test`. Call `worker.scheduled(...)` the same way for cron.
- Inject `fetch` and the clock from `@tidings/test-utils`:

  ```ts
  const clock = createFixedClock(); // 2026-11-10T12:00:00Z
  const f = createFakeFetch();
  f.serveFeed('https://example.test/feed.xml', xml, { etag: '"v1"' }); // honours If-None-Match / If-Modified-Since
  f.route('https://example.test/gone.xml', { status: 410 });
  f.route('https://example.test/slow.xml', { hang: true }); // aborts when the fetcher's timeout fires
  ```

- Load fixture files into workerd tests with Vite's raw import, for example
  `import xml from '../../../e2e/fixtures/feeds/atom-basic.xml?raw'`. Large generated feeds come from
  `generatedFeed('rss-huge')` in `e2e/fixtures/generate-feeds.ts` (pure functions, safe in workerd).
- Known noise: workerd prints "enable_ctx_exports became the default as of 2025-11-17" because
  `wrangler.jsonc` still lists the flag. Harmless; TID-003 decides whether to drop it.

## End-to-end tests

- Projects (in `e2e/playwright.config.ts`): `mobile-light`, `mobile-dark` (375 x 812, touch, DPR 2),
  `desktop-light`, `desktop-dark` (1280 x 800), all Chromium, using `colorScheme`.
- Import `test` and `expect` from `e2e/support/test.ts`, not from `@playwright/test`. It adds the
  `fixtureServer` fixture (reset before every test).
- App under test: the built SPA served by `wrangler dev` together with the Worker, with
  `APP_ORIGIN=http://localhost:8788`, `RP_ID=localhost`, and `ALLOW_FETCH_HOSTS=127.0.0.1:8790` so the
  Worker may fetch from the fixture server. Passkeys need a secure context: always use `localhost`.
- **Fixture server** (`e2e/support/fixture-server.ts`): serves `e2e/fixtures/feeds/<file>` at
  `/feeds/<file>` and generated feeds at `/feeds/generated/<name>.xml` with ETag and Last-Modified and
  correct 304 handling. Script behaviours per path with `fixtureServer.script(path, {...})`: status
  (404/410/500/429), `retryAfter` (seconds or HTTP date), `redirectTo` + `redirectStatus` (chains and
  loops), `delayMs`, `hang`, `body`/`contentType`, `oversizeBytes` (with `chunked` to omit
  Content-Length), and `times` to limit a behaviour to N requests. `setBody` simulates a feed update,
  `requests(path)` records what the Worker sent (conditional headers, User-Agent) and what it answered.
  The same server is used by Node tests in `e2e/test` via `startFixtureServer()` on a random port.
- **Virtual authenticator** (`e2e/support/virtual-authenticator.ts`): `addVirtualAuthenticator(page)`
  before the page triggers WebAuthn; `credentials()`, `setUserVerified(false)` to fail a biometric,
  `clearCredentials()`, `remove()`.
- **axe** (`e2e/support/axe.ts`): `expectNoSeriousA11yViolations(page)` runs WCAG 2.0/2.1/2.2 A and AA
  rules and fails on serious or critical impacts. Pass `exclude` only with a written reason in the test.

## Fixture corpus (`e2e/fixtures/`)

| Path                                       | Purpose                                                                                                                             |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `feeds/rss2-basic.xml`                     | RSS 2.0: guid permalink and non-permalink, `dc:creator`, enclosure, tracking params in link                                         |
| `feeds/rss2-cdata-entities.xml`            | CDATA, numeric and named entities, `content:encoded`, `media:thumbnail`, `media:content`, `dc:date`, emoji/CJK/RTL, offset timezones |
| `feeds/rdf-basic.xml`                      | RSS 1.0 / RDF with `dc:date` (date-only form too)                                                                                   |
| `feeds/atom-basic.xml`                     | Atom 1.0: html, xhtml and text content, relative link, `+10:00` offset, entry without `published`                                   |
| `feeds/no-dates.xml`                       | No dates, unparseable date, far-future date                                                                                         |
| `feeds/duplicate-guids.xml`                | Same GUID twice, same link under two GUIDs, no GUID, no GUID and no link, empty GUID                                                |
| `feeds/hostile-html.xml`                   | Script, handlers, `javascript:` links, iframes, forms, style, meta refresh, entity-encoded script in a feed                          |
| `feeds/billion-laughs.xml`                 | Nested entity expansion and an external `SYSTEM` entity (R10 in the spec)                                                           |
| `feeds/malformed-truncated.xml`            | Cut off mid-item                                                                                                                    |
| `feeds/malformed-bad-markup.xml`           | Unescaped `&`, mismatched tags, undefined entities                                                                                  |
| `feeds/not-a-feed.html`                    | HTML page advertising feeds via `<link rel=alternate>` (discovery)                                                                  |
| `feeds/generated/*` (generated on request) | `rss-small` ~20 KB, `rss-typical` ~150 KB, `atom-typical` ~100 KB, `rdf-typical` ~30 KB, `rss-large` ~1 MB, `rss-huge` ~3 MB / 500 items (sizes match the TID-002 spike) |
| `opml/inoreader-export.opml`               | 248 unique feeds in 18 folders, one nested folder, one feed in two folders, 5 unfiled feeds, 3 invalid entries                       |
| `xss/payloads.json`                        | 43 HTML payloads (with what must survive and `rel` expectations) and 8 hostile URL payloads for the sanitiser and link handling     |

Fixture hostnames use `.example.test` (never resolvable). The fixture feeds are "as the world sends them";
expected parser output (JSON snapshots) is added with TID-011.

## Traceability convention

1. Every test whose purpose is an acceptance criterion carries the criterion in its name:
   `AC<n>: <behaviour>` inside a file or `describe` named for the story, for example
   `describe('TID-013 subscribe', () => it('AC3: a feed that 404s is rejected with feed_unreachable'))`.
   A test that proves several criteria lists each (`AC2, AC5: ...`).
2. Playwright specs name the story in the file (`tid-013-subscribe.spec.ts`) or the `test.describe`.
3. Tests that are not criteria (regressions, extra edge cases) omit the `AC` prefix and say why they exist.
4. The tester's report for a story lists every criterion as pass, fail or untested with the test name.
   `untested` is a gap and goes to the PM. Search for coverage with `grep -rn "AC3:" apps e2e packages`
   filtered by the story's describe name.
5. Defects are filed in `docs/testing/DEFECTS.md` with the story, the failing test name if any, and a
   severity, and are referenced from the test as `// DEF-nnn` while open.

## TID-005 traceability

| Criterion                                                                                           | Status | Tests                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC1: `npm test` runs Worker tests in workerd against a migrated local D1                            | pass   | `apps/worker/test/smoke.test.ts` (AC1 tests), `apps/worker/test/isolation.test.ts` (AC1 tests)                                                                                                                |
| AC2: four Playwright projects run a smoke test; axe has zero serious/critical on the placeholder    | pass   | `e2e/specs/smoke.spec.ts` (AC2 tests, in `mobile-light`, `mobile-dark`, `desktop-light`, `desktop-dark`)                                                                                                      |
| AC3: passkey registration and assertion complete in Chromium through the helper                     | pass   | `e2e/specs/webauthn-helper.spec.ts` (real Chromium, all four projects), `e2e/test/virtual-authenticator.test.ts` (unit). Re-verified against the real setup and sign-in screens when TID-007 and TID-008 land |
| AC4: fixture server: 304 on matching `If-None-Match`; scriptable 404/410/500/429, redirects, slow, oversized | pass   | `e2e/test/fixture-server.test.ts` (AC4 tests)                                                                                                                                                                 |
| AC5: this document                                                                                  | pass   | (document review)                                                                                                                                                                                             |

Migrations are applied per test file from `apps/worker/migrations/`. Until TID-004 adds `0001_init.sql`
that directory is empty, so AC1 is proven with an in-test probe migration through the same
`applyD1Migrations` call (`smoke.test.ts`).

## TID-006 traceability

Specs: `e2e/specs/tid-006-app-shell.spec.ts` (engineer), `e2e/specs/tid-006-app-shell-qa.spec.ts` (tester),
`apps/web/src/App.test.tsx`, `theme-init.test.ts`, `headers.test.ts`, `lib/toast.test.ts` (engineer),
`apps/web/src/qa-shell.test.tsx` (tester).

| Criterion                         | Status   | Tests                                                                                                                                                                            |
| --------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC1: dark OS, no flash            | pass     | engineer: DOMContentLoaded attribute and held-CSS tests. QA: "AC1 pixels" (CDP screencast frames sampled), "AC1 control" (detector fails without theme-init.js), "AC1 paint timing" |
| AC1 with a stored opposite choice | fail     | "AC1: before the stylesheet arrives the canvas colour scheme equals the stored choice" (`test.fail`, DEF-002)                                                                                                         |
| AC2: stored choice beats the OS   | pass     | engineer "AC2"; QA "AC2" (computed colours, other-tab storage event, corrupted values)                                                                                             |
| AC3: live OS changes              | pass     | engineer "AC3" (two); QA "AC3: theme-color meta follows live OS changes"                                                                                                           |
| AC4: drawer                       | pass     | engineer "AC4" (two) and App.test.tsx; QA "drawer stress", "tap targets" per route. Repeated-input robustness fails (DEF-005)                                                        |
| AC5: axe on every route           | pass     | engineer "AC5" per route; QA adds drawer-open, offline banner, 320 px reflow, 200 status per route                                                                                 |
| AC6: headers and no CSP violation | pass     | engineer "AC6"; QA headers on static files plus HSTS, violation listener with control, bundle has no inline code                                                                   |
| AC7: contrast ratios              | untested | UX verifies with `docs/ux/check-contrast.mjs`; not run by the tester                                                                                                              |

Technique notes. The no-flash check records the frames the compositor produced
(`Page.startScreencast`), decodes them in a scratch page and classifies the bottom-centre pixel, with the
stylesheet held back by `page.route`. `test.fail` marks a known defect by ID; remove it when the defect is
fixed so the test guards the fix. `localStorage` blocking is simulated by a throwing property getter.

## Security and free-tier checks (applied per story)

- Unauthenticated access to every route; user A against user B's data; CSRF; session expiry and logout.
- XSS payloads from `xss/payloads.json` through the sanitiser (unit, jsdom) and rendered in E2E with
  `window.__pwned` asserted undefined.
- SSRF: `http://127.0.0.1`, `169.254.169.254`, `localhost`, internal hostnames, redirects to them, and
  `ALLOW_FETCH_HOSTS` set while `APP_ORIGIN` is not localhost (config guard).
- Free tier: assert subrequest counts per refresh, conditional GET sent on second fetch, no writes on
  `304`, `meta.rows_read`/`rows_written` within the spec's budgets, retention keeps D1 under its size
  budget. CPU time is checked on a deployed Free-plan Worker, not locally.

## CI

`.github/workflows/ci.yml`: `npm ci`, typecheck, lint, `npm test`, `npm run build`, Playwright browser
install, `npm run test:e2e`, `npm audit --audit-level=high`. The Playwright report and traces upload as an
artifact when a step fails.
