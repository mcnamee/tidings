# 0016. Email magic-link sign-in (amends ADR 0002)

- Status: Accepted
- Date: 2026-11-17
- Deciders: product-manager, at the owner's request; sending domain and secret decided by the owner (2026-11-17)
- Story: TID-053. Amends ADR 0002 (magic links "Rejected") and spec §3.1, §8.3, §9, §10.

## Context

ADR 0002 rejected magic links because they "need an email provider" and are "slow on a phone". The owner now often signs in from a work computer that has neither their phone (passkey) nor their password safe (recovery codes). On that computer they can read their own email. The phone objection doesn't apply there, and passkeys stay the primary method everywhere else.

Facts established on 2026-11-17 (orchestrator):

- The `mcn.am` apex MX records point to Google Workspace, so Cloudflare Email Routing must **not** be enabled on the apex. The owner chose (2026-11-17) to enable it on the app's own subdomain, `tidings.mcn.am`, only. Its MX and TXT records sit alongside the Worker custom domain's records, and the apex MX is untouched.
- The Workers `send_email` binding costs nothing, but it can only deliver to destination addresses verified in the account's Email Routing. For a single owner with one verified address, that restriction helps us.
- The current API token lacks Email Routing permissions, so the owner does the dashboard setup (TID-053 "Owner setup").

Cloudflare's docs could not be reached from this session on 2026-11-17 (`developers.cloudflare.com` not in the allowed network). The `send_email` facts above are from the orchestrator and from memory, so they are **unverified** here. TID-053 AC15 verifies them in production before the story closes.

## Options

| Option | For | Against | Verdict |
|---|---|---|---|
| Workers `send_email` binding from `signin@tidings.mcn.am` | Free; no new vendor or API key; verified-destination rule means it can only mail the owner | Owner must set up Email Routing on `tidings.mcn.am`; only verified recipients (fine for one owner) | **Chosen** |
| Third-party email API (Resend, Postmark, …) | Arbitrary recipients | New account, API key secret, a vendor that sees the sign-in links, possible cost | Rejected |
| Recovery code typed from memory or paper | No new code | Codes are single use and 16 characters long; the owner doesn't carry them | Rejected for this use case |
| Cloudflare Access in front of the app | No auth code | Already rejected in ADR 0002 (SPA fetch redirects, PWA issues) | Rejected |
| Link consumed on GET | Simplest | Corporate mail scanners (Defender Safe Links, Mimecast, Proofpoint) GET every link and would burn the token first | Rejected: consume on POST |
| Bind the link to the requesting browser (cookie) | A leaked or scanned link is useless elsewhere | Breaks when the mail client opens links in a different browser or profile, which is common on managed work PCs | Rejected |

## Decision

### Delivery

- Binding `send_email: [{ "name": "SIGNIN_EMAIL" }]`. The committed config holds no address. Sender `MAGIC_LINK_FROM` (var, `signin@tidings.mcn.am`, display name "Tidings"). Recipient: the Worker secret **`MAGIC_LINK_EMAIL`** (`wrangler secret put`; `.dev.vars` locally). The owner's address is never written into a committed file, and the recipient never comes from user input.
- Email Routing is enabled on `tidings.mcn.am` only. The apex stays on Google Workspace.
- **Enabled only when configured:** the `SIGNIN_EMAIL` binding, `MAGIC_LINK_EMAIL` (non-empty, contains `@`) and `MAGIC_LINK_FROM` are all present, and exactly one user exists. Otherwise the feature is off: `GET /api/auth/session` returns `emailSignIn: false`, both endpoints return `404 not_found`, and nothing is sent. **Kill switch:** `wrangler secret delete MAGIC_LINK_EMAIL` turns it off without a redeploy.

### Flow

1. On `/login` the owner taps "Email me a sign-in link", types their address and submits. `POST /api/auth/email/request { email }`.
2. The server claims rate-limit slots, then compares the normalised input (trimmed, lower-cased) with the normalised `MAGIC_LINK_EMAIL`. If they match, it deletes any unused link for the user, stores a new one, and sends the email inside `ctx.waitUntil`. Whatever the outcome, a well-formed request gets the same `202 {}` with no body difference and no timing difference that depends on the match (the send happens after the response).
3. The email links to `https://tidings.mcn.am/login/email#token=<token>`. The token sits in the **fragment**, so it never reaches the server on GET, server logs or a `Referer` header. A scanner that GETs the link only loads the SPA shell.
4. The `/login/email` page reads the fragment, removes it from the address bar with `history.replaceState`, and shows one "Sign in" button. Tapping it sends `POST /api/auth/email/verify { token }`. Nothing is consumed until that POST.
5. On success: a new session, exactly as for a passkey sign-in (§10.2), with `auth_method = 'email'`, then the default view.

