# 0002. Authentication: passkeys with recovery codes, single owner, server-side sessions

- Status: Accepted (user may override: spec Q3). WebAuthn CPU results in from spike TID-003, decision pending PM (see Results).
- Date: 2026-11-16
- Deciders: product-manager

## Context

The account holds one person's subscriptions and reading history. Every API route except auth must require a session. The Worker has a 10 ms CPU budget per invocation on the Free plan. The app is mostly used on a phone.

## Options

| Option                                              | Notes                                                                                                                                                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cloudflare Access (Zero Trust, free under 50 users) | No auth code. But SPA `fetch` calls are redirected to the Access login when the token expires (opaque CORS errors), installed-PWA flows are awkward, config lives outside the repo, and local/E2E testing is hard. |
| Email + password                                    | Workers caps PBKDF2 at 100,000 iterations (workerd #1346; below OWASP's 600,000), and that cost likely exceeds 10 ms CPU. Argon2/bcrypt in WASM are slower. Needs email reset.                                     |
| Magic links                                         | Needs an email provider; slow on a phone.                                                                                                                                                                          |
| **Passkeys (WebAuthn)**                             | Phishing-resistant, no shared secret stored, native ECDSA verify, synced across devices by iCloud Keychain / Google Password Manager. Needs a recovery path; credentials bound to the hostname.                    |

## Decision

- **Passkeys** via `@simplewebauthn/server` and `@simplewebauthn/browser` (14.x). Discoverable credentials, `userVerification: 'required'`, attestation `none`.
- **First-run setup** gated by a `SETUP_TOKEN` secret; impossible once a user exists. No public sign-up.
- **10 single-use recovery codes** (80-bit random), stored as SHA-256. A fast hash is fine because they're high-entropy, not user-chosen.
- **Sessions**: opaque 32-byte token in a `__Host-` cookie (HttpOnly, Secure, SameSite=Lax); only its SHA-256 is stored in D1; 30-day sliding, 180-day absolute.
- **CSRF**: Origin check + JSON content type on every mutation.
- **Single owner in MVP**; schema is multi-tenant so invites can come in M3.

## Consequences

- No passwords to leak or hash; auth CPU cost is low (to be confirmed in TID-003, including library cold start).
- The production hostname must be chosen before setup (spec Q2); changing it means re-registering passkeys.
- E2E tests use Chromium's virtual authenticator.
- Browsers without passkey support are unsupported (spec NFR-12).

## Results (spike TID-003, run 2026-11-16, Workers Free plan): WebAuthn CPU

Code: `spikes/tid-003/webauthn/` and `spikes/tid-003/scripts/webauthn-client.mjs` (never merged). Library `@simplewebauthn/server` 14.1.0, bundled by Wrangler 4.162.0 **without `nodejs_compat`** (nothing in the library needed it). Bundle 710 KiB (130 KiB gzip); deploy-reported `Worker Startup Time` 17 ms (a bare Worker reports 1 ms).

Method: a Node script acts as a virtual authenticator and builds real attestation (`fmt: none`) and assertion responses (P-256 ES256, RSA-2048 RS256, Ed25519 EdDSA) for the deployed Worker's `workers.dev` origin and RP ID. The Worker runs `verifyRegistrationResponse` and `verifyAuthenticationResponse` with `userVerification: 'required'` (challenge supplied by the client in the spike; D1 is not touched). Every response verified (ES256 and RS256: 50 of 50 registrations and 50 of 50 authentications each; EdDSA: 30 of 30 each).

**Measurement source:** `wrangler tail --format json` `cpuTime` (whole milliseconds, so "0" means under 1 ms), not `performance.now()`. Tail sheds events under load, so each table row is the sample of events delivered out of the 50 requests sent (requests were paced at 400 to 700 ms to reduce shedding). The GraphQL Analytics API could not be used (the permission system denied reading the OAuth token).

### Warm isolate (steady state)

| Operation                                                       | Requests sent | Events measured | p50  | p95  | p99  | max  |
| --------------------------------------------------------------- | ------------- | --------------- | ---- | ---- | ---- | ---- |
| ES256 registration verify                                       | 50            | 26              | 0 ms | 1 ms | 3 ms | 3 ms |
| ES256 authentication verify                                     | 50            | 19              | 0 ms | 3 ms | 3 ms | 3 ms |
| RS256 registration verify                                       | 50            | 39              | 0 ms | 1 ms | 1 ms | 1 ms |
| RS256 authentication verify                                     | 50            | 36              | 0 ms | 2 ms | 2 ms | 2 ms |
| EdDSA registration / authentication verify                      | 30 each       | 3 / 3           | 0 ms | 1 ms | 1 ms | 1 ms |
| `generateRegistrationOptions` / `generateAuthenticationOptions` | 30 / 30       | 27 / 16         | 0 ms | 0 ms | 0 ms | 0 ms |

Warm p99 is 3 ms against the 8 ms target. (p99 equals max at these sample sizes.)

### Cold start (first request to a fresh isolate, after a redeploy)

15 samples: ES256 registration 9, 7, 6, 3, 6 ms; ES256 authentication 5, 9, 10, 5 ms; RS256 authentication 3, 4, 4 ms; RS256 registration 9, 4, 3 ms. Sorted: 3, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7, 9, 9, 9, 10. **Median 5 ms, p95 and max 10 ms, three of 15 at 9 ms.** The first request is whichever route the user hits first, and the cold cost appears on both registration and authentication.

### Reading

- **Against the spec's p99 <= 8 ms target:** warm passes with wide margin (3 ms). Cold does not clear it reliably (p99 = max = 10 ms over 15 samples), so by the TID-003 rule the "consequences" need a mitigation note. For a single-owner app, sign-in is rare and the Worker is usually cold when it happens, so the cold figure is the realistic one.
- **Mitigating facts:** (a) the 10 ms limit was not a hard cutoff in this account (ADR 0004 Results: a 699 ms request and 29 ms callees ran to completion on Free), so a 10 ms cold login is unlikely to be killed, but that is not a promise; (b) a failed or killed login is retried on a warm isolate at 0 to 3 ms; (c) authentication is a once-per-30-days event per device.
- **Hidden cost to avoid:** the library adds 17 ms of startup and 710 KiB to any Worker that bundles it. Import it dynamically (`await import('@simplewebauthn/server')`) only inside the auth route handlers, so the hot API routes (feed list, entry reads) do not pay it. Not measured in the spike.
- **Option enabled by ADR 0004's result:** run verification in its own `WorkerEntrypoint` through `ctx.exports` (RPC), which gives the verify call its own CPU budget separate from the HTTP handler. Not tested; the isolation result in ADR 0004 says it should work.

### Recommendation (for the PM to decide)

Keep `@simplewebauthn/server` and passkeys (ADR 0002 stands). Do not build the lighter Web Crypto verifier (spec R9 fallback) now: warm cost is 3 ms and cold cost is borderline, not clearly over. Re-label spec §9.7 "WebAuthn verify" as "warm p99 3 ms, cold up to 10 ms, verified 2026-11-16" and have TID-007 load the library dynamically in the auth routes. If TID-007 measures cold login above 10 ms in the real Worker, move verification behind a `ctx.exports` entrypoint first, and only then consider the lighter verifier (ES256 and EdDSA only, which covers Apple, Google and password-manager passkeys; RS256 is Windows Hello).
