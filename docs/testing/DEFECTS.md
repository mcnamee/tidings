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

### DEF-020: A capped feed that stops changing keeps its `new_item_cap` warning indefinitely

- Story: TID-046 (AC3, "on the first refresh in a new UTC day that stays under the cap, the warning clears")
- Severity: S4. Owner: SE.
- Status: Open
- Found by: `apps/worker/test/churn-guard-adversarial.test.ts` > "DEF-020: a quiet feed (identical body) on a later UTC day clears the warning" (`it.fails`; remove the marker when fixed).
- Steps to reproduce: a feed hits the cap and gets `warning_code = 'new_item_cap'`; it then stops publishing (the origin answers 304 or an identical body). Refresh it on the next UTC day.
- Expected: the refresh is under the cap (it stored nothing), so the warning clears.
- Actual: an identical-body refresh (tested; a 304 takes the same unchanged path, not separately tested) does not run the code that clears the warning, so "This feed publishes too many new items" stays until the feed next changes, possibly weeks.
- Suggested fix: PM decision. Either accept it (reword AC3 to "first changed fetch") or clear the warning in the existing 304/unchanged `UPDATE` when `new_entries_day` is before today (no extra statement; that update already runs).


### DEF-031: A text/plain feed with more than 4 KB of prolog before the root element is "no_feed_found"
- Story: TID-013 (FR-SU-1, discovery sniff)
- Severity: S3 (low likelihood). Owner: SE.
- Status: Open
- Found by: `apps/worker/test/subscribe-adversarial.test.ts` > "a text/plain feed with a long comment before <rss> is still subscribed" (`it.fails`).
- Steps to reproduce: serve a valid RSS 2.0 document as `Content-Type: text/plain` with a 5 KB XML comment between `<?xml ...?>` and `<rss>`; add its URL.
- Expected: subscribed (the refresher parses it).
- Actual: `422 no_feed_found`: `sniff` looks only at the first 4,096 bytes and, with no xml/html content type, answers `other`. `application/octet-stream` and a normal `text/plain` feed work.
- Suggested fix: for an unplaceable type, fall back to the refresher (subscribe, let it record `parse_error`) as already done for `xml`, or sniff past comments and whitespace.


### DEF-018: HEAD /api/health is 401, so a HEAD uptime check fails

- Story: TID-008 (spec 8.1 deny by default, 8.8 health)
- Severity: S4. Owner: SE (or PM, if HEAD is out of scope).
- Status: Open
- Found by: `apps/worker/test/security-attack.test.ts` > "HEAD /api/health is answered like GET" (`it.fails`)
- Steps to reproduce: `HEAD /api/health` with no session.
- Expected: 200 with no body, like GET (monitoring services default to HEAD).
- Actual: 401 `unauthenticated`. The public list matches method and exact path, and `HEAD` is not in it. Safe by default, which is why this is S4: a HEAD probe sees an outage that is not there.
- Suggested fix: treat `HEAD` as `GET` in `isPublicRoute` for the two public GET routes, or document that monitors must use GET.

### DEF-019: E2E run is not robust to the host sleeping (the "Playwright stalls")

