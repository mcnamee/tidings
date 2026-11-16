# Screen spec: app shell

Story: TID-006. Read with `../DESIGN_SYSTEM.md` (tokens, classes) and `../FLOWS.md` (navigation model). Colours below are token names.

The shell is everything around the screen content on authenticated routes: header, feed tree (drawer or sidebar), main area, optional bottom bar, offline banner and toast region. Auth screens (`/setup`, `/login`, `/recover`) do not use it (section 12).

---

## 1. Anatomy and landmarks

DOM order is also the Tab order.

```
<a  class="skip-link" href="#main">Skip to content</a>
<aside>/<nav> feed tree      sidebar at >=1024px (static)  |  drawer dialog <1024px (after the header in DOM, rendered only when open)
<header role=banner>         Menu or Back | h1 title | right actions
<div role=status>            offline banner (only when offline)
<main id="main" tabindex="-1">   screen content
<div  id="bottom-bar">       screen-supplied actions (only when a screen supplies them)
<div  id="toasts">           toast region (live regions)
```

Landmarks: one `banner`, one `navigation` labelled "Feeds and folders", one `main`, one `region` labelled "Notifications". The header title is the page's only `h1`. At >=1024 px the sidebar comes **before** the header in DOM so the skip link has something to skip; below 1024 px the nav only exists in the DOM while the drawer is open.

---

## 2. Phone, 375 x 812 (primary)

### 2.1 Default (a list screen, online, content loaded)

```
375 px
+---------------------------------------+  <- safe-area-inset-top (status bar, notch)
|                                       |
+---------------------------------------+  <- header, min 56 px, bg surface, bottom border
| [=]  All articles          [Unread v] |
+---------------------------------------+
|                                       |
|  main (bg canvas)                     |
|  screen content, 16 px gutters        |
|                                       |
|  (list rows ...)                      |
|                                       |
|                                       |
|           +-------------------------+ |  <- toast (when present), 12 px above bottom bar
|           | Marked 14 as read [Undo]| |
|           +-------------------------+ |
+---------------------------------------+
| [Mark all read]            [Refresh]  |  <- bottom bar, min 56 px, bg surface, top border
+---------------------------------------+
|                                       |  <- safe-area-inset-bottom (home indicator)
+---------------------------------------+
```

Header (left to right):

| Element | Spec |
|---|---|
| Menu button | 44 x 44 hit area at the left gutter, 24 px `Menu` icon. `aria-label="Open navigation"`, `aria-haspopup="dialog"`, `aria-expanded` true while the drawer is open, `aria-controls="nav-drawer"`. Shown below 1024 px on top-level screens. |
| Back button | Replaces Menu on sub-pages: 44 x 44, `ArrowLeft`, `aria-label="Back"` (see FLOWS 1.6). |
| Title | The page `h1`, `text-lg font-semibold`, single line, ellipsis when long, `min-w-0 flex-1`. At large text sizes it may wrap to 2 lines (`line-clamp-2`). |
| Right actions | 0 to 2 icon buttons, each 44 x 44, supplied by the screen. 8 px apart. Everything else goes in an overflow button (`Ellipsis`, `aria-label="More actions"`). |

Header is `position: sticky; top: 0`, always visible (decision: no hide-on-scroll in MVP, it hides the Menu control and complicates focus; revisit with the article screen).

The right-action slot, bottom-bar slot and the title are the only things a screen may change. Screens must not add their own sticky bars.

### 2.2 Drawer open

