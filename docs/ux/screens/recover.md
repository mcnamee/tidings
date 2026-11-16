# Screen spec: sign in with a recovery code (`/recover`)

Story: TID-009 (FR-AU-4; spec 8.3, 10.1, 10.7). Read with `auth-common.md` and `login.md`. Colours are token names. Also specifies the persistent "Add a new passkey" banner shown in the shell after recovery (section 4).

Used when the passkey is lost. The person has a printed or saved list of codes, so the design favours forgiving input (any case, with or without dashes) and calm, vague errors.

---

## 1. Phone 375 x 812: default

```
+---------------------------------------+
|              (inset-top)              |
|                                       |
|               Tidings                 |
|                                       |
|  +---------------------------------+  |
|  | Use a recovery code             |  |  h1
|  | Enter one of the 10 codes you   |  |  text-base text-fg-muted
|  | saved when you set up Tidings.  |  |
|  | Each code works once.           |  |
|  |                                 |  |
|  | Recovery code                   |  |  label
|  | +-----------------------------+ |  |
|  | | XXXX-XXXX-XXXX-XXXX         | |  |  48 px, font-mono, placeholder muted
|  | +-----------------------------+ |  |
|  | Letters and numbers. Dashes     |  |  helper
|  | are optional.                   |  |
|  |                                 |  |
|  | [           Sign in           ] |  |  primary, 48 px
|  | Use a passkey instead           |  |  text link -> /login, 44 px
|  +---------------------------------+  |
|              (inset-bottom)           |
+---------------------------------------+
```

### Field

| Aspect | Spec |
|---|---|
| Control | `input type="text"`, label **Recovery code**, helper **Letters and numbers. Dashes are optional.**, placeholder `XXXX-XXXX-XXXX-XXXX` (an example, `text-fg-muted`) |
| Attributes | `autocomplete="off"`, `autocapitalize="characters"`, `autocorrect="off"`, `spellcheck="false"`, `inputmode="text"`, `enterkeyhint="go"`, `data-1p-ignore`, `data-lpignore="true"` |
| Look | `font-mono`, `uppercase` via CSS (display only; the typed value is never rewritten as the person types, so the caret never jumps and pasting works) |
| Input | Accepts any case, spaces, dashes (AC1). A paste of the whole `XXXX-XXXX-XXXX-XXXX` or the 16 characters without dashes both work. Leading and trailing whitespace is trimmed. |
| Normalising | On submit the client sends the value as typed, trimmed; the server normalises (upper-case, no dashes). The client does not reformat it, so there is no client rule that could disagree with the server. |
| Client check | Only "not empty after removing spaces and dashes". Anything else is the server's call, so a malformed code and a wrong code look identical (nothing to learn). |
| Enter | Submits. |
| The code is never | stored, logged, put in the URL or kept after the request. The field is cleared on success. |

Primary: **Sign in**. Request: `POST /api/auth/recover` `{ code }`. Secondary: **Use a passkey instead**, a text link to `/login`, 44 px.

---

## 2. States

### 2.1 Checking the session (loading)

Same as `login.md` 2.1: skeleton card until `GET /api/auth/session` answers, then the redirect rules in auth-common 7.

### 2.2 Submitting

| Aspect | Spec |
|---|---|
| Button | **Signing in...** with spinner, `aria-busy`, `aria-disabled` |
| Field | `readonly` |
| Helper | none (no device prompt is involved) |

### 2.3 Empty submit

Field error (auth-common 2.2): **Enter a recovery code.** Focus to the field. Nothing is sent.

### 2.4 Wrong code

`401 invalid_recovery_code`. The same message covers wrong, already used, and mistyped (the server cannot and must not tell them apart).

```
|  | Recovery code                   |  |
|  | +-----------------------------+ |  |
|  | | K7Q2-M9XD-4TRP-8WZ          | |  |  2 px border-danger, aria-invalid, value kept
|  | +-----------------------------+ |  |
|  | (!) That code didn't work.      |  |  text-danger, CircleAlert, role="alert"
|  | Check it and try again. Each    |  |
|  | code works only once.           |  |
|  |                                 |  |
|  | [           Sign in           ] |  |
```

