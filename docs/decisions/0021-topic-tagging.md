# 0021. Topic tagging with Workers AI

- Status: Accepted (owner approval 2026-11-26; the PM confirms the as-built details at acceptance)
- Date: 2026-11-26
- Deciders: owner (second AI feature, model, budget, topic list, scope), product-manager (design, storage, caps)
- Stories: TID-077 (tagging pipeline), TID-078 (topic chips and the Topics setting), TID-079 (hide rules, deferred). Builds on ADR 0018 (embeddings, the `Recommender` entrypoint, the AI budget rows), ADR 0003 (data store), ADR 0008 (list read budgets), ADR 0012 (isolation).
- Evidence: `docs/testing/topic-tagging-2026-11-26/README.md` (owner-approved accuracy test, 118 hand-labelled articles).

## Context

The owner wants to filter the All articles list by topic ("AI", "Formula 1", "UK politics"), the way Inoreader's tag views work for them today. Feeds don't carry usable categories, so Tidings has to work out each article's topic.

The spec (§1.4) allowed exactly one AI feature, the recommended sort (ADR 0018). Summaries, translations and any chat or generative feature were out. On 2026-11-26 the owner approved a **second AI feature: topic tagging**. It uses a text-generation model, but only to choose topic numbers from a fixed list. No generated text is ever stored or shown. Summaries, translations and chat stay Won't do.

The accuracy test compared three approaches on 118 hand-labelled production articles. The results, from the README:

| Method | First tag right | Precision | Recall | Neurons per article |
|---|---|---|---|---|
| Embedding cosine top-1 (reuses TID-067 vectors) | 71% | 71% | 47% | 0 |
| Embedding per-topic z-score | 73% | 70% | 51% | 0 |
| `@cf/meta/llama-3.2-3b-instruct`, batches of 10 | 55% | 45% | 68% | about 0.9 |
| `@cf/meta/llama-3.1-8b-instruct-fast`, batches of 10 | 36% | 52% | 34% | about 0.9 |
| **`@cf/meta/llama-3.3-70b-instruct-fp8-fast`, batches of 10** | **93%** | **78%** | **81%** | **about 5.4** |

Embeddings alone get about 7 in 10 first tags right, and their second and third tags are mostly noise. The small models do worse than embeddings. The 70B model gets 93% of first tags right, and its misses are mostly arguable. The one systematic error was UK politics stories being tagged US politics, because the list had no UK topic.

## Decisions

### 1. A second AI feature, limited to choosing topics

Spec §1.4 is amended to allow two AI features: the recommended sort (ADR 0018) and topic tagging (this ADR). The tagging model only chooses up to three numbers from a fixed list. Its output is parsed as integers in range, and anything else is discarded. No model text is stored, logged or shown.

### 2. Model: `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, in batches

