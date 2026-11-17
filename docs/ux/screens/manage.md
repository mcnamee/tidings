# Screen spec: Manage feeds (`/manage`)

Story: TID-014 (also holds the entry points for TID-013 and TID-016). Written after build, at the end-of-MVP review (`docs/ux/reviews/mvp-review.md`), so it records what was built plus the corrections. Read with `app-shell.md` and `docs/ux/FLOWS.md` 2.3 and 2.4. Colours are token names. Code: `apps/web/src/manage/Manage.tsx`, `Sheet.tsx`, `actions.ts`.

Purpose: see every folder and feed, fix what is broken, and organise. Rare screen (drawer footer), so it favours clarity over speed.

Chrome: header left Menu, `h1` **Manage feeds**, right slot **New folder** (icon plus label, 44 px). No bottom bar. Document title `Manage feeds - Tidings`.

---

## 1. Phone 375 x 812

```
+---------------------------------------+
| [=]  Manage feeds     [+folder] New f.|  header
+---------------------------------------+
| [+          Add feed                +]|  primary, 48 px  -> /manage/add
| [       Import from OPML            ]|  secondary, 48 px -> /manage/import
|                                       |
| Folders                               |  h2 (text-lg semibold)
| +-----------------------------------+ |
| | [] A very long folder name...  [e][t]|  name truncates; Rename, Delete 44x44
| |    0 feeds                          |
| |-------------------------------------|
| | [] Tech                         [e][t]|
| |    2 feeds                          |
| +-----------------------------------+ |
|                                       |
| Feeds                                 |  h2
| +-----------------------------------+ |
| | An Extremely Long Feed Title Th...  |  feed row = one 56 px+ button
| | No folder                           |  text-sm fg-muted
| |-------------------------------------|
| | Broken Blog                         |
| | News                                |
| | /!\ Timed out after 10 s            |  warning-subtle-fg, icon + text
| +-----------------------------------+ |
+---------------------------------------+
```

Order: folders alphabetical (case-insensitive), feeds alphabetical by display title. Lists are cards: `rounded-md border border-line bg-surface divide-y divide-line`.

| Element | Spec |
|---|---|
| Add feed | `min-h-12 w-full rounded-md bg-accent text-accent-fg`, Plus icon |
| Import from OPML | `min-h-12 w-full border border-line-strong bg-surface` |
| Folder row | Icon (decorative), name (`truncate`, `font-medium`), count line ("0 feeds", "1 feed", "12 feeds"), then Rename (pencil) and Delete (bin), each `size-11` with `aria-label` "Rename {name}" / "Delete {name}". At large text the row wraps: actions drop under the name (name column `min-w-32`). Tapping the name does nothing. |
| Feed row | One button, `min-h-14`, shows display title (custom title if set), folder name or "No folder", and the health note if there is one. `aria-label` "{title}, options", described by the folder and health lines. Opens the feed options sheet. |
| Health note | Failing, dead, gone: the feed's fixed error message (`feedErrorMessage`), else "This feed has stopped updating." / "This feed no longer exists." / "Couldn't fetch this feed.". A feed with a server warning shows that text. Always icon plus text, never colour alone. |

Pending feeds (never fetched): **to build**, `Waiting for the first fetch.` in `text-fg-muted` with a Clock icon (review item 3).

## 2. Sheets (all modal, lower half of the screen)

`Sheet`: `role=dialog aria-modal`, labelled by its `h2`, `rounded-t-lg bg-raised p-4`, max height 85 dvh, scrolls inside at large text. On 640 px and wider it is centred, `max-w-md`, `rounded-lg`. Scrim closes it. Escape closes it. Tab stays inside. Focus goes to the first control, or to the element marked `data-autofocus`; on close it returns to the opener. Buttons are stacked, full width, 48 px, primary or destructive first and **Cancel** last.

| Sheet | Title | Contents | Notes |
|---|---|---|---|
| New folder | New folder | Field "Folder name", helper "1 to 64 characters.", **Create folder**, **Cancel** | Focus in the field. Empty: "Enter a name to continue." Server duplicate: "You already have a folder with that name." Busy: button shows "Saving..." and the field is read-only |
| Rename folder | Rename folder | Same, prefilled, **Save** | |
| Feed options | The feed's title | **Rename**, **Move to folder**, **Unsubscribe**, **Cancel** | Focus on Rename |
| Rename feed | Rename feed | Field "Feed name", helper "Leave empty to use the feed's own title.", **Save**, **Cancel** | Empty saves `null` (reset) |
| Move to folder | Move to folder | One button per destination: "No folder", then each folder. The current one has a 2 px accent border, `aria-pressed`, and the word "Current". **Cancel** | Choosing applies at once and closes. At most about half the screen with 5 folders; scrolls beyond |
| Delete folder | Delete {name}? | "Its 12 feeds move out of the folder. Nothing is unsubscribed." (or "It has no feeds." / "Its 1 feed moves out ...") , **Delete folder** (danger), **Cancel** | **Focus starts on Cancel** (`data-autofocus`) |
| Unsubscribe | Unsubscribe from {title}? | "Your read history for this feed will be removed.", **Unsubscribe** (danger), **Cancel** | Focus starts on Cancel |

Every action is optimistic where it can be (tree and lists update at once) and rolls back with an error toast on failure. No Undo in MVP: the confirm sheets are the safeguard.

## 3. States

| State | What shows |
|---|---|
| Loading | Add feed and Import buttons stay; two skeleton cards below (`aria-busy`, label "Loading feeds"). Built. |
| Empty | Buttons, then under Folders "No folders yet. Use New folder to group your feeds." and under Feeds "You aren't following any feeds yet." |
| Error | `role=alert` card, `bg-danger-subtle text-danger-subtle-fg`: "Couldn't load your feeds. Check your connection." with **Try again** (44 px). Buttons above stay |
| Offline | Shell banner. The lists show from cache. Actions that need the server fail with the toast "You're offline. That change wasn't saved." Banner copy on this route and on Add feed, Import and Settings: "You're offline. Changes can't be saved." |
| Long names | Folder and feed names truncate to one line; sheets show the full title (wrapping) |
| Large text (200%) | Header actions may wrap to two lines. Folder rows wrap as above. Sheets scroll inside themselves |

## 4. Wide screens

At 1024 px and up the sidebar is permanent and the content is a centred column of 42 rem, unchanged. Sheets are centred dialogs. Nothing relies on hover.

## 5. Copy (final)

Buttons: Add feed, Import from OPML, New folder, Create folder, Save, Cancel, Rename, Move to folder, Unsubscribe, Delete folder, Try again. Headings: Manage feeds, Folders, Feeds. The rest is in section 2 and in the copy table of `reviews/mvp-review.md`.

## 6. Accessibility

Headings: `h1` in the shell, `h2` Folders and Feeds. Lists are `ul`. Icon buttons have names. The feed row's button is described by its folder and health text. Sheets are dialogs with labelled titles and return focus. The name field sets `aria-invalid` and `aria-describedby` for its helper and error, and the error is also announced through a `role=alert` region.
