# Screen spec: first-run setup (`/setup`)

Story: TID-007 (FR-AU-1, FR-AU-2, FR-AU-8; spec 8.3, 10.1, 10.7). Read with `auth-common.md` (layout, controls, shared messages, redirect rules) and `../DESIGN_SYSTEM.md`. Colours are token names.

Two steps on one route, in one component, with no URL change between them:

1. **Create your passkey** (display name, setup token, passkey prompt).
2. **Save your recovery codes** (shown once).

The account and session exist as soon as `setup/verify` succeeds (step 1 to 2). Step 2 is therefore the only chance to see the codes, and the design below is about making it hard to lose them by accident.

---

## 1. Step 1, phone 375 x 812: default

```
+---------------------------------------+
|              (inset-top)              |
|                                       |
|               Tidings                 |
|                                       |
|  +---------------------------------+  |
|  | Set up Tidings                  |  |  h1
|  | Create your account with a      |  |  intro, text-base text-fg-muted
|  | passkey. You'll need the setup  |  |
|  | token from your deployment.     |  |
|  |                                 |  |
|  | Your name                       |  |  label
|  | +-----------------------------+ |  |
|  | |                             | |  |  48 px, autocomplete="name"
|  | +-----------------------------+ |  |
|  | Shown in Settings.              |  |  helper
|  |                                 |  |
|  | Setup token                     |  |  label
|  | +---------------------------+---+ |
|  | | ••••••••••••              | O | |  password field + Show/Hide (44 x 44)
|  | +---------------------------+---+ |
|  | The SETUP_TOKEN secret you set  |  |  helper
|  | when you deployed Tidings.      |  |
|  |                                 |  |
|  | [      Create passkey         ] |  |  primary, 48 px
|  | Already set up? Sign in         |  |  text link -> /login (44 px)  [see note]
|  +---------------------------------+  |
|              (inset-bottom)           |
+---------------------------------------+
```

Note on "Already set up? Sign in": shown only so a visitor who lands here by mistake has a way out; when a user exists the route redirects to `/login` anyway (TID-007 AC5). Keep it, it costs one line.

### Fields

| Field | Control | Attributes | Validation (on submit) |
|---|---|---|---|
| Your name | `input type="text"`, label "Your name", helper "Shown in Settings." | `autocomplete="name"`, `autocapitalize="words"`, `spellcheck="false"`, `enterkeyhint="next"` | Trim. Empty: "Enter your name." Over 64 characters: "Use 64 characters or fewer." (No `maxlength`: it silently truncates a paste.) |
| Setup token | `input type="password"`, label "Setup token", helper "The SETUP_TOKEN secret you set when you deployed Tidings." | `autocomplete="off"`, `autocapitalize="none"`, `autocorrect="off"`, `spellcheck="false"`, `enterkeyhint="go"`, `data-1p-ignore`, `data-lpignore="true"` | Trim. Empty: "Enter your setup token." No format check on the client (the server decides; a client check would reveal the length rule). |
| Show / Hide | Icon button inside the field's right edge, 44 x 44, `Eye` / `EyeOff` | `type="button"`, `aria-label="Show setup token"` / `"Hide setup token"`, `aria-pressed` reflects shown | Toggles `type` between password and text. Resets to hidden when the step changes or the page unloads. |

Enter in either field submits. The setup token is never written to storage, the URL, a query cache or logs. It is held in component state and dropped when step 2 appears.

### Primary action

Label "Create passkey". It runs, in order: `POST /api/auth/setup/options` with `{ setupToken, displayName }`, then `navigator.credentials.create` with the options, then `POST /api/auth/setup/verify` with `{ setupToken, displayName, response, passkeyName }`.

`passkeyName` is a best-effort label so the later Settings list is readable: "Passkey on iPhone", "Passkey on Mac", "Passkey on Android", "Passkey on Windows", otherwise "Passkey". It can be renamed in Settings (TID-022).

---

## 2. Step 1 states

### 2.1 Checking whether setup is needed (loading)

On first load the app asks `GET /api/auth/session`. Until it answers, the card shows a skeleton: an `h1`-height bar (10 rem), two label bars, two input-shaped blocks (48 px, `bg-sunken`, `animate-skeleton`) and a button-shaped block. `aria-busy="true"` on the card, no text. If the answer is a redirect case (auth-common section 7) the user never sees the form. On failure: the "Couldn't reach Tidings" banner with a "Try again" button (auth-common section 3).

