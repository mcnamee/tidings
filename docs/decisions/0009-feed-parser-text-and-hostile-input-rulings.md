# 0009. Feed parser: text handling, nesting bound and real-world shapes

- Status: Accepted
- Date: 2026-11-17
- Deciders: product-manager
- Story: TID-011 (rejected 2026-11-17 pending DEF-006 to DEF-010)

## Context

The tester's adversarial suite on `tid-011-feed-parser` found five defects (DEF-006 to DEF-010 after renumbering) and the engineer made several choices the spec didn't cover. ADR 0006 fixed the library (htmlparser2 12), the caps (1 MiB body, 50 items, per-item content cap) and client-side sanitisation. This ADR settles the gaps. Nothing here is deployed, so nothing needs migrating.

## Options considered

- **Untyped Atom `content`/`summary`.** (a) RFC 4287 strictly: untyped is text, always escape. (b) Treat untyped as HTML. (c) Escape unless the text contains a tag from our HTML allowlist. (a) shows literal `<p>` to the reader for the many feeds that send HTML untyped. (b) is wrong for real plain-text feeds and turns text such as `&lt;script&gt;` into live markup. (c) costs one bounded regex and gets both cases right.
- **Deep nesting (DEF-007).** (a) Cap element depth and stop. (b) Cap total element count. (c) Switch parser. The quadratic cost is in htmlparser2's open-element stack, so a depth cap removes it at its root. (b) doesn't, and (c) reopens ADR 0006.
- **`xml:base` (DEF-008).** (a) Ignore it and close as Won't fix. (b) Honour it on `feed`, `entry` and `link` for item links only. (c) Full RFC 3986 scoping on every element. (a) sends the reader to a 404 on the wrong host. (b) is a few lines. (c) is effort for no visible gain, because relative URLs inside content are resolved by the client against the entry URL (TID-019 AC6).
- **Named zones (DEF-009).** (a) Fetch time, as built. (b) A fixed table of unambiguous abbreviations, with any other alphabetic zone read as UTC. (c) A full tz database. (a) sorts European and Australian articles as "just fetched". (c) is too heavy for the bundle.

## Decision

1. **Atom text constructs** (`title`, `summary`, `content`):
   - `type="text"`: the value is plain text. When it is stored as `content_html`, HTML-escape `&`, `<`, `>`, `"`. This applies to CDATA too.
   - `type="html"`: the decoded value is HTML.
   - `type="xhtml"`: the inner markup of the `div`, re-serialised, as now.
   - **No `type`:** escape it as text **unless** the decoded value contains an opening or closing tag whose name is in the spec §10.5 allowlist plus `div` and `span` (for example `<p`, `</a>`, `<br`, `<img`). Then it is HTML. `<script>`, `<iframe>` and `<style>` are not in that list, so untyped `&lt;script&gt;…` alone stays escaped text. Either way the client sanitises before rendering (§10.5).
   - RSS `description` and `content:encoded` are always HTML (unchanged).
2. **Plain-text fields** (`title`, `author`, feed title). After XML decoding: remove comments and tags whose name is an HTML element name (the WHATWG element list, any case), decode HTML entities once, collapse whitespace and trim. A `<` or `>` that isn't part of such a tag is literal text, so `5 < 6 and 7 > 3`, `I <3 RSS feeds` and `Vec<T> in Rust` survive intact. A known edge case, accepted: `List<Map>` loses `<Map>`, because `map` is an HTML element. `summary` keeps its §6.5 rule (strip tags from HTML, then decode) and gets the same literal-angle handling.
   - The dedup fallback key (§6.3 rule 3) uses the corrected title. Nothing is stored yet, so there's no migration. The `rss2-cdata-entities` snapshot must be regenerated to `CDATA title with <angle> brackets & ampersand`.
