# Screen spec: Topic chips (All articles) and the Topics setting (`/settings/topics`)

Story: TID-078 (ADR 0021, spec FR-RD-13 and FR-ST-5). Designed before build, 2026-11-26. Depends on TID-077 (tags, `GET /api/topics`, `topicChips` setting) and on the TID-074/075 header, Filters panel and reveal drawers.

Two parts:

1. The **chip row** at the top of the All articles list.
2. The **Topics** setting, where the owner chooses which topics become chips and puts them in order.

Tokens, classes and the few additions this story needs (hide-scrollbar, edge fade, drag lift) are in `DESIGN_SYSTEM.md` section 12. Journeys are in `FLOWS.md` 2.8 and 2.9. Everything here is CSS classes and CSSOM only (no `style` attributes).

---

## Decisions in one place

| Decision | Choice | Why |
|---|---|---|
| Does the row stick under the header? | **No. It scrolls away with the list** (it is the first thing in the list's content, below the header's `--header-h` padding). | (1) The header is already a fixed glass stack (header, plus the offline banner when shown). A second fixed band costs another 52 px of a 812 px screen, 6% of reading space, for something used a few times a session. (2) Fixed elements do not move during the iOS rubber band; a *sticky* row does, which is the gap bug TID-069 removed. Putting the row inside the content avoids both: it bounces with the list, and it needs no new measured height in `--header-h`. (3) With no background of its own it slides under the glass and is blurred like any row, so it never adds a second seam. (4) Getting back to it is the native gesture, a status-bar tap. Choosing a chip scrolls the list to the top anyway, so the row is where the thumb expects it. |
| Chip tap and history | `replace`, like the "Unread only" switch (`setParams(..., { replace: true })`). | Back from the list leaves All articles instead of stepping through every chip. Back from an article still returns to the filtered list (URL carries `?topic=`). |
| Where is the chosen topic shown once the row has scrolled away? | In the header title: a small muted kicker "All articles" above the topic name, both inside the one `h1`. | The row is off screen mid-list, so without this you could not tell the list is filtered. The title already has two lines of room, so the header does not grow. |
| Left edge swipe (menu) vs a sideways-scrolling row | The row carries `data-swipe-ignore`, but **a touch that starts in the left 24 px edge zone (`SWIPE_EDGE_PX`) still opens the menu**. | A rightward drag inside the row means "scroll chips back", and must not open the drawer. A deliberate swipe from the very edge still does. Needs one small change in `useSwipe`, see the gesture section. |
| Selection cue | Filled accent pill with `accent-fg` text, versus an outlined pill; plus `aria-pressed="true"`. No check icon. | Shape and luminance change, not hue alone (WCAG 1.4.1), and no width change under the finger. |
| Reorder | Drag by a grip handle (pointer, touch) **and** visible "Move up" / "Move down" buttons on every chosen row. The grip is not a tab stop. | The buttons are the keyboard and screen reader path. Keeping the grip out of the tab order stops each row having five tab stops. |

---

## Part 1. Chip row on All articles

### 1.1 Phone 375 x 812, default (three topics chosen, "All" selected)

```
+---------------------------------------+
| (status bar, safe area, solid canvas) |
| [=]  All articles          [v/]  [=]  |  glass header 56 px + safe area
+---------------------------------------+  <- --header-h ends here
|  ( All ) ( AI ) ( Formula 1 ) ( UK po |  chip row, 52 px, no background
|  =====                                |   "All" filled (pressed), others outlined
+---------------------------------------+
| [img]  BBC News . 3 h                 |  first article row
|        Title of the article that ...  |
```

Chosen chip ("Formula 1"), list scrolled a little so the row is partly under the header:

```
+---------------------------------------+
| [=]  All articles          [v/]  [=]  |  h1 = kicker "All articles" (xs, muted)
|      Formula 1                        |       + topic name (lg, semibold)
+---------------------------------------+
|  ( All ) ( AI ) (=Formula 1=) ( UK p  |  pressed chip is filled and scrolled
|                                       |  into view
```