```
+---------------------------------------+
|///////////////////+-----------------+ |
|// dimmed page ////| Tidings    [ X ]| |  <- drawer header (56 px + inset-top)
|// (inert) ////////+-----------------+ |
|///////////////////| [#] All articles | |
|///////////////////|            128  | |  (current: bg accent-subtle, 3 px accent bar)
|///////////////////| > [F] Tech   34 | |
|///////////////////| v [F] News   12 | |
|///////////////////|     [r] BBC   8 | |
|///////////////////|     [r] Guardian| |
|///////////////////|          4      | |
|///////////////////| [r] Daring Fire.| |
|///////////////////|             1   | |
|///////////////////| [r] xkcd        | |  (zero unread: text-fg-muted, no count)
|///////////////////| [!] Some Blog   | |  (failing: warning icon)
|///////////////////|                 | |
|///////////////////+-----------------+ |
|///////////////////| [+ Add feed]    | |  <- footer, pinned, thumb zone
|///////////////////| [Manage][Setting| |
|///////////////////+-----------------+ |
+---------------------------------------+
   scrim (bg-scrim)   drawer: min(86vw, 320px) = 320 px at 375
```

(The wireframe is schematic; counts sit right-aligned on the same row as the name, never below it.)

Drawer anatomy:

| Part | Spec |
|---|---|
| Container | `role="dialog" aria-modal="true" aria-label="Navigation"`, `id="nav-drawer"`, left edge, full height, `bg-raised shadow-raised`, plus `border-r border-line` in dark. Width `min(86vw, 20rem)`. Internal padding respects `safe-area-inset-left/top/bottom`. |
| Header row | Wordmark "Tidings" (`text-lg font-semibold`, a `span`, not a heading) and a Close button (44 x 44, `X`, `aria-label="Close navigation"`). |
| Tree | Scrolls on its own (`overflow-y-auto overscroll-contain`). Contents in section 3. |
| Footer | Pinned. "Add feed" is a full-width primary button, 44 px high minimum, above two secondary buttons "Manage" and "Settings", each 44 px high and half width. All primary navigation actions are in the bottom third. |
| Scrim | `bg-scrim`, covers the rest of the viewport, `aria-hidden="true"`. |

Drawer rules:

1. **Open**: Menu button click or Enter/Space. Pushes one history entry (`state: { drawer: true }`) so system Back closes it.
2. **Initial focus**: the Close button.
3. **Focus trap**: Tab and Shift+Tab cycle only through the drawer's focusable elements (Close, tree rows and chevrons, footer buttons). The rest of the app is `inert` (and `aria-hidden` on older browsers). Body scroll is locked with a class on `html`, not an inline style.
4. **Close** by: Escape; tap on the scrim; Close button; choosing any destination link or footer action; system Back; viewport growing to 1024 px or wider (the sidebar takes over).
5. **Focus on close**: returns to the Menu button, **except** when closing because of navigation, in which case focus goes to the new screen's `h1` (FLOWS 1.7).
6. **No swipe gestures in MVP.** Swipe-left-to-close moved to TID-035 (Later, M2): swipe past 40% of the width or flick, popping the history entry the drawer pushed. Swiping from the screen edge to open is deliberately not offered (it collides with the iOS Safari back gesture). Every way to close has a button or key.
7. **Motion**: 200 ms slide and fade; none under `prefers-reduced-motion` (design system section 7).
8. Opening the drawer never refetches; it shows cached folders and counts and revalidates quietly.

### 2.3 Offline

```
+---------------------------------------+
|                                       |  inset-top
+---------------------------------------+
| [=]  All articles          [Unread v] |
+---------------------------------------+
| (i) You're offline. Showing saved     |  <- banner: bg warning-subtle, text warning-subtle-fg,
|     articles.                         |     WifiOff icon, text-sm, min 40 px, sticky under header
+---------------------------------------+
|  cached list, fully usable ...        |
```

- Appears within 1 s of the browser `offline` event or a failed request with no response; disappears on `online` and a successful request. Not dismissible.
- `role="status"` (polite): announced once on appearing; the removal is not announced (quiet).
- Any mutation attempted while offline fails fast and shows an error toast "You're offline. That change wasn't saved." (spec FR-PW-3: nothing is queued).
- Controls that cannot work offline (Add feed button, Import file button, Refresh) are `aria-disabled="true"` with helper text where there is room; they stay focusable so a screen reader can find out why.

### 2.4 Toast region

