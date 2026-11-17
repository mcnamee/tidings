# UX review: MVP screens (end of release, ADR 0014)

Reviewed: branch `claude/vigilant-ptolemy-xzzzem`, HEAD 84d7786 (TID-013, 014, 016, 018, 019, 020 merged). Fixes below are in the two `UX:` commits on top.
Method: built app under `wrangler dev` with the E2E database, seeded folders, feeds (ok, failing, dead, pending), 60 entries (images, no title, very long titles, rich article with image, code block, table). Captured by `docs/ux/reviews/capture-mvp.mjs` at 375x812 and 1280x800, light and dark, plus 200% root text at 375 (about 200 states). Measurements are in `docs/ux/reviews/mvp-measurements.json`. Network states a local server can't produce (500s, choice list, partial success, rate limit) were produced with route interception.
Screenshots kept in `docs/ux/reviews/mvp/` (7 of about 200; run `OUT=/some/dir CHROME_PATH=... node docs/ux/reviews/capture-mvp.mjs` to regenerate all).

## Verdict

No open blockers. Four large-text and layout defects were blocker or should-fix class and are fixed (section 1). Seven should-fix items remain for the engineer (section 2). The built UI matches the design system tokens in both themes, and the invented copy is approved with the corrections in section 5.

## 1. Fixed in this review (commits dfe45b9 and fdc34dd)

| # | Severity | Screen | Viewport | Problem | Fix applied |
|---|---|---|---|---|---|
| F1 | Blocker (WCAG 1.4.4/1.4.10) | All three lists, Add feed, Import (any screen with a bottom bar of two buttons) | 375, 200% text | Bottom bar did not wrap: "Refresh" ran to x=452 on a 375 viewport, the page scrolled sideways and the fixed bar fell off screen | `shell/slots.tsx`: bar container gets `flex-wrap` |
| F2 | Should-fix | Article | 375, 200% text and default | Previous / Mark as unread / Next shared one row with `min-w-0`: at 200% "Previous" overlapped "Mark as unread"; at 100% "Mark as unread" wrapped to two lines and made the bar taller than the list bar | Previous and Next are chevron only below `26rem` (`min-w-14 flex-none min-[26rem]:flex-1`, label in `max-[26rem]:sr-only`); middle button `flex-[2]`. Accessible names unchanged |
| F3 | Should-fix | Manage, folders | 375, 200% text | Name column collapsed to one letter ("A.", "0 fe e ds") between two 88 px icon buttons | Row is `flex-wrap`, name column `min-w-32 flex-1`: actions drop under the name |
| F4 | Should-fix | Lists | 375, 200% text | 5 rem thumbnail grew to 160 px and squeezed the feed name to nothing (row showed "• · 33m") | Thumbnail `size-[80px]` |
| F5 | Should-fix | Article | 1280 | Body text was centred in the 65ch column while the title sat flush left, so the two left edges differed by 36 px | `.article-prose { margin-inline: 0 }` |
| F6 | Should-fix | Manage | all | Delete folder and Unsubscribe sheets opened with the destructive button focused, so Enter right after opening confirmed it | `Sheet` focuses `[data-autofocus]` first; both Cancel buttons carry it. Unit test added |
| F7 | Should-fix | Manage | screen reader | `aria-label="Title, options"` replaced the button's content, so folder and the failing-feed message were never announced | `aria-describedby` on the folder and health note. Unit test added |
| F8 | Should-fix | Lists | all | "Unread only" on/off differed by background tint alone (about 1.2:1 against the header in light): WCAG 1.4.1 | Filter icon becomes a check mark while pressed |
| F9 | Copy | Import | all | Disabled button read "Import 0 feeds"; failure screen's "Leave" did not say where | "Nothing new to import"; "Back to Manage". Unit test updated |

## 2. Remaining fixes for the engineer, ranked

All should-fix before release unless marked later.

