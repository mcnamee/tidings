# 0012. Sign-in and API security: ratified deviations, HEAD on health, and where isolation is proven

- Status: Accepted
- Date: 2026-11-17
- Deciders: product-manager
- Stories: TID-008 (accepted), TID-009, TID-013, TID-022, TID-023, TID-038. Source: `tid-008-verification` (tip `f38e3fa`), tester traceability in `docs/testing/TEST_STRATEGY.md`, DEF-018 and DEF-019.

## Context

TID-008 passed AC1-AC8 and AC10-AC15, with 28 of 28 guard mutations caught and an 80-test attack suite finding no bypass. AC9 (user B can't touch user A's IDs) can't be fully proven yet because no route takes an ID. The engineer made eight choices the spec didn't spell out and asked two questions. The tester filed DEF-018 (HEAD on health) and DEF-019 (E2E "stalls").

## Decision: deviations ratified

1. **Deny by default.** Any `/api/*` request not on the Public list (method and exact path), including unknown routes, needs a session: `401` without one. Already in §8.1.
2. **`GET /api/auth/session` slides the session** like any authenticated call. Already in §8.3.
3. **Two login counters** (`login:options:ip` and `login:verify:ip`, 10 each per 10 minutes). Already in §10.7.
4. **`wrangler dev --infer-origin-from-routes=false`** in `npm run dev` and the E2E server, so local requests keep the browser's real `Origin` and the CSRF check is exercised as in production. Added to §14.1.
5. **`localStorage['tidings.hasSession']`** holds `'1'` while this device believes it has a session. It is set on sign-in, cleared on Sign out, and only decides whether a `401` shows the "Your session ended" banner. It is a UI hint, never an auth signal, and holds no token or user data. Added to §11.3.
6. **A stand-in Sign out button on the `/settings` placeholder** until TID-022 builds Settings. TID-022 replaces it; its account section must keep Sign out.
7. **The IndexedDB database name is `tidings-cache`** (version 1). TID-023's persister must use it, because Sign out deletes it by that name. Added to §11.3.
8. **No index on `webauthn_challenges(purpose, expires_at)`.** Per-IP limits keep the table at a few rows, and the hourly purge (TID-021 AC6) empties expired ones, so a scan costs a handful of reads. An index would add a write to every challenge. Revisit only if the table ever holds more than 1,000 rows.

## Decision: engineer's questions

9. **The E2E base `request` fixture sends the app `Origin`.** Accepted. TID-007 proved setup's behaviour, not the absence of headers, and CSRF tests use `bareRequest`, which sends nothing extra. The tester confirmed nothing TID-007 proved is hidden.
10. **A bodyless `DELETE` must still send `Content-Type: application/json`.** Accepted as the strict reading of §10.3, which applies to every mutating method. The SPA's API client always sends it. §10.3 now says so explicitly.

## Decision: DEF-018, HEAD on `/api/health`

11. **`HEAD /api/health` is Public and answered like `GET`, with no body.** Uptime monitors default to HEAD. Only `/api/health` gets this; every other HEAD request follows deny by default. Built in TID-009 (AC6), the next story to touch the Public route list. Severity S4, so it doesn't block TID-008.

## Decision: AC9 isolation

12. **TID-008 AC9 is accepted as partial.** The middleware resolves the user from the session for every route, and a tripwire test (`no registered route takes an ID yet`) fails as soon as the first `:param` route is registered.
13. **The tripwire is too narrow.** IDs also arrive in query strings (`GET /api/entries?id=`) and bodies (`folderId` on `POST /api/subscriptions`, `entryIds` on read-state). TID-013 AC11 widens it: the route table records each route's ID inputs (path, query, body), and the guard test fails for any route with an ID input but no B-against-A case. TID-013 is the first story with an ID input (`folderId`).
14. **Standing rule:** every later story that adds an ID input extends the isolation suite in the same story. This is in the backlog's header notes, so TID-014, TID-015, TID-018, TID-019, TID-020 and TID-022 inherit it.

## Decision: UX review of `/login`

15. **It doesn't gate TID-008.** The E2E suite ran the sign-in flow at 375 px in both themes (mobile-light and mobile-dark projects), and the screen is built from the auth components UX reviewed in TID-007. UX reviews `/login` alongside `/recover` in TID-009 (AC7). Findings are filed as defects and fixed in TID-009.

## Decision: DEF-019

16. **Not a product defect.** Each "stall" matched a macOS system sleep to the second, and the same tests passed 16 of 16 under `caffeinate -ims`. TID-038 is rewritten around this and becomes the next story.

## Consequences

- TID-008 is Done. TID-009 gains AC6 (HEAD) and AC7 (UX review of `/login` and `/recover`). TID-013 gains AC11 (isolation suite and the wider tripwire).
- §10.3, §11.3, §14.1 and §8.8 are updated.
- The isolation suite grows with each story instead of being written once at the end.