```
+---------------------------------------+
|                                       |
|  +---------------------------------+  |  <- 16 px gutters, max width 28 rem, centred
|  | Marked 14 as read       [ Undo ] |  |     bg toast, text toast-fg, rounded-md, shadow-raised
|  +---------------------------------+  |     message left, action right (44 px high), optional X
|  (12 px)                              |
+---------------------------------------+  <- bottom bar top edge (or inset-bottom + 12 px if none)
```

| Aspect | Rule |
|---|---|
| Position | Bottom centre of the main column, 12 px above the bottom bar, or above `safe-area-inset-bottom` + 12 px when there is no bar. Never overlaps the bar. |
| DOM | Two persistent regions inside `#toasts`: one `aria-live="polite" role="status"` for info, success and undo; one `role="alert"` for errors. Region elements exist from first render (so the first message is announced); only their children change. |
| Content | Message (`text-base`, up to 2 lines then ellipsis for display; full text in the DOM), optional text button action (min 44 x 44, `text-toast-action`, `font-medium`), close X (44 x 44) on error toasts. |
| Duration | Info and success 4 s. Undo 5 s (FR-RD-9). Error 8 s. The timer pauses while the toast has hover, focus or touch, and resumes afterwards. Errors also have a close button. A toast with an action is never shorter than 5 s. |
| Stacking | One toast on screen at a time. A new info or success toast replaces the visible one. A visible **Undo** toast is never replaced by an info toast (the info toast waits, queue of 1, newest wins). Errors replace anything except an Undo toast; they queue behind it. |
| Keyboard | The action button and close are in the normal Tab order after `main` and the bottom bar. Escape dismisses a focused toast. |
| Motion | Slide up 12 px and fade, 200 ms; instant under reduced motion. |
| Undo behaviour | Pressing Undo runs the action, dismisses the toast and announces the result ("Undone"). |
| Undo fails | The Undo toast is dismissed and an **error** toast shows "Couldn't undo. Your change was kept." (8 s, close button, no action). It must not use the generic "Something went wrong. Try again.": the Undo button is gone, so "Try again" would point at nothing. The original action stays applied, so the copy is accurate for every Undo (for example mark all as read); the user can reverse it by hand (mark as unread). Offline, the offline copy still applies. |

Toast API the engineer should build (names are a suggestion): `toast.info(message)`, `toast.success(message)`, `toast.error(message)`, `toast.undo(message, onUndo)`.

---

## 3. Feed tree content (drawer and sidebar)

One component, two containers.

```
+------------------------------------+
| [#]  All articles             128  |  <- link, current item styled
| [>]  [F] Tech                  34  |  <- chevron button | folder link | count
| [v]  [F] News                  12  |
|          [r] BBC News           8  |  <- feed link, indented 40 px
|          [r] The Guardian       4  |
| [r]  Daring Fireball            1  |  <- loose feeds, no chevron, same left edge as folders
| [r]  xkcd                          |  <- zero unread: dimmed
| [!]  Some Blog                     |  <- failing: TriangleAlert icon, name
+------------------------------------+
```