| Aspect | Spec |
|---|---|
| Placement | First child of the list's stretch region, after the pull-to-refresh indicator and before the rows. The pull indicator is above the row, so a pull drags the row down with the list. The row sits inside the column (`max-w-2xl` centred), full column width, no background, no border, no shadow. |
| Row box | `flex gap-0 overflow-x-auto px-4 pt-2 pb-1`, `scroll-px-4`, `overscroll-behavior-x: contain`, `touch-action: pan-x pan-y`, hidden scrollbar. Left and right padding follow the page gutter (`max(1rem, env(safe-area-inset-*))`). Content is `w-max` so it never wraps. |
| Chip hit area | A `button`, `min-h-11 min-w-11` (44 px), no visible background. |
| Chip visual | Inside the button a pill: `min-h-9` (36 px, grows with text size), `rounded-full`, `px-4`, `mx-1` (so pills are 8 px apart and hit areas touch), `text-sm font-medium`, `whitespace-nowrap`, vertically centred. |
| Visible chips | With Unread only on, a chip shows only while its topic has unread articles (owner, 2026-11-26). The pressed chip always stays; with no chip but "All" there is no row. With Unread only off every chosen chip shows. |
| Default chip | `bg-surface text-fg border border-line-strong`. Press: the `active:` overlay from DS section 7. |
| Selected chip | `bg-accent text-accent-fg border border-accent`, `aria-pressed="true"`. Exactly one chip is pressed. In forced-colors mode: `border-2` and `forced-color-adjust: none` with `Highlight` / `HighlightText`. |
| "All" chip | Always first, label **All**, accessible name **All topics**. Pressed when there is no valid `?topic=`. Tapping it removes the param (`replace`). |
| Order | "All", then `topicChips` in the owner's order. Names are the `GET /api/topics` names. |
| Overflow | Chips past the edge are reached by swiping sideways, with native momentum. The last chip may be cut off at the right edge, which is the hint. From 12 chips up the right edge also gets the fade (DS 12.2); a left fade shows once scrolled. No snap points (free scroll feels native). |
| Selected chip into view | On load, deep link and selection, the row scrolls so the pressed chip is centred, by setting the row's `scrollLeft` (not `scrollIntoView`, which can scroll the window under the header). Smooth unless reduced motion. |
| Desktop 1024+ | Same row at the top of the 42 rem column. With a mouse and no horizontal wheel the row also shows a 44 px scroll button at each end while that direction can scroll (chevron on a canvas-coloured fade). They are `aria-hidden`, out of the tab order, hidden on coarse pointers; keyboard users have the arrow keys. |
| Text zoom 200% | The pill grows (`min-h-9`, rem padding), the row grows with it. Nothing is clipped, the row still does not wrap. |

### 1.2 Chip interaction

- **Tap:** the selection fills at once (under 100 ms), `?topic=<id>` is set with `replace`, the window scrolls to 0 (instant), the list swaps to the new topic's data (skeleton if not cached). Focus stays on the chip. A polite sr-only status says **Showing Formula 1** (or **Showing all articles**). Focus is not moved to the `h1`: this is not a route change.
- **Keyboard:** the group is one Tab stop (roving tabindex on the pressed chip). Left and Right move focus between chips, Home and End jump to the ends, Enter or Space presses. Focus follows into view horizontally.
- **Landmarks:** `<div role="group" aria-label="Topics">` holding the buttons. Not a `nav`.
- **Deep link:** `/all?topic=formula-1` selects the chip and scrolls the row to it. An unknown or retired ID shows "All" pressed and removes the param (`replace`), with no toast.
- **Back from an article** restores scroll and the same chip (URL), as today.
- **Header title, document title:** with a topic chosen the `h1` reads "All articles" then "Formula 1" (kicker first in the DOM, so a screen reader hears "All articles Formula 1"). Document title: `Formula 1 - All articles - Tidings`.
- **Other filters:** the Filters panel and its dot behave as today. The chosen topic is not part of the Filters dot, because the chip row (or the header title) already shows it.

### 1.3 Gestures: the row and the left edge swipe

Below 1024 px in the installed app, `useSwipe` opens the menu on a rightward drag from any x (TID-069). A rightward drag inside the chip row, which scrolls the row back toward "All", would otherwise open the drawer. Rules:

1. The row has `data-swipe-ignore`. The drawer's `useSwipe` call passes `ignoreWithin: '[data-swipe-ignore]'`, so a touch that starts on the row is left to the row's own scroll.
2. **Exception:** `useSwipe` should skip the ignore check when the touch starts within `SWIPE_EDGE_PX` (24 px) of the left edge. The "All" pill starts 20 px from the edge (16 px gutter plus the button's 4 px), so a thumb dragging right from the bezel still opens the menu, even over the row. This is a one-line change in `begin()`: check `ignored(target)` only when `x > SWIPE_EDGE_PX`. Tests: a drag from x = 10 on a chip opens the menu; a drag from x = 100 on a chip scrolls the row and does not.
3. **Row at scrollLeft 0, drag right** (rubber band of the row): does nothing, not the drawer. Accepted: the edge exception is the way to the menu.
4. **Filters panel swipe** (swipe right on the page strip closes it): while a panel is open the page is inert, so the row does not take part (`data-swipe-ignore` is dropped while `panel !== 'off'` or inert is set).
5. **Pull to refresh:** a vertical pull that starts on the row works as anywhere else; a sideways move gives it up (as `usePullToRefresh` already does).
6. In a Safari tab (not installed) the edge belongs to the browser, so nothing changes there.
7. The row is not a scroll-chain trap: `overscroll-behavior-x: contain` stops the end of the row from starting the browser's back navigation in Chrome and from chaining into the page.
8. **No ancestor may narrow `touch-action`** (found on a real iPhone, 2026-11-26: the row scrolled in fits and starts). `touch-action` intersects down the tree and WebKit does not stop at a scroll container, so `html.swipe-nav { touch-action: pan-y }` took horizontal panning away from the row. Every root rule is now `pan-x pan-y` (still no pinch or double-tap zoom), and the row sets the same itself. Guarded by `apps/web/src/touchAction.test.ts` and an e2e check of every ancestor's computed value.

### 1.4 States

| State | What shows |
|---|---|
| **No topics chosen** (`topicChips` is empty) | No row at all, no placeholder, no hint on All articles. The list starts at the header padding as today. (Spec default.) |
| **Folder and feed views** | No row (spec: All articles only). A `?topic=` on those routes is ignored and removed. |
| **Topic names loading, nothing cached** (online) | A skeleton row of pills (`bg-sunken animate-skeleton`, 36 px high, widths 52, 48, 96, 80 px: one "All" pill plus up to three others, never more than the chosen count), `aria-hidden`, same box as the real row so nothing shifts. No spinner. |
| **Topic names cached** | The row appears immediately from cache (24 h) and refreshes quietly. |
| **Names unavailable: no cache and offline, or no cache and the request failed** | No row (no broken or empty chips). No error and no toast here; the list works as usual. The Topics setting shows its own error (Part 2). |
| **List loading after a chip tap** | The chips are already updated. Below them the list shows the existing skeleton rows (`Loading articles`, `aria-busy`). While `items` is empty and `nextCursor` is not null (a short or empty page), keep the skeleton rather than the empty state, then the existing "loading more" row once rows exist. |
| **Empty result** (`nextCursor` null, no items) | See copy below. The chip row stays above it, with the topic pressed. |
| **Offline** | The shared offline banner shows under the header as always, and pushes the row down (the header stack grows, `--header-h` is re-measured). The row stays and chips still work: a topic that was opened before shows its cached rows. A topic with no cached page shows the offline state below. Nothing is queued. |
| **Error on topic list** | The same "Something went wrong on our side." with "Try again" as other lists. The row stays so the owner can switch chip. |
| **Reduced motion** | The row's own scroll to the pressed chip jumps (no smooth scroll). No pill animation exists to remove. The edge fade toggles instantly. |

### 1.4a Copy

| Where | Text |
|---|---|
| Group label | **Topics** |
| First chip | **All** (accessible name **All topics**) |
| Live status on select | **Showing Formula 1** / **Showing all articles** |
| Header kicker | **All articles** |
| Empty, Unread only on | Title **Nothing unread in Formula 1**. Buttons (stacked, 44 px+): **Show read articles too** (sets `state=all`), **Show all topics** (clears the topic). |
| Empty, Unread only off | Title **No articles about Formula 1 yet**. Button **Show all topics**. |
| Offline, topic not saved | Title **This topic isn't saved on this device**. Body **Reconnect to load Formula 1.** Button **Show all topics**. |
| Mark all as read confirm (more than 20) | Title **Mark 84 Formula 1 articles as read?** Buttons **Mark 84 as read**, **Cancel**. |
| Mark all as read toast | **Marked 14 Formula 1 articles as read** with **Undo** (5 s). Other articles stay unread. |

The empty states use the plain `State` block (no random "caught up" art; that belongs to the all-read state of a whole list). "All caught up" is not shown for a topic, because an article tagged an hour from now may still arrive.

### 1.5 Wireframes: empty result and offline

```
+---------------------------------------+
| [=]  All articles          [v/]  [=]  |
|      Formula 1                        |
+---------------------------------------+
|  ( All ) ( AI ) (=Formula 1=) ( UK p  |
|                                       |
|         Nothing unread in Formula 1   |
|                                       |
|     [ Show read articles too ]        |
|     [   Show all topics      ]        |
+---------------------------------------+
```

```
+---------------------------------------+
| [=]  All articles          [v/]  [=]  |
|      Formula 1                        |
| (!) You're offline. Showing saved art.|  warning-subtle banner, in the header stack
+---------------------------------------+
|  ( All ) ( AI ) (=Formula 1=) ( UK p  |
|      This topic isn't saved on this   |
|      device                           |
|      Reconnect to load Formula 1.     |
|         [ Show all topics ]           |
+---------------------------------------+
```

### 1.6 Colour and contrast (computed from the tokens in DESIGN_SYSTEM section 2.2)

| Pair | Light | Dark | Need |
|---|---|---|---|
| Default chip text (`fg`) on `surface` | 17.0 | 12.4 | 4.5 |
| Default chip border (`line-strong`) against the page (`bg`) | 3.6 | 4.6 | 3.0 |
| Selected chip label (`accent-fg`) on `accent` | 6.9 | 8.2 | 4.5 |
| Selected chip fill (`accent`) against the page | 6.4 | 8.5 | 3.0 |
| Focus ring (`focus`) against the page | 7.1 | 9.4 | 3.0 |
| Header kicker (`fg-muted`, `text-xs`) on the header's blended background | 6.6 on solid canvas; the glass worst case in DS 1.5b leaves at least 4.5 | 7.2; same | 4.5 |

The focus ring against a selected chip is only 1.1:1, so the ring uses `outline-offset: 2px` (DS section 10) and sits on the page, not on the fill. Do not use a negative offset on chips.

---

## Part 2. Topics setting (`/settings/topics`)

### 2.1 Entry: a row in Settings

In Settings, at the end of the **Reading** section's list, a link row (56 px, `divide-y` like the toggles):

```
| Topics                              > |
| AI, Formula 1, UK politics            |  text-sm text-fg-muted, one line, truncated
```

- Label **Topics**, value line **3 chosen: AI, Formula 1, UK politics** truncated with an ellipsis, or **None chosen** when empty. Hint is the value line. Chevron `ChevronRight`, `aria-hidden`. The whole row is one `Link` (min 56 px). Accessible name: "Topics, 3 chosen: AI, Formula 1, UK politics".
- Opens `/settings/topics` (`replace` in the installed app, like other sub-page links).

### 2.2 Chrome

Header left **Back** (history first; opened directly it goes to `/settings` with `replace`, FLOWS 1.6). `h1` **Topics**. No right-hand actions, no bottom bar. Document title `Topics - Tidings`. This is a sub-page, so the drawer edge swipe is off (as for Add feed). The screen needs no Save button: every change saves itself.

### 2.3 Phone 375 x 812, with three chosen

```
+---------------------------------------+
| [<]  Topics                           |
+---------------------------------------+
| Choose the topics that appear as      |  text-base, fg-muted
| chips above All articles. Drag the    |
| grip, or use the arrows, to set the   |
| order.                                |
|                                       |
| On the chips                       3  |  h2 (lg semibold) + count (sm, muted)
| +-----------------------------------+ |
| | (-)  AI                  [^] [v] [::]|  Remove | name | Move up | Move down | grip
| |-------------------------------------|
| | (-)  Formula 1           [^] [v] [::]|
| |-------------------------------------|
| | (-)  UK politics         [^] [v] [::]|
| +-----------------------------------+ |
|                                       |
| Other topics                       25 |  h2
| +-----------------------------------+ |
| |  Climate and environment   [+ Add]  |
| |-------------------------------------|
| |  Cricket                   [+ Add]  |
| |  ...                                |
| +-----------------------------------+ |
+---------------------------------------+
```

Row widths at 343 px (375 minus two 16 px gutters): Remove 44, name flexible (about 163 px), Move up 44, Move down 44, grip 44. Names wrap to two lines rather than truncate ("Climate and environment"), so the full name is always readable; the row grows.

| Element | Spec |
|---|---|
| Intro | One paragraph, `text-base text-fg-muted`, above the lists. |
| "On the chips" list | An ordered list (`ol`) in a `surface` card with `border border-line`, `rounded-lg`, rows separated by `border-line`. `aria-labelledby` the h2. The order here is the chip order, left to right. |
| Chosen row | Min 56 px high. Left to right: **Remove** (44 px icon button, lucide `MinusCircle` 24 px, `text-fg-muted`; not the danger colour, because nothing is lost), the name (`text-base`), **Move up** (`ChevronUp`), **Move down** (`ChevronDown`), the **grip** (`GripVertical`, `text-fg-muted`). All 44 x 44. |
| Remove | `aria-label="Remove Formula 1 from chips"`. The topic returns to "Other topics" at its alphabetical place. Focus goes to the Remove button of the row now in its position, else the previous row's, else the "Other topics" heading. |
| Move up / down | `aria-label="Move Formula 1 up"` / `"Move Formula 1 down"`. Disabled with `aria-disabled="true"` on the first row (up) and the last row (down), so focus is never lost; a press on a disabled one does nothing. After a move, focus **stays on the same button of the same topic**; if that button has just become disabled (it reached the end), focus moves to the other arrow of that row. |
| Grip | `aria-hidden`, `tabindex="-1"`, pointer only. 44 x 44 hit area, `touch-action: none` on the grip alone, so the rest of the row still scrolls the page. Cursor `grab` / `grabbing` on fine pointers. It is on the **right**, away from the iOS back-swipe strip at the left edge. |
| "Other topics" list | A `ul`, alphabetical, same card. Row min 56 px: name left, **Add** button right (`Plus` icon plus the word, outlined `border-line-strong`, 44 px high, `px-3`). `aria-label="Add AI to chips"`. Adding appends the topic at the end of "On the chips" and moves it between the lists. Focus goes to that topic's Move up button in the chosen list (so the owner can place it at once). |
| Counts | "On the chips" count is the number chosen; "Other topics" the number left. |
| All 28 chosen | The "Other topics" section becomes the text **Every topic is on the chips.** |
| None chosen | "On the chips" shows the card with the text **No topics chosen. All articles has no chip row.** (`text-fg-muted`, centred, padded 16 px) in place of rows. |
| Retired topic | Not listed. The server already drops it (AC7). |

### 2.4 Drag behaviour

- **Pick up:** `pointerdown` on the grip starts the drag at once (no long press, it is an explicit handle). Pointer capture on the grip. The row lifts: `bg-raised shadow-raised`, 1 px `border-line-strong`, `z` above its siblings. The slot it left stays as a gap. No scale or tilt.
- **Move:** the row follows the pointer vertically only. Neighbours slide out of the way, 150 ms `ease-standard`. The page auto-scrolls while the pointer is within 64 px of the bottom of the viewport or within 48 px below the header's bottom edge, at a speed that rises toward the edge (up to about 12 px a frame). The lifted row stays in the chosen list; it cannot be dropped into "Other topics" (use Remove).
- **Drop:** on `pointerup` the row settles into the nearest slot over 150 ms. The new order is saved (see 2.6). A polite announcement says **Formula 1 moved to position 2 of 3.**
- **Cancel:** Escape (keyboard attached), `pointercancel` or the browser taking the touch returns the row to where it started, with **Move cancelled** announced. A drop where the order did not change saves nothing and announces nothing.
- **Reduced motion:** the lift is a colour and shadow change only (no animation), neighbours jump rather than slide, the settle is instant, auto-scroll still runs (it is not decoration) but without easing.
- **Mouse:** the same path with a mouse. Dragging a row's name does nothing; only the grip drags.

### 2.5 Non-drag alternative (keyboard and screen reader)

| Action | Keys | Announcement (polite live region `role="status"`, always in the DOM) |
|---|---|---|
| Move up / down | Tab to the arrow, Enter or Space | **Formula 1 moved to position 1 of 3.** |
| Add | Tab to Add, Enter or Space | **AI added to chips, position 4 of 4.** |
| Remove | Tab to Remove, Enter or Space | **AI removed from chips.** |
| Cancelled drag | Escape | **Move cancelled.** |

Tab order inside a chosen row: Remove, Move up, Move down. Two rows' controls are therefore reached in reading order. Each name sits inside the row's `li`, and the list is labelled, so a screen reader says "On the chips, list, 3 items". Do not put `aria-live` on the list itself (it would read the whole list on every move).

### 2.6 Saving and failures

- Every change is **optimistic**: the lists and the chip row on All articles update at once (they share the cached setting).
- Saved with `PATCH /api/me` `{ settings: { topicChips } }` carrying the **whole ordered list**. Saves are debounced 500 ms (trailing) and coalesced, so holding Move down does not send ten requests. A pending save is flushed when the screen is left.
- On failure the screen and the chip row roll back to the last list the server accepted, and an error toast says **Couldn't save your topics. Try again.** (8 s, close button). The live region says **Couldn't save. Topics put back.**
- Another device: the setting follows the owner (it is in `/api/me`). The screen reflects it on the next settings refetch; no live sync.
- There is no saved/saving indicator. A quiet success is the design.

### 2.7 States

| State | What shows |
|---|---|
| **Loading, nothing cached** | Intro text, then skeletons: an h2-sized block, four 56 px row blocks (`bg-sunken animate-skeleton`) in a card, a second h2 block and four more rows. `aria-busy="true"`, label **Loading topics**. |
| **Loading, cached** | The lists immediately from the 24 h cache, refreshed quietly. |
| **Error, no cache** | `State` block: title **Couldn't load topics.** Body **Check your connection and try again.** Button **Try again**. |
| **Offline, topics cached** | Lists show; the shared banner reads **You're offline. Changes can't be saved.** (the existing text for Settings). Remove, Add and Move are `aria-disabled` and dimmed, the grip does not start a drag. Each blocked press shows the toast **You're offline. That change wasn't saved.** |
| **Offline, nothing cached** | The same as the error state, but the body is **Topics aren't available offline.** and the button is hidden. |
| **Save failed** | 2.6. |
| **Long names** | Wrap onto a second line in the row; the row grows. In the chip row names never wrap. |
| **No image content** | Not applicable (text only). |
| **Reduced motion** | 2.4. |
| **200% text** | Names wrap; the four 44 px controls keep their size; at the narrowest widths the name column can drop to about 100 px and wraps to three lines rather than clipping. |

### 2.8 Desktop and tablet

Same single column (`max-w-2xl`), same rows, centred next to the sidebar from 1024 px. Rows get `hover:bg-sunken` only as a bonus. The grip shows `cursor: grab`. Nothing depends on hover. No new layout.

### 2.9 Theme notes

Cards are `surface` on the `canvas` page, with `border-line` outlines (the same pattern as other settings and Manage cards), so both themes read the same. The lifted drag row uses `raised` (a lighter step in dark mode, white plus shadow in light). In dark mode the shadow is `--sh-2`, already black-tuned. No new colour tokens.

---

## Decisions on the open questions (orchestrator, 2026-11-26, applied in the TID-078 build)

1. The Topics setting shows names only. `GET /api/topics` returns `id` and `name`, no descriptions.
2. The `useSwipe` edge exception is in scope. Built as an opt-in option, `ignoreExemptEdgePx` (the menu swipe passes `SWIPE_EDGE_PX`), not as a change to every `ignoreWithin` user, so the article swipe-back keeps ignoring tables and code blocks from the very edge as before.
3. The "within about an hour of arriving" sentence is dropped from the empty-state copy (done above).

## Build notes (what differs from this design)

- **A `?topic=` counts only when it is one of the chosen chips.** A known topic that is not chosen falls back to All and the parameter is removed, the same as an unknown or retired one (the row has no pressed chip to show it with).
- **Desktop scroll buttons** are shown only while the row can scroll that way on a fine pointer (`pointer-fine`), at the 44 px ends.
- **Alt+Up and Alt+Down** on a row, mentioned nowhere above, were not built (the Move buttons are the keyboard path).
- **Drag scroll** zones: 64 px at the bottom of the viewport and 48 px below the header, at most 12 px a frame.

## Part 3: topics on the article view (owner request 2026-11-26)

The article view lists the article's topics under the feed, author and date line, as small grey pills (`text-xs`, `text-fg-muted`, `border-line`, fully rounded), in stored order (most relevant first). They are plain text in a `<ul aria-label="Topics">`, not links or buttons. An untagged article shows nothing. Screenshots: `docs/ux/reviews/tid-078/375-{light,dark}-article-topics.png`.