### Token

- 32 random bytes from `crypto.getRandomValues` (256 bits, above the 128-bit floor), base64url. Only `SHA-256(token)` is stored, in a new table `magic_links (token_hash PK, user_id, created_at, expires_at, used_at)`. A fast hash is fine because the token is high-entropy (same reasoning as recovery codes).
- Expires 15 minutes after it is issued. Single use: consumed with one atomic `UPDATE … SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`, and it succeeds only when exactly one row changed. At most one live link per user, because each new request deletes the earlier unused ones.
- Expired or used rows are deleted by the request handler (same statement as the "delete unused" step) and by the hourly maintenance job.
- Never logged: the token, the full URL, or the typed address. Logs record only `email_link_requested { matched: boolean }` and `email_link_verified { ok: boolean }`.

### Sessions and step-up

- Migration `0004_email_sign_in.sql` creates `magic_links` and rebuilds `sessions` so the `auth_method` CHECK allows `'email'` (SQLite cannot change a CHECK in place; use the documented copy-and-rename with `PRAGMA defer_foreign_keys = true`).
- An `email` session can read and manage feeds like any other session. It **cannot** add or remove passkeys or regenerate recovery codes: those return `403 reauth_required`, and the UI offers a passkey sign-in. So someone who gets into the owner's mailbox can read Tidings, but can't lock the owner out or keep access after "Sign out everywhere".
- The sessions list (TID-032, M2) shows each session's sign-in method.

### Rate limits (D1 `rate_limits`, §10.7)

| Counter | Limit | Refund |
|---|---|---|
| `email:request:ip:<ip>` | 5 / 10 min | Never |
| `email:request:global` | 100 / hour | Never (bounds D1 writes from abuse) |
| `email:send:global` | 10 emails / day (UTC) | Never. Claimed only when the address matches, so someone who doesn't know the address can't use up the owner's daily sends |
| `email:verify:ip:<ip>` | 10 / 10 min | Refunded on success |
| `email:verify:global` | 30 / hour | Refunded on success |

All slots are claimed before the address comparison or the token lookup, so a `429` doesn't reveal whether the address matched. When `email:send:global` is full, the request still returns `202` and no email is sent (logged as `send_capped`).

### CSRF and origin

Both endpoints are mutating Public routes, so §10.3 applies unchanged: the `Origin` must equal `APP_ORIGIN` (or `Sec-Fetch-Site: same-origin`) and the `Content-Type` must be `application/json`. The link opens an SPA route, and the GET has no side effects. The verify POST also needs the same origin, so a page on another site can't consume a token.

## Free-tier cost

Per sign-in: about 4 Worker requests (session, request, landing page session check, verify). D1 writes: request about 4 (2 to 3 rate-limit upserts, 1 delete, 1 insert); verify about 6 (2 rate-limit, 1 token update, sessions row plus its `sessions_user` index entry, 1 refund). That's about 10 rows written and fewer than 20 read. At the 10 emails/day cap that is at most about 100 rows a day, or 0.1% of the 100,000 daily writes. Abuse is bounded by `email:request:global` at 100 an hour: at most about 2,400 requests and 7,200 rows written a day (7%). Emails: at most 10 a day. No KV, Queues or Cron changes. CPU: one SHA-256 and a D1 round trip, under 1 ms, with no WebAuthn library load.

## Consequences

- **Whoever controls the owner's mailbox can sign in to Tidings.** For a personal reader this is accepted. Damage is limited: the attacker can't add or remove passkeys or regenerate recovery codes, every sign-in sends an email the owner sees, and the owner can turn the feature off (delete the `MAGIC_LINK_EMAIL` secret) or "Sign out everywhere". Spec risk R13.
- A link forwarded or seen within 15 minutes can be used by whoever has it. The 15-minute expiry, single use and "at most one live link" limit this.
- An attacker who knows the address can use up the 10 sends a day. The owner then falls back to a passkey or recovery code. Accepted.
- Corporate mail can delay delivery by minutes. 15 minutes allows for that. If it proves too short, change the constant in an ADR amendment, not ad hoc.
- Multi-user (M3) would need `users.email` and a per-user verified destination. The `send_email` restriction makes that unsuitable, so a provider decision is needed then.
- The apex `mcn.am` mail is untouched. Getting the subdomain setup wrong could affect Google Workspace mail, so the owner's steps include checking the apex MX afterwards. Email Routing adds MX and SPF TXT records on `tidings.mcn.am`. These coexist with the custom-domain record that serves the app, and TID-053 AC15 confirms the app still loads afterwards.
