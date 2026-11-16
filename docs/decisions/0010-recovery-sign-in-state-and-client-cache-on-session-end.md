# 0010. Recovery sign-in state, recovery-code input and the client cache on session end

- Status: Accepted
- Date: 2026-11-17
- Deciders: product-manager
- Stories: TID-007, TID-008, TID-009, TID-023. Source: UX auth screens on `ux-m0-updates` (`docs/ux/screens/auth-common.md`, `setup.md`, `login.md`, `recover.md`).

## Context

The UX auth specs raised four questions that change the API or the security model:

1. `mustAddPasskey` is returned only by `POST /api/auth/recover`, so the "Add a new passkey" banner (FR-AU-4) disappears on reload.
2. Codes are Crockford base32. People typing a code by hand confuse O with 0, and I or L with 1.
3. The download of recovery codes is a client-side `blob:` `.txt` file. Does the §10.4 CSP allow it?
4. Session expiry keeps the IndexedDB cache, and only an explicit sign-out clears it.

## Options considered

- **(1)** (a) Client `sessionStorage` flag: lost when the PWA is relaunched, and not shared across tabs. (b) A user-level flag: wrong, because it would nag on other devices that already have a passkey. (c) A session-level marker on the server: correct, and it costs one column. **(c).**
- **(2)** (a) Exact match only. (b) Map confusables as Crockford decoding does. The generator never emits I, L, O or U, so (b) maps typos onto the only code that could have been meant. The search space and entropy are unchanged. **(b).**
- **(3)** Downloads triggered by `<a download href="blob:…">` aren't governed by CSP fetch directives (`connect-src`, `default-src`), so no CSP change is needed. A `data:` top-level navigation fallback (UX's suggestion) is blocked by Chromium and isn't wanted.
- **(4)** (a) Clear on any 401. (b) Keep it until explicit sign-out. (b) gives an instant repaint after re-sign-in. The risk is a different account seeing cached data on a shared device. That is mitigated by tagging the cache with the user ID.

## Decision

1. **Migration `0002_session_auth_method.sql`** (shipped in TID-007, see amendment) adds `sessions.auth_method TEXT NOT NULL DEFAULT 'passkey' CHECK (auth_method IN ('setup','passkey','recovery'))`. `GET /api/auth/session` returns `mustAddPasskey: boolean`. It is true only when the current session's `auth_method = 'recovery'` and the user has no passkey with `created_at ≥ sessions.created_at`. That is one indexed read on `passkeys`, done only for recovery sessions, and **no extra writes**. `POST /api/auth/recover` keeps returning `mustAddPasskey: true`. Registering a passkey from any session clears the banner on the next session fetch.
2. **Recovery-code normalisation** (server, both when hashing a submitted code and when generating one): trim, remove spaces and dashes, upper-case, then map `O→0`, `I→1`, `L→1`. The client sends the value as typed (trimmed).
3. **CSP unchanged.** TID-007's E2E asserts the Download produces a file with all 10 codes and logs no CSP violation in every Playwright project. If any browser blocks it, the engineer stops and raises it with the PM. The fallback is Copy only on that browser, never a weaker CSP or a `data:` URL.
4. **Client cache on session end.** A `401 unauthenticated` (expiry, or "sign out everywhere" from another device) keeps the persisted cache but never paints it behind the login screen. An explicit **Sign out** clears it. The persisted cache records the user ID it belongs to. After any sign-in, if that ID differs from the signed-in user, the cache is discarded before anything paints.
5. **No "Lost your codes too?" link** on `/recover`. The public sign-in page shouldn't advertise the break-glass procedure or link to the repository. The owner finds it in the README (TID-024 AC2).
6. **`passkeyName`** is a best-effort client label. The server trims it, caps it at 64 characters, and falls back to "Passkey" when it is missing, empty or invalid. It never rejects setup over this field.

## Consequences

- There is a schema change (one column) and a spec API change in §8.3. The migration shipped with TID-007 (amendment below); TID-009 builds `mustAddPasskey` on it.
- Recovery codes are slightly more forgiving to type, at no security cost.
- On a device shared by two accounts (M3 invites), a sign-in as the second user discards the first user's cache. The user-ID tag makes that safe now.

## Amendment (2026-11-17, ADR 0011)

Migration `0002_session_auth_method.sql` landed in TID-007, not TID-009, because setup sessions need `auth_method = 'setup'` (TID-007 AC11). TID-009 must not add it again.