| Element | Spec |
|---|---|
| Order | "All articles", then folders A to Z (case-insensitive), then loose feeds A to Z. Feeds inside a folder A to Z. |
| Row | Minimum 44 px high, `text-base`, 16 px horizontal padding, icon 20 px, 12 px icon-to-label gap. |
| Row (All, feed) | One `a` element: icon, label, count. |
| Row (folder) | Two controls side by side. The chevron `button` (44 x 44, `aria-expanded`, `aria-controls` the feed list, `aria-label="Expand Tech"` / `"Collapse Tech"`) toggles. The rest is an `a` to the folder list. The two do not overlap. |
| Count | Right aligned, `text-sm tabular-nums`, `text-fg-muted` (or `accent-subtle-fg` on the current row). `999+` above 999. Hidden when zero. |
| Zero unread | Label `text-fg-muted`, no count. Only in unread-only mode (FR-RD-2). If the setting "Hide feeds with no unread" is on, these rows are not rendered, except the current one and any folder that still has an unread child. |
| Current item | `aria-current="page"`, `bg-accent-subtle text-accent-subtle-fg`, 3 px `accent` bar at the left edge. Folder rows are current only on the folder list itself; feed rows inside an open folder are current on the feed list. |
| Failing feed | A `TriangleAlert` icon in `text-warning` replaces the `Rss` icon, with `role="img"` and `aria-label="This feed has problems"`. The row is otherwise normal. |
| Dead or gone feed | Same marker (the Manage screen explains the state). |
| Long names | Single line, ellipsis (`truncate`), count never shrinks. Folder names are at most 64 characters; feed titles may be much longer. Full name is in the accessible name. |
| Accessible name per link | Visible text plus count, for example "Tech, 34 unread". The label contains the visible text so voice control works. |
| Expand state | Remembered per device (`localStorage['tidings.navOpen']`, a list of folder ids). The folder that contains the current feed opens automatically. Expanding is animated 200 ms (`grid-template-rows`) or instant under reduced motion. |
| Feed icon | A generic `Rss` icon for every feed. No favicons in MVP: fetching them costs requests and leaks reads (spec 9, Q9). |

Tree states:

| State | What the user sees |
|---|---|
| Loading, no cache | "All articles" row with no count, then 6 skeleton rows (icon block + a name bar of varying width), `bg-sunken`, pulsing. `aria-busy="true"` on the list. |
| Loading, cache present | Cached tree and counts immediately. Background revalidation is invisible: no spinner. |
| Empty (no subscriptions) | "All articles" row, then a short message and a button: "No feeds yet." / "Add a feed or import your OPML file." with "Add a feed" and "Import from Inoreader" as links. The drawer footer still shows. |
| Error, no cache | Message "Couldn't load your feeds." and a "Try again" button (44 px). "All articles" still works. |
| Error, cache present | Keep cached data. No error in the tree. (Counts may be a few minutes stale; the next refetch fixes them.) |
| Offline | Cached tree; same as online. Banner covers the explanation. |
| 300 feeds, 25 folders | Folders collapsed so the tree is about 30 rows. The tree scrolls on its own; the footer stays pinned. |
| Very long folder or feed names | Truncated as above. |

---

## 4. Tablet, 768 x 1024

Drawer behaviour is identical to the phone (the sidebar starts at 1024). Differences are only gutters and sizes.

```
768 px
+-----------------------------------------------------------+
| [=]  All articles                              [Unread v] |  header spans full width
+-----------------------------------------------------------+
|                                                           |
|            +-------------------------------+              |
|            |  content column, max 42 rem   |              |
|            |  (672 px), centred            |              |
|            |                               |              |
|            +-------------------------------+              |
|                                                           |
+-----------------------------------------------------------+
|          [Mark all read]          [Refresh]               |  bottom bar content aligned to the column
+-----------------------------------------------------------+
```

- The header background spans the full width. The Menu button stays at the left page gutter and the right-hand actions stay at the right gutter (a Menu button floating in the middle of the screen is hard to find). The title is left aligned next to Menu.
- The bottom bar background spans the full width; its buttons sit inside the 42 rem column.
- Toasts centre on the viewport, width 28 rem.
- Drawer width is still 320 px; the page behind is dimmed.
- Article title steps up to 36 px.

---

## 5. Desktop, 1280 x 800

```
1280 px
+--------------+------------------------------------------------------+
| Tidings      |  All articles                         [Unread v] [..]|  <- header (main width)
|              +------------------------------------------------------+
| [#] All  128 |                                                      |
| > [F] Tech 34|            +----------------------------+            |
| v [F] News 12|            | content column, 42 rem     |            |
|     BBC     8|            | centred in the main area   |            |
|     Guardian |            |                            |            |
| [r] Daring  1|            |                            |            |
| [r] xkcd     |            |                            |            |
| [!] Some Blog|            +----------------------------+            |
|              |                                                      |
|              |   [Mark all read]  [Refresh]   (bottom bar, centred) |
+--------------+------------------------------------------------------+
| [+ Add feed]                                                         |
| [Manage] [Settings]                                                  |
+--------------+
  sidebar 288 px, bg surface, right border line   main: rest
```

