# Screen spec: Import from OPML (`/manage/import`)

Story: TID-016 (FLOWS 2.2). Written after build, at the end-of-MVP review (`docs/ux/reviews/mvp-review.md`); records what was built plus corrections. Code: `apps/web/src/manage/ImportOpml.tsx`, `apps/web/src/lib/opml.ts`. Colours are token names.

Purpose: the switch from Inoreader. The first run goal is reading within 15 minutes. The file is parsed in the browser; nothing is saved until the person confirms. Re-importing is safe (already-followed feeds are skipped).

Chrome: header left **Back** (history first, `/manage` if there is none), `h1` **Import from OPML**, no right actions. The bottom bar holds the primary action on the preview step only. Document title `Import from OPML - Tidings`. On every step change focus moves to the step's `h2` (`tabindex=-1`).

Steps (one component, four stages): choose, preview, sending, progress.

---

## 1. Choose (phone 375 x 812)

```
+---------------------------------------+
| <-  Import from OPML                  |
+---------------------------------------+
| [ ! banner, only after a bad file ]   |
| Choose your file                      |  h2
| In Inoreader, open Preferences, then  |  text-base fg-muted
| Import / Export, and export your      |
| subscriptions as an OPML file. Then   |
| choose that file here.                |
|                                       |
| [        Choose OPML file          ]  |  label+file input, 48 px, accent
+---------------------------------------+
```

- The control is a `label` styled as the primary button wrapping a visually hidden `input type=file accept=".opml,.xml,..."`. Keyboard focus shows the ring on the label (`focus-within`).
- While the file is read: label text "Reading file..." at 60% opacity, input disabled.
- Bad file (not XML, no feeds, over 2 MB): banner `role=alert` "That file doesn't look like an OPML export", and the button label becomes **Choose another file**.
- The same file can be chosen again (input is cleared after each pick).

## 2. Preview

```
| Found 250 feeds in 18 folders         |  h2
| 248 already subscribed                |
| 1 can't be imported                   |
| 1 feed in more than one folder. Each  |  only when > 0
| goes in the first folder it appears in.
| Everything in this file is already in |  only when nothing is new
| Tidings.                              |
| [      Choose another file          ] |  secondary, 48 px
|                                       |
+---------------------------------------+
| [        Import 249 feeds           ] |  bottom bar, primary
|          (You're offline)             |  only when offline
+---------------------------------------+
```

- Counts use thousands separators. "N already subscribed" and "N can't be imported" (addresses the server would refuse) always show, including 0.
- Primary reads **Import N feeds** (N = feeds not yet followed, singular "1 feed") or, when N is 0, a disabled **Nothing new to import**. Offline: the button is disabled (`aria-disabled`, still focusable) and "You're offline" with an icon sits below it, tied by `aria-describedby`.
- Known gap (review item 2): the preview's N can be higher than what the server accepts.

## 3. Sending

```
| Importing your feeds                  |  h2
| Sent 100 of 249 feeds                 |  role=status
| [=========-------------------------]  |  progressbar "Import progress"
```

Requests of at most 100 feeds are sent one after another. The bar is `h-2 rounded-full bg-sunken` with an `accent` fill and real values. Leaving the page stops sending; the server keeps what it received, and importing again resumes (idempotent).

Failure mid-way: banner `role=alert` (network: "Couldn't reach Tidings. Check your connection and try again."; 429: "Too many requests. Try again in a minute."; else "Something went wrong on our side. Try again."), heading **Import paused**, then **Try again** (primary, continues from the failed request) and **Back to Manage** (secondary).

## 4. Progress

```
| Fetching your feeds                   |  h2 -> "Import complete" when done
| Fetched 120 of 248 feeds              |  role=status, polled every 5 s
| [========------------------------]    |  progressbar "Fetch progress"
| 248 feeds added                       |
| 3 were already subscribed             |  only when > 0
| 2 feeds could not be imported         |  only when > 0
| 12 feeds will start fetching tomorrow,|  only when deferred > 0
| to stay within the daily limit.       |
| 4 feeds couldn't be fetched. See which|  only when done and any failed
| [          Start reading            ] |  link button, once any feed has articles
| You can leave this page. Fetching     |  before that
| carries on in the background.         |
```

- N excludes feeds deferred to tomorrow. Polling stops when every counted feed has left `pending`; the counts are then refreshed so the drawer shows unread numbers.
- "See which" links to `/manage` (no filter yet, review item 6).
- **Start reading** goes to `/all`. Once it shows, "The rest keep fetching in the background." appears under it until done.

## 5. Large text and wide screens

At 200% text all stages stay single column with no overflow, and the bottom bar wraps. At 1024 px and up the content is the usual centred 42 rem column; the primary action stays in the bottom bar.

## 6. Accessibility

`h2` per stage receives focus. Progress bars have a label, min, max and now. The two live regions (`role=status` for counts, `role=alert` for errors) are the only announcements. The file input is reachable by Tab and Enter or Space activates the label. All buttons are 48 px.
