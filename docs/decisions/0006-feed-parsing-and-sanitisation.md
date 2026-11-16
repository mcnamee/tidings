# 0006. Feed parsing on the Worker, HTML sanitisation in the browser

- Status: Accepted; parser library provisional on spike TID-002
- Date: 2026-11-16
- Deciders: product-manager

## Context

Parsing is the most CPU-intensive thing the Worker does and the Free plan allows 10 ms CPU per invocation. Feed HTML is untrusted and must be sanitised before it reaches the DOM. OPML import is a one-off parse of a ~50 KB file.

## Options

- Parser: **htmlparser2 12** (streaming SAX-style callbacks in `xmlMode`; tolerant; can stop early), **feedsmith 3** (complete RSS/Atom/RDF/namespace mapping on top of fast-xml-parser; builds a full object tree), fast-xml-parser 5 directly, native `HTMLRewriter` (fast, but HTML semantics break RSS: `<link>` is a void element in HTML).
- Sanitiser location: Worker at ingestion vs browser at render.
- OPML parse location: Worker vs browser.

## Decision

- **Parse feeds on the Worker with htmlparser2** in streaming mode with our own minimal RSS 2.0 / Atom 1.0 / RSS 1.0 mapper in `packages/feed-parser`, stopping after 50 items and ignoring elements we don't store. Provisional: TID-002 benchmarks htmlparser2 vs feedsmith on the real Free plan and may switch.
- **Use `HTMLRewriter`** only for feed autodiscovery in website HTML.
- **Sanitise in the browser** with DOMPurify, plus a strict CSP. The server stores raw content (capped at 100 KB) and never renders it.
- **Parse OPML in the browser** (`DOMParser`), send JSON in chunks of ≤ 100 feeds.

## Consequences

- Worker CPU is spent only on extraction; sanitisation cost moves to the client, which has plenty.
- Any future non-browser consumer of `contentHtml` must sanitise it too; the API types document it as raw.
- `packages/feed-parser` is pure TypeScript with no Workers APIs so it can be unit-tested and benchmarked in Node and swapped.