- Field error copy: **That code didn't work. Check it and try again. Each code works only once.**
- Focus moves to the field and **selects its text**, so the person can retype the whole code or edit a typo.
- The value is kept (not cleared). Errors never say how many attempts remain (the server doesn't expose it).
- The response time of right and wrong codes is the server's concern (AC3); the client adds no artificial delay and no animation that differs between the two cases.

### 2.5 Rate limited

`429 rate_limited` (10 attempts per IP per 10 minutes, or 30 globally per hour; AC4).

```
|  | +-----------------------------+ |
|  | | (!) Too many attempts. Try  | |  warning banner, role="alert"
|  | | again in 9 minutes.         | |
|  | +-----------------------------+ |
|  | Recovery code [ K7Q2-...     ]  |  editable
|  | [        Sign in (disabled)   ] |  aria-disabled
|  | Try again in 9 minutes.         |  helper
```

Copy and timing: auth-common 3.1. Because the global limit is shared, someone else's failed attempts can cause this; the copy stays neutral. When the wait ends: "You can try again now." and the button is enabled.

### 2.6 Success

`200 { user, mustAddPasskey: true }`. The session cookie is set and the code is burned.

1. Clear the field and drop the value from state.
2. `navigate(from ?? defaultView, { replace: true })`. Here `from` follows auth-common 7; default view is spec 11.1 (last list on this device, else `/all`). After recovery the owner is **not** pushed to Settings: they may want to read first, and the banner (section 4) is persistent.
3. Focus goes to the destination `h1`.

### 2.7 Other states

| State | Behaviour |
|---|---|
| Offline | Warning banner "You're offline. Connect to the internet to continue." Button `aria-disabled` with helper "You're offline." |
| Network error | "Couldn't reach Tidings. Check your connection and try again." Value kept. |
| Server error | "Something went wrong on our side. Try again." Value kept. |
| Passkeys not supported | The recover screen works normally (no passkey is involved). The banner after sign-in (section 4) switches to the unsupported variant. |
| Session expired | Not applicable on this screen (it is where a signed-out person arrives). If `reason: 'expired'` state is present because they came via login, no banner is repeated here. |
| Setup required | Redirect to `/setup`. |
| Already signed in | Redirect to the default view. |
| Very long paste (for example 500 characters) | The field scrolls; the server rejects it as wrong. Nothing special. |
| 200% text zoom | Labels and helpers wrap; field is 48 px or taller; no horizontal scroll. |
| Lost codes as well | See footnote below. |

Footnote under the card, shown when TID-021 (README break-glass runbook) exists: text link **Lost your codes too?** opening the README section. Until then, omit it. (Question for PM below.)

---

## 3. Desktop 1280 x 800

```
+-----------------------------------------------------------------------+
|                               Tidings                                 |
|                    +----------------------------+                     |
|                    | Use a recovery code        |                     |
|                    | Enter one of the 10 codes  |                     |
|                    | you saved when you set up  |                     |
|                    | Tidings. Each code works   |                     |
|                    | once.                      |                     |
|                    | Recovery code              |                     |
|                    | [ XXXX-XXXX-XXXX-XXXX    ] |                     |
|                    | [         Sign in        ] |                     |
|                    | Use a passkey instead      |                     |
|                    +----------------------------+                     |
+-----------------------------------------------------------------------+
```

Card 24 rem, centred on both axes. Paste works with the keyboard; Enter submits.

---

## 4. After recovery: the "Add a new passkey" banner (in the shell)

Required by FR-AU-4 and TID-009 AC1: a persistent banner until a passkey has been registered in this session. It belongs to the shell (`app-shell.md` section 1), so it is specified here and listed in the shell anatomy.

```
375 px
+---------------------------------------+
| [=]  All articles          [Unread v] |  header
+---------------------------------------+
| (!) You signed in with a recovery     |  banner: bg warning-subtle, text on-warning-subtle,
| code. Add a new passkey so you        |  KeyRound icon, text-sm, py-3 px-4
| don't need another one.               |
| [ Add a new passkey ]                 |  button, 44 px high, full width at 375
+---------------------------------------+
|  list ...                             |
```

| Aspect | Spec |
|---|---|
| Position | Directly under the header, above the offline banner when both are present. It is in normal flow (not sticky), so it scrolls away with the content and never takes permanent vertical space, but it is at the top of every screen again until resolved. |
| Content | Icon, text **You signed in with a recovery code. Add a new passkey so you don't need another one.**, button **Add a new passkey** |
| Action | Link-button to `/settings#passkeys` (the passkey list and "Add a passkey" in Settings, TID-022) |
| Dismissal | None. It disappears when a passkey has been registered, and not before. (There is no close button: FR-AU-4 says persistent.) |
| ARIA | `role="status"` (polite), shown once, announced once on appearance, on first render after sign-in. The button is a normal tab stop in header-then-banner order, before `main`. |
| Not supported | If passkeys are unsupported on this browser the banner text becomes **You signed in with a recovery code. Open Tidings on a device that supports passkeys to add a new one.** and the button is omitted. |
| Contrast | `on-warning-subtle` on `warning-subtle`: 7.95:1 light, 9.75:1 dark. Button uses the secondary (outlined) style on the banner. |
| Desktop | Same banner, aligned to the content column, button auto width. |

Reload behaviour is a question for the PM and engineer (below): the flag has to come from the server, not only from the `recover` response, or the banner disappears on the first reload.

---

## 5. Focus order and landmarks

1. `h1` (programmatic only).
2. **Recovery code** field.
3. **Sign in**.
4. **Use a passkey instead**.

Errors keep focus in the field (selected). After a rate limit, focus stays where it was. After success, focus goes to the destination `h1`.

---

## 6. Exact copy

| Where | Text |
|---|---|
| `h1`, `document.title` | Use a recovery code, Use a recovery code - Tidings |
| Intro | Enter one of the 10 codes you saved when you set up Tidings. Each code works once. |
| Label | Recovery code |
| Placeholder | XXXX-XXXX-XXXX-XXXX |
| Helper | Letters and numbers. Dashes are optional. |
| Empty | Enter a recovery code. |
| Wrong | That code didn't work. Check it and try again. Each code works only once. |
| Primary, idle | Sign in |
| Primary, in progress | Signing in... |
| Secondary link | Use a passkey instead |
| Rate limited | Too many attempts. {Wait}. / You can try again now. |
| Offline, network, server | See auth-common 3 |
| Banner | You signed in with a recovery code. Add a new passkey so you don't need another one. |
| Banner action | Add a new passkey |
| Banner, unsupported | You signed in with a recovery code. Open Tidings on a device that supports passkeys to add a new one. |
| Break-glass link (when TID-021 lands) | Lost your codes too? |

## 7. ARIA labels

| Element | Attribute |
|---|---|
| Card | `<main>`; form `aria-labelledby="recover-h1"`, `noValidate` |
| Field | label "Recovery code"; error and helper linked with `aria-describedby`; `aria-invalid` on error |
| Error | `role="alert"` container present from first render |
| Primary | `aria-disabled`, `aria-busy`, `aria-describedby` helper |
| Banner | `role="status"`; button name is its visible text "Add a new passkey" |

## 8. Acceptance checks (UX review)

1. 375 x 812 and 1280 x 800, light and dark: default, submitting, wrong code, rate limited, offline; and the shell with the banner.
2. A valid code in any case, with and without dashes, signs in (TID-009 AC1); the banner appears and persists across navigation and reload; it clears after a passkey is registered.
3. The same code again shows the wrong-code message (AC2) and the text is identical for an unknown code (AC3).
4. The 11th attempt in 10 minutes shows the rate-limit banner with a wait time (AC4).
5. The field is 48 px high; focus lands in it with text selected after an error; axe shows no serious or critical violations.
