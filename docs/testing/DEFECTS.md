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

### DEF-002: Atom `type="text"` (and untyped) content is stored unescaped
- Story: TID-011 (hostile input requirement, spec 6.5, ADR 0006)
- Severity: S2 (major). Owner: SE.
- Status: Open
- Found by: `packages/feed-parser/src/adversarial.test.ts` > "Atom summary/content type=\"text\" is escaped, not live markup (DEF-002)" and two siblings (marked `it.fails`)
- Steps to reproduce: `parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"><title>T</title><entry><id>1</id><title>x</title><content type="text">&lt;script&gt;alert(1)&lt;/script&gt;</content></entry></feed>', ...)`. Same for an untyped `<summary>` and for `type="text"` in CDATA.
- Expected: plain text is escaped when stored as HTML: `contentHtml === '&lt;script&gt;alert(1)&lt;/script&gt;'`, so the reader shows the characters. The code's own comment and the engineer's note say `type="text"` is escaped.
- Actual: `contentHtml === '<script>alert(1)</script>'`. `modeForAtomType` returns `'escape'` but `ontext` in `parse.ts` only escapes when `mode === 'xhtml'`; `'escape'` is never acted on. The parser turns text into live markup before DOMPurify, and the article renders wrong (markup shown as formatting or stripped). DOMPurify should still neutralise scripts, so this is defence-in-depth plus a correctness bug, not a known exploit.
- Note for the fix: untyped Atom text is, in practice, often HTML in the wild. The PM should rule on whether untyped `summary`/`content` stays "text" per RFC 4287 (then escape) or is treated as HTML (then document it). The snapshot for `atom-basic` item 1 ("Plain text summary.") is unaffected.

### DEF-003: Deeply nested elements make parse time quadratic (CPU budget)
- Story: TID-011 (AC4/AC6 robustness, spec 7.3, ADR 0006 CPU gate)
- Severity: S2 (major). Owner: SE.
- Status: Open
- Found by: `adversarial.test.ts` > "bounds work for deeply nested elements (DEF-003)" (`it.fails`); the engineer's "nested elements" test only asserts `typeof result.ok` and does not measure work.
- Steps to reproduce: parse an item containing N unclosed `<x>` elements. Node 25, M-series: 10k tags (30 KB) 11 ms, 20k 53 ms, 40k (120 KB) 434 ms, 200k (600 KB) 10.4 s, 300k (900 KB, inside the 1 MiB body cap) 16.6 s. Bare htmlparser2 with no callbacks shows the same curve, so the cost is inside the library's open-element stack.
- Expected: bounded work for any body within `MAX_BODY_BYTES`. Real feeds nest under 30 levels deep.
- Actual: a 100 KB hostile feed uses far more than the 10 ms Free-plan CPU budget; a 1 MiB one runs for tens of seconds in Node. On Workers it would be killed (`cpu_limit`) and backed off, but it could be repeated every refresh.
- Suggested fix: track depth in `onopentag` and stop (as the early stop does, via `parser.pause()`) past a limit such as 64, returning what was parsed so far.

### DEF-004: `xml:base` is ignored when resolving relative links
- Story: TID-011 (real-world shapes)
- Severity: S3 (minor). Owner: PM ruling, then SE.
- Status: Open
- Found by: `adversarial.test.ts` > "xml:base on an Atom entry is honoured for relative links (DEF-004)" (`it.fails`)
- Steps to reproduce: Atom entry with `xml:base="https://b.example.test/dir/"` and `<link href="p1"/>`, parsed with `baseUrl: 'https://a.example.test/feed'`.
- Expected: `https://b.example.test/dir/p1` (RFC 4287 s2).
- Actual: `https://a.example.test/p1`, a wrong URL that opens a 404 on the wrong host. Without `baseUrl` the link is null. The spec does not mention `xml:base`; if the PM rules it out of MVP, close as Won't fix and keep the test as documentation.

### DEF-005: RFC 822 dates with non-US zone names fall back to the fetch time
- Story: TID-011 (AC5, spec 6.5)
- Severity: S3 (minor). Owner: SE.
- Status: Open
- Found by: `adversarial.test.ts` > "non-US named zones (CEST, BST, IST) are not silently replaced by the fetch time (DEF-005)" (`it.fails`)
- Steps to reproduce: `<pubDate>Mon, 09 Nov 2026 08:15:00 CEST</pubDate>`. `BST` behaves the same.
- Expected: a date near 2026-11-09T06:15Z (or at least a documented table of zones).
- Actual: `Date.parse` returns NaN, so `published_at = fetched_at`. Articles from European and Australian feeds that use zone names sort as "just fetched". The dedup key is unaffected (it uses the parsed ISO date or empty). `EST`, `EDT`, `CST`, `PST`, `GMT+1` and numeric offsets are correct (tested). Also note: a date with no zone (`2026-11-09 08:15:00`) is read in the host's local zone; Workers run in UTC so production is fine, but Node test runs depend on `TZ`.

### DEF-006: Plain-text fields lose text around literal `<` and `>`
- Story: TID-011 (AC1: title match)
- Severity: S3 (minor). Owner: SE.
- Status: Open
- Found by: `adversarial.test.ts` > "plain-text fields keep literal angle brackets (DEF-006)" (three `it.fails` tests)
- Steps to reproduce: `<title>5 &lt; 6 and 7 &gt; 3</title>`; `<title>I &lt;3 RSS feeds</title>`; `<title><![CDATA[Vec<T> in Rust]]></title>`.
- Expected: titles `5 < 6 and 7 > 3`, `I <3 RSS feeds`, `Vec<T> in Rust`.
- Actual: `5 3`, `I`, `Vec in Rust`. `plainField` runs the tag-stripping regex over decoded text, and an unterminated `<` swallows everything to the end. The fixture snapshot `rss2-cdata-entities.json` freezes this: "CDATA title with <angle> brackets & ampersand" is stored as "CDATA title with brackets & ampersand". Suggested fix: strip only recognisable tags (`<` followed by a letter, `/` or `!` and a closing `>` within a short window), and decode entities after stripping.

## Closed

None.
