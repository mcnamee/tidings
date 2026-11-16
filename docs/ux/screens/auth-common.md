# Screen spec: auth layout and shared pieces

Stories: TID-007, TID-008, TID-009. Read with `app-shell.md` section 12 (the auth layout outline), `../DESIGN_SYSTEM.md` (tokens) and the three screens that use this file: `setup.md`, `login.md`, `recover.md`. Colours are token names.

Everything the three auth screens share lives here once: layout, controls, the in-flight pattern, banners, and the messages for offline, rate limiting, network and server errors, and unsupported browsers. Screen files only add what is different.

---

## 1. Layout

No shell: no header, drawer, sidebar, bottom bar or skip link. The theme, `prefers-reduced-motion` and the toast region still work. The page has one `main`, one `h1` (inside the card), and the wordmark is a `span`, not a heading.

```
375 x 812, phone (card anchored in the upper-middle; the action is in the lower half)
+---------------------------------------+
|              (inset-top)              |  bg canvas
|                                       |
|                                       |  top padding: max(2rem, 8dvh)
|               Tidings                 |  wordmark, text-xl font-semibold, centred
|                                       |
|  +---------------------------------+  |  card: bg surface, border-line, rounded-md
|  |                                 |  |  max-w 24rem (384 px), 16 px page gutters,
|  |  h1  (text-xl font-semibold)    |  |  inner padding 24 px (p-6)
|  |  intro text (text-base, muted)  |  |
|  |                                 |  |
|  |  [banner, when there is one]    |  |
|  |  [fields]                       |  |
|  |                                 |  |
|  |  [ Primary action          ]    |  |  full width, 48 px high, rounded-md
|  |  secondary link (44 px high)    |  |
|  +---------------------------------+  |
|                                       |
|              (inset-bottom)           |
+---------------------------------------+

1280 x 800, desktop (card centred on both axes)
+-----------------------------------------------------------------------+
|                                                                       |
|                               Tidings                                 |
|                    +--------------------------+                       |
|                    |  card, 24 rem, centred   |                       |
|                    +--------------------------+                       |
|                                                                       |
+-----------------------------------------------------------------------+
```

Rules:

1. Root: `min-h-dvh bg-canvas flex flex-col items-center` with `px: max(1rem, env(safe-area-inset-left/right))`, `pt: max(2rem, calc(env(safe-area-inset-top) + 1rem))`, `pb: max(2rem, env(safe-area-inset-bottom))`. From `md` (768 px) the root becomes `justify-center` so the card centres vertically; below `md` it is top-anchored so the primary button lands in the lower half at 375 x 812 (roughly y 520 to 600 for the three-field screens) and does not jump when an inline error appears.
2. The card scrolls with the page (never an inner scroll area). When the on-screen keyboard opens, the browser scrolls the focused field into view; the primary button stays in normal flow directly under the fields, so it is reachable by scrolling. No fixed or sticky footer on `/setup`, `/login` and `/recover` (the one exception is the recovery codes step, `setup.md` section 5).
3. The wordmark is not a link (there is nowhere to go while signed out).
4. A short `<noscript>` message and the theme work as in `app-shell.md` section 7.
5. Text uses the normal scale: `h1` `text-xl`, body `text-base`, helper and error text `text-sm`. Inputs are 16 px or larger so iOS does not zoom.

---

## 2. Shared controls

### 2.1 Buttons

| Kind | Classes | Notes |
|---|---|---|
| Primary | `bg-accent text-accent-fg`, `min-h-12 w-full rounded-md text-base font-medium` | 48 px high. Label is a plain verb phrase. |
| Secondary (outlined) | `border border-line-strong bg-surface text-fg`, `min-h-11 rounded-md` | Copy, Download. |
| Text link | `text-accent underline-offset-2`, `min-h-11 inline-flex items-center` | 44 px hit area even though the text is small. |

Primary buttons use `aria-disabled="true"` (not the `disabled` attribute) while a request is in flight, while offline, while rate limited, and while a precondition is missing. The button stays focusable so a screen reader can reach it and read why (the helper text is linked with `aria-describedby`). A press on an `aria-disabled` button does nothing. Its style is `opacity-60 cursor-not-allowed`; disabled controls are exempt from contrast rules, and the label stays readable.

### 2.2 Text field

```
 Label                         text-base font-medium text-fg, above the input
 +-----------------------------------+
 | value                             |  min-h-12 (48 px), px-3, bg-sunken, 1 px border-line-strong,
 +-----------------------------------+  rounded-md, text-base (16 px)
 Helper text                          text-sm text-fg-muted, below
 (!) Error text                       text-sm text-danger, CircleAlert icon, replaces helper
```

