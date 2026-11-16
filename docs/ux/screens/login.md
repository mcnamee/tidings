# Screen spec: passkey sign-in (`/login`)

Story: TID-008 (FR-AU-3, FR-AU-5; spec 8.3, 10.1, 10.2, 10.7). Read with `auth-common.md` (layout, controls, shared messages, redirect rules). Colours are token names.

One screen, one decision: tap "Sign in with a passkey". There is no username field (discoverable credentials, `allowCredentials` empty). The way out for a lost passkey is a link to `/recover`.

Decision: the passkey prompt does **not** start automatically on load. An automatic prompt needs no tap, but Safari requires a user gesture for some flows, a prompt that appears unasked is startling, and a cancelled auto-prompt leaves the person on a page that looks broken. One tap on a large button in the thumb zone is fast enough.

---

## 1. Phone 375 x 812: default

```
+---------------------------------------+
|              (inset-top)              |
|                                       |
|                                       |
|               Tidings                 |
|                                       |
|  +---------------------------------+  |
|  | Sign in                         |  |  h1
|  | Use the passkey on this device  |  |  text-base text-fg-muted
|  | or in your password manager.    |  |
|  |                                 |  |
|  |                                 |  |
|  | [ (key) Sign in with a passkey ]|  |  primary, 48 px, KeyRound icon
|  |                                 |  |
|  | Lost your passkey?              |  |  text link -> /recover, 44 px
|  +---------------------------------+  |
|              (inset-bottom)           |
+---------------------------------------+
```

Vertical position: the screen has so little on it that the button would sit near y 400 on 812. To keep it in the thumb zone the card has `min-h-[22rem]` on phones, with the button group pushed to the bottom of the card (`mt-auto`), which puts the button at about y 520.

| Element | Spec |
|---|---|
| `h1` | Sign in |
| Intro | Use the passkey on this device or in your password manager. |
| Primary | `KeyRound` icon (20 px, aria-hidden), label **Sign in with a passkey**. Full width, 48 px high. |
| Secondary | Text link **Lost your passkey?** to `/recover`, 44 px hit area, centred under the button, 16 px gap. |
| Focus | The primary button is the first and most prominent tab stop; it is **not** auto-focused on load (that would show a focus ring nobody asked for on touch devices and would make a stray Enter start the prompt). |

Process: `POST /api/auth/login/options` with `{}`, then `navigator.credentials.get` with the options, then `POST /api/auth/login/verify` with `{ response }`. On success the app navigates (`replace`) to `location.state.from` if it is valid (auth-common 7), otherwise to the default view (spec 11.1: last list viewed on this device, else `/all`), and focus goes to the destination `h1`.

---

## 2. States

### 2.1 Checking the session (loading)

On load the app calls `GET /api/auth/session`. Until it answers, the card shows a skeleton: an `h1` bar (6 rem), two text bars, a button-shaped block (48 px) and a short link bar, `bg-sunken`, `animate-skeleton`, `aria-busy="true"`. Cached last-known "signed out" is not trusted for this; the call is quick. If the user is already signed in, redirect to the default view. If the app needs setup, redirect to `/setup`. On failure: "Couldn't reach Tidings. Check your connection and try again." with a **Try again** button.

### 2.2 Passkey prompt in progress

| Phase | Button label | Helper (`role="status"`) |
|---|---|---|
| Requesting options, or verifying | Signing in... | |
| Device prompt open | Waiting for your passkey... | Follow the prompt on your device. |

The in-flight pattern is auth-common 2.3 (spinner, `aria-busy`, `aria-disabled`, no overlay). "Lost your passkey?" stays a working link so the person can leave while a prompt is open.

### 2.3 The user cancelled the prompt

`NotAllowedError`: cancelled, dismissed, timed out, or the device had no matching passkey (iOS and Android both report that as a cancel).

```
|  | +-----------------------------+ |
|  | | (i) Sign-in was cancelled.  | |  info banner, role="status"
|  | | Try again. No passkey on    | |
|  | | this device? Use a recovery | |
|  | | code.                       | |
|  | +-----------------------------+ |
|  | [ (key) Sign in with a passkey ]|  focus returns here
|  | Lost your passkey?              |
```

- Copy: **Sign-in was cancelled. Try again. No passkey on this device? Use a recovery code.** "Use a recovery code" is a link inside the banner to `/recover` (underlined, 44 px tall line box via padding).
- Focus returns to the primary button.
- Cancelling is never counted as a failure by the client and never shows an error colour.

### 2.4 The passkey didn't work

`401 webauthn_failed` (unknown credential, bad signature, wrong origin, expired challenge). Error banner:

- Copy: **That passkey didn't work. Try again, or use a recovery code.** with "use a recovery code" as a link to `/recover`.
- Focus to the primary button. The server gives no more detail and neither do we.

### 2.5 The device doesn't support passkeys

Detected on load (no `PublicKeyCredential` or insecure context; auth-common 5). The primary button is replaced by the unsupported block, and the recovery route is offered as the alternative:

```
|  | Sign in                         |  |
|  | +-----------------------------+ |  |
|  | | (!) This browser can't use  | |  |  warning banner
|  | | passkeys.                   | |  |
|  | | Tidings signs in with       | |  |
|  | | passkeys. Open it in a      | |  |
|  | | recent version of Safari,   | |  |
|  | | Chrome, Edge or Firefox, on | |  |
|  | | a device with a screen      | |  |
|  | | lock, Face ID, Touch ID or  | |  |
|  | | a security key.             | |  |
|  | +-----------------------------+ |  |
|  | [      Use a recovery code    ] |  |  primary (the only way forward), 48 px
```

