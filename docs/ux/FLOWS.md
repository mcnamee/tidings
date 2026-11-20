# Tidings navigation model and key flows

Status: designed for TID-006 (navigation model and flow-level journeys). Screen-level detail for each step lives in `docs/ux/screens/`; the shell is in `screens/app-shell.md`. Visual tokens are in `DESIGN_SYSTEM.md`.

---

## 1. Navigation model

### 1.1 Principles

- One place to go anywhere: the **feed tree** (All, folders, feeds). It is a drawer on phones and tablets and a permanent sidebar on wide screens. Same content, same order, same component.
- The header says where you are and offers one way to move: **Menu** on top-level screens, **Back** on sub-pages.
- Reading is a two-level journey: list, then article. Going back always returns to the same list at the same scroll position.
- Everything people do many times a day (read, next, mark read) is reachable with a thumb in the bottom half of the screen. Rare things (manage, import, settings) sit in the drawer footer.

### 1.2 Breakpoints

| Width | Feed tree | Header left control | Content |
|---|---|---|---|
| under 1024 px (phone, tablet) | Modal **drawer**, opened from the header Menu button | Menu | One column, centred, max 42rem on tablet |
| 1024 px and up | Permanent **sidebar**, 18rem | None (the sidebar is always there) | One column, centred, max 42rem, next to the sidebar |

768 px (tablet) changes only gutters and the article title size. There is no split view in MVP: list and article are separate screens at every width. Reasoning: the owner reads on a phone; a split view would be a second layout to build and test for a rare case. Revisit in M2 if the owner reads on a desktop.

### 1.3 Route map and chrome

Authenticated routes are inside the shell. Auth routes are not.

| Route | Header left | Header title (`h1`) | Right-hand actions (slot) | Bottom bar (slot) |
|---|---|---|---|---|
| `/setup`, `/login`, `/recover` | no shell: centred auth layout, no header, no drawer | | | |
| `/all` | Menu | All articles | Unread/All filter, overflow | Mark all as read, refresh |
| `/folders/:id` | Menu | Folder name | same | same |
| `/feeds/:id` | Menu | Feed title (custom title if set) | same, plus feed overflow | same |
| `/*/a/:entryId` | Back | Feed title | Open original | Previous, Mark read/unread, Next |
| `/manage` | Menu | Manage feeds | Add feed | none |
| `/manage/add` | Back | Add a feed | none | Primary action when keyboard is closed |
| `/manage/import` | Back | Import from OPML | none | none |
| `/settings` | Menu | Settings | none | none |
| unknown | Menu | Page not found | none | none |

The right-hand and bottom slots are provided by the shell and filled by each screen; this table is the contract for those later screen specs. Top-level destinations use Menu, sub-pages use Back. A screen never shows both.

### 1.4 Where things live

| Thing | Where | Notes |
|---|---|---|
| Unread counts | Feed tree rows (All, each folder, each feed) | A right-aligned number, `999+` above 999. Zero is not drawn; the row is dimmed instead (FR-RD-2). Counts never appear in the header. |
| Folders | Feed tree, alphabetical, collapsed by default | Chevron toggles; tapping the name opens the merged folder list. The folder holding the current feed is open. Open/closed state is remembered on the device. |
| Feeds without a folder | Feed tree, below the folders | Alphabetical |
| Failing feed marker | Feed tree row, a warning icon with text label for screen readers | FR-FH-2 |
| Add feed | Drawer footer (primary button) and Manage header | |
| Manage, Settings | Drawer footer | |
| Unread-only / All toggle | List header right slot | FR-RD-4 |
| Recommended sort toggle (TID-067) | List header right slot, beside Unread only, unread lists only. A pressed-state button with a sparkles icon: icon only below 640 px (44 px target, name "Recommended" for assistive tech, so the title keeps its room at 375 px), icon and label from 640 px. Pressed = Recommended, saved as the setting `listSort` and mirrored by a switch in Settings. When it cannot apply yet, a muted line above the list: "Recommended gets better as you read. Showing newest first for now." (under 20 signals) or "Recommended isn't available right now. Showing newest first." | FR-RD-3 |
| Mark all as read | List bottom bar | FR-RD-9. Bottom, because it is a frequent one-handed action. |
| Refresh | Pull to refresh on lists. Also in the bottom bar for non-touch users. | Refetches cached server data only (FR-RD-11) |
| Offline state | A banner directly under the header, on every screen | |
| Toasts (undo, errors) | Bottom of the screen, above the bottom bar | |

### 1.5 Drawer behaviour (summary; full rules in `screens/app-shell.md`)