- Each new article gets **up to 3 topics, most relevant first**, from the system list (§5 below).
- One call tags a **batch of up to 20 articles** (`TAG_BATCH = 20`). Each article is sent as the same text TID-067 embeds: title, then summary, as plain text clipped to 400 characters. The prompt lists the topics, numbered, with their one-line descriptions, then the numbered articles. The model answers one line per article: `<article number>: <topic numbers, most relevant first>`, or `0` for none.
- `max_tokens = 10 × batch + 20`. Topic numbers instead of names, and batches of 20 instead of 10, cut the cost per article from about 5.4 neurons (as tested) to about 3 to 4 (§3).
- **Batch size 20 is not yet validated.** The test used batches of 10. Before TID-077 merges, the orchestrator reruns `llm.mjs` on the same gold set with batches of 20 and numeric output. It must reach **at least 90% first tag right** and **0% misaligned items** (an article given another article's topics). If it doesn't, `TAG_BATCH` becomes 10 and the cap (§3) still bounds the spend.
- The parser maps answers by **article number, not line order**. A missing or invalid line, an unknown topic number or a duplicate is dropped. If an article ends up with no valid line, it gets the fallback (§4). If the model answers `0`, the article is stored as tagged with no topic.
- The call has a **30 s timeout**. A timeout counts as a failed call.

### 3. Budget and the daily cap

Prices are from the Workers AI pricing page, checked on 2026-11-26 (spec §9.1). Workers Free includes 10,000 neurons a day, reset at 00:00 UTC. This model costs **26,668 neurons per million input tokens** and **204,805 per million output tokens**. The README's measured batch fits these prices: 1,270 prompt tokens plus about 100 completion tokens came to 53.5 neurons, and the price list gives about 54.

**Cost per call** at a batch of 20, estimated from the test's prompt:

- The fixed part of the prompt (instructions and 28 topics with descriptions) is about 820 tokens, so about 22 neurons a call.
- Each article adds about 45 input tokens and about 8 output tokens, so about 2.8 neurons an article.

**Calls are batched by time as well as size** (§6). A call made for 2 articles still pays the 22-neuron fixed part. If tagging ran every minute, as the embed step does, trickling arrivals would cost about 6,600 neurons a day. Batching by time avoids that.

| | A (1 user, 400 new articles a day) | Owner's measured rate (about 450 a day) | B (3 users, 800 a day) |
|---|---|---|---|
| Tag calls a day | about 30 (hourly flushes plus full batches) | about 32 | about 45 |
| Neurons a day | about 1,800 (18%) | about 2,000 (20%) | about 3,100 wanted. The cap stops it at **2,500 (25%)**, and about 1 in 4 articles gets the fallback |
| With the TID-067 embed step (about 100 to 200 a day) | about 1,900 (19%) | about 2,100 (21%) | about 2,700 (27%) |

This is inside the 15% to 25% the owner accepted.

**The cap in code.** Tagging may spend at most `TAG_DAILY_NEURON_CAP = 2,500` neurons per UTC day (25% of the free allowance). Spend is counted in a third `rate_limits` row, `ai:tag`, next to TID-067's `ai:tokens` and `ai:entries`, with the same UTC-day window and the same reset. Before each call the step computes an **upper bound** for the call: prompt characters ÷ 3 as input tokens (an over-estimate), plus `max_tokens` as output tokens, at the prices above. It calls only if `spent + upperBound ≤ cap`. After the call it adds the actual cost, from the response's `usage` (`prompt_tokens`, `completion_tokens`), or the upper bound when `usage` is missing. The cap can't be overshot, even when `usage` is absent. It is not shared with the embed cap.

**The Workers AI ceiling.** The embed cap (3,000 neurons, ADR 0018) plus the tag cap (2,500) is **5,500 neurons a day (55%)** at most, leaving 4,500 for retries and anything else on the account. Typical use is about 20%.

**Import day.** An OPML import of 250 feeds links about 2,500 unread entries in its first day (ADR 0013, 250 first fetches a day). Tagging them all with the model would cost about 8,000 neurons. The cap stops the model at 2,500. The newest entries are tagged first, so the newest 600 to 700 get model tags and the rest get the fallback.

### 4. Fallback: embedding top-1, else untagged

When the model isn't used for an article, the article gets **one topic**: the topic whose vector has the highest cosine similarity to the article's TID-067 embedding (raw top-1, 71% first tag right in the test). The model isn't used when:

- the cap can't cover the call
- the call fails, times out or returns something malformed
- the model gives the article no valid line

An article with **no embedding** stays **untagged** (`topics` NULL). That happens when the embed call failed three times and the queue row is parked, when the entry has no title or summary, or when there is no `AI` binding.

**Topic vectors** are embedded once with the TID-067 model, from the plain description (the test found the plain description slightly better than the BGE query prefix). They are stored in `topic_vectors(topic_id, version, vec)`, in the same 388-byte base64 form as `entry_embeddings`. The step reads them only in a run that needs the fallback (28 rows). It re-embeds them in one call (28 texts, about 2 neurons, counted in the embed budget) when any row's `version` is below `TOPICS_VERSION`, or a topic has no row.

Every fallback-tagged article is marked as such in storage (§5), so a later backfill could upgrade it, and so the logs can show the fallback rate.

**No AI binding** (local dev, E2E, tests): nothing is embedded or tagged, every `topics` is NULL, and topic filters show nothing. Tests inject a fake tagger and a fake embedder, as TID-067 does.

### 5. Storage: one packed integer column on `entries`

**Decision: `entries.topics INTEGER`, nullable, not indexed** (migration `0013_topic_tags.sql`). Entries are shared between users and the topic list is system-wide, so an article's topics belong on the shared `entries` row, computed once however many users have it.

Encoding, from the least significant bits:

| Bits | Meaning |
|---|---|
| 0 to 7 | first topic ID (0 = empty slot) |
| 8 to 15 | second topic ID |
| 16 to 23 | third topic ID |
| 24 to 25 | source: 1 = model, 2 = embedding fallback |

`NULL` means not tagged. A value with only source bits means tagged with no topic. Topic IDs are 1 to 255. The filter predicate is `(topics & 255) = ?t OR ((topics >> 8) & 255) = ?t OR ((topics >> 16) & 255) = ?t`.

**Why, against spec §9.4 (rows written is the first daily quota we'd hit):**

| Option | Rows written per tagged article | Order kept | Filter cost |
|---|---|---|---|
| **Packed column on `entries`, no index (chosen)** | **1** (one `UPDATE` of an unindexed column; nothing extra at purge, the value goes with the row) | Yes | Bounded scan of the user's index (§7) |
| Bitmask column (`1 << id`) | 1 | **No** (loses "most relevant first") | Same |
| `entry_topics(entry_id, topic_id)` with only a primary key | about 2.2 at tagging and 2.2 at deletion, so about 4.4 | Needs a rank column | Can't filter without a `topic_id` index |
| `entry_topics` plus a `(topic_id, entry_id)` index for filtering | about 8.8 | With a rank column | Index probe, but still has to join the user's `user_entries` |
| Per-user `user_entry_topics` mirroring the `ue_*` indexes | about 2.2 × 6 = 13 **per subscriber** | Yes | Indexed per user |

At 400 articles a day the packed column costs **400 rows a day (0.4%)**. The table options cost 1,800 to 5,200 rows (1.8% to 5.2%), and the per-user table costs 5,200 per user. The column's price is in reads: the topic filter can't use an index, so it scans the user's newest rows and checks each entry's `topics` (§7). Reads are 20 times more plentiful than writes (5,000,000 against 100,000 a day), and the scan is bounded. JSON text (`'[14,13]'`) was also considered and rejected: it is larger, and `json_each` filtering costs more CPU in D1 than integer arithmetic.

**Open to user-defined topics later.** The packed column holds only **system** topics (IDs 1 to 255). User-defined topics would be per user, so they can't live on the shared `entries` row. They would need a per-user store and per-user tagging, at about 6 rows per subscriber per article, plus a new budget and ADR. The API is already shaped for them: topic IDs are strings in the API (§8), and system topics use slugs, so user topics could later use another form (for example `u:<uuid>`) without changing a field. Settings store an ordered list of these string IDs.

### 6. How tagging fits the embed step (one step, not two)

Tagging is **part of the TID-067 embed step** in the `Recommender` entrypoint. It isn't a separate step with its own queue. The step becomes the **embed-and-tag step**:

1. It takes up to **20** ready `embed_queue` rows, newest first (`AI_BATCH = 20`, down from 25, so one run is one embed call and one tag call).
2. Entries that **already have an embedding** are not embedded again. Their vector is read from `entry_embeddings`. This is new, and it is what lets a backfill or a retag re-queue entries for tagging only (§9).
3. It makes one embed call for the rest, as today. If the call fails, `tries` goes up and nothing else is written, as today.
4. If the tag budget covers a call (§3), it makes one tag call for the batch. If not, or if the call fails, it uses the fallback (§4) from the vectors it already holds.
5. It writes everything in **one D1 batch**: the embedding inserts, one `UPDATE entries SET topics = ?` per entry, the queue deletes, and the counters (`ai:tokens`, `ai:entries`, and `ai:tag` when the model was called).

**Cost: 1 extra row written per article** (the `UPDATE`), plus 2 rows per model call for the `ai:tag` counter. A separate tag queue, or a flag on `embed_queue`, would cost 2 more rows per article (insert and delete, or update and delete), and the brief asks for the cheapest option in writes.

**When the step runs (the batch gate).** The fixed prompt cost (§3) means tagging must not run every minute for one or two articles. The step runs when **any** of these holds:

- (a) at least 20 ready rows are queued (probe: `SELECT 1 FROM embed_queue WHERE tries < 3 LIMIT 20`, at most 20 rows read)
- (b) it is the **hourly flush**, the dispatcher tick at minute 41 of each UTC hour (clear of the :17 maintenance run), and the queue has any ready row
- (c) the tag budget can't cover a call today, in which case the step runs every minute while the queue has a row, as TID-067 did, and tags by the fallback

So every article is tagged within about **60 minutes** of being linked (`TAG_FLUSH_MINUTES = 60`). Full batches go sooner.

**Consequence for TID-067.** New entries now get their embedding up to 60 minutes later, instead of within a minute. Until then, the Recommended sort scores them with the default cosine of 0.3 plus the full freshness bonus. They still show near the top as fresh articles, just not ranked by interest for that first hour. This is accepted as the cheaper design. Keeping embeddings every minute and tagging separately would cost one more row per article (about 400 a day, 0.4%), which is affordable. **Open question for the owner (spec §16.1 Q18):** recommended default, accept the delay.

The embed cap (`DAILY_ENTRY_CAP` 3,000 entries a day) still bounds the step. Past it, nothing is embedded or tagged until 00:00 UTC, and the queue waits. Only entries in `embed_queue` are tagged: new entries linked as unread by a refresh or a new subscription. Entries linked as already read (older than 7 days on a first fetch) are never queued, so they are never tagged. They never appear in an unread list, and they never show under a topic chip.

**Concurrency.** A model call can take several seconds. With the 30 s timeout it ends well before the next minute's run. The step also keeps TID-067's rule that a run handles only the rows it read, and every write is idempotent (`UPDATE … SET topics`, `INSERT OR IGNORE` embeddings, `DELETE` by key). An overlapping run can at worst tag an entry twice and spend one extra call, inside the cap.

### 7. Reading: filter by topic, bounded

`GET /api/entries?view=all&topic=<id>` (spec §8.5) is the only list that filters by topic, matching the owner's ask (chips on All articles). Folder and feed views reject `topic` with `400`. The scan is bounded:

- **Newest first.** A page reads at most **`TOPIC_SCAN_LIMIT = 1,000`** of the user's `user_entries` index rows after the cursor (`ue_unread_all` or `ue_all`), joins each to `entries` and keeps those whose `topics` match, up to `limit + 1`. If the scan limit is reached first, the page may be **short or even empty**. Its `nextCursor` is then the key of the last row *scanned*, so the next request carries on from there. `nextCursor` is `null` only when the index is exhausted. Worst case about 2,000 rows read per page, plus the page rows. The SPA keeps loading while the end of the list is in view (TID-078).
- **Recommended plus a topic.** The candidates are the matching entries among the newest 1,000 unread, at most 500 (`CANDIDATE_LIMIT`), ranked exactly as in TID-067. Phase 2 is the newest-first topic scan above, starting below the ranked set.
- **Mark all as read with a topic** (`POST /api/entries/mark-all-read`, optional `topic`) marks only the unread entries of that topic published at or before `before`. It reads the user's unread rows and their entries (about 2 × unread, 2,000 at the assumed 1,000 unread backlog) and writes the usual 4 rows per article marked.

No per-topic unread counts. They would mean scanning every unread row and joining it to `entries` on every counts call (about 2,000 reads, 200 times a day). They are out of scope (TID-078).

### 8. Retention

The tag lives on the `entries` row. It costs 8 bytes and **no extra write at any retention step**. A purge leaves it on the tombstone (never read again, since purged entries have no `user_entries` rows), and it is deleted with the tombstone after 180 days. `topic_vectors` is 28 rows and is only replaced, never swept. No new maintenance step.

### 9. The topic list and retagging when it changes

**The list** lives in code (`packages/shared/src/topics.ts`): `TOPICS: { id: number; slug: string; name: string; description: string }[]` and `TOPICS_VERSION = 1`. It holds the 27 topics in `topics.json` plus **UK politics** (ID 28, description: "United Kingdom politics: the Prime Minister, Westminster, Parliament, Labour, the Conservatives, Reform UK, the Liberal Democrats, UK elections"). IDs are stable, are never reused, and don't depend on display order. UK politics is shown after US politics. The list is in spec §7.9.

**When the list changes**, the change bumps `TOPICS_VERSION`, and these rules apply:

- **Add a topic:** new ID. From the next run, new articles are tagged against the new list, and the topic vectors are recomputed. Existing articles are **not** retagged automatically.
- **Retire a topic:** it is removed from `TOPICS` and its ID is listed in `RETIRED_TOPIC_IDS`, never to be reused. Stored tags that carry it are ignored when read (not in `topics`, never matched by a filter, which rejects the ID with `400`), and it is dropped from a user's chip setting when the setting is read.
- **Reword a description:** keep the ID if the meaning is the same. Otherwise retire the topic and add a new one.
- **Backfill or retag (optional, per change):** a numbered migration re-queues recent unread entries into `embed_queue`, as migration 0009 did for images. The step reuses their embeddings (§6) and only tags them. The cost is about 3 rows written per entry (queue insert, `topics` update, queue delete) and about 3 neurons per entry inside the daily cap. A retag of 400 entries costs about 1,200 rows (1.2%) and 1,300 neurons. Each backfill is its own small story with its numbers.

**At launch**, migration 0013 queues the **newest 400 unread entries published in the last 3 days** (about a day of articles), so the chips aren't empty on day one. That is a one-time cost of about 1,200 rows written and up to about 1,300 neurons, inside the first day's cap. What doesn't fit gets the fallback.

### 10. Privacy and security

- The model sees only public feed text (titles and summaries), as the embed step does, on Workers AI in the owner's own Cloudflare account. It never sees user identifiers, settings or engagement signals.
- **Prompt injection.** Titles and summaries are untrusted. The worst a hostile article can do is skew the topic numbers for its own batch. Output is only ever parsed as integers between 1 and the number of topics. It is never rendered, logged or used in a query except as a bound integer.
- New routes and parameters follow spec §8.1: session required, CSRF on writes, the `API_RL` limit, and every query scoped to the caller's `user_id`. `topic` is a value from a fixed list, not an object ID, so it needs no isolation case. A test still checks that user B's topic list contains only B's entries (ADR 0012 standing rule).
- The step logs counts only: model-tagged, fallback-tagged and untagged entries, calls, and neurons charged.

## Consequences

- **Free tier: no quota passes 10% of its daily limit at either load**, and nothing exceeds the free plan. Neurons are the one new spend, at about 20% typical and capped at 25%. Details are in spec §9.
  - **Rows written:** about +500 a day in A (0.5%) and +900 in B (0.9%), plus one-time 1,200 for the launch backfill. Import day goes from about 90% to about 92% in A. That is still the tightest day, already flagged in §9.8, and bounded by the 250 first fetches a day.
  - **Rows read:** about +110,000 a day in A (2.2%) and +250,000 in B (5%), mostly topic list pages and the gate probe.
  - **Requests:** no new invocations. The step runs less often than before (batched), so requests go down slightly.
  - **CPU:** prompt building and parsing are microseconds. The fallback is 20 × 28 cosines of 384 dimensions, under 1 ms. Each run is its own `Recommender` invocation.
  - **Storage:** about 9 bytes per entry, plus 15 KB of topic vectors.
- **First limit we'd hit for this feature: our own tag cap.** It is meant to be hit on busy or import days. Past it, tags degrade to the embedding top-1 (71% first tag right) instead of failing.
- **Recommended sort freshness:** new entries are ranked by interest up to 60 minutes later than before (§6, Q18).
- **Untagged articles exist**, and the owner should expect them: no `AI` binding, a parked embed, an article without text, articles linked as already read, and articles from before launch beyond the backfill. They appear in All, never under a topic chip.
- **Model availability.** If Cloudflare retires or reprices `llama-3.3-70b-instruct-fp8-fast`, the cap still holds (it is enforced from `usage`), and the fallback keeps tags coming. Changing the model needs this ADR amended, and the gold-set test rerun.

## Alternatives considered

- **Embeddings only (no model).** Free in neurons, but 71% to 73% first tag right, and second and third tags are noise. The owner chose the 70B model after seeing the test. Kept as the fallback.
- **Smaller models (3B, 8B).** Cheaper, but worse than embeddings in the test (they misalign batch items and stray from the list).
- **A separate tag step with its own queue.** Keeps embeddings every minute, at +2 rows written per article (+400 to 800 a day) and a second queue. Rejected for the cheapest-writes design. Still a valid fallback if the owner rejects the delay (Q18). It would then cost +1 row per article, by flagging the existing queue row.
- **Tag at refresh time.** Rejected. A model call in the refresh would tie feed freshness to Workers AI latency, and a failed call would fail a refresh (the same reasoning as ADR 0018 §2).
- **Vectorize or a KV index for topics.** No benefit at 28 topics. KV's 1,000 writes a day are scarcer still.
- **Per-topic unread counts on chips.** Rejected for now on reads (§7).
