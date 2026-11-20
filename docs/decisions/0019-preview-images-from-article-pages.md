# 0019. Preview images from article pages

- Status: Accepted (owner request 2026-11-20; the PM confirms at acceptance)
- Date: 2026-11-20
- Deciders: owner (request), software-engineer (design), product-manager (acceptance)
- Story: TID-071. Amended by ADR 0020 (TID-072: weak images, outbound-link fallback). Builds on ADR 0006 (parsing limits), ADR 0018 / TID-067 (queue and entrypoint pattern) and spec §7.8.

## Context

Formula1.com, Al Jazeera, The Guardian F1 and ASPI Strategist feeds have no image on any item (no media, enclosure or `<img>`), so their lists show no thumbnails, where Inoreader shows one by reading each article page's preview image. The article pages name it in `<meta property="og:image">`. Fetching article pages is new outbound traffic on the free tier, so it needs a budget.

## Decisions

1. **A queue table, `image_queue(entry_id)`, not a column.** Cheapest in rows written: 3 per enriched entry (queue insert, `entries.image_url` UPDATE, queue delete), 2 when the page yields nothing. A `image_tried_at` column would need a partial index to find work (insert, index removal, update: also 3) and rows in the large `entries` table. The queue is filled once per entry by the refresh (entries are stored once, so a deleted queue row is never re-queued: **each page is fetched at most once, success or failure**). Migration 0009 also queues the newest 300 recent unread image-less entries so the owner sees the effect on existing articles.
2. **Own invocation.** The step runs through the `ImageEnricher` entrypoint (`ctx.exports`), every minute after the dispatcher and only when the queue has a row. Its CPU and subrequests are separate from the refresh, and a failure cannot reach it.
3. **Bounds.** 12 pages a run, 3 per host a run, 600 pages a UTC day (`rate_limits` key `img:pages`), 60 queue rows examined, entries fetched more than 3 days ago dropped unfetched, entries no longer unread dropped unfetched. At most 2 redirects and 6 s per page, so a run makes at most 12 × 3 + 4 = 40 subrequests (limit 50).
4. **Only the head is read.** `safeFetch` gained `truncate` (cut at `maxBodyBytes` and cancel the stream, instead of `too_large`) and `accept`. The step reads the first 128 KB of decoded bytes, so a hostile or huge page, or a compression bomb, costs at most 128 KB of work. All SSRF rules apply on every hop (§10.6).
5. **Extraction is a bounded tag scanner**, not a DOM or a regex over the page. Priority: `og:image`, `og:image:secure_url`, `twitter:image`, `link rel=image_src`. The result must be a public http(s) URL (same host check as a fetch target); tiny declared sizes and obvious logo, favicon and placeholder names are skipped.
6. **Feed images win.** Entries with an image at insert time are never queued, and the UPDATE only writes when `image_url IS NULL`.
7. No API or web change: lists already render `imageUrl` with `loading="lazy"` and `referrerpolicy="no-referrer"`. Images still load directly from the publisher (Q9).

## Consequences

- About 700 rows written a day in A (0.7%), at most 2,300 (2.3%); reads at most about 270,000 a day in the worst case (spec §9.4, §9.5). Both under the 10% line, so no owner decision is needed.
- Outbound traffic: up to 600 page fetches a day, at most 128 KB each, from the Worker. Publishers see a `Tidings/1.0` user agent and at most 3 requests per host per minute.
- A page that fails once never gets an image (no retry). Acceptable: the cost of retries is more fetches for pages that mostly stay broken. A later story can add one retry if real data shows transient failures.
- Entries older than 3 days when their turn comes, or read first, stay without an image.

## Alternatives considered

- **`image_tried_at` column plus partial index:** same writes, bigger table, rejected above.
- **Fetch inside the refresh:** adds subrequests and CPU to the refresh and couples their failures; rejected.
- **Reading images at list time:** a fetch per view; rejected.
- **A proxy or image cache (Q9):** stays Won't do.
