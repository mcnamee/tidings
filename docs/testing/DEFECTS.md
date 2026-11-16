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

## Closed

None.
