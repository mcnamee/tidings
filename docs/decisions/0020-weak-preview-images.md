# 0020. Weak preview images: detect, replace, and never stretch

- Status: Accepted (owner request 2026-11-20; the PM confirms at acceptance)
- Date: 2026-11-20
- Deciders: owner (request), software-engineer (design), product-manager (acceptance)
- Story: TID-072. Amends ADR 0019 (queue, step, limits) and spec §7.8.

## Context

TID-071 gave every feed a preview image, but quality is uneven and small images look bad stretched into hero rows and desktop cards. Production evidence:

- **Techmeme** items carry `<A HREF="<source article>"><IMG SRC="http://www.techmeme.com/261120/i32.jpg" WIDTH="100" ...></A>`: a tiny thumbnail over http. The entry link is a techmeme.com permalink, so its page has nothing better. The good picture is the `og:image` of the source article the link wraps.
- **Slashdot** (RSS 1.0) ended up with `https://a.fsdn.com/sd/twitter_icon_large.png`, a site-wide default. The story page's `og:image` is a 64px topic icon (`.../topics/china_64.png`). The good picture is on the source article linked from the story text.

## Decisions

1. **One shared weak-image check** (`apps/worker/src/images/weak.ts`, pure). Verdicts:
   - `junk`: URL names an icon, logo, favicon, avatar, gravatar, sprite, placeholder or `default-image`, lives in an `icons/`, `avatars/`, `emoji/`, `sprites/` or `topics/` directory, is `.ico` or `.svg`, or is a **site default**: the same URL already used by at least 2 other entries of the same feed (stored entries plus the other new items of the same fetch). Junk is never stored.
   - `small`: declared `width` or `height` under **300** (the feed's `<img>` attributes, `media:thumbnail` / `media:content` attributes, `og:image:width` / `height`), or a size baked into the URL under 300 (`_64.png`, `-150x150.jpg`, `/100x100/`, `?w=120`). Small images are real, so they are stored as a fallback.
   - `good`: anything else.
   Years and ids (`photo-2026.jpg`), big sizes (`-1200x630`) and words that merely contain a hint (`silicon`, `iconic`, `pixel-8`) do not trigger it.
2. **The parser reports declared sizes.** `ParsedItem` gains `imageWidth` and `imageHeight` (null when not declared), taken from the same source as `imageUrl`. `firstImgSrc` became `firstImg` (also returns the dimensions, and no longer mistakes `data-src` for `src`).
3. **At refresh** (`images/plan.ts`): junk is stored as no image, small and good images are stored, and an `http:` image on a known https-capable host (a short list, plus the entry's own host when the entry link is https) is upgraded to `https:`. An entry is queued when its image is junk, small or missing (and it has a link and is unread for someone). The site-default check costs one read of the feed's rows by the `(feed_id, guid_hash)` index, and only when a new item carries an image.
4. **Enrichment** tries the entry page's image first (as in ADR 0019), now judged by the weak check including the page's declared `og:image` size. If it is missing or weak, it follows the entry's **primary outbound link**: the first `<a href>` in the stored content or description on a different site than the entry link (last two host labels, three under `co.uk`-style names), preferring the link that wraps an `<img>`. It reads at most 16 KB of content and 60 anchors, and the URL goes through the same SSRF checks as any fetch. That page's `og:image` is used the same way.
5. **Only replace with something better.** Ranking: good (2) over small (1) over junk or none (0). A queued entry's stored image counts as at most small (it was queued for being weak), so a good image replaces a declared-small one even when its URL looks fine. A small image from a page is stored only when the entry has no usable image. If nothing better is found and the stored image is junk it is cleared. The UPDATE still compares the image it read (`image_url IS ?`), so a concurrent change wins.
6. **Limits stay those of ADR 0019, counted per fetch.** 12 fetches a run in total (the article page and the outbound page of an entry each count), 3 per host a run (both fetches count against their host), 600 a UTC day (the counter adds the fetches actually made), 2 redirects and 6 s each: at most 12 x 3 + 4 = 40 subrequests, under 50. Entries are worked on by 6 concurrent workers; each starts only while budget remains. If an entry's second fetch finds no budget, its queue row is kept for the next run (its first fetch is repeated, bounded by the daily cap); if the outbound host is at its per-host cap, the entry is finished without it. Each entry is otherwise still tried once.
7. **Client never stretches a small image.** When a row's preview image loads with `naturalWidth` between 1 and 299 it switches to a `small` layout: a thumbnail at natural size (never upscaled, `object-contain`, capped to the 96px box a thumbnail uses), in a row on every breakpoint, no hero and no `lg:col-span-2`. The text beside it does not move when the image loads (the 96px box is the same before and after). Small image URLs are remembered for the session so a remounted row (Back, refetch) starts small. A failed image still falls back to text-only. Only Tailwind classes are used (CSP forbids inline styles).
8. **Migration 0010** queues up to 300 unread entries fetched in the last 3 days whose stored image looks weak by URL alone (SQL `instr` and `GLOB` mirror of the URL rules; slightly broader than the code, which makes the final decision). It touches no `entries` row.

## Consequences

- More entries are queued than under ADR 0019 (weak and small images as well as missing ones). Rows written per enriched entry stay 3 (queue insert, UPDATE or clear, queue delete) and 2 when nothing changes; the 600-fetch daily cap still bounds fetches and the ceiling of about 2,300 rows a day is unchanged (spec §9.4). Because an entry can take two fetches, fewer entries are enriched under the cap in the worst case (300 instead of 600).
- Extra reads at refresh: one query per refresh that has new items with images, over that feed's rows (a few hundred at most with retention), well under the 10% line (estimated under 100,000 reads a day).
- A feed whose pictures are all small now shows small thumbnails, not stretched ones. The decision to show small images (rather than none) is deliberate: a small real picture beats a text row.
- The known https host list is static and short. An unknown host's `http:` image stays `http:` and may be blocked as mixed content in the browser; the entry is still queued if it is small.
- A site default is recognised only on its third use in a feed (two others), so the first two entries carrying a default image whose URL gives no hint keep it (they are not queued, being good by URL and size). Later entries are dropped and queued. Accepted: it needs no extra state.

## Alternatives considered

- **Probing image dimensions server-side (fetching the image):** another subrequest per entry and image bytes in the Worker; rejected. Declared sizes plus the client's `naturalWidth` check cover it.
- **A persisted flag for small images:** schema change and an API field for what the browser learns for free on load; rejected.
- **Upgrading every `http:` image:** breaks hosts without https (broken image); rejected for the short known list.
- **Following every link of an entry:** unbounded; rejected for the single primary link.
