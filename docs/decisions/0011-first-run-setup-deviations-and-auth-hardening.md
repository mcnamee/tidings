# 0011. First-run setup: ratified deviations and auth hardening rulings

- Status: Accepted
- Date: 2026-11-17
- Deciders: product-manager
- Stories: TID-007 (accepted), TID-008, TID-009, TID-021, TID-024. Source: TID-007 build (`tid-007-first-run-setup`, tip `8908166`), tester traceability in `docs/testing/TEST_STRATEGY.md`, UX review of setup.

## Context

TID-007 was built with seven deviations from the spec, which the tester and UX judged acceptable. The tester also raised four observations that need a ruling. This ADR records both so the spec, backlog and later stories agree.

## Decision: deviations ratified

1. **Migration `0002_session_auth_method.sql` landed in TID-007**, not TID-009, because setup creates the first session with `auth_method = 'setup'` (TID-007 AC11). ADR 0010 item 1 is amended. TID-009 uses the column and doesn't add a migration for it.
2. **Accessible names include the visible label** (WCAG 2.5.3 Label in Name). `docs/ux/screens/setup.md` is updated. Later auth screens follow the same rule.
3. **zod runs in the Worker only.** The schemas live in `@tidings/shared/schemas`, which the SPA doesn't import. zod 4 probes `Function('')` at load, which the SPA's CSP (no `unsafe-eval`, §10.4) reports as a violation. The SPA shares types from `@tidings/shared` (which has no zod) and does its own light form checks. The server stays authoritative. The CSP isn't changed.
4. **Auth rate limits count failed attempts.** A slot is claimed when a request arrives and handed back when it succeeds. A normal setup uses no slots. Spec §8.3 already says this (edited on the TID-007 branch). TID-008 (login) and TID-009 (recover) use the same mechanism, with the exception in item 9 below.
5. **A missing or short `SETUP_TOKEN` (under 32 characters) returns `500 config_error`** from the setup endpoints, with a logged error and no token comparison. Once an owner exists, the `409 setup_unavailable` check runs first, so removing the secret after setup is harmless.
6. **The WebAuthn user handle is the new user's ID**, generated at `setup/options` and held in `webauthn_challenges.user_id` until `setup/verify` creates the user with that ID. The spec §6.1 schema comment is updated.
7. **The E2E suite's resting state is "an owner exists"**, with one Playwright worker. The tester recorded the convention in `TEST_STRATEGY.md`.

## Decision: tester observations

8. **CSRF on the public auth routes.** The setup endpoints accept `text/plain` bodies and don't check `Origin` today. Spec §10.3 applies to *every* mutating request, Public ones included. TID-008 builds it, and its AC14 covers setup, login and recover.
9. **Bounding challenge rows.** Refunded successes let a caller create challenge rows without limit. That's harmless for setup (only the token holder gets that far) but becomes a D1 write-amplification route on `login/options`, which anyone can call.
   - `setup/options` deletes expired `setup` challenges in its write batch, and refuses with `429 rate_limited` when 5 unexpired `setup` challenges already exist. The table can't grow, and an owner retrying normally never sees the 429 (TID-008 AC15).
   - `login/options` is **not** refunded: each call uses a slot in the per-IP limit, and a successful `login/verify` refunds its own slot only. One sign-in uses one slot, so 10 sign-ins per IP per 10 minutes. That's plenty for one person and caps one IP at 1 challenge row a minute.
   - The hourly maintenance job deletes every expired challenge row, whatever its purpose (TID-021 AC6). Orphaned setup challenges expire like any other.
10. **Global setup lockout griefing is accepted.** Before an owner exists, 30 failed setup attempts an hour from any IPs lock setup for everyone for up to an hour. The exposure lasts only from deploy until the owner completes setup (normally minutes), and the attacker has to find the URL in that window. The owner's remedy is to wait, or to delete the `rate_limits` rows with `wrangler d1 execute` (TID-024 runbook, AC8). The global `recover` limit stays as specified: it can delay recovery but not passkey sign-in, and it caps online guessing of recovery codes. Recorded as risk R12.
11. **E2E flakiness gets its own story.** Playwright context-setup and teardown stalls (15-minute runs, an 8.7-minute hang) are tracked as TID-038 for the tester. They aren't product defects and don't block TID-007.

## Consequences

- TID-008 gains AC14 and AC15. TID-009 AC5 no longer mentions adding the migration. TID-021 AC6 states the challenge purge explicitly. TID-024 AC8 adds the rate-limit reset to the runbook.
- The SPA bundle doesn't include zod. If client-side validation ever needs schemas, they must be zod-free or loaded in a way the CSP allows. Don't relax the CSP.
- Login challenge rows are bounded per IP. A distributed attacker can still create rows, as on any public endpoint. At 1 row a minute per IP, that's a negligible share of the 100,000 writes a day.