- Opens from the Menu button. Also closes on Escape, backdrop tap, choosing a destination, and browser/system Back. Open and close are in the TID-006 scope; the drawer pushes one history entry while open (spec 11.1).
- Modal: focus is trapped and the page behind is inert.
- Swipe the open drawer left to close it (TID-035, all modes). Swipe from the left edge to open it only in the installed (standalone) app: in Safari the edge belongs to the browser's back gesture. In the installed app, an edge swipe on the article view goes back (TID-055). Every gesture has a button or key equivalent.
- Swipes continue from the finger. An edge swipe that opens the drawer keeps the same panel and finishes sliding to open with no second entrance animation; a swipe-close slides straight out. An article is a full-screen layer above the list it was opened from (the list stays mounted underneath, inert and hidden from assistive tech): dragging the article right shows the list moving in from 30% to the left while the dim fades; releasing past 35% (or a flick) finishes the slide and the list is there at the same scroll position, otherwise the article slides back. From 1024px the layer covers only the content column, the sidebar stays (no swipe on desktop).

### 1.6 Back behaviour

| From | Back (header button, browser back, Android back) goes to | Rule |
|---|---|---|
| Article, app has history | One history entry back: the list it was opened from, at the same scroll position | Next/previous inside the article use `replace`, so history is always `[list, article]`, never a stack of articles. Header Back and browser back are equivalent. (TID-006 AC9) |
| Article opened by a direct link or after reload (no history in the app) | The list **in the article's own route**: `/all`, `/folders/:id` or `/feeds/:id` for `/all/a/:entryId`, `/folders/:id/a/:entryId`, `/feeds/:id/a/:entryId` | Not "the feed the article belongs to": an article opened from a folder list returns to that folder. Navigate with `replace`. After that, Back leaves to wherever the user came from. |
| Add feed, Import, app has history | One history entry back (for example `/all` or the drawer's origin) | History first (TID-006 AC8). |
| Add feed, Import, opened directly (no history in the app) | `/manage`, with `replace` | Fallback only. |
| Drawer open | Closes the drawer | The drawer pushes one history entry while open |
| A list, Manage, Settings | Previous screen in history as normal | No custom stack |
| Login after sign-out | Back must not return into the app | Sign-out replaces history |

Scroll position is restored on returning to a list (React Router scroll restoration plus the cached infinite query, so the same pages are present).

### 1.7 Focus and announcements on navigation

- The document title is `Screen name - Tidings` and updates on every route change.
- After a route change (not after Back/Forward) focus moves to the `h1`, which has `tabindex="-1"`, so screen-reader and keyboard users start at the top of the new screen.
- After Back or Forward, the browser restores scroll and focus is left alone.

### 1.8 Where the app opens

**Decided (PM, 2026-11-16, spec 11.1).** `/` redirects to the last list viewed on this device, stored in `localStorage['tidings.lastList']` (one of `/all`, `/folders/:id`, `/feeds/:id`). It falls back to `/all` when nothing is stored, the value is malformed, or the folder or feed no longer exists (TID-018 AC11). "Default view" after sign-in (FR-AU-3) means the same target; after first-run setup the user lands on `/all`. Wrap storage access in try/catch like the theme (DESIGN_SYSTEM 9.4).

---

## 2. Key journeys

Notation: `[Screen]` is a screen, `-> ` is a user action, `(state)` is a notable state. Each journey ends in a defined place.

### 2.1 First sign-in (first run, story TID-007)

1. Owner opens the deployed URL. The app asks the session endpoint; with no users it returns `setupRequired`, so the app goes to **[Setup]** (no shell).
2. -> enters display name and setup token -> "Create passkey". The device passkey prompt appears.
   - (wrong token) inline error on the token field, nothing created.
   - (passkey cancelled) stay on Setup, message "Passkey setup was cancelled. Try again."
   - Full states and copy: `screens/setup.md`.
3. **[Recovery codes]** (second step of `/setup`, same route): ten codes shown once, with Copy and Download. "Continue" is inert until "I've saved these" is ticked. Back, reload and tab close are guarded while it is unticked.
4. -> Continue -> **[All articles, empty state]**: "No feeds yet", with two actions: "Import from Inoreader" (primary, goes to Import) and "Add a feed".

Returning sign-in: **[Login]** with one "Sign in with a passkey" button (discoverable credentials), "Lost your passkey?" link to **[Recover]**. Success lands on the remembered route after a session expiry, otherwise the last list (or `/all`). Detail: `screens/login.md`.

Lost passkey: **[Recover]** accepts one recovery code, signs in, burns it, and shows a persistent banner "Add a new passkey" linking to Settings (FR-AU-4). The banner sits in the shell under the header until the owner adds a passkey. Detail: `screens/recover.md`.

Session ended (any 401 while using the app): redirect to **[Login]** with the line "Your session ended. Sign in again." The previous route is remembered and restored after sign-in.

### 2.1a Sign in with an emailed link (TID-053, ADR 0016)

For a computer without the owner's passkey or recovery codes. Shown only when `GET /api/auth/session` returns `emailSignIn: true`. Layout, banners, offline and error messages follow `screens/auth-common.md`.

1. **[Login]**: under "Lost your passkey?", a second text link, **Email me a sign-in link** (44 px hit area). Tapping it reveals the email form in the same card. There's no new route, and focus moves to the field.
   - Field label **Email address**, `type="email"`, `autocomplete="email"`, `inputmode="email"`. Primary button **Email me a link** (48 px). Secondary text button **Use a passkey instead** hides the form again.
   - Sending: button label **Sending...**, disabled.
   - Sent (always the same after `202`, whatever the address): the form becomes a `role="status"` message. Heading **Check your email**. Text: **If that address is set up for Tidings, a sign-in link is on its way. It works once and expires in 15 minutes.** Text button **Send another link** (back to the form, address kept).
   - `400`: inline field error **Enter an email address.**
   - `429`: the shared rate-limit message from auth-common.
2. **Email** (plain text). Subject **Your Tidings sign-in link**. Body: "Use this link to sign in to Tidings: <link>", "It works once and expires in 15 minutes (requested <time> UTC).", "If you didn't ask for this, ignore this email. Nobody can sign in without the link."
3. **[Email sign-in]** `/login/email` (auth layout, title "Sign in"). The page strips `#token=` from the address bar on load and never signs in by itself.
   - Ready: `h1` **Sign in to Tidings**. Intro: **Tap the button to finish signing in on this device.** Primary button **Sign in** (48 px, not auto-focused).
   - Signing in: button label **Signing in...**, disabled. On success the app goes (`replace`) to the default view, as after a passkey sign-in.
   - `401 invalid_link`, or no token in the URL: `h1` **This link has expired**. Text: **Sign-in links work once and expire after 15 minutes. Ask for a new one.** Primary button **Back to sign in** goes to `/login`.
   - `404` (feature off): the same as `401`, but the text is **Email sign-in isn't available. Use a passkey or a recovery code.**
4. Email sessions can't manage passkeys or regenerate recovery codes. Those actions show the passkey re-auth prompt (copy owned by TID-022).

### 2.2 Import OPML from Inoreader (the switch, TID-016)

The first-run goal is to be reading within 15 minutes.

1. Entry points: the empty state ("Import from Inoreader"), **[Manage]** header menu, **[Settings]** Data section. All go to **[Import]**.
2. **[Import]** step 1, "Choose your file": short instructions to export OPML from Inoreader, then a "Choose OPML file" button (system file picker, `.opml` and `.xml`).
3. The browser parses the file locally. Step 2, **preview**: "Found 243 feeds in 18 folders. 3 already subscribed. 1 invalid." Lists the affected counts (for example feeds in several folders: first folder wins). Nothing is saved yet.
   - (not an OPML file / empty) error "That file doesn't look like an OPML export" with "Choose another file".
4. -> "Import 239 feeds" (primary, bottom of screen). Chunks are sent; a progress bar is shown.
5. Step 3, **progress**: "Fetched 120 of 243 feeds", polled every 5 s. The owner can leave at any time; fetching continues on the server. A "Start reading" button is available as soon as one feed has articles.
   - (some feeds fail) they are counted at the end: "12 feeds couldn't be fetched" with "See which" going to **[Manage]** filtered to problem feeds.
6. -> "Start reading" -> **[All articles]**.

Re-import is safe (idempotent): the preview shows everything as already subscribed.

### 2.3 Add a feed (TID-013)

1. Entry: drawer footer "Add feed", **[Manage]** header, empty state.
2. **[Add a feed]**: one URL field (pasted feed URL or website URL), optional folder picker, optional title. Primary "Add feed" button at the bottom of the screen.
3. Outcomes:
   - One feed found: subscribes, fetches (up to 10 s), then **toast** "Added Feed title" and goes to that feed's list. First fetch shows at most 10 items.
   - Several candidates: a short list to choose from ("We found 3 feeds on this site"), pick one, continue as above. JSON Feed candidates are shown disabled with "Not supported yet".
   - None found: inline error "We couldn't find a feed at that address."
   - Already subscribed: "You already follow this feed" with a link to it.
   - Limit reached (1,000): "You've reached the limit of 1,000 feeds."
   - Offline: the button is disabled with "You're offline" helper text.

### 2.4 Organise folders (TID-014)

Done on **[Manage]**, which lists folders and feeds with health.

- **Create folder**: "New folder" in the Manage header menu, name field, 1 to 64 characters, unique; inline error "You already have a folder with that name."
- **Rename folder**: row menu, "Rename".
- **Move a feed**: tap the feed row, "Move to folder", choose a folder or "No folder" (one folder per feed, FR-FO-2). Done in a bottom sheet in the lower half of the screen.
- **Rename a feed**: same row menu, "Rename" (empty resets to the feed's own title).
- **Delete a folder**: row menu, "Delete folder", confirm dialog: "Delete Tech? Its 12 feeds move out of the folder. Nothing is unsubscribed." Buttons "Delete folder" (destructive) and "Cancel". Toast afterwards.
- **Unsubscribe**: row menu, "Unsubscribe", confirm dialog: "Unsubscribe from Feed title? Your read history for this feed will be removed." Buttons "Unsubscribe" and "Cancel".
- The feed tree updates immediately (optimistic), rolling back with an error toast on failure.

### 2.5 Browse by folder or feed

1. Open the drawer (Menu). The tree shows All, folders, then loose feeds with counts.
2. Tap **All articles**, a folder name, or a feed. The drawer closes, the list opens, focus goes to the title.
3. Tap a folder's chevron to peek at its feeds without leaving the current list. The drawer stays open.
4. The list shows "Unread" by default (setting); the header toggle switches to "All" without losing position in the tree.
5. With nothing unread, the list shows "All caught up" with a button "Show all articles".

### 2.6 Read an article (TID-019)

1. **[List]** -> tap a row -> **[Article]** (route `/.../a/:entryId`). The article is marked read on open (if the setting is on) and the list row and counts update immediately (optimistic).
2. Read. The bottom bar offers Previous, Mark as unread/read, Next. "Open original" is in the header.
3. -> Next: replaces the article in place (history stays `[list, article]`), scroll resets to top. At the end of the loaded list the Next button loads more; at the very end it is disabled.
4. -> Back: return to the list at the same scroll position, with the read items now showing as read (or gone, in unread-only mode, only after the list is next refreshed, so rows do not jump away under the thumb).

Decision recorded here for the list spec: in Unread-only mode a row that has just been read stays in place until the user leaves and returns or pulls to refresh.

### 2.7 Mark as read

- **One article**: automatic on open, or the Mark as read/unread button in the article bottom bar and on a list row's overflow. Optimistic within 100 ms; on failure the state rolls back and a toast says "Couldn't update that article. Try again."
- **Mark all as read**: list bottom bar, "Mark all as read".
  - 20 or fewer articles: happens immediately, with a toast "Marked 14 as read" and an Undo button for 5 seconds.
  - More than 20: confirm sheet in the lower half: "Mark 84 articles as read?" with "Mark 84 as read" and "Cancel", then the same toast with Undo.
  - More than 1,000: the confirm step applies, and the toast has no Undo (spec FR-RD-9).
  - Only articles that were in the view when it loaded are affected.
- Counts in the feed tree update with the action and are reconciled by the next count refetch.

---

## 3. Cross-cutting states every flow must handle

| State | Behaviour | Copy |
|---|---|---|
| Offline | Banner under the header; cached lists and counts still show; any change fails with a toast; actions that need the network are disabled with a reason. | "You're offline. Showing saved articles." and "You're offline. That change wasn't saved." |
| Session ended | See 2.1. | "Your session ended. Sign in again." |
| Server error | Inline retry in place of the failing region; never a blank screen. | "Something went wrong on our side." with "Try again" |
| Loading with cache | Show cached content instantly and refresh quietly: no spinner, no flash. | |
| Loading without cache | Skeleton rows shaped like the final content. | |
| Rate limited | Toast with the wait time where known. | "Too many requests. Try again in a minute." |

## Native-feel transitions (TID-058, owner request 2026-11-18)

- **Pull to refresh (TID-064, reworked by TID-069):** below `lg` the document (window) is the scroller, so a status-bar tap scrolls to the top and iOS gives the real rubber band at both ends, momentum and flicks included. The header and bottom bar are `position: fixed` (safe areas included; fixed elements do not move during the bounce, so the TID-058 gap above a sticky header cannot return) and the content carries matching padding (`--header-h` and `--bar-h`, measured and published by the shell). On iOS the pull distance is `-window.scrollY` (it goes negative while overscrolled): "Pull to refresh" shows above the list as it is revealed, "Release to refresh" past 64 px while a finger is down, and lifting the finger refreshes (a fling that bounces with no finger down never does). Where `scrollY` cannot go negative (Chromium, Android) the old touch pull remains: the content follows the finger with resistance (CSSOM transform) and springs back. While refreshing on iOS the indicator sits in the flow at the top. From `lg` the document scrolls with `overscroll-behavior-y: none`, as before.
- **Opening an article:** the article slides in from the right (300 ms, iOS ease) while the list shifts left by 30% and dims; the Back button plays the reverse; the edge swipe-back finishes the same slide. Next/Previous slide the body 32 px with a fade (180 ms). No animation on a direct link, a reload, reduced motion, or at desktop width.

- **Bottom bounce (TID-063, superseded by TID-064):** the JS bottom stretch is gone; the native container bounces at the end.
- **End of list (TID-063, TID-069):** once no more pages can load, space as tall as the viewport minus the fixed header and bottom bar (`calc(100dvh - --header-h - --bar-h)`; 10 rem on desktop) follows the last row so the last articles can scroll fully out of view at the top and be marked read. The note is vertically and horizontally centred in that space: check icon and "You're all caught up" when everything above is read, otherwise "End of list". None while more pages load or on empty states.
- **Scroll root (TID-069, replaces the TID-064 scrolling `main`):** mark-read-on-scroll and the infinite-scroll sentinel observe the viewport (rows count once they pass the header's bottom edge, via `rootMargin`).
- **Article scroll (TID-069):** below `lg` the open article is the document scroller (a status-bar tap scrolls it to the top), with its own fixed header and bottom bar. The list underneath is frozen: taken out of the flow (`position: fixed`) with its content shifted up by the scroll it had (`top: -scrollY`), and Back, the Back button and the swipe-back all put it back and restore that scroll exactly. The slide-in/out and the swipe-back move the layer's content, header and bar together (a transform on a shared parent would make the fixed bars scroll away); the list underneath still shifts from -30% and the scrim fades. From `lg` the article layer is a fixed box beside the sidebar with its own scroller, as before.
- **A different list starts at the top (TID-069):** choosing All, a folder or a feed (menu, sidebar, Manage links) resets the scroll to 0; Back from an article of the same list does not.
- **Edge swipe opens the menu (TID-069):** in the installed app the drawer swipe starts at any x, including the very edge, still horizontal-locked and never taking a vertical scroll. Because the installed app never pushes history for the drawer or for list-to-list links (drawer links, Manage/Add/Import links to a feed or All, a feed added from Add feed all replace), a list has no entry behind it and iOS's own edge swipe-back has nothing to do there. (The article part of this is superseded by TID-070 below.)
- **No history in the installed app (TID-070, owner request 2026-11-20):** iOS's own edge swipe-back animates the page away over a blank snapshot (the frozen `position: fixed` list does not show in it), so in the installed app (`isStandalone()`) the article leaves no entry for it to go to. Opening an article from a row **replaces** the list's entry; Back and the swipe-back **replace** the article with its parent list (the path without `/a/:id`, same `?state=`), after the usual slide-out, and the list's freeze/restore returns its exact scroll (no heading focus on the list after coming back). The article swipe-back starts from the very edge (x=5; still horizontal-locked, 35% or flick to commit, list parallax underneath, ignored inside `pre, table`). Manage/Settings/list links to sub-pages replace too, and a sub-page's Back goes to its parent path with replace, so nothing in the installed app leaves an entry behind. In a browser tab nothing changes: opening pushes and the browser Back works. Previous/Next always replace. A user-initiated open (row tap, Previous, Next) is marked in the navigation state (`lib/articleNav.ts`, with an ID new on every page load), so engagement `open` is sent once per such open, not for Back, and not for a reload of an article URL even though the open is now a REPLACE.
- **Focus rings only for the keyboard (TID-069):** `<html data-input="keyboard">` is set by Tab, arrows, Home/End, Page keys, Enter, Space or Escape and cleared by any pointer or touch; focus rings show only then (text fields always show theirs). Programmatically focused headings (`tabindex="-1"`) and `main` never show a ring, so a tap leaves none on the screen title or the Menu button.

## Launch screen (TID-059, owner request 2026-11-18)

- On a full load (browser open, reload, Home Screen launch) a full-screen splash shows the mark (accent, 72 px, gentle fade/scale in) with "Tidings" below on the surface colour, in the resolved theme and inside the safe areas. Minimum 1 s from navigation start (2 s until 2026-11-19; reduced once the native launch images, TID-065, covered the start) and until the first screen is ready, then a 250 ms fade out. Reduced motion: no animation, it is simply removed. Not shown on in-app navigation. Hidden from assistive technology.