- The label is a real `<label for>`; there are no placeholder-only labels. Placeholders, where used, are examples only and use `text-fg-muted`.
- Error state: border becomes `border-danger` (2 px), `aria-invalid="true"`, the error element has an id and is added to `aria-describedby` (the helper stays in the description too). The icon plus words mean colour is never the only cue.
- Validation runs on submit, not on blur, so nobody is told off for tabbing through. After a failed submit, focus goes to the first invalid field.
- `autocomplete`, `autocapitalize`, `spellcheck` are set on each field in the screen specs.
- Focus ring: the global `:focus-visible` rule (design system section 10).

### 2.3 In-flight pattern

While a request or a passkey prompt is running:

- The primary button gets `aria-busy="true"` and `aria-disabled="true"`, shows a 20 px `Loader` (animated rotate; replaced by a static icon under reduced motion) before the label, and the label changes to the in-progress text given in the screen spec.
- Fields become `readonly` (not `disabled`) so their values stay readable and are not lost.
- A helper line under the button says what the user should do ("Follow the prompt on your device."). It is a `role="status"` region that exists from first render, so changes are announced.
- No full-card spinner and no overlay. The card never changes height while in flight.
- A request that takes longer than 15 s is abandoned by the client (abort) and treated as a network error (section 4).

### 2.4 Banners inside the card

Banners sit at the top of the card, above the fields, 12 px padding, `rounded-md`, icon 20 px at the left, text `text-sm`.

| Tone | Classes | Icon | ARIA | Use |
|---|---|---|---|---|
| Error | `bg-danger-subtle text-danger-subtle-fg` | `CircleAlert` | `role="alert"` | Failed verification, wrong code, network and server errors |
| Warning | `bg-warning-subtle text-warning-subtle-fg` | `TriangleAlert` or `WifiOff` | `role="alert"` for rate limit, `role="status"` for offline | Rate limited, offline, "save these now" |
| Info | `bg-sunken text-fg border border-line` | `Info` | `role="status"` | Cancelled prompt, session ended, already set up |

Each banner container exists in the DOM from first render (empty) and its content is swapped, so screen readers announce the first message. Only one banner is shown at a time; a new one replaces the old one. A banner clears when the user submits again. Banners are not dismissible (they clear themselves), except nothing here needs a close button.

---

## 3. Shared messages

| Situation | Where | Exact copy |
|---|---|---|
| Offline (`navigator.onLine` is false, or a request fails with no response) | Warning banner, `role="status"`, `WifiOff` | You're offline. Connect to the internet to continue. |
| Offline, primary button helper | Text under the button | You're offline. |
| Network error (request failed, no response, or aborted after 15 s) | Error banner | Couldn't reach Tidings. Check your connection and try again. |
| Server error (5xx, or an unexpected 4xx) | Error banner | Something went wrong on our side. Try again. |
| Rate limited (`429 rate_limited`) | Warning banner, `role="alert"`, `TriangleAlert` | Too many attempts. {Wait}. (see 3.1) |
| Rate limit has passed | Replaces the banner, `role="status"` | You can try again now. |
| Passkeys not available, no `PublicKeyCredential` | Replaces the form (see 5) | heading and body in 5 |
| Session check failed on load (`GET /api/auth/session`) | Error banner in the card, no form | Couldn't reach Tidings. Check your connection and try again. Button: Try again |

The offline banner here is the card banner, because the shell's offline banner does not exist outside the shell. It appears within 1 s of the `offline` event and clears on `online`.

### 3.1 Wait text from `Retry-After`

`Retry-After` is in seconds. Let `m = ceil(seconds / 60)`.

| Value | {Wait} text |
|---|---|
| header missing or not a number | Try again in a few minutes |
| `seconds` under 60 | Try again in less than a minute |
| `m` is 1 | Try again in 1 minute |
| `m` 2 to 54 | Try again in {m} minutes |
| `m` 55 or more | Try again in about an hour |

The text is computed once, when the response arrives. It is not a live countdown (a ticking number would chatter in screen readers). A timer re-enables the button when `Retry-After` elapses and swaps the banner to "You can try again now." If the page is reloaded the state is lost; the server answers 429 again and the banner reappears, which is fine.

While rate limited the primary button is `aria-disabled="true"` and its helper reads the same wait text. Fields stay editable.

---

## 4. Error handling order

