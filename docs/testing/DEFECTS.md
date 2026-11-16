# Defects

Owner: tester. One entry per defect. IDs are `DEF-nnn`, never reused.

Severity: **S1** data loss, security hole or app unusable; **S2** acceptance criterion fails or a
core flow is broken with no workaround; **S3** wrong behaviour with a workaround, or an edge case;
**S4** cosmetic.

Entry template:

```
### DEF-nnn: short title
- Story: TID-###
- Severity: S1 | S2 | S3 | S4
- Status: Open | Fixed (commit) | Verified | Won't fix (reason)
- Found by: test name, or manual
- Steps to reproduce:
- Expected:
- Actual:
```

## Open

### DEF-001: All-unread page 2 reads 103 rows, one over the NFR-7 budget of 102
- Story: TID-004 (AC5, NFR-7)
- Severity: S3 (minor). Owner: PM (ruling needed), then SE if the query must change.
- Status: Open
- Found by: `apps/worker/test/entries-list.test.ts` > "AC5: All-unread page 2 reads <= 103 rows (cursor continuation; see DEF-001)"
- Steps to reproduce: seed the DB (`buildSeedSql()`), call `listEntries(db, 'seed-user', { view: 'all', unreadOnly: true, limit: 50 })`, then again with `cursor` set to the returned `nextCursor`. Read `meta.rows_read` of the second call.
- Expected: NFR-7 says each All/Feed list query reads <= (limit + 1) x 2 = 102 rows.
- Actual: page 1 reads 102, page 2 reads 103. The engineer attributes the extra row to the cursor row being re-read on seek (not independently confirmed). Page 1 and the feed view are within budget.
- Decision needed: either NFR-7 and AC5 allow +1 on continuation pages (then tighten the test comment and keep the <= 103 assertion), or the query must change to hit 102. The test currently asserts <= 103 and references this ID. Impact is one row per page, so free-tier risk is negligible.
- Related observation (not a defect): folder view reads 211 rows for limit 50 on a 150-entry folder, consistent with spec 8.6 ("reads every matching row in that folder"). It is guarded at <= 2 x folder size.

### DEF-002: A stored theme opposite to the OS flashes the OS tone while the stylesheet loads
- Story: TID-006 (AC1 spirit; FR-ST-1, NFR-10 "no flash of the wrong theme on load")
- Severity: S3. Owner: SE.
- Status: Fixed (95792b2), awaiting tester closure
- Found by: `e2e/specs/tid-006-app-shell-qa.spec.ts` > "AC1: before the stylesheet arrives the canvas colour scheme equals the stored choice (DEF-002)" (marked `test.fail`, so it turns red when fixed and the marker must then be removed). A pixel-level run of the same scenario, with CDP screencast frames, showed tones dark,light,light under a dark OS with a stored light choice; that version is timing-dependent (the pre-stylesheet frame is not always composited), so the deterministic cause check is what is committed.
- Steps to reproduce: set `localStorage['tidings.theme'] = 'light'` with the OS in dark mode (or the reverse), hold back `/assets/*.css` for 1.5 s, load `/all`, and read `meta[name=color-scheme]` once `data-theme` is set.
- Expected: every frame is the stored theme's colour.
- Actual: the meta stays `light dark`, and the first composited frame is the OS canvas colour (rgb 18,18,18 under a dark OS) before the light stylesheet arrives. `theme-init.js` sets `data-theme`, but with the stylesheet outstanding the only thing colouring the canvas is `<meta name="color-scheme" content="light dark">`, which follows the OS, not the stored choice. The OS-equals-stored case (AC1 as written) is fine: all frames are correct, and the control test proves the detector fails when `theme-init.js` is absent.
- Suggested fix: have `theme-init.js` also set `meta[name=color-scheme]` content to the resolved theme (`light` or `dark`), and update it in `apply()`.

### DEF-003: App crashes when `localStorage` access throws (storage blocked)
- Story: TID-006 (robustness of the "/" redirect and last-list memory, FLOWS 1.8)
- Severity: S2 for affected browsers (blank app), S3 overall. Owner: SE.
- Status: Fixed (95792b2), awaiting tester closure
- Found by: `apps/web/src/qa-shell.test.tsx` > "returns /all and does not throw when the localStorage global itself throws on access" (`it.fails`), and `e2e/specs/tid-006-app-shell-qa.spec.ts` > "localStorage blocked: the app still renders, follows the OS and "/" lands on /all (DEF-003)" (`test.fail`).
- Steps to reproduce: in a browser that throws `SecurityError` on reading `window.localStorage` (Chrome with "Block all cookies", some embedded webviews), open `/`.
- Expected: `/` redirects to `/all`, the shell renders, the theme follows the OS.
- Actual: `apps/web/src/lib/lastList.ts` uses `storage = localStorage` as a default parameter of `readLastList()` and `saveLastList()`. Default parameters are evaluated outside the function's `try/catch`, so the SecurityError propagates out of render (`App`) and an effect (`AppShell`) and React unmounts the tree. `theme-init.js` is safe (its access is inside `try`).
- Suggested fix: read the global inside the `try` (`try { return (storage ?? localStorage).getItem(...) }`).

### DEF-004: A throwing Undo action leaves the toast on screen
- Story: TID-006 (toast region, UX app-shell 2.4)
- Severity: S4. Owner: SE.
- Status: Fixed (e16e62b), awaiting tester closure
- Found by: `apps/web/src/qa-shell.test.tsx` > "keeps the toast usable when the Undo action throws..." (`it.fails`).
- Steps to reproduce: show an Undo toast whose `run` throws, click Undo.
- Expected: the toast is dismissed, so a second click cannot re-run a failing action.
- Actual: `ToastCard` calls `item.action.run()` before `store.dismiss(item.id)`; the throw skips the dismiss and the Undo button stays until the timer expires.
- Suggested fix: dismiss first, or call `run()` in a `try/finally`.

### DEF-005: Drawer close inputs are not idempotent, so a repeated input leaves the screen
- Story: TID-006 (AC4, drawer closes on Escape and backdrop tap; UX app-shell 2.2 rule 1 "pushes one history entry")
- Severity: S3. Owner: SE.
- Status: Fixed (e16e62b), awaiting tester closure
- Found by: `e2e/specs/tid-006-app-shell-qa.spec.ts` (all `test.fail`, so they turn red when fixed and the markers must then be removed): "a double tap on the scrim closes the drawer once and stays on the screen (DEF-005)", "two Escape events in the same task do not navigate away from the screen (DEF-005)", "double-clicking Menu leaves exactly one history entry to unwind (DEF-005)".
- Steps to reproduce (mobile, 375 px): open `/settings`, then `/all`; open the drawer; double-tap the scrim (or the Close button), or press Escape twice quickly.
- Expected: the drawer closes and the user stays on `/all`.
- Actual: each input calls `navigate(-1)` (`closeDrawer` in `AppShell.tsx`) because nothing guards against a second call before React re-renders, so the second input pops the previous screen and the user lands on `/settings`. Likewise a second Menu click before the drawer has rendered pushes a second `state.drawer` entry, and one Escape then leaves the drawer open.
- Suggested fix: ignore close while a close is pending (a ref cleared when `open` flips), and make `openDrawer` a no-op when `location.state.drawer` is already set.
- Related observation (test-only, not a defect): right after Menu is clicked the dialog can take more than 100 ms to appear on a loaded machine; a tap on the scrim position in that window is a tap on the page behind. The drawer-stress tests wait for the dialog before interacting.

## Closed

None.