- Sidebar: `<nav aria-label="Feeds and folders">`, always visible, `position: sticky; top: 0; height: 100dvh`, tree scrolls inside it, footer pinned at the bottom. No close button, no scrim, no focus trap. Wordmark "Tidings" on top.
- The header lives in the main area only and has no Menu button; the title is left aligned to the content column.
- Bottom bar, if a screen supplies one, is centred on the content column (it is a toolbar, not full-width, so the actions stay close to the content).
- Toasts centre on the main area.
- Keyboard: Tab goes skip link, sidebar, header, main, bottom bar, toasts. Visible focus ring everywhere. The skip link jumps past the sidebar to `main`.
- Mouse and trackpad: hover shows a subtle row background (`@media (hover: hover)`), never the only cue.
- If the viewport shrinks below 1024 px the sidebar becomes the drawer and the Menu button appears; an open drawer state is not carried across.

---

## 6. Safe areas and tap targets

Required in `index.html`: `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`. Never disable zoom.

| Region | Inset used |
|---|---|
| Header | `padding-top: env(safe-area-inset-top)`. Left and right padding `max(1rem, env(safe-area-inset-left / right))` |
| Main | Left and right `max(1rem, env(safe-area-inset-left / right))`. No bottom padding rule for the bar: the bar is in the page flow, so content never sits under it. When there is no bar, `padding-bottom: env(safe-area-inset-bottom)` |
| Bottom bar | In normal page flow after `main`, `position: sticky; bottom: 0` (not fixed), `padding-bottom: env(safe-area-inset-bottom)` plus the 56 px bar. It sticks to the viewport bottom while the list scrolls and rests at the end of the page when the content is short. |
| Drawer | Top, left and bottom insets in padding; scroll area ends above the footer, footer has `padding-bottom: env(safe-area-inset-bottom)` |
| Toasts | `bottom: calc(var(--bottom-offset, 0px) + env(safe-area-inset-bottom) + 0.75rem)` where bottom offset is the bar height when a bar is present |
| Landscape phone (812 x 375) | Notch on the left or right is covered by the gutters; header stays 56 px; the drawer takes `min(86vw, 20rem)` and its content respects the left inset |

Tap targets (all minimum 44 x 44 px, in `rem` so they grow with text zoom):

| Control | Size | Notes |
|---|---|---|
| Menu, Back, header actions, Close | 44 x 44 (24 px icon) | 8 px apart |
| Drawer rows | full width x 44 min | |
| Folder chevron | 44 x 44 | separate from the folder link |
| Drawer footer buttons | full width x 44 min | |
| Bottom bar buttons | 44 high min, label + icon, at least 44 wide | |
| Toast action and close | 44 x 44 | |
| Offline banner | not interactive | |
| Skip link | 44 high when visible | |

---

## 7. Every shell state at a glance

| State | Header | Tree | Main | Notes |
|---|---|---|---|---|
| First load, no cache, online | Real title from the route, immediately | Skeleton | Screen's own skeleton | The shell is part of the app bundle: it renders before any data arrives. |
| First load, cache present | Title | Cached tree | Cached screen | Revalidates in the background. |
| Offline | Normal | Cached | Cached | Banner under header (2.3). |
| Offline and no cache | Normal | "All articles" only, with the error message | Screen's own offline empty state | Copy: "Nothing saved yet. Connect to load your articles." |
| Signed out or session ended | n/a | n/a | Redirect to `/login` | Copy on login (FLOWS 2.1). |
| Unknown route | Title "Page not found", Menu | Normal | "We couldn't find that page." with a link "Go to All articles" | `document.title` "Page not found - Tidings" |
| Route placeholder (TID-006) | Real title | Real tree (empty or cached) | `<p>` "This screen isn't built yet." | Not release copy; removed as each screen story lands. |
| JavaScript disabled | n/a | n/a | `<noscript>` text, see copy | Plain text on `bg-canvas`, no inline style needed (uses the stylesheet). |
| New app version waiting (TID-023) | Normal | Normal | Normal | Toast with action: "A new version is ready." "Reload". No timeout, close button present. |
| Large text (200%) | Grows, title may wrap to 2 lines | Rows grow | Reflows, no horizontal scroll | NFR-9. |
| Reduced motion | Same | Drawer and toasts appear instantly | Same | |
| Forced colours | Same | Same | Same | Focus ring and borders remain. |