3. **Nesting bound.** `MAX_DEPTH = 64` open XML elements, counting every element from the document root, including `xhtml` content. Real feeds stay under 30. When an `onopentag` would exceed it, the parser stops at once (`parser.pause()`, as the item cap does) and:
   - if at least one item has closed, it returns those items as a normal result, with `truncated: 'too_deep'` so the refresher can log it;
   - otherwise it returns `parse_error` (reason `too_deep`, logged only).
   Feed health shows the existing `parse_error` message, "Couldn't parse the feed". There is no new user-facing error code, because the owner can't act on the difference.
4. **`xml:base`:** honour it on `feed`, `entry`/`item` and `link` for the item link and `imageUrl` only. Resolve each nested value against the parent's resolved base, and the outermost against `baseUrl`. If the result isn't http(s), drop it to null as now. `xml:base` on `content` is ignored, because the client resolves relative URLs in content against the entry URL.
5. **Dates.** RFC 822 and ISO 8601 as now, plus this fixed zone table. Anything else alphabetic is read as UTC, not as fetch time. A date with no zone is read as UTC explicitly, so tests don't depend on `TZ`. Future dates are still clamped to `fetched_at` (§6.5).

   | Abbr. | Offset | Abbr. | Offset | Abbr. | Offset |
   |---|---|---|---|---|---|
   | UT, UTC, GMT, Z | +00:00 | CET | +01:00 | CEST | +02:00 |
   | WET | +00:00 | WEST | +01:00 | BST | +01:00 |
   | EET | +02:00 | EEST | +03:00 | MSK | +03:00 |
   | JST, KST | +09:00 | HKT, SGT, AWST | +08:00 | AEST | +10:00 |
   | AEDT | +11:00 | ACST | +09:30 | ACDT | +10:30 |
   | NZST | +12:00 | NZDT | +13:00 | EST/EDT, CST/CDT, MST/MDT, PST/PDT | RFC 822 |

   `IST` is ambiguous (India, Ireland, Israel), so it is read as UTC, the same as any unknown zone.
6. **Engineer's choices, ruled:**
   - **Content cap = 102,400 UTF-16 code units**, applied during accumulation: confirmed. That is 100 KB for ASCII, and at most about 300 KB of UTF-8 for CJK-heavy text, well under D1's 2 MB row limit. The §9.6 storage average (6 KB) is unchanged. The worst case is recorded in §9.6.
   - **Unprefixed Atom namespace only** (`<feed xmlns="http://www.w3.org/2005/Atom">`): accepted for MVP. A prefixed Atom root (`<atom:feed>`) returns `parse_error`. Atom elements used *inside* RSS under a prefix, such as `atom:link`, are ignored as now.
   - **Relative links resolve only with `baseUrl`:** accepted. The refresher and discovery must always pass `baseUrl` = the final URL after redirects (TID-012 AC14).
   - **Channel fields after item 50 are not read:** accepted. RSS, Atom and RDF all put channel metadata before items in practice.
   - **`itunes:image`:** the item-level `itunes:image@href` is added to the `imageUrl` order after an image `enclosure` and before the first `<img>` (§6.5). Channel-level art is not used per item.
   - **NUL and lone surrogates:** every stored string has U+0000 removed and lone surrogates replaced with U+FFFD (`String.prototype.toWellFormed()`), before the caps are applied.
   - **Shared package:** the URL canonicaliser core and `guidHash` living in `@tidings/shared` is confirmed. The Worker and the parser must import that one implementation, and neither may keep a copy.

## Consequences

- TID-011 goes back to the engineer with AC12 to AC17 added. All five `it.fails` tests flip to `it` and pass.
- One regex sniff per untyped Atom text construct (on the first 4 KB) and one depth counter add negligible CPU, and the depth cap removes the only known super-linear path within 1 MiB.
- If a real feed nests deeper than 64 (unlikely), its later items are lost and the refresher logs `truncated: 'too_deep'`. If that shows up in production logs, we revisit.
- The zone table is a maintained list. A missing zone costs at most a few hours of sort error, not a "just fetched" timestamp.