1. **Manage loading is the bare word "Loading"** (`manage/Manage.tsx`, `folders.isPending || subs.isPending`). Principle: skeletons, not text. Replace with two skeleton cards: `<div aria-busy="true" aria-label="Loading feeds">` then `h-5 w-1/3` and four rows of `h-14 animate-skeleton rounded-md bg-sunken` (same pattern as `lists/ArticleList.tsx` `Skeleton`). Keep the Add feed and Import buttons visible above it (they do not need data).
2. **Import count mismatch** (`manage/ImportOpml.tsx`, found when importing `e2e/fixtures/opml/inoreader-export.opml` into an empty database). Preview says "Found 250 feeds in 18 folders", button "Import 249 feeds", "1 invalid"; the result says "248 feeds added" and "2 feeds could not be imported". One feed the preview accepted was rejected by the server and is counted as "could not be imported" with no reason. Either the preview should reject what the server rejects, or the result should say why ("1 was a duplicate"). Find which feed it is (fixture line with the same `xmlUrl` in two folders is the likely cause; the preview's "first folder wins" note covers it but the count does not).
3. **Pending feeds say nothing on Manage.** A feed in `pending` state shows no status; a new import of 240 feeds will look the same as healthy ones for minutes. Show `Waiting for the first fetch.` in `text-fg-muted` with a `Clock` icon (not the warning triangle). Same wording as the list empty state.
4. **Offline banner says "You're offline. Showing saved articles." on Add feed, Import and Manage**, where there are no saved articles. Make the shell banner route-aware: on `/manage/*` and `/settings` use `You're offline. Changes can't be saved.`
5. **Header action wraps to three lines at 200% text** ("Unread only", "New folder"), squeezing the title to "Ars Tec...". Add `whitespace-nowrap` to the header action buttons and let the title take `line-clamp-2` as now; at 200% the header will then be two lines, not three. Later if it proves fiddly.
6. **FLOWS 2.2 step 5 promised "See which" opens Manage filtered to problem feeds.** It opens plain `/manage`, where problem feeds sort alphabetically among the rest. Later: sort failing, dead and gone feeds to the top of the Feeds list (`feeds.sort` in `manage/Manage.tsx`, health first), or add a "Problems" filter chip.
7. **Heading focus on deep links** (later). Loading `/manage/import` or `/manage/add` directly puts focus on the in-page `h2` (`Choose your file`), not the shell `h1`, and shows a focus ring for keyboard users. Harmless, but the shell's `h1` should win on first load: guard the `useEffect(() => heading.current?.focus(), [stage.kind])` so it skips the first render.

## 3. Checks

### Tap targets (375 px, measured)

All pass at 44 px or more except one exemption. Header and bottom-bar buttons 44 px; drawer rows 44 px (expand chevrons 44x44); folder rename and delete 44x44; feed rows 56 px; sheet buttons and inputs 48 px; toast Undo 65x44; primary buttons 48 px. Exempt: links inside article text (20 px tall, WCAG 2.5.8 inline exception). No horizontal overflow at 375 on any screen at default text size.

### Contrast

`docs/ux/check-contrast.mjs`: all 74 token pairs pass in both themes (lowest text pair 5.90:1, muted on raised in dark; lowest control border 3.29:1 on sunken, light). New usages in the MVP screens are all on listed pairs: health notes use `warning-subtle-fg` on `surface` (above 7:1 both themes), error banners `danger-subtle-fg` on `danger-subtle`, toast Undo `toast-action` on `toast` (8.77 light, 6.74 dark). Disabled buttons use 60% opacity or `fg-muted` and are exempt. Dark article images are dimmed (`brightness(0.9)` confirmed on `article img` in dark, `none` in light); a pure white 2000 px chart no longer glares.

### Focus order and keyboard

- Manage: skip link, Menu, New folder, Add feed, Import, then each folder's Rename and Delete, then feeds. Matches reading order. Sheets trap Tab, Escape closes, focus returns to the opener (checked: Delete Tech returns to "Delete Tech").
- Add feed: Back, address, folder, title, Add feed (bar). The hidden submit button is out of the order, Enter in a field submits.
- Article: Open original, in-article links, the scrollable code block (Chrome makes it focusable, good), Mark as read/unread, Next. Previous is skipped while disabled.
- Import: heading receives focus on each step change.

### Screen-reader names

No unnamed controls on any captured screen. Icon buttons carry labels (`Rename X`, `Delete X`, `Open original`, `Open navigation`). Progress bars have `role=progressbar` with label and values. Unread rows say "Unread." in `sr-only`. Skeletons carry `aria-busy` and a label. Errors use `role=alert`, status text `role=status`. Remaining gap: F7 (fixed).

### Large text (200% root, 375 px)

After the fixes: no horizontal overflow on Manage, a list, or the article (checked). Sheets fit without scrolling. The article bar wraps to two rows at 200% (about 200 px) which is acceptable. Open: item 5 above.

### States seen

Empty (All, Manage), loading skeleton, list error with retry, Manage error with retry, offline (list, Add feed), caught up, failing / dead / pending feed lists, long titles and no-space titles (wrap, 3-line clamp), untitled article ("Untitled article"), article without content, article with images in both themes, confirm sheet over 20 ("Mark 24 articles as read?"), Undo toast (12 px above the bar, 5 s, Undo works and restores), Add feed: busy, no feed, already subscribed, limit, rate limit, choice list with a disabled JSON Feed, partial success; Import: choose, not OPML, preview, sending, progress, paused after failure; Manage: new folder (empty, duplicate), rename, delete, feed options, move, unsubscribe. Desktop at 1280: single centred column beside the 18 rem sidebar, sheets centred, no layout break.

## 4. Decisions the PM should know about

- Sheets, not row menus, are the pattern for every Manage action (FLOWS 2.4 said "row menu"). Approved: one pattern, thumb reachable. FLOWS stays as is; `screens/manage.md` records what was built.
- Tapping a feed row on Manage opens its options sheet; it does not open the feed. The feed is one tap away in the drawer. Approved.
- "Import from Inoreader" (empty state) and "Import from OPML" (Manage) both stay: the first is the switch story, the second the neutral name.
- No Undo on Unsubscribe or Delete folder (confirm sheet instead). Approved for MVP.

## 5. Copy review

Approved as built unless a correction is shown.

| String | Where | Verdict |
|---|---|---|
| No folders yet. Use New folder to group your feeds. | Manage | Approved |
| You aren't following any feeds yet. | Manage | Approved |
| 1 to 64 characters. / Enter a name to continue. / Use 64 characters or fewer. | Folder name sheet | Approved |
| Leave empty to use the feed's own title. | Rename feed | Approved |
| Its 12 feeds move out of the folder. Nothing is unsubscribed. / It has no feeds. | Delete folder | Approved (matches FLOWS) |
| Your read history for this feed will be removed. | Unsubscribe | Approved (matches FLOWS) |
| Couldn't load your feeds. Check your connection. | Manage error | Approved |
| This feed has stopped updating. / no longer exists. / Couldn't fetch this feed. | Manage health fallback | Approved |
| Enter an address to continue. / Enter a web address, like https://example.com/feed.xml | Add feed | Approved |
| We couldn't find a feed at that address. | Add feed | Approved. Optional later: add "Try the website's home page." |
| This address is not allowed. | Add feed | Approved |
| You already follow this feed. Open it | Add feed | Approved |
| That folder no longer exists. Choose another folder. | Add feed | Approved |
| We couldn't load it just now (The server returned 500 ...). Tidings will keep trying in the background. | Add feed, partial success | Approved. The capital letter inside the brackets is fixed text from `feedErrorMessage`; leave it |
| We found 3 feeds on this site / Choose the one you want to follow. / Not supported yet / Try a different address | Choice list | Approved |
| Added Feed title (toast and heading) | Add feed | Approved |
| Choose your file / In Inoreader, open Preferences, then Import / Export, and export your subscriptions as an OPML file. Then choose that file here. | Import | Approved. Verify the Inoreader menu names once against the live app |
| That file doesn't look like an OPML export | Import | Approved |
| Found 250 feeds in 18 folders / 248 already subscribed / 1 invalid | Import preview | Approved; "1 invalid" should say "1 can't be imported" if item 2 is fixed with reasons |
| Everything in this file is already in Tidings. | Import | Approved |
| Import 249 feeds / Nothing new to import | Import | Corrected (disabled state) |
| Sent 120 of 249 feeds / Import paused | Import sending | Approved |
| Leave | Import paused | Corrected to "Back to Manage" |
| Fetching your feeds / Fetched X of N feeds / Import complete | Import progress | Approved |
| N feeds added / N were already subscribed / N could not be imported | Import progress | Approved |
| N feeds will start fetching tomorrow, to stay within the daily limit. | Import progress | Approved |
| N feeds couldn't be fetched. See which | Import progress | Approved |
| You can leave this page. Fetching carries on in the background. / The rest keep fetching in the background. | Import progress | Approved |
| No feeds yet / Add a feed or import your OPML file. | All, empty | Approved |
| This feed has problems / Waiting for the first fetch / All caught up / Show all articles / No articles yet / Nothing here yet | Lists | Approved |
| We couldn't find that page. / Something went wrong on our side. / Try again / Couldn't load more. Try again | Lists | Approved |
| Mark 84 articles as read? / Mark 84 as read / Marked 14 as read / Undo | Mark all | Approved ("Marked 1 as read" is fine) |
| Couldn't mark these as read. Try again. / Couldn't undo. Your change was kept. | Mark all errors | Approved |
| Untitled article / This article has no content here. Use Open original to read it on the website. | Article | Approved |
| We couldn't find that article. / Couldn't load more articles. Try again. | Article | Approved |
| Pull to refresh / Release to refresh | Lists | Approved |

## 6. Questions for the PM

1. Is "Import 249 feeds" meant to count feeds the server may still reject (item 2), or should the preview promise only what will be saved?
2. Should failing feeds sort to the top of Manage (item 6), or is the alphabetical list fine until R2's feed-health work (TID-015)?
3. Offline copy on non-reading screens (item 4): "You're offline. Changes can't be saved." is proposed; confirm.