For every call, evaluate in this order and show exactly one banner or field error:

1. Offline: do not send; offline banner.
2. Client validation: field errors, nothing sent.
3. Response `429`: rate-limited banner.
4. Screen-specific code (`invalid_setup_token`, `webauthn_failed`, `invalid_recovery_code`, `setup_unavailable`): see the screen spec.
5. No response / abort: network banner.
6. Anything else: server-error banner.

Never show an error code, HTTP status or stack text to the user. Never reveal anything an attacker could use: the same message covers "wrong", "used" and "unknown" for recovery codes, and "wrong key", "unknown credential" and "wrong origin" for passkeys.

---

## 5. Passkeys not supported

Detected before the user acts: `!('PublicKeyCredential' in window)` or `!window.isSecureContext`. The check runs on load and the form is replaced by this block (same card, same `h1` as the screen, so the page title does not change):

```
+-----------------------------------+
|  h1  (screen's own title)         |
|  (!) This browser can't use       |
|      passkeys.                    |   warning banner style, TriangleAlert
|  Tidings signs in with passkeys.  |
|  Open it in a recent version of   |
|  Safari, Chrome, Edge or Firefox  |
|  on a device with a screen lock,  |
|  Face ID, Touch ID or a security  |
|  key.                             |
+-----------------------------------+
```

| Case | Heading (inside the banner, bold) | Body |
|---|---|---|
| No `PublicKeyCredential` | This browser can't use passkeys. | Tidings signs in with passkeys. Open it in a recent version of Safari, Chrome, Edge or Firefox, on a device with a screen lock, Face ID, Touch ID or a security key. |
| Not a secure context (plain http) | Passkeys need a secure connection. | Open Tidings using its https address and try again. |

What follows depends on the screen (`setup.md`: nothing else; `login.md`: a "Use a recovery code" button).

The same block is used when a call to `navigator.credentials.create/get` throws `NotSupportedError` after the user has acted (for example the device has no screen lock and no key). That runtime variant uses the heading "This device can't use passkeys." and the body "Turn on a screen lock, or connect a security key, then try again." and keeps the primary button so the user can retry.

---

## 6. Document titles and focus

| Route | `h1` text | `document.title` |
|---|---|---|
| `/setup` | Set up Tidings | Set up Tidings |
| `/setup` (recovery codes step) | Save your recovery codes | Save your recovery codes - Tidings |
| `/login` | Sign in | Sign in - Tidings |
| `/recover` | Use a recovery code | Use a recovery code - Tidings |

- On first render the `h1` has `tabindex="-1"` but focus is **not** forced there on page load (it would pop the on-screen keyboard or skip the intro). Screen reader users start at the top of the document anyway.
- On a step change within a screen (setup to recovery codes) focus moves to the new `h1`, the same rule as FLOWS 1.7.
- After a successful sign-in the app navigates with `replace` so Back never returns to an auth screen, and focus goes to the destination `h1`.

---

## 7. Redirect rules (for the engineer, and for UX review)

| Condition | Result |
|---|---|
| `GET /api/auth/session` says `setupRequired` and the route is `/login` or `/recover` | Redirect to `/setup` (`replace`) |
| A user exists and the route is `/setup` (TID-007 AC5) | Redirect to `/login` (`replace`), no message |
| A user exists and `setup/options` or `setup/verify` returns `409 setup_unavailable` mid-flow | Redirect to `/login` with notice "This Tidings is already set up. Sign in instead." (info banner on login) |
| Signed in and the route is `/login`, `/recover` or `/setup` | Redirect to the default view (spec 11.1: last list, else `/all`) |
| Any other route and signed out | Redirect to `/login`, remembering the route (`location.state.from`) |

`from` is restored only if it is a same-origin path that starts with a single `/`, is not `//...`, and is not one of `/setup`, `/login`, `/recover`. Otherwise use the default view.

---

## 8. Accessibility checks for all three screens

1. axe: zero serious or critical violations in light and dark at 375 and 1280 widths, in every state in the screen specs.
2. One `h1`, one `main`, one `form` per step; fields have visible labels.
3. Every error and status message is in a live region that existed before the message arrived.
4. Tap targets at least 44 x 44 (inputs and primary button are 48 high).
5. 200% text zoom: the card reflows, no horizontal scroll, the button stays under the fields.
6. Forced colours: borders, focus ring and the checkbox remain visible.
7. Reduced motion: the `Loader` rotation is replaced by a static icon; nothing else moves.
8. Tab order matches the visual order in each screen spec, with nothing focusable outside the card.