Placeholder routes for TID-006 (every route in spec 11.1) use the titles in FLOWS 1.3. Each placeholder renders the real header, the drawer and a single paragraph.

---

## 8. Interactions summary

| Gesture or key | Result |
|---|---|
| Tap Menu | Opens drawer, focus to Close |
| Tap scrim, Escape, Close | Closes drawer, focus to Menu |
| Tap a destination in the drawer | Navigates, closes drawer, focus to the new `h1` |
| Tap folder chevron | Expands or collapses; drawer stays open |
| Android system Back / iOS swipe-back with drawer open | Closes the drawer |
| Tap Back in header | Parent screen (FLOWS 1.6) |
| Tab / Shift+Tab | Order per section 1; trapped inside the drawer while open |
| Enter on skip link | Focus moves to `main` |
| Tap toast action | Runs the action |
| Escape on a focused toast | Dismisses it |

No gesture is the only way to do something. Pull-to-refresh on lists has a button equivalent in the bottom bar.

---

## 9. Exact copy

| Where | Text |
|---|---|
| Wordmark | Tidings |
| Skip link | Skip to content |
| Menu button label | Open navigation |
| Close drawer label | Close navigation |
| Back button label | Back |
| More actions label | More actions |
| Drawer dialog label | Navigation |
| Nav landmark label | Feeds and folders |
| Toast region label | Notifications |
| All row | All articles |
| All row accessible name | All articles, 128 unread |
| Folder chevron | Expand Tech / Collapse Tech |
| Folder link accessible name | Tech, 34 unread |
| Feed link accessible name | BBC News, 8 unread |
| Zero unread accessible name | xkcd, no unread articles |
| Failing feed marker | This feed has problems |
| Footer: primary | Add feed |
| Footer: secondary | Manage, Settings |
| Tree empty heading | No feeds yet |
| Tree empty body | Add a feed or import your OPML file. |
| Tree empty links | Add a feed, Import from Inoreader |
| Tree error | Couldn't load your feeds. |
| Tree error button | Try again |
| Offline banner | You're offline. Showing saved articles. |
| Offline, no cache | Nothing saved yet. Connect to load your articles. |
| Mutation failed offline (toast) | You're offline. That change wasn't saved. |
| Generic error (toast) | Something went wrong. Try again. |
| Undo failed (toast) | Couldn't undo. Your change was kept. |
| Server error (inline) | Something went wrong on our side. |
| Rate limited (toast) | Too many requests. Try again in a minute. |
| Update available (toast) | A new version is ready. |
| Update action | Reload |
| Undo action | Undo |
| Toast close label | Dismiss |
| 404 title | Page not found |
| 404 body | We couldn't find that page. |
| 404 link | Go to All articles |
| Placeholder body | This screen isn't built yet. |
| `<noscript>` | Tidings needs JavaScript to run. Turn it on and reload. |
| Document title | `{Screen} - Tidings` (for example "All articles - Tidings"); app name only on first load before the route resolves |

