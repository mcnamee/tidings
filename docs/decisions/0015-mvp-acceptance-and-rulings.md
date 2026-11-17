# 0015. MVP acceptance: verdicts, rulings and carried-over work

- Status: Accepted
- Date: 2026-11-17
- Deciders: product-manager (orchestrator rulings ratified; Q13 and Q14 left with the owner)
- Stories: TID-013, TID-014, TID-016, TID-018, TID-019, TID-020, TID-046; new TID-048 to TID-052

## Context

ADR 0014 replaced per-story acceptance with one decision round at the end of the MVP. Every MVP feature story has been built, verified by the tester (each AC traced to tests, key guards mutated and caught) and merged. `npm run typecheck`, `npm run lint` and `npm test` pass (worker 1,111 plus 3 expected failures, web 454). The last full E2E run on the merged code had 771 passed and 3 failed: one was a test bug, now fixed (1cf3aaa); two are intermittent flakes under load (DEF-090). A final full E2E run on the fix batch is in progress. The UX review of all MVP screens (`docs/ux/reviews/mvp-review.md`) found no open blockers; its should-fix items 1 to 5 are fixed (679d8c9), and items 6 and 7 are deferred below.

The three expected failures are documented known limits, not unfinished work: DEF-040 (won't fix), DEF-050 (open, below) and the DEF-018 HEAD probe (S4, from TID-008).

## Verdicts

| Story | Verdict | Notes |
|---|---|---|
| TID-013 Subscribe | Accept | DEF-030 and DEF-031 fixed. |
| TID-046 Churn guard and daily cap | Accept | DEF-020 fixed: the first unchanged refresh of a new UTC day clears the warning, with no extra statement. |
| TID-014 Folders and management | Accept | AC9 met by the UX review. DEF-041 fixed; DEF-040 won't fix. |
| TID-018 Article lists | Accept with conditions | Every AC passes except AC5's folder-view bound (DEF-050). That bullet moves to TID-049 (R2). The cost is far inside the free quota (spec Q13), so it does not block release. |
| TID-016 OPML import | Accept | DEF-060 and DEF-061 fixed; the preview now counts only what the server will save. |
| TID-019 Article view | Accept | DEF-051 and DEF-070 to DEF-072 fixed. List-row read toggling moves to TID-048. |
| TID-020 Mark all as read | Accept | DEF-080 and DEF-081 fixed. Backdated late arrivals move to TID-051. |

## Orchestrator rulings (ratified)

1. **The OPML preview promises only what the server will save.** The preview uses the shared address rules, so "Import N feeds" matches `created`. Ratified.
2. **Offline copy on `/manage/*` and `/settings`:** "You're offline. Changes can't be saved." Ratified; reading screens keep "Showing saved articles."
3. **DEF-040 won't fix for MVP.** Folder-name case folding is ASCII only. Inoreader folder names are almost always ASCII, and a fix needs a migration. TID-014 AC2 reads as ASCII case. Ratified.
4. **Problem feeds first in Manage is deferred to R2.** It is added to TID-015 as AC7, because that story is the feed-health work. Ratified.

## Rulings on open questions

**TID-013**

- *An unreachable or mistyped address becomes a `failing` subscription.* Keep it. AC5 requires this, because an origin that is down now may recover, and the add screen already says it will keep trying. The owner can unsubscribe in two taps. TID-015 (R2) will show the reason in Manage. No story.
- *Double origin fetch on subscribe* (discovery in the request, then the `FeedRefresher` first fetch). Accept. Subscribing is rare, it costs one extra subrequest and request per add, and the first fetch running in `FeedRefresher` is what AC9 requires. An OPML import never fetches in the request, so the bulk path has no double fetch. No story.

**TID-016**

- *The OPML `title` is stored as `title_override`.* Accept. The OPML title is the name the owner chose in Inoreader, so keeping it is the expected result of an import. Clearing the name in Manage restores the feed's own title.
- *`htmlUrl` is dropped.* Accept. The feed's own site link comes from the first fetch, and TID-017 exports `htmlUrl` "when known" from that.
- *Folders refused by the 200-folder limit go unfiled with no message.* Real, but rare: Inoreader exports seldom have more than 200 folders. Fix in R2 as TID-050.
- *The import daily cap (250 first fetches a UTC day) is per user.* Accept for the single-owner MVP. Before invite-only multi-user (TID-042, M3), re-check whether it must become per-deployment; note added here so TID-042's refinement picks it up.

**TID-018 and TID-019**

- *Mark read or unread on list rows (FR-RD-8) was not built.* No TID-019 AC required it, so this is a gap between the spec and the stories, not a failed AC. The owner needs it to switch from Inoreader, so it is TID-048 in R2, not later.
- *Next and Previous are disabled on a direct link.* Accept. AC7 applies "in a list view"; a direct link has no list order to follow.

**TID-020**

- *The confirm count is approximate.* Accept. It is the view's cached unread count, which spec §8.5 already says is used, and the success toast states the exact number changed. No story.
- *Backdated arrivals are marked read.* An entry linked after `asOf` but dated before it is caught by `published_at <= before`. The window is the time between loading the list and tapping, and the publisher has to backdate an item, so this is rare. It is fixed in R3 as TID-051, which lets the engineer choose an entry-ID watermark (no migration) or an `added_at` column, and record the choice in an ADR.

**DEF-050 (folder view read cost)**

The PM recommends the tester's option (a): rewrite to a keys-then-join query and restate the folder bound as M + 3 × (limit + 1) + S + 10 (+ T on continuation pages). No migration, and no extra writes. It is scheduled as TID-049 (R2) on that default. The owner's question remains open as spec Q13, because the orchestrator has already put it to them, but the answer does not block the release: the worst measured page reads about 300 rows, against 5,000,000 a day.

**DEF-090 (flaky E2E tests)**

S4 test flakiness, not a product defect. Added to TID-038 (R3) as AC7. For the MVP exit criterion "full suite green", a test that fails once and passes on rerun, and is listed under DEF-090, does not block; any repeatable failure does.

**UX review item 7 (heading focus on deep links)** is TID-052 (R3).

## MVP exit criteria (TID-024)

| Criterion | State |
|---|---|
| Every MVP story Done | Met for every feature story (TID-018 with its AC5 folder bullet carried over). TID-024 itself remains. |
| Full suite green | Met for typecheck, lint and unit and integration tests. E2E: met if the in-progress final run has no failures other than DEF-090 flakes that pass on rerun. |
| One UX review of all MVP screens at 375 px in both themes | Met (`docs/ux/reviews/mvp-review.md`; should-fix items 1 to 5 fixed). |
| The owner can sign in, import their OPML and read on their phone | Proven in E2E against the local stack; still needs production (TID-024) and the owner's manual pass on a real iPhone. |

## Consequences

- The MVP can ship once TID-024 is approved and run, and the owner has done one manual pass on their iPhone.
- R2 gains TID-048, TID-049 and TID-050, and TID-015 gains AC7. R3 gains TID-051 and TID-052, and TID-038 gains AC7.
- Housekeeping for the tester, which does not block the release: `TEST_STRATEGY.md` has traceability tables only up to TID-014. The PM spot-checked that tests for TID-016, TID-018, TID-019, TID-020 and TID-046 name every AC (TID-018 AC11 is covered in `App.test.tsx` and `tid-008-sign-in.spec.ts`; TID-019 AC8 is the lint rule in `eslint.config.js`). The tester adds the five tables. In `DEFECTS.md`, DEF-050 sits under Closed although it is open, and the fixed DEF-020, DEF-031, DEF-041 and DEF-070 to DEF-072 sit under Open; the tester refiles them.
- Spec §2 lists the new stories, and spec §16.1 holds Q13 (DEF-050) and Q14 (deploy approval).