- Story: TID-008 verification, feeds TID-038 (E2E stability)
- Severity: S3 (the suite reports failures that are not product failures). Owner: SE (TID-038).
- Status: Open
- Found by: full `npm run test:e2e` on `tid-008-sign-in` (tip b964f3d), 3 failed, 669 passed, 80 skipped, 40.6 min.
- Steps to reproduce: start the full run and leave the machine alone. macOS enters dark-wake cycles and goes back to sleep after about 3 minutes unless something holds a system-sleep assertion. Playwright and `wrangler dev` hold none (Chromium's "Capturing" assertion only stops display sleep).
- Expected: either no failures, or failures that say what happened.
- Actual: three tests failed, each after a silence that equals a system sleep in `pmset -g log` to the second: test 147 (mobile-light, tid-007-setup `a cancelled prompt...`) 1002 s silent, "Test timeout of 30000ms exceeded while setting up context", sleep 16:09:43 to 16:26:23; test 359 (mobile-dark, tid-008-session `a session past expires_at...`) 190 s, "Test timeout exceeded" then "apiRequestContext.post: Target page, context or browser has been closed", sleep 16:29:27 to 16:32:33; test 544 (desktop-light, tid-008-session `AC5: sign out`) 648 s, "page.evaluate: Test timeout exceeded", sleep 16:34:47 to 16:45:34. A watcher that dumped state 60 s into the second stall showed every process at 0% CPU, `/api/health` answering in 5 ms, Chromium alive: nothing was hung. After wake the wall clock has jumped past the 30 s test timeout, so the test in flight is failed. desktop-dark had no sleep and no failure. The same three tests plus their siblings passed 16 of 16, in all four projects, in 65 s under `caffeinate -ims`.
- Stall pattern for TID-038: phase is whatever the test was doing when the machine slept (context setup, an API request, `page.evaluate`), so it looks random; the duration equals the sleep (190 s to 17 min); it hits one to three tests per run, on any project; it needs an unattended machine and a run longer than about 3 minutes; the app, wrangler and Chromium are healthy throughout. Nothing in the harness (`execFileSync` to wrangler, the shared D1) was involved.
- Suggested fix: run local full runs under `caffeinate -ims` (done in TEST_STRATEGY), add `npm run test:e2e:full` that wraps it on macOS, have the harness log a "host slept" note when two consecutive test timestamps differ by far more than the test timeout, and consider `retries: 1` locally for tests that fail after a wall-clock jump. The pattern does not need a Playwright or wrangler fix.

### DEF-013: A feed whose guids change every fetch floods entries with no cap

- Story: TID-012 (FR-RF-5, spec 9.4, risk to the D1 write budget)
- Severity: S3 (design gap, PM decision). Owner: PM, then SE.
- Status: Resolved by TID-046 (tester, commit 2be5f4b): secondary key against the previous fetch plus a 200/UTC day cap; verified by `apps/worker/test/churn-guard.test.ts` and `churn-guard-adversarial.test.ts`. Closed on PM acceptance of TID-046.
- Found by: `apps/worker/test/refresh-adversarial.test.ts` > "CHARACTERISATION: a feed whose guids change every fetch..." (passes by asserting today's behaviour)
- Steps to reproduce: serve 50 items with new guids on every fetch (timestamped or random guids, which exist in the wild).
- Expected: some guard: a per-feed cap on new entries per day, or a flag for feeds that are all-new every fetch.
- Actual: 50 entries and 50 unread rows per subscriber per fetch: 401 rows written per fetch (1 subscriber), about 19,248 rows/day for one feed (19% of the daily quota), 2,400 new unread articles/day, and `entries` grows by 2,400 rows/day until retention (TID-021). The 50-item cap bounds one fetch, not the day.
- Suggested fix: PM to decide. Options: throttle a feed to N new entries/day, back off the interval when more than 80% of a fetch is new three times in a row, or only link items newer than the newest known `published_at`.

### DEF-014: A 304 on a never-fetched feed marks it ok and sets last_success_at

- Story: TID-012 (AC2, spec 7.3 step 2)
- Severity: S3. Owner: SE.
- Status: Closed (tester, tip 522b2bb)
- Found by: `apps/worker/test/refresh-adversarial.test.ts` > "a 304 for a feed that has never been fetched does not claim success (DEF-014)" (marker removed)
- Steps to reproduce: a `pending` feed with `last_success_at NULL` and no etag; origin answers 304 (a buggy origin or proxy; no validators were sent).
- Expected: not a success: the feed stays `pending` (or fails) with no `last_success_at`.
- Actual: `unchanged()` sets `state='ok'`, `last_success_at=now`. The feed has no content, and its first real 200 then links every item (the FR-SU-3 10-item limit is lost because that rule keys on `last_success_at IS NULL`).
- Suggested fix: in `unchanged`, treat a 304 as success only when the job sent a validator (`etag` or `lastModified` not null) or `bodyHash` is not null; otherwise record a failure.
- Fix: a 304 when the job sent no `etag` and no `lastModified` is a failure `http_304` (existing `http_<status>` family; added the reason phrase 'Not Modified' so the fixed message reads "The server returned 304 Not Modified"), with normal backoff and no `last_success_at`. PM note: no new code type was added; confirm that message wording is acceptable.
- Closure (tester, 522b2bb): the two DEF-014 tests differ from the earlier `it.fails` only by `it.fails` to `it` (assertions unchanged); the new http_304 and 'after we sent an ETag is still success' tests are additions. The guard is `job.etag === null && job.lastModified === null` on the `not_modified` branch, which is correct: a 304 is only meaningful for a conditional request. A feed with a body hash but no validators (origin that sends neither ETag nor Last-Modified) also gets a 304 only if it is broken, so failing it is right. `npm test -w @tidings/worker`: 562 passed, 1 todo, 25 files, 5 consecutive solo runs.

### DEF-015: Spec 9.8 understates the cost of a first fetch and of an OPML import

- Story: TID-012 (FR-SU-3, spec 9.8 item 2)
- Severity: S3 (budget documentation, no AC fails). Owner: PM.
- Status: Open
- Found by: `refresh-adversarial.test.ts` > "first fetch of a 50-item feed stores 50 entries but links 10: 201 rows..."
- Expected (spec 9.8): 250 feeds x 10 items x 8 rows = about 20,000 rows.
- Actual: the refresher stores all parsed items (up to 50) and links 10: 50 x 3 + 10 x 5 + 1 = 201 rows per feed, so about 50,250 rows for 250 feeds (50% of a day, 75% on import day in scenario A). Storing all 50 is the right design (otherwise items 11 to 50 would arrive as new and unread on the next fetch); the spec number is wrong. The engineer's read-cost note (about 121 reads per changed fetch) is also not yet in 9.5.
- Suggested fix: PM updates 9.8 and 9.5, and decides whether import needs a longer stagger.

### DEF-016: AC13 gate ignores invocations that died for any reason other than exceededCpu

- Story: TID-012 (AC13), `apps/worker/bench/analysis.ts`
- Severity: S2 for the gate's validity (it could pass vacuously). Owner: SE.
- Status: Closed (tester, tip 522b2bb)
- Found by: `apps/worker/test/bench-gate.test.ts` > "a window with killed or crashed invocations is not a PASS" and "analytics seeing far fewer invocations..." (markers removed)
- Expected: any non-`success` status in a measured window (`exceededResources`, `exceededMemory`, `scriptThrewException`, `internalError`) fails the gate, and a window where Analytics saw less than 98% of the calls is not a PASS.
- Actual: only the literal status `exceededCpu` fails. Quantiles come from the `success` group only, so killed invocations drop out of the p95 (survivorship), and the 98% coverage check only adds a note. I could not check offline which status Cloudflare reports for a CPU kill, so the literal may never match.
- Suggested fix: FAIL on any non-success request count; NEEDS PM when coverage is under 98%. The runner's warnings (including `rejected` calls) are also not saved in the run file, so `analyze.ts` cannot enforce them; save them and fail the analysis when present.
- Fix: any non-`success` status in a gated window fails (per-status counts are in the table); coverage under 98% gives NEEDS PM; the runner saves its warnings in the run file and `analyze.ts` refuses to PASS with any (NEEDS PM). The tester's CPU-kill status question is moot: no status other than `success` can pass.
- Closure (tester, 522b2bb): the two DEF-016 tests differ only by marker removal. Any non-`success` count in a gated window now FAILs (including a missing status dimension, counted as `unknown`); coverage under 98% gives NEEDS PM and never hides a FAIL; the runner saves `runs` and `warnings` and `analyze.ts` passes them to `overall`. Residual S4 notes, not blocking: (1) ceilings are read from `run.scenarios` in the run file, not from the current plan, so a hand-edited or stale run file can carry a looser ceiling (a removed ceiling is caught as INCOMPLETE; a raised one is not); (2) run files written before this fix have no `warnings` or `runs` and are treated as none/200; (3) a window with more requests seen than calls made (overlapping windows or other traffic on the script) is not flagged and can contaminate the quantiles. Suggest the PM folds (1) into the first real AC13 run: have `analyze.ts` look ceilings up by id in the current plan.

### DEF-017: AC13 gate can PASS on too few calls or on a subset of the scenarios

- Story: TID-012 (AC13), `apps/worker/bench/analysis.ts`
- Severity: S3. Owner: SE.
- Status: Closed (tester, tip 522b2bb)
- Found by: `apps/worker/test/bench-gate.test.ts` > "fewer than 200 measured calls cannot PASS..." and "overall is not PASS with no gated rows..." (markers removed)
- Expected: AC13 requires at least 200 calls per fixture and all 8 gated scenarios.
- Actual: `evaluate` ignores `window.calls` (5 calls can PASS, for example `--runs 5`), and `overall` returns PASS for an empty list or for one row (`[].every(...)` is true; the existing test even asserts `overall([rowPass]) === 'PASS'`). The engineer's suggested `--only changed:rss-typical` run would print "Overall: PASS".
- Suggested fix: require `calls >= 200` in measure windows, and have `overall` check that all 8 gated scenario ids are present.
- Fix: each gated window needs at least max(`--runs`, 200) measured calls (else INCOMPLETE); `overall` requires every gated scenario of the full plan (10, not 8: 4 changed, 4 unchanged, 2 too_large). Empty, partial or `--only` runs print "PARTIAL: not a gate result". The old engineer assertion `overall([rowPass]) === 'PASS'` in `bench.test.ts` was wrong and now expects INCOMPLETE.
- Closure (tester, 522b2bb): the two DEF-017 tests differ only by marker removal. The engineer also changed `bench.test.ts` `overall([rowPass])` from PASS to INCOMPLETE; that is right: the old assertion encoded the vacuous-truth bug (one row of ten gated scenarios is not a gate result), and the test keeps its intent via `overall([rowPass], { expectedIds: ['changed:rss-typical'] })` returning PASS. Gate review: PASS needs every gated id in the plan present (10), every row PASS (so NO DATA, PROVISIONAL, INFO-for-gated and NEEDS PM rows cannot pass), at least max(runs, 200) calls, no runner warnings, and an empty list is INCOMPLETE. I found no remaining vacuous path other than the S4 notes under DEF-016. Note the first worker run after `npm install` once showed 4 failures in setup.test.ts and setup-attack.test.ts (409 instead of 201); it did not recur in 6 solo runs, and 3 runs in parallel reproduce it, so it is shared local storage between concurrent vitest processes, not a product defect. Recorded for TID-038.

### DEF-040: Folder names are case-insensitive for ASCII only, so "Étude" and "étude" can both exist
- Story: TID-014 (AC2, FR-FO-1)
- Severity: S4. Owner: SE.
- Status: Open
- Found by: `apps/worker/test/folders-adversarial.test.ts` > "names differing only by non-ASCII case conflict" (`it.fails`).
- Steps to reproduce: `POST /api/folders {"name":"Étude"}`, then `{"name":"étude"}`.
- Expected: `409 conflict` (AC2 says duplicates are case-insensitive).
- Actual: `201`. The column is `COLLATE NOCASE`, which folds only A-Z. The drawer sort has the same limit.
- Suggested fix: PM decision. Either accept it (reword AC2 to "ASCII case") or compare a JS-lowercased `name_key` column (a migration).

### DEF-041: A folder name made only of zero-width characters is accepted
- Story: TID-014 (AC3)
- Severity: S4. Owner: SE.
- Status: Open
- Found by: `apps/worker/test/folders-adversarial.test.ts` > "a name made only of zero-width characters is rejected as blank" (`it.fails`).
- Steps to reproduce: `POST /api/folders {"name":"\u200b\u200b"}`.
- Expected: `400 validation_failed` (blank).
- Actual: `201`; the folder shows as an empty-looking row in the drawer. `trim()` does not remove U+200B/U+200C/U+200D/U+2060/U+FEFF. Same for feed titles.
- Suggested fix: strip those code points before the length check, in `folderRequestSchema` and the title schemas.


## Closed

### DEF-030: A feed link discovered on a page skips the address check, so a private-address feed is subscribed
- Story: TID-013 (AC6, spec 10.6)
- Severity: S3. Owner: SE.
- Status: Closed (tester, tip a3228bb). Verified by mutation: removing `checkUrl` from `safeCandidateUrl` fails 3 tests; turning `blocked` into `none` fails the `blocked_address` test. `resolve.ts` canonicalises and runs `checkUrl` on every discovered URL; a private one returns `blocked` and is dropped from a `feed_choice_required` list. `it.fails` flipped to a passing test.
- Found by: `apps/worker/test/subscribe-adversarial.test.ts` > "a page whose only feed link points at a private address must not create a subscription" (`it.fails`).
- Steps to reproduce: `POST /api/subscriptions` with a public page URL whose only `<link rel="alternate" type="application/rss+xml">` has `href="http://169.254.169.254/latest/meta-data"` (or `http://127.0.0.1/`).
- Expected: `422 blocked_address`, no feed row and no subscription (AC6: "a private-address URL ... nothing is created"). For `feed_choice_required`, candidates should not carry such URLs either.
- Actual: `201`; a `feeds` row and a subscription for the private URL are created. Only the typed URL goes through `checkUrl`; `resolveFeedUrl` returns the discovered URL and `routes.ts` uses it without `checkUrl` or `canonicalizeUrl`. No request leaves the Worker (companion test: the private address is never requested, because the refresher's `safeFetch` refuses it), so this is junk data and a failing subscription, not SSRF.
- Suggested fix: run `checkUrl` (and canonicalise) on the discovered URL in `resolve.ts` and return `blocked`; drop private candidates from a choice.

### DEF-011: Stripping HTML tags from plain-text fields in one pass re-forms a tag

- Story: TID-011 (ADR 0009 section 2, defence in depth)
- Severity: S3 (minor). Owner: SE.
- Status: Closed (tester, tip ec14a5c)
- Found by: `packages/feed-parser/src/adversarial.test.ts` > "stripping cannot re-form an element tag: <scr<b>ipt> (DEF-011)" (`it.fails`)
- Steps to reproduce: `<title><![CDATA[<scr<b>ipt>x</scr<b>ipt>]]></title>` (also `<<b>script>alert(1)<</b>/script>` and `<im<i>g src=x>`), and the same text in `<description>`.
- Expected: no HTML element tag survives in `title`, `author`, feed title or `summary` (ADR 0009 section 2). Stripping `<b>` should not leave `<script>` behind.
- Actual: title and summary are `<script>x</script>`, `<script>alert(1)</script>` and `<img src=x>`. `HTML_TAG_RE` runs once, so removing the inner tag joins the outer fragments into a new tag. Not exploitable today because every consumer renders these fields as text nodes; it becomes live markup if any future consumer (an email digest, an OPML export, `innerHTML` in a toast) trusts them as already stripped. The comment case (`<!<!-- -->-- -->`) is not affected: no `<!--` survives.
- Suggested fix: repeat the strip until the string stops changing (bounded, for example 3 passes, then drop remaining `<` that precede an element name), or replace removed tags with a space. Then switch the `it.fails` to `it`.
- Not blocking acceptance if the PM agrees the text-only rendering contract (spec 10.5) is the defence.
- Fix: `stripTags` in `packages/feed-parser/src/text.ts` repeats the whole strip (script/style, comments, block tags, element tags) until the text stops changing. Each changing pass shortens the text, so it terminates. A 16-pass cap bounds cost; if hit, every `<` that opens an element tag or `<!--` is deleted (the fix's claim: a deletion cannot create a new opener; this is wrong, see Retest). Tests: `adversarial.test.ts` DEF-011 test is now `it` (assertions unchanged), plus 3+ level nesting and a 2 KB timing test.

- Retest (tester, tip 5ef2072): the fixed-point loop is sound. At a fixed point every strip regex found nothing, and `HTML_TAG_RE` matches any `</?name` followed by whitespace, `/`, `>` or end, so no element tag or `<!--` can remain, and each changing pass shortens the text. The `adversarial.test.ts` DEF-011 test differs from the earlier version only by `it.fails` to `it` and its comment. All reported payloads and 3 to 1000 levels of split tags pass.
- Retest, residual hole: the cap fallback `current.replace(TAG_OPENER_RE, '')` is one regex pass, and deleting a `<` can create a new opener. In `<<b>`, the first `<` is followed by `<` so it is kept, the second is an opener and is deleted, and the result is `<b>`. To reach the fallback, the input needs more than 16 passes: `'<' + '<b'.repeat(17) + '>'.repeat(17)` returns `<b>`. With 18 levels it returns `<<bb>>` (no tag); with `'script>x'` appended at 17 it returns `<b>script>x`. Severity stays S3 (text-only rendering, needs a 40-byte crafted title), but the stated guarantee does not hold.
- Suggested fix: make the fallback final by deleting every `<` in the string (or every `<` followed by `/`, `!` or a letter), not only those that currently open an element tag. Alternatively loop the opener removal to a fixed point. Then switch the `it.fails` test "cap fallback cannot leave an element tag (DEF-011 residual)" in `adversarial.test.ts` to `it`.
- Fix 2: the cap fallback is now `dropOpeners` in `text.ts`: it deletes every run of `<` that is followed by `/`, `!` or an ASCII letter (a superset of all tag and comment openers; the run goes together so `<<b` cannot become `<b`) and repeats until nothing changes. The output has no `<` before those characters, so it is final. Chosen over deleting every `<` because literal `<` before a space, digit or end of text (`5 < 6`) is still kept. `adversarial.test.ts`: the `it.fails` is now `it` (assertions unchanged), plus 17, 18, 40 and 1000 level variants and the same with a `script>x` suffix.
- Closure (tester, ec14a5c): the residual test differs from the earlier `it.fails` only by `it.fails` to `it` and its comment; the new 17/18/40/1000-level and `script>x` tests are additions. `dropOpeners` is final: its loop exits only when `/<+(?=[/!A-Za-z])/` finds nothing, so the output has no `<` before `/`, `!` or a letter, and every element tag (`</?name`) and comment (`<!--`) opener needs one. Each round shortens the text, so it terminates. `npm test -w @tidings/feed-parser`: 181 tests pass (4 files), plus 6 in the second workspace run, no failures, no `it.fails` left for DEF-011.

### DEF-006: Atom `type="text"` (and untyped) content is stored unescaped

- Story: TID-011 (hostile input requirement, spec 6.5, ADR 0006)
- Severity: S2 (major). Owner: SE.
- Status: Verified, closed (fix d5b27dc)
- Found by: `packages/feed-parser/src/adversarial.test.ts` > "Atom summary/content type=\"text\" is escaped, not live markup (DEF-006)" and two siblings (marked `it.fails`)
- Steps to reproduce: `parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"><title>T</title><entry><id>1</id><title>x</title><content type="text">&lt;script&gt;alert(1)&lt;/script&gt;</content></entry></feed>', ...)`. Same for an untyped `<summary>` and for `type="text"` in CDATA.
- Expected: plain text is escaped when stored as HTML: `contentHtml === '&lt;script&gt;alert(1)&lt;/script&gt;'`, so the reader shows the characters. The code's own comment and the engineer's note say `type="text"` is escaped.
- Actual: `contentHtml === '<script>alert(1)</script>'`. `modeForAtomType` returns `'escape'` but `ontext` in `parse.ts` only escapes when `mode === 'xhtml'`; `'escape'` is never acted on. The parser turns text into live markup before DOMPurify, and the article renders wrong (markup shown as formatting or stripped). DOMPurify should still neutralise scripts, so this is defence-in-depth plus a correctness bug, not a known exploit.
- Note for the fix: untyped Atom text is, in practice, often HTML in the wild. The PM should rule on whether untyped `summary`/`content` stays "text" per RFC 4287 (then escape) or is treated as HTML (then document it). The snapshot for `atom-basic` item 1 ("Plain text summary.") is unaffected.
- Verification: `parse.test.ts` "Atom text constructs (AC12, ADR 0009 section 1)" (6 tests) and `adversarial.test.ts` "Atom summary/content type=\"text\" is escaped" and "type=\"text\" in CDATA is escaped" now pass as plain `it` (`it.fails` removed, assertions unchanged). The untyped test was re-pointed per ADR 0009 section 1: untyped `&lt;script&gt;`, `&lt;iframe&gt;` and `&lt;style&gt;` stay escaped (new input, same intent); untyped text with an allowlisted tag such as `&lt;b&gt;` is HTML (AC12, `parse.test.ts` "untyped text with an allowlisted tag is stored as HTML").

### DEF-007: Deeply nested elements make parse time quadratic (CPU budget)

- Story: TID-011 (AC4/AC6 robustness, spec 7.3, ADR 0006 CPU gate)
- Severity: S2 (major). Owner: SE.
- Status: Verified, closed (fix f65515a)
- Found by: `adversarial.test.ts` > "bounds work for deeply nested elements (DEF-007)" (`it.fails`); the engineer's "nested elements" test only asserts `typeof result.ok` and does not measure work.
- Steps to reproduce: parse an item containing N unclosed `<x>` elements. Node 25, M-series: 10k tags (30 KB) 11 ms, 20k 53 ms, 40k (120 KB) 434 ms, 200k (600 KB) 10.4 s, 300k (900 KB, inside the 1 MiB body cap) 16.6 s. Bare htmlparser2 with no callbacks shows the same curve, so the cost is inside the library's open-element stack.
- Expected: bounded work for any body within `MAX_BODY_BYTES`. Real feeds nest under 30 levels deep.
- Actual: a 100 KB hostile feed uses far more than the 10 ms Free-plan CPU budget; a 1 MiB one runs for tens of seconds in Node. On Workers it would be killed (`cpu_limit`) and backed off, but it could be repeated every refresh.
- Suggested fix: track depth in `onopentag` and stop (as the early stop does, via `parser.pause()`) past a limit such as 64, returning what was parsed so far.
- Verification: `adversarial.test.ts` "bounds work for deeply nested elements (DEF-007)" is a plain `it`. `parse.test.ts` "nesting bound (AC13)": 300k nested tags (about 890 KB) parse in <= 50 ms (best of 5), 2 good items then nesting gives those items with `truncated: too_deep`, nesting in the first item gives `parse_error`, exactly 64 levels parse and 65 truncate, a 40-deep xhtml content parses. The depth spy asserts <= 65 rather than 64 because htmlparser2 pushes the 65th tag onto its own stack before our `onopentag` runs; the pinned 64-accepted / 65-truncated test proves the accepted depth is 64 and no later open is processed. Judged acceptable.

### DEF-008: `xml:base` is ignored when resolving relative links

- Story: TID-011 (real-world shapes)
- Severity: S3 (minor). Owner: PM ruling, then SE.
- Status: Verified, closed (fix 042fb8f)
- Found by: `adversarial.test.ts` > "xml:base on an Atom entry is honoured for relative links (DEF-008)" (`it.fails`)
- Steps to reproduce: Atom entry with `xml:base="https://b.example.test/dir/"` and `<link href="p1"/>`, parsed with `baseUrl: 'https://a.example.test/feed'`.
- Expected: `https://b.example.test/dir/p1` (RFC 4287 s2).
- Actual: `https://a.example.test/p1`, a wrong URL that opens a 404 on the wrong host. Without `baseUrl` the link is null. The spec does not mention `xml:base`; if the PM rules it out of MVP, close as Won't fix and keep the test as documentation.
- Verification: `adversarial.test.ts` "xml:base on an Atom entry is honoured" is a plain `it`; `parse.test.ts` "xml:base (AC14)" (7 tests: entry, feed+entry+link composition, feed alone, imageUrl and RSS items, absolute href, non-http(s) is null, no leak between entries). The engineer honours `xml:base` on the root of any format, a small superset of ADR 0009 section 4; harmless, and still resolved only against `baseUrl` or an absolute base.

### DEF-009: RFC 822 dates with non-US zone names fall back to the fetch time

- Story: TID-011 (AC5, spec 6.5)
- Severity: S3 (minor). Owner: SE.
- Status: Verified, closed (fix 55a9811)
- Found by: `adversarial.test.ts` > "non-US named zones (CEST, BST, IST) are not silently replaced by the fetch time (DEF-009)" (`it.fails`)
- Steps to reproduce: `<pubDate>Mon, 09 Nov 2026 08:15:00 CEST</pubDate>`. `BST` behaves the same.
- Expected: a date near 2026-11-09T06:15Z (or at least a documented table of zones).
- Actual: `Date.parse` returns NaN, so `published_at = fetched_at`. Articles from European and Australian feeds that use zone names sort as "just fetched". The dedup key is unaffected (it uses the parsed ISO date or empty). `EST`, `EDT`, `CST`, `PST`, `GMT+1` and numeric offsets are correct (tested). Also note: a date with no zone (`2026-11-09 08:15:00`) is read in the host's local zone; Workers run in UTC so production is fine, but Node test runs depend on `TZ`.
- Verification: `parse.test.ts` "dates and zones (AC15)": all 31 zones in the ADR table (`it.each`), IST/unknown/lower-case as UTC, zone-less RFC 822 and ISO as UTC, and a test that flips `process.env.TZ`. `adversarial.test.ts` "non-US named zones" is a plain `it`. The whole parser suite passes under `TZ=UTC` and `TZ=Pacific/Auckland`. Unparseable or impossible dates fall back to the fetch time, consistent with AC5 and ADR 0009 section 5 (which only turns alphabetic zones into UTC).

### DEF-010: Plain-text fields lose text around literal `<` and `>`

- Story: TID-011 (AC1: title match)
- Severity: S3 (minor). Owner: SE.
- Status: Verified, closed (fix 049e81a)
- Found by: `adversarial.test.ts` > "plain-text fields keep literal angle brackets (DEF-010)" (three `it.fails` tests)
- Steps to reproduce: `<title>5 &lt; 6 and 7 &gt; 3</title>`; `<title>I &lt;3 RSS feeds</title>`; `<title><![CDATA[Vec<T> in Rust]]></title>`.
- Expected: titles `5 < 6 and 7 > 3`, `I <3 RSS feeds`, `Vec<T> in Rust`.
- Actual: `5 3`, `I`, `Vec in Rust`. `plainField` runs the tag-stripping regex over decoded text, and an unterminated `<` swallows everything to the end. The fixture snapshot `rss2-cdata-entities.json` freezes this: "CDATA title with <angle> brackets & ampersand" is stored as "CDATA title with brackets & ampersand". Suggested fix: strip only recognisable tags (`<` followed by a letter, `/` or `!` and a closing `>` within a short window), and decode entities after stripping.
- Verification: `parse.test.ts` "literal angle brackets in plain text (AC16)" and the three `adversarial.test.ts` tests are plain `it`. The `rss2-cdata-entities` snapshot now keeps `<angle>`. `hostile-html.json` item summary `<scr ipt> <script>alert('double')</script>` was checked by hand: the real `<script>...</script>` span (which starts inside `<scr<script>ipt>` and ends at `</scr</script>`) is dropped and leaves a space, `<scr` and `ipt>` remain as literal text (not element names), and the entity-escaped `&lt;script&gt;` is decoded once, after stripping, to literal text. That matches ADR 0009 section 2 and is rendered as text (summary is a text node in the SPA, spec 10.5). The adversarial XSS assertions were rewritten to the ADR (see DEF-011 for the one remaining gap).

### DEF-001: All-unread page 2 reads 103 rows, one over the NFR-7 budget of 102

- Story: TID-004 (AC5, NFR-7)
- Severity: S3 (minor). Owner: PM (ruling needed), then SE if the query must change.
- Status: Won't fix (budget relaxed, ADR 0008)
- Found by: `apps/worker/test/entries-list.test.ts` > "AC5: All-unread page 2 reads <= 103 rows (cursor continuation; see DEF-001)"
- Steps to reproduce: seed the DB (`buildSeedSql()`), call `listEntries(db, 'seed-user', { view: 'all', unreadOnly: true, limit: 50 })`, then again with `cursor` set to the returned `nextCursor`. Read `meta.rows_read` of the second call.
- Expected: NFR-7 says each All/Feed list query reads <= (limit + 1) x 2 = 102 rows.
- Actual: page 1 reads 102, page 2 reads 103. The engineer attributes the extra row to the cursor row being re-read on seek (not independently confirmed). Page 1 and the feed view are within budget.
- Decision needed: either NFR-7 and AC5 allow +1 on continuation pages (then tighten the test comment and keep the <= 103 assertion), or the query must change to hit 102. The test currently asserts <= 103 and references this ID. Impact is one row per page, so free-tier risk is negligible.
- Related observation (not a defect): folder view reads 211 rows for limit 50 on a 150-entry folder, consistent with spec 8.6 ("reads every matching row in that folder"). It is guarded at <= 2 x folder size.
- Resolution: PM ruling 2026-11-16, ADR 0008. NFR-7 on continuation pages is (limit + 1) x 2 + T, T being the user's rows in the view that share the cursor's `published_at` (T = 1 on the seed data, so <= 103). The test `apps/worker/test/entries-list.test.ts` > "AC5: All-unread page 2 reads <= 103 rows (cursor continuation; ADR 0008)" keeps the <= 103 assertion and its comment now cites ADR 0008. The tied-timestamp case belongs to TID-018 AC5.

### DEF-012: `config_error` responses are not `Cache-Control: no-store`

- Story: TID-007 (spec 8.1: "Responses carry `Cache-Control: no-store`"; AC-adjacent, the story added the header)
- Severity: S3. Owner: SE.
- Status: Closed (tester, tip a8d00f5)
- Found by: `apps/worker/test/setup-attack.test.ts` > "every response, including the config_error short-circuit, is Cache-Control: no-store (DEF-012)" (`it.fails`)
- Steps to reproduce: call any `/api/*` route with `ALLOW_FETCH_HOSTS` set and `APP_ORIGIN` not `http://localhost:*`.
- Expected: `500 config_error` with `Cache-Control: no-store`, like every other API response.
- Actual: no `Cache-Control` header. The config guard in `apps/worker/src/api/app.ts` is registered before the no-store middleware and returns without calling `next()`, so the second middleware never runs. No secret is in the body (fixed message), so impact is a cacheable 500 at an intermediary, not a leak.
- Suggested fix: register the no-store middleware first (it sets the header after `await next()`, which also covers short-circuits), then switch the `it.fails` to `it`.
- Closure (tester, a8d00f5): the test differs from the `it.fails` version only by `it.fails` to `it` and its comment (assertions unchanged: status 500 and `Cache-Control: no-store`). The no-store middleware is now the first `app.use` in `createApp`, so it also wraps the config guard's short-circuit. `npm test -w @tidings/worker`: 452 tests pass (19 files).

### DEF-002: A stored theme opposite to the OS flashes the OS tone while the stylesheet loads

- Story: TID-006 (AC1 spirit; FR-ST-1, NFR-10 "no flash of the wrong theme on load")
- Severity: S3. Owner: SE.
- Status: Verified, closed (fix 95792b2)
- Found by: `e2e/specs/tid-006-app-shell-qa.spec.ts` > "AC1: before the stylesheet arrives the canvas colour scheme equals the stored choice (DEF-002)" (marked `test.fail`, so it turns red when fixed and the marker must then be removed). A pixel-level run of the same scenario, with CDP screencast frames, showed tones dark,light,light under a dark OS with a stored light choice; that version is timing-dependent (the pre-stylesheet frame is not always composited), so the deterministic cause check is what is committed.
- Steps to reproduce: set `localStorage['tidings.theme'] = 'light'` with the OS in dark mode (or the reverse), hold back `/assets/*.css` for 1.5 s, load `/all`, and read `meta[name=color-scheme]` once `data-theme` is set.
- Expected: every frame is the stored theme's colour.
- Actual: the meta stays `light dark`, and the first composited frame is the OS canvas colour (rgb 18,18,18 under a dark OS) before the light stylesheet arrives. `theme-init.js` sets `data-theme`, but with the stylesheet outstanding the only thing colouring the canvas is `<meta name="color-scheme" content="light dark">`, which follows the OS, not the stored choice. The OS-equals-stored case (AC1 as written) is fine: all frames are correct, and the control test proves the detector fails when `theme-init.js` is absent.
- Suggested fix: have `theme-init.js` also set `meta[name=color-scheme]` content to the resolved theme (`light` or `dark`), and update it in `apply()`.
- Verification: `test.fail` removed, assertion unchanged from a42605d; passes in all four projects, twice. Root cause fixed: `theme-init.js` `apply()` now sets `meta[name=color-scheme]` to the resolved theme, so the canvas follows the stored choice before the stylesheet loads.

### DEF-003: App crashes when `localStorage` access throws (storage blocked)

- Story: TID-006 (robustness of the "/" redirect and last-list memory, FLOWS 1.8)
- Severity: S2 for affected browsers (blank app), S3 overall. Owner: SE.
- Status: Verified, closed (fix 95792b2)
- Found by: `apps/web/src/qa-shell.test.tsx` > "returns /all and does not throw when the localStorage global itself throws on access" (`it.fails`), and `e2e/specs/tid-006-app-shell-qa.spec.ts` > "localStorage blocked: the app still renders, follows the OS and "/" lands on /all (DEF-003)" (`test.fail`).
- Steps to reproduce: in a browser that throws `SecurityError` on reading `window.localStorage` (Chrome with "Block all cookies", some embedded webviews), open `/`.
- Expected: `/` redirects to `/all`, the shell renders, the theme follows the OS.
- Actual: `apps/web/src/lib/lastList.ts` uses `storage = localStorage` as a default parameter of `readLastList()` and `saveLastList()`. Default parameters are evaluated outside the function's `try/catch`, so the SecurityError propagates out of render (`App`) and an effect (`AppShell`) and React unmounts the tree. `theme-init.js` is safe (its access is inside `try`).
- Suggested fix: read the global inside the `try` (`try { return (storage ?? localStorage).getItem(...) }`).
- Verification: `it.fails` and `test.fail` removed, assertions unchanged. Root cause fixed: the `localStorage` global is read inside the `try` in `readLastList` and `saveLastList`. Unit and E2E (blocked storage) tests pass.

### DEF-004: A throwing Undo action leaves the toast on screen

- Story: TID-006 (toast region, UX app-shell 2.4)
- Severity: S4. Owner: SE.
- Status: Verified, closed (fix e16e62b)
- Found by: `apps/web/src/qa-shell.test.tsx` > "keeps the toast usable when the Undo action throws..." (`it.fails`).
- Steps to reproduce: show an Undo toast whose `run` throws, click Undo.
- Expected: the toast is dismissed, so a second click cannot re-run a failing action.
- Actual: `ToastCard` calls `item.action.run()` before `store.dismiss(item.id)`; the throw skips the dismiss and the Undo button stays until the timer expires.
- Suggested fix: dismiss first, or call `run()` in a `try/finally`.
- Verification: `it.fails` removed, assertion unchanged. The toast is dismissed before `run()`; a throw is logged and an error toast is shown. Checked against the store rules: dismiss promotes any queued toast, the error toast then replaces it (errors win over non-undo kinds), and an Undo toast is never replaced because it is already gone. `toast.test.ts` "Undo runs once" and the queueing tests pass. Observation (copy, not a defect): the error text says "Try again" although the Undo is gone; UX may want to reword.

### DEF-005: Drawer close inputs are not idempotent, so a repeated input leaves the screen

- Story: TID-006 (AC4, drawer closes on Escape and backdrop tap; UX app-shell 2.2 rule 1 "pushes one history entry")
- Severity: S3. Owner: SE.
- Status: Verified, closed (fix e16e62b)
- Found by: `e2e/specs/tid-006-app-shell-qa.spec.ts` (all `test.fail`, so they turn red when fixed and the markers must then be removed): "a double tap on the scrim closes the drawer once and stays on the screen (DEF-005)", "two Escape events in the same task do not navigate away from the screen (DEF-005)", "double-clicking Menu leaves exactly one history entry to unwind (DEF-005)".
- Steps to reproduce (mobile, 375 px): open `/settings`, then `/all`; open the drawer; double-tap the scrim (or the Close button), or press Escape twice quickly.
- Expected: the drawer closes and the user stays on `/all`.
- Actual: each input calls `navigate(-1)` (`closeDrawer` in `AppShell.tsx`) because nothing guards against a second call before React re-renders, so the second input pops the previous screen and the user lands on `/settings`. Likewise a second Menu click before the drawer has rendered pushes a second `state.drawer` entry, and one Escape then leaves the drawer open.
- Suggested fix: ignore close while a close is pending (a ref cleared when `open` flips), and make `openDrawer` a no-op when `location.state.drawer` is already set.
- Related observation (test-only, not a defect): right after Menu is clicked the dialog can take more than 100 ms to appear on a loaded machine; a tap on the scrim position in that window is a tap on the page behind. The drawer-stress tests wait for the dialog before interacting.
- Verification: three `test.fail` markers removed, assertions unchanged; pass in all projects, twice. Root cause fixed with ref guards (`openPending`, `closePending`) cleared on `[location.key, open]`. New edge cases probed and added as QA tests (3 of 3 runs pass on both mobile projects): browser Back closes the drawer, then Menu reopens and one Escape closes it, and a further Escape with nothing open does not navigate; after a reload onto a stale drawer entry, double-click Menu then one Escape stays on the screen. Residual, not fixable in the page: Escape and browser Back in the same task pop two entries.