Typography: sentence case everywhere, no exclamation marks, no emoji, plain verbs ("Add feed", not "Let's add a feed"). Curly or straight apostrophes are both fine; use straight (') for consistency with code strings.

---

## 10. Header title per route

| Route | Title |
|---|---|
| `/all` | All articles |
| `/folders/:id` | Folder name |
| `/feeds/:id` | Subscription title (custom title if set) |
| article routes | Feed title (the article's own title is in the page body) |
| `/manage` | Manage feeds |
| `/manage/add` | Add a feed |
| `/manage/import` | Import from OPML |
| `/settings` | Settings |
| `/setup`, `/login`, `/recover` | No header (auth layout). `h1` is in the card: "Set up Tidings", "Sign in", "Use a recovery code" (see `setup.md`, `login.md`, `recover.md`) |
| unknown | Page not found |

### 10.1 Loading and fallback titles

While a name is loading, the header never shows a placeholder word. "Folder" and "Feed" appear **only** as the `document.title` fallback while loading; the visible header shows a skeleton.

| Route | Header (visible) while loading | `document.title` while loading | After load |
|---|---|---|---|
| `/folders/:id`, `/folders/:id/a/:entryId` | Skeleton bar, 8 rem wide, `bg-sunken`, pulsing, `aria-busy="true"` on the `h1` | Folder - Tidings | `{Folder name} - Tidings` |
| `/feeds/:id`, `/feeds/:id/a/:entryId` | Skeleton bar, 8 rem wide | Feed - Tidings | `{Feed title} - Tidings` |
| `/all`, `/all/a/:entryId` | "All articles" (static) | All articles - Tidings | same |
| `/manage`, `/manage/add`, `/manage/import`, `/settings` | Static title from the table above | `{Title} - Tidings` | same |
| Folder or feed not found (404 from API) | "Page not found" | Page not found - Tidings | |
| Name request fails, no cache | "Couldn't load" in `text-fg-muted` is **not** used; keep the skeleton and show the screen's own error state in main | Feed - Tidings | |

The skeleton `h1` still exists in the DOM with an `aria-label` of "Loading" so the page has one `h1` and focus-on-navigation has a target (FLOWS 1.7); the label is replaced by the real name on load. With a warm cache the name renders immediately and no skeleton is shown.

Auth titles (also the `document.title` prefix): "Set up Tidings", "Sign in", "Use a recovery code", each followed by " - Tidings" except "Set up Tidings", which is used as is.

---

## 11. Acceptance checks for the shell (UX review will use these)

1. At 375 x 812, light and dark: header 56 px plus inset, Menu button 44 x 44 at the left, title truncates with an ellipsis, no horizontal scroll.
2. Drawer: opens from the Menu button; first focus on Close; Tab and Shift+Tab never leave it; Escape and scrim tap close it; focus returns to Menu; every row, chevron and button is at least 44 x 44.
3. At 1024 x 768 and 1280 x 800: no Menu button, sidebar visible, no scrim, skip link works.
4. Offline (Playwright `context.setOffline(true)`): banner appears under the header with the exact copy and `role="status"`; cached content stays usable.
5. Toast: Undo toast stays at least 5 s, pauses on focus, is never covered by the bottom bar, and is announced by a screen reader.
6. Safe areas: with simulated insets (top 47, bottom 34) nothing important sits under them and the bottom bar clears the home indicator.
7. Reduced motion on: drawer and toasts have no movement.
8. axe: zero serious or critical violations on every route in both themes; every page has one `h1`.
9. Contrast of every token pair: `node docs/ux/check-contrast.mjs` exits 0.

---

## 12. Auth layout (outside the shell)

For `/setup`, `/login`, `/recover` (screen specs arrive with TID-007).

```
375 px
+---------------------------------------+
|                (inset-top)            |
|                                       |
|              Tidings                  |  wordmark, text-xl semibold, centred
|                                       |
|  +---------------------------------+  |
|  | card (surface, border, rounded- |  |  max width 24 rem, centred, 16 px gutters
|  | md)                             |  |
|  |  h1  Sign in                    |  |
|  |  ...                            |  |
|  |  [ Sign in with a passkey ]     |  |  full-width primary, 48 px high, in the lower half
|  +---------------------------------+  |
|                                       |
|                (inset-bottom)         |
+---------------------------------------+
```

No header, no drawer, no skip link needed (single column). One `h1`. Toast region and the theme still apply. On a short viewport the card scrolls; the primary button must remain reachable above the on-screen keyboard.