The primary button here is **Use a recovery code**, a link styled as a button, to `/recover`. (A recovery code signs in without a passkey, so it works even here. Adding a passkey afterwards in Settings needs a supporting browser, which the recover screen's banner will say.) If `NotSupportedError` is thrown after a tap, the runtime variant in auth-common 5 shows above the primary button and the button stays.

### 2.6 Rate limited

`429 rate_limited` (10 failed sign-ins per IP in 10 minutes).

- Warning banner **Too many attempts. {Wait}.** (auth-common 3.1), `role="alert"`.
- Primary button `aria-disabled`, helper under it with the same wait text. "Lost your passkey?" still works, but note the recovery route has its own limit.
- When the wait ends: "You can try again now." and the button is enabled.

### 2.7 Session expired

The app routes here whenever any authenticated request returns `401 unauthenticated` (session past `expires_at` or `absolute_expires_at`; TID-008 AC4), and for a reload after the cookie has expired.

```
|  | Sign in                         |  |
|  | +-----------------------------+ |  |
|  | | (i) Your session ended.     | |  |  info banner, role="status"
|  | | Sign in again.              | |  |
|  | +-----------------------------+ |  |
|  | Use the passkey on this device  |  |
|  | or in your password manager.    |  |
|  | [ (key) Sign in with a passkey ]|  |
|  | Lost your passkey?              |
```

- Copy: **Your session ended. Sign in again.** Shown when `location.state.reason === 'expired'`. The banner stays until the next attempt starts, then is replaced by the outcome.
- The route the person was on is remembered (`location.state.from`, path plus search) and restored after sign-in (FLOWS 2.1), but only if it passes the rules in auth-common 7.
- The cached lists (IndexedDB) are kept on expiry so the restored screen paints instantly; they are cleared only by an explicit sign-out. The app must not paint cached content behind the login card.
- After the person chose **Sign out**, there is no banner: sign-out replaces history, goes to `/login` with no state, and the card is the plain default. Back does not return into the app.

### 2.8 Other states

| State | Behaviour |
|---|---|
| Offline | Warning banner "You're offline. Connect to the internet to continue." Primary `aria-disabled`, helper "You're offline." |
| Network error | "Couldn't reach Tidings. Check your connection and try again." |
| Server error | "Something went wrong on our side. Try again." |
| Redirected from `/setup` after `409 setup_unavailable` | Info banner: "This Tidings is already set up. Sign in instead." |
| Setup required | Redirect to `/setup`, never shown here. |
| Reduced motion | The `Loader` spin becomes a static icon. |
| 200% text zoom | Intro wraps; button grows in height; link stays 44 px; no horizontal scroll. |
| Long `from` URL | Never displayed, only used for the redirect. |

---

## 3. Desktop 1280 x 800

```
+-----------------------------------------------------------------------+
|                                                                       |
|                               Tidings                                 |
|                    +----------------------------+                     |
|                    | Sign in                    |                     |
|                    | Use the passkey on this    |                     |
|                    | device or in your password |                     |
|                    | manager.                   |                     |
|                    | [ Sign in with a passkey ] |                     |
|                    | Lost your passkey?         |                     |
|                    +----------------------------+                     |
|                                                                       |
+-----------------------------------------------------------------------+
```

Card 24 rem, centred horizontally and vertically. The button is keyboard-operable (Enter, Space). The browser may show its own passkey picker or "use a phone or tablet" option; that UI is the browser's.

---

## 4. Focus order and landmarks

1. `h1` (programmatic only; no initial focus on load).
2. **Sign in with a passkey** (or **Use a recovery code** in the unsupported state).
3. **Lost your passkey?**
4. A link inside a banner (when present) comes before the button in DOM order, so it is reached first; this is deliberate, since banners are above the button.

After an error or cancel, focus returns to the primary button. After success, focus goes to the destination `h1`.

---

## 5. Exact copy

| Where | Text |
|---|---|
| `h1`, `document.title` | Sign in, Sign in - Tidings |
| Intro | Use the passkey on this device or in your password manager. |
| Primary, idle | Sign in with a passkey |
| Primary, in progress | Signing in... / Waiting for your passkey... |
| Prompt helper | Follow the prompt on your device. |
| Secondary link | Lost your passkey? |
| Cancelled | Sign-in was cancelled. Try again. No passkey on this device? Use a recovery code. |
| Passkey failed | That passkey didn't work. Try again, or use a recovery code. |
| Unsupported | This browser can't use passkeys. / Passkeys need a secure connection. (bodies in auth-common 5) |
| Unsupported action | Use a recovery code |
| Rate limited | Too many attempts. {Wait}. / You can try again now. |
| Session expired | Your session ended. Sign in again. |
| Already set up | This Tidings is already set up. Sign in instead. |
| Offline, network, server | See auth-common 3 |

## 6. ARIA labels

| Element | Attribute |
|---|---|
| Card | `<main>`; `aria-busy="true"` while the session check runs |
| Form | none needed (one button); the button is `type="button"` or in a `<form aria-labelledby="login-h1">` with `type="submit"` so Enter works |
| Primary | `aria-disabled`, `aria-busy`, `aria-describedby` helper; the name is the visible label |
| Link | accessible name is its text, "Lost your passkey?" |
| Banners | `role="alert"` (error, rate limit), `role="status"` (info, offline); present from first render |
| Icons | `aria-hidden="true"` |

## 7. Acceptance checks (UX review)

1. 375 x 812 and 1280 x 800, light and dark: default, in progress, cancelled, failed, unsupported, rate limited, session expired, offline.
2. With the virtual authenticator: one tap signs in and lands on the last list (or `/all`); Back does not return to `/login`.
3. Session-expired banner appears after a forced 401 and the previous route is restored after sign-in.
4. Primary button 48 px high, link 44 px, nothing else focusable; focus ring visible in both themes.
5. axe: no serious or critical violations in every state.
