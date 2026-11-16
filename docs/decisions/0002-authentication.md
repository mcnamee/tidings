# 0002. Authentication: passkeys with recovery codes, single owner, server-side sessions

- Status: Accepted (user may override: spec Q3)
- Date: 2026-11-16
- Deciders: product-manager

## Context

The account holds one person's subscriptions and reading history. Every API route except auth must require a session. The Worker has a 10 ms CPU budget per invocation on the Free plan. The app is mostly used on a phone.

## Options

| Option | Notes |
|---|---|
| Cloudflare Access (Zero Trust, free under 50 users) | No auth code. But SPA `fetch` calls are redirected to the Access login when the token expires (opaque CORS errors), installed-PWA flows are awkward, config lives outside the repo, and local/E2E testing is hard. |
| Email + password | Workers caps PBKDF2 at 100,000 iterations (workerd #1346; below OWASP's 600,000), and that cost likely exceeds 10 ms CPU. Argon2/bcrypt in WASM are slower. Needs email reset. |
| Magic links | Needs an email provider; slow on a phone. |
| **Passkeys (WebAuthn)** | Phishing-resistant, no shared secret stored, native ECDSA verify, synced across devices by iCloud Keychain / Google Password Manager. Needs a recovery path; credentials bound to the hostname. |

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