### 2.2 Passkey prompt in progress

Two phases with different labels, because the first is quick and the second is waiting on the person.

| Phase | Button label | Helper under the button (`role="status"`) |
|---|---|---|
| Asking the server for options, or verifying | Creating passkey... | (empty) |
| Device prompt is open (`credentials.create` pending) | Waiting for your passkey... | Follow the prompt on your device. |

```
|  | Your name                       |  |
|  | [ Matt                        ] |  |  readonly
|  | Setup token                     |  |
|  | [ ••••••••••••               ] |  |  readonly
|  |                                 |  |
|  | [ (o) Waiting for your passkey ]|  |  aria-busy, aria-disabled, 60% opacity, spinner
|  | Follow the prompt on your       |  |
|  | device.                         |  |
```

The in-flight pattern is auth-common 2.3. Pressing Escape does not cancel anything (the OS prompt owns that).

### 2.3 The user cancelled the passkey prompt

`navigator.credentials.create` rejects with `NotAllowedError` (cancel, dismiss, or the browser's timeout). This is not an error; the user chose it. Nothing was created on the server.

```
|  | +-----------------------------+ |
|  | | (i) Passkey setup was       | |  info banner, role="status"
|  | | cancelled. Try again.       | |
|  | +-----------------------------+ |
|  | Your name  [ Matt            ]  |  values kept
|  | Setup token [ •••••••••••••  ]  |
|  | [        Create passkey      ]  |  focus returns here
```

- Copy: **Passkey setup was cancelled. Try again.**
- Values in both fields are kept. Focus returns to the "Create passkey" button, so retrying is one key press or tap.
- Pressing the button again calls `setup/options` again (new challenge).

### 2.4 The device doesn't support passkeys

Two moments, both in auth-common section 5.

- **Known before the user acts** (no `PublicKeyCredential`, or insecure context): the form is replaced by the warning block "This browser can't use passkeys." / "Passkeys need a secure connection." There is no button. On `/setup` there is nothing else to offer: the setup token is not asked for.
- **Found out while trying** (`NotSupportedError`, for example no screen lock): the warning banner "This device can't use passkeys." with "Turn on a screen lock, or connect a security key, then try again." above the form, values kept, button available.

### 2.5 Wrong setup token

`403 invalid_setup_token`. Nothing was created and no passkey prompt was shown (the options call is the one that checks the token).

```
|  | Setup token                     |  |
|  | [ ••••••••••••            ] [O] |  |  2 px border-danger, aria-invalid
|  | (!) That setup token isn't      |  |  text-danger
|  | right. Check it and try again.  |  |
```

- Field error copy: **That setup token isn't right. Check it and try again.**
- Focus moves to the token field with its text selected, Show/Hide left as it was (so the user can reveal it to compare).
- The display name field is untouched.
- The same message is used whether the token is wrong or just mistyped; no hint about length.

### 2.6 Passkey could not be verified

`401 webauthn_failed` from `setup/verify` (bad signature, expired or already-used challenge after more than 5 minutes). Error banner:

- Copy: **We couldn't verify that passkey. Try again.**
- Values kept, focus to the primary button. Trying again fetches a new challenge.

### 2.7 Rate limited

`429 rate_limited` (10 setup attempts per IP per 10 minutes, or 30 per hour overall).

```
|  | +-----------------------------+ |
|  | | (!) Too many attempts. Try  | |  warning banner, role="alert"
|  | | again in 7 minutes.         | |
|  | +-----------------------------+ |
|  | [   Create passkey (disabled) ] |  aria-disabled
|  | Try again in 7 minutes.         |  helper, aria-describedby of the button
```

Copy and timing are in auth-common 3.1. When the wait is over: "You can try again now." and the button is enabled.

### 2.8 Other step 1 states

| State | Behaviour |
|---|---|
| Offline | Warning banner "You're offline. Connect to the internet to continue." Button `aria-disabled` with helper "You're offline." |
| Network error | "Couldn't reach Tidings. Check your connection and try again." Values kept. |
| Server error | "Something went wrong on our side. Try again." |
| `409 setup_unavailable` | Redirect to `/login` with "This Tidings is already set up. Sign in instead." |
| Very long name or token pasted | Input scrolls horizontally inside itself; the card does not widen. A long name is rejected only at over 64 characters. |
| 200% text zoom | Labels wrap, inputs stay 48 px minimum height (they grow), the card scrolls, the button stays under the fields. |

---

## 3. Step 1, desktop 1280 x 800

```
+-----------------------------------------------------------------------+
|                                                                       |
|                               Tidings                                 |
|                    +----------------------------+                     |
|                    | Set up Tidings             |                     |
|                    | Create your account ...    |                     |
|                    | Your name                  |                     |
|                    | [                        ] |                     |
|                    | Setup token                |                     |
|                    | [                      O ] |                     |
|                    | [      Create passkey    ] |                     |
|                    | Already set up? Sign in    |                     |
|                    +----------------------------+                     |
|                                                                       |
+-----------------------------------------------------------------------+
```

The card is 24 rem and vertically centred. Browser passkey UI appears as the browser's own dialog (Chrome, Edge, Safari) or may offer "use a phone or tablet", which is the browser's, not ours.

---

## 4. Step 2, transition

When `setup/verify` returns `201`, the card changes to the recovery codes step in place (no navigation, no redirect), the `h1` becomes "Save your recovery codes", and focus moves to it. The 10 codes are held in component state only (see section 6).

---

## 5. Step 2: save your recovery codes, phone 375 x 812

The goal is that the owner ends up with the codes saved somewhere, and cannot leave by accident. The ten codes are in the document immediately, no "reveal" tap (a reveal step adds a tap and protects only against a person standing behind them; the codes are useless without the matching instance).

```
+---------------------------------------+
|              (inset-top)              |
|               Tidings                 |
|  +---------------------------------+  |
|  | Save your recovery codes        |  |  h1 (focus lands here)
|  |                                 |  |
|  | +-----------------------------+ |  |  warning banner, TriangleAlert
|  | | (!) Save these now. This is | |  |  role="status"
|  | | the only time they're shown.| |  |
|  | +-----------------------------+ |  |
|  | If you lose your passkey, one   |  |  text-base text-fg-muted
|  | of these codes signs you in.    |  |
|  | Each code works once.           |  |
|  |                                 |  |
|  | +-----------------------------+ |  |  <ol aria-label="Recovery codes">, bg-sunken,
|  | | 1   K7Q2-M9XD-4TRP-8WZB     | |  |  rounded-md, p-3, font-mono text-base,
|  | | 2   3HFN-V6C0-JQ5E-A2YT     | |  |  each row min-h-10 (40 px), number muted
|  | | 3   ...                     | |  |  codes selectable (user-select: all per item)
|  | | ...                         | |  |
|  | | 10  ...                     | |  |
|  | +-----------------------------+ |  |
|  |                                 |  |
|  | [ Copy codes ] [ Download .txt ]|  |  two secondary buttons, each 44 high, 50% width
|  | (status line, role=status)      |  |  "Copied" / "Saved as ..." / error
|  |                                 |  |
|  | [x] I've saved these            |  |  checkbox row, 44 high hit area
|  |     Somewhere safe, like a      |  |  helper (aria-describedby)
|  |     password manager. They      |  |
|  |     won't be shown again.       |  |
|  |                                 |  |
|  | [        Continue (disabled)  ] |  |  primary, aria-disabled until ticked
|  | Tick the box to continue.       |  |  helper
|  +---------------------------------+  |
|              (inset-bottom)           |
+---------------------------------------+
```

The page scrolls (about 1.3 screens tall). The "I've saved these" row and Continue form a **sticky footer** inside the card column: `position: sticky; bottom: 0` with `bg-surface`, top `border-line`, padding bottom `env(safe-area-inset-bottom)`, in normal flow (the same pattern as the shell's bottom bar). This keeps the confirmation and Continue reachable by thumb while the codes scroll past. Desktop shows it all without scrolling and the footer does not stick visibly.

### 5.1 The codes list

| Aspect | Spec |
|---|---|
| Markup | `<ol aria-label="Recovery codes">` with ten `<li>`, each `<code>` in `font-mono`, upper case, `tabular-nums`. The number is a CSS counter in a muted column, not part of the selectable text. |
| Format | `XXXX-XXXX-XXXX-XXXX`, as returned by the API. Shown exactly as given; nothing is lower-cased, spaced or grouped differently. |
| Size | 16 px mono at 375 (about 182 px wide for 19 characters; fits the 295 px inner width), steps to 18 px from `md`. Never wraps; if 200% zoom makes it wider than the card it scrolls inside the list container (`overflow-x-auto`), not the page. |
| Colours | `text-fg` on `bg-sunken` (14.26:1 light, 13.86:1 dark); numbers `text-fg-muted` on `bg-sunken` (6.02:1, 7.44:1). No pure white or black. |
| Selection | One tap-and-hold selects a code. The list has `select-text`; tapping a row does nothing else. |
| Screen readers | The list is read as ten items. The better route is Copy or Download; the helper under the buttons says so for assistive tech via the buttons' accessible names. |

### 5.2 Copy and Download

| Button | Label | Accessible name | Result |
|---|---|---|---|
| Copy | Copy codes | Copy all 10 recovery codes | Writes the ten codes, one per line, nothing else, to the clipboard. Label changes to "Copied" with a `Check` icon for 4 s, and the status line says "Copied 10 codes." |
| Download | Download .txt | Download recovery codes as a text file | Saves `tidings-recovery-codes.txt` (below). Status line: "Saved tidings-recovery-codes.txt." |

Icons: `Copy` and `Download` (aria-hidden). Buttons are secondary style, 44 high, side by side at 375 (each about 145 px wide; labels do not wrap at normal size, and stack to full width if the label would wrap).

Download file content (plain text, UTF-8, `\n` line endings):

```
Tidings recovery codes
Created {YYYY-MM-DD} for {host}

Each code works once. Keep this file somewhere safe and private.

1. XXXX-XXXX-XXXX-XXXX
2. ...
10. ...
```

- Generated client side as a `Blob` and an `<a download>` click; no request. A `blob:` URL is revoked straight after.
- The CSP (spec 10.4) must allow `blob:` downloads; an anchor `download` needs no `connect-src`. If the engineer finds it blocked, the fallback is the `data:` route in a new tab, not weakening the policy.
- Clipboard failure (`navigator.clipboard` missing or rejected): status line, role `alert`, text **Couldn't copy. Select the codes and copy them by hand.** The codes stay selectable.
- Download failure (rare; some in-app browsers block it): **Couldn't download the file. Copy the codes instead.**
- Neither button is required before Continue. The checkbox is the confirmation (TID-007 AC3); using Copy or Download only changes the helper under the checkbox (below).

Helper text under the checkbox changes with what has been done, to nudge without forcing:

| Done so far | Checkbox helper |
|---|---|
| Nothing | Somewhere safe, like a password manager. They won't be shown again. |
| Copied or downloaded | You can get new codes later in Settings, but these won't be shown again. |

### 5.3 "I've saved these" confirmation

- `input type="checkbox"` with a visible 24 px box inside a 44 px high label row; the whole row is the hit area. Label text: **I've saved these**. Helper associated with `aria-describedby`.
- Unticked by default. Never remembered, never pre-ticked.
- Ticking it enables Continue (`aria-disabled` removed), changes the helper under Continue to nothing, and announces nothing else (the checkbox's own state is announced by the browser).
- Unticking disables it again.
- Continue while unticked: nothing happens, and a `role="status"` line says **Tick the box to continue.** (it is the helper text, already linked by `aria-describedby`, so screen readers hear it on focus; the status region repeats it on a press so the press is not silent).

### 5.4 Continue

- Label **Continue**. Runs `navigate('/all', { replace: true })` and drops the codes from state. After setup the user lands on `/all` (spec 11.1), which shows the empty state.
- No timeout. Nothing on this screen auto-advances, auto-dismisses or changes after a delay. There is no toast that could cover it (toasts are suppressed on this step).

### 5.5 Guarding against accidental loss

While the codes are on screen and the checkbox is **not** ticked:

| Risk | Guard |
|---|---|
| Reload, close tab, address-bar navigation | `beforeunload` handler is registered so the browser shows its own "Leave site?" confirmation. (The text is the browser's; it cannot be customised.) |
| Browser or system Back (and iOS swipe-back) | On entering step 2 the app pushes one extra history entry with `state: { setupCodes: true }`. A `popstate` landing before that entry is intercepted: the app re-pushes it and opens the **leave dialog** below. |
| Tapping outside, Escape | Nothing on this screen is dismissable that way. There is no modal and no scrim. |
| Accidental tap on Continue | It is inert until the box is ticked, so a stray tap never navigates. |
| Switching apps to a password manager | Nothing times out and no state is lost; the screen waits. |

Leave dialog (appears only on Back with the box unticked):

```
+---------------------------------------+
|///////////////////////////////////////|  scrim
|///+-------------------------------+///|
|///| Leave without saving?         |///|  role="alertdialog", aria-modal, bg-raised
|///| Your recovery codes won't be  |///|  rounded-lg, border-line (dark)
|///| shown again. You can make new |///|  initial focus: "Stay and save codes"
|///| ones later in Settings.       |///|
|///|                               |///|
|///| [   Stay and save codes     ] |///|  primary, 48 high
|///| [        Leave anyway       ] |///|  text button, 44 high
|///+-------------------------------+///|
+---------------------------------------+
```

- Title **Leave without saving?**; body **Your recovery codes won't be shown again. You can make new ones later in Settings.**; buttons **Stay and save codes** (primary, default focus) and **Leave anyway**.
- Escape and scrim tap choose "Stay and save codes". "Leave anyway" goes to `/all` (`replace`) and drops the codes. Focus on close returns to the checkbox.
- With the box ticked, the guards are off (the user has said they saved them) and Back just leaves to `/all`.
- "Make new ones later" relies on FR-AU-7 (regenerate recovery codes in Settings, TID-022), so the worst case of losing the codes is recoverable while the owner still has a passkey and a session.

### 5.6 Step 2 states

| State | Behaviour |
|---|---|
| Loading | None; the codes arrive with the `201`. The step is rendered only once they exist. |
| Error | None; there is no request on this step. |
| Offline | Works fully (everything is local). No offline banner is shown on this step. |
| Session cookie lost mid-step | Not detectable here; Continue goes to `/all` and the normal 401 flow applies. |
| Reduced motion | No animation on this step apart from the "Copied" label swap, which is instant. |
| Very narrow (320 px) | Copy and Download stack to full width; codes stay on one line (they fit in 270 px at 16 px mono, about 182 px). |
| No images | Not applicable; the screen has no images. |

---

## 6. Rules for the engineer on codes

1. Keep the ten codes in React component state (or a ref) only.
2. Do not put them in the TanStack Query cache, the persisted IndexedDB cache (FR-PW-3), `localStorage`, `sessionStorage`, history state, the URL or logs. The `setup/verify` mutation must set `gcTime: 0` and the result must be excluded from persistence.
3. Do not render them into `document.title` or `aria-label`s other than the list's own label.
4. `autocomplete="off"` on the form; the codes are text, not inputs.
5. Clear the state on Continue, Leave anyway and unmount.
6. The spec for 8.1 sets `Cache-Control: no-store` on API responses, which keeps them out of the HTTP cache.

---

## 7. Step 2, desktop 1280 x 800

```
+-----------------------------------------------------------------------+
|                               Tidings                                 |
|             +--------------------------------------+                  |
|             | Save your recovery codes             |                  |
|             | (!) Save these now. This is the only |                  |
|             | time they're shown.                  |                  |
|             | If you lose your passkey, ...        |                  |
|             | +----------------------------------+ |                  |
|             | | 1   K7Q2-M9XD-4TRP-8WZB          | |                  |
|             | | ...                              | |                  |
|             | +----------------------------------+ |                  |
|             | [ Copy codes ]  [ Download .txt ]    |                  |
|             | [x] I've saved these                 |                  |
|             | [            Continue              ] |                  |
|             +--------------------------------------+                  |
+-----------------------------------------------------------------------+
```

On desktop the card is wider (28 rem, `md:max-w-md`) so the list and buttons sit comfortably, and the sticky footer is a static footer. Height is about 780 px at 1280 x 800, so the page may scroll by a few lines; the card is vertically top-aligned on this step (not centred) so the heading stays visible. Keyboard: Tab goes through Copy, Download, the checkbox and Continue.

---

## 8. Focus order

Step 1: `h1` (programmatic only) then Your name, Setup token, Show/Hide setup token, Create passkey, Already set up? Sign in.

Step 2: `h1` (focus lands here on entry) then the codes list (not a tab stop; it is selectable text), Copy codes, Download .txt, I've saved these, Continue. In the leave dialog focus is trapped on "Stay and save codes" then "Leave anyway".

---

## 9. Exact copy

| Where | Text |
|---|---|
| Step 1 `h1` | Set up Tidings |
| Step 1 intro | Create your account with a passkey. You'll need the setup token from your deployment. |
| Name label, helper | Your name, Shown in Settings. |
| Name errors | Enter your name. / Use 64 characters or fewer. |
| Token label, helper | Setup token, The SETUP_TOKEN secret you set when you deployed Tidings. |
| Token error (empty) | Enter your setup token. |
| Token error (wrong) | That setup token isn't right. Check it and try again. |
| Show / hide labels | Show setup token, Hide setup token |
| Primary, idle | Create passkey |
| Primary, in progress | Creating passkey... / Waiting for your passkey... |
| Prompt helper | Follow the prompt on your device. |
| Cancelled | Passkey setup was cancelled. Try again. |
| Verify failed | We couldn't verify that passkey. Try again. |
| Unsupported (before) | This browser can't use passkeys. / Passkeys need a secure connection. (bodies in auth-common 5) |
| Unsupported (runtime) | This device can't use passkeys. Turn on a screen lock, or connect a security key, then try again. |
| Rate limited | Too many attempts. {Wait}. / You can try again now. |
| Offline, network, server | See auth-common 3 |
| Sign-in link | Already set up? Sign in |
| Step 2 `h1` | Save your recovery codes |
| Step 2 warning | Save these now. This is the only time they're shown. |
| Step 2 intro | If you lose your passkey, one of these codes signs you in. Each code works once. |
| List label | Recovery codes |
| Copy button, copied | Copy codes, Copied |
| Copy status | Copied 10 codes. |
| Copy failed | Couldn't copy. Select the codes and copy them by hand. |
| Download button | Download .txt |
| Download status | Saved tidings-recovery-codes.txt. |
| Download failed | Couldn't download the file. Copy the codes instead. |
| Checkbox | I've saved these |
| Checkbox helper | Somewhere safe, like a password manager. They won't be shown again. / You can get new codes later in Settings, but these won't be shown again. |
| Continue | Continue |
| Continue helper | Tick the box to continue. |
| Leave dialog | Leave without saving? / Your recovery codes won't be shown again. You can make new ones later in Settings. / Stay and save codes / Leave anyway |

## 10. ARIA labels

| Element | Attribute |
|---|---|
| Card | `<main>`, `aria-busy` only while loading the session check |
| Step 1 form | `<form aria-labelledby="setup-h1" noValidate>` (we render our own messages) |
| Show / Hide | `aria-label="Show setup token"` / `"Hide setup token"`, `aria-pressed` |
| Banner containers | `role="alert"` for errors and rate limit, `role="status"` for info and offline, present from first render |
| Primary button | `aria-disabled`, `aria-busy`, `aria-describedby` to the helper |
| Codes list | `<ol aria-label="Recovery codes">` |
| Copy | `aria-label="Copy all 10 recovery codes"` |
| Download | `aria-label="Download recovery codes as a text file"` |
| Status line | `role="status"`, present from first render |
| Checkbox | label "I've saved these", `aria-describedby` helper |
| Continue | `aria-disabled` until ticked, `aria-describedby` helper |
| Leave dialog | `role="alertdialog" aria-modal="true" aria-labelledby aria-describedby` |

## 11. Acceptance checks (UX review)

1. 375 x 812 and 1280 x 800, light and dark: step 1 default, in progress, cancelled, wrong token, rate limited, unsupported; step 2 default, copied, ticked, leave dialog. No horizontal scroll.
2. Using the virtual authenticator: complete setup, see 10 distinct codes in `XXXX-XXXX-XXXX-XXXX` form; Copy and Download both yield all 10 (TID-007 AC3).
3. Continue is inert until the box is ticked; ticking it lands on `/all`.
4. With the box unticked, reload shows the browser prompt, and Back opens the leave dialog. With it ticked, neither.
5. The codes appear nowhere in IndexedDB, `localStorage` or `sessionStorage` after the step.
6. Tap targets at least 44 x 44; sticky footer clears the home indicator (inset-bottom 34).
7. axe: no serious or critical violations in any state; `node docs/ux/check-contrast.mjs` exits 0.
