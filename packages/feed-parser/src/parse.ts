import { Parser } from 'htmlparser2';
import { canonicalizeHttpUrl } from '@tidings/shared/url';
import { parseFeedDate } from './dates';
import { itemKey } from './key';
import { MAX_CONTENT_CHARS, MAX_DEPTH, MAX_ITEMS_PER_FETCH, MAX_SHORT_FIELD_CHARS } from './limits';
import {
  CappedText,
  cleanText,
  escapeAttr,
  escapeHtml,
  escapeText,
  firstImg,
  plainField,
  safeSlice,
  sniffedHtml,
  summarise,
} from './text';
import type { FeedFormat, ParsedFeed, ParsedItem, ParseOptions, ParseResult } from './types';

/** media:content URLs that are clearly not pictures. */
const NON_IMAGE_EXT = /\.(?:mp3|mp4|m4a|m4v|mov|webm|ogg|oga|ogv|wav|aac|pdf|m3u8)$/i;

type Field =
  | 'title'
  | 'link'
  | 'guid'
  | 'author'
  | 'dcCreator'
  | 'published'
  | 'updated'
  | 'description'
  | 'encoded'
  | 'content'
  | 'summary';

/**
 * How captured text is stored: verbatim, escaped to HTML (Atom type=text), escaped unless it
 * looks like HTML (untyped Atom, ADR 0009 section 1), or re-serialised (xhtml).
 */
type Mode = 'raw' | 'escape' | 'sniff' | 'xhtml';

interface Capture {
  field: Field;
  text: CappedText;
  mode: Mode;
  /** Stack length right after the capturing element was pushed. */
  depth: number;
}

interface ItemState {
  /** Stack length right after the item element was pushed. */
  depth: number;
  fields: Partial<Record<Field, string>>;
  about: string | null;
  /** Resolved `xml:base` in force for this item (feed base, then the item's own). */
  base: string | null;
  /** Resolved base for the RSS `<link>` capture (its own `xml:base`, else `base`). */
  linkBase: string | null;
  atomLinks: { href: string; rel: string; base: string | null }[];
  atomAuthorOpenAt: number;
  thumbnail: string | null;
  mediaImage: string | null;
  enclosureImage: string | null;
  itunesImage: string | null;
  /** Declared `width`/`height` of the media thumbnail and media image (TID-072). */
  thumbnailSize: DeclaredSize;
  mediaSize: DeclaredSize;
  enclosureUrl: string | null;
}

type DeclaredSize = { width: number | null; height: number | null };
const declared = (attribs: Record<string, string>): DeclaredSize => ({
  width: toDim(attribs['width']),
  height: toDim(attribs['height']),
});
const toDim = (v: string | undefined): number | null =>
  v !== undefined && /^\s*\d{1,6}\s*$/.test(v) ? Number(v) : null;

const CONTENT_FIELDS: ReadonlySet<Field> = new Set([
  'description',
  'encoded',
  'content',
  'summary',
]);
const VOID_TAGS: ReadonlySet<string> = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'wbr']);

/** Direct-child element names inside an item that we store, mapped to a field. */
const ITEM_FIELD_BY_TAG: Readonly<Record<string, Field>> = {
  title: 'title',
  guid: 'guid',
  id: 'guid',
  pubDate: 'published',
  'dc:date': 'published',
  published: 'published',
  updated: 'updated',
  'dc:creator': 'dcCreator',
  description: 'description',
  'content:encoded': 'encoded',
  content: 'content',
  summary: 'summary',
};

function newItem(depth: number, about: string | null, base: string | null): ItemState {
  return {
    depth,
    base,
    linkBase: base,
    fields: {},
    about,
    atomLinks: [],
    atomAuthorOpenAt: -1,
    thumbnail: null,
    mediaImage: null,
    enclosureImage: null,
    itunesImage: null,
    thumbnailSize: { width: null, height: null },
    mediaSize: { width: null, height: null },
    enclosureUrl: null,
  };
}

/**
 * Atom text constructs (ADR 0009 section 1). Titles are plain-text fields and are flattened by
 * `plainField`, so they are never escaped here. `content` and `summary` are stored as HTML.
 */
function modeForAtomType(type: string | undefined, field: Field): Mode {
  const t = (type ?? '').trim().toLowerCase();
  if (t === 'xhtml' || t === 'application/xhtml+xml') return 'xhtml';
  if (field === 'title') return 'raw';
  if (t === 'html' || t === 'text/html') return 'raw';
  if (t === '') return 'sniff';
  return 'escape';
}

/**
 * Parses RSS 2.0, Atom 1.0 and RSS 1.0 (RDF) text with htmlparser2 in `xmlMode` (ADR 0006).
 *
 * Properties the caller can rely on:
 * - Never throws; failures come back as `{ ok: false }`.
 * - Stops consuming input after `maxItems` items close (`parser.pause()`; `end()` is never
 *   called), so cost does not grow with the size of the tail of the document.
 * - Text accumulation is capped while it happens (100 KB content, 2 KB for short fields).
 * - Entities declared in a DOCTYPE are never expanded and external entities are never fetched:
 *   htmlparser2 does not implement either, and this module does no I/O at all.
 * - Content is passed through as raw HTML; the browser sanitises it (ADR 0006).
 */
export function parseFeed(input: string, options: ParseOptions): ParseResult {
  try {
    return parseFeedUnsafe(input, options);
  } catch (err) {
    return {
      ok: false,
      error: { code: 'parse_error', message: err instanceof Error ? err.message : 'parse failed' },
    };
  }
}

function parseFeedUnsafe(input: string, options: ParseOptions): ParseResult {
  const maxItems = options.maxItems ?? MAX_ITEMS_PER_FETCH;
  const { fetchedAt, baseUrl } = options;
  if (input.charCodeAt(0) === 0xfeff) input = input.slice(1);
  input = cleanText(input);
  if (input.trim() === '') {
    return { ok: false, error: { code: 'empty', message: 'Empty response body' } };
  }

  const stack: string[] = [];
  const items: ParsedItem[] = [];
  let format = null as FeedFormat | null;
  let notAFeed = false;
  let tooDeep = false;
  let stopped = false;
  let finishing = false;
  let parseError = null as string | null;
  let item = null as ItemState | null;
  let capture = null as Capture | null;
  let feedTitle = null as string | null;
  let siteUrl = null as string | null;
  let channelLink = null as string | null;
  let feedAuthor = null as string | null;
  let feedAuthorOpenAt = -1;

  /** Resolved `xml:base` of the root element; nested bases compose on top of it (ADR 0009). */
  let feedBase: string | null = baseUrl ?? null;

  /** `xml:base` value resolved against its parent's base; unusable values leave the parent. */
  const composeBase = (parent: string | null, value: string | undefined): string | null => {
    if (value === undefined || value.trim() === '' || value.length > 4096) return parent;
    try {
      return (parent ? new URL(value.trim(), parent) : new URL(value.trim())).href;
    } catch {
      return parent;
    }
  };

  const resolveUrl = (
    raw: string | null | undefined,
    base: string | null = feedBase,
  ): string | null => {
    if (!raw) return null;
    let candidate = raw.trim();
    if (candidate === '' || candidate.length > 4096) return null;
    if (base) {
      try {
        candidate = new URL(candidate, base).href;
      } catch {
        return null;
      }
    }
    const r = canonicalizeHttpUrl(candidate);
    return r.ok ? r.url : null;
  };

  const startCapture = (field: Field, mode: Mode, depth: number): void => {
    capture = {
      field,
      mode,
      depth,
      text: new CappedText(CONTENT_FIELDS.has(field) ? MAX_CONTENT_CHARS : MAX_SHORT_FIELD_CHARS),
    };
  };

  const finishCapture = (): void => {
    if (!capture) return;
    let value = capture.text.toString();
    if (capture.mode === 'sniff') value = sniffedHtml(value, capture.text.cap);
    if (item) {
      // First occurrence wins.
      if (item.fields[capture.field] === undefined) item.fields[capture.field] = value;
    } else if (capture.field === 'title') {
      if (feedTitle === null) feedTitle = plainField(value) || null;
    } else if (capture.field === 'link') {
      if (channelLink === null) channelLink = value;
    } else if (capture.field === 'author') {
      if (feedAuthor === null) feedAuthor = plainField(value) || null;
    }
    capture = null;
  };

  const finishItem = (it: ItemState): void => {
    const f = it.fields;
    const rssLink = f.link ? resolveUrl(f.link, it.linkBase) : null;
    const altLink = it.atomLinks.find((l) => l.rel === '' || l.rel === 'alternate');
    const link = rssLink ?? (altLink ? resolveUrl(altLink.href, altLink.base) : null);
    let enclosureUrl = it.enclosureUrl;
    let enclosureBase = it.base;
    if (!enclosureUrl) {
      const enc = it.atomLinks.find((l) => l.rel === 'enclosure');
      if (enc) {
        enclosureUrl = enc.href;
        enclosureBase = enc.base;
      }
    }
    const enclosure = resolveUrl(enclosureUrl, enclosureBase);

    const guidRaw = (f.guid ?? it.about ?? '').trim();
    const guid = guidRaw === '' ? null : guidRaw;
    const rawTitle = plainField(f.title ?? '');

    const publishedMs = parseFeedDate(f.published) ?? parseFeedDate(f.updated);
    const publishedIso = publishedMs === null ? null : new Date(publishedMs).toISOString();
    const publishedSec = publishedMs === null ? null : Math.floor(publishedMs / 1000);
    const publishedAt =
      publishedSec !== null && publishedSec <= fetchedAt ? publishedSec : fetchedAt;

    const key = itemKey({ guid, link, title: rawTitle, publishedIso, enclosureUrl: enclosure });
    if (key === null) return; // no identity at all: nothing to dedupe on, skip

    const contentHtml = firstNonEmpty(f.encoded, f.content, f.description, f.summary);
    const summarySource = firstNonEmpty(f.description, f.summary, f.encoded, f.content);
    const summaryText = summarySource === null ? '' : summarise(summarySource);

    let imageUrl: string | null = null;
    let imageSize: DeclaredSize = { width: null, height: null };
    const sources: [string | null, DeclaredSize][] = [
      [it.thumbnail, it.thumbnailSize],
      [it.mediaImage, it.mediaSize],
      [it.enclosureImage, { width: null, height: null }],
      [it.itunesImage, { width: null, height: null }],
    ];
    for (const [candidate, size] of sources) {
      imageUrl = resolveUrl(candidate, it.base);
      if (imageUrl) {
        imageSize = size;
        break;
      }
    }
    if (!imageUrl && contentHtml) {
      const img = firstImg(contentHtml);
      imageUrl = resolveUrl(img?.src ?? null, it.base);
      if (imageUrl && img) imageSize = { width: img.width, height: img.height };
    }

    const authorText = plainField(f.dcCreator ?? f.author ?? '') || feedAuthor || '';

    items.push({
      guidKey: key,
      guid,
      title: rawTitle || safeSlice(summaryText, 80) || link || 'Untitled',
      link,
      author: authorText === '' ? null : authorText,
      publishedAt,
      contentHtml,
      summary: summaryText === '' ? null : summaryText,
      imageUrl,
      imageWidth: imageUrl ? imageSize.width : null,
      imageHeight: imageUrl ? imageSize.height : null,
    });
  };

  const parser: Parser = new Parser(
    {
      onopentag(name, attribs) {
        if (stopped) return;
        if (stack.length >= MAX_DEPTH) {
          // Opening this element would exceed the bound: stop at once (ADR 0009 section 3).
          tooDeep = true;
          stopped = true;
          parser.pause();
          return;
        }
        const depth = stack.length;
        const parent = depth > 0 ? stack[depth - 1] : undefined;

        if (depth === 0) {
          if (name === 'rss') format = 'rss';
          else if (name === 'feed') format = 'atom';
          else if (name === 'rdf:RDF') format = 'rdf';
          else {
            notAFeed = true;
            stopped = true;
            parser.pause();
            return;
          }
          feedBase = composeBase(feedBase, attribs['xml:base']);
          stack.push(name);
          return;
        }
        stack.push(name);

        // Inside an xhtml capture: re-serialise nested markup.
        if (capture) {
          if (capture.mode === 'xhtml') {
            let tag = '<' + name;
            for (const k of Object.keys(attribs)) tag += ` ${k}="${escapeAttr(attribs[k] ?? '')}"`;
            capture.text.append(tag + '>');
          }
          return;
        }

        if (item === null) {
          const isItem =
            (format === 'rss' && name === 'item' && parent === 'channel') ||
            (format === 'rdf' && name === 'item' && parent === 'rdf:RDF') ||
            (format === 'atom' && name === 'entry' && parent === 'feed');
          if (isItem) {
            item = newItem(
              stack.length,
              attribs['rdf:about'] ?? null,
              composeBase(feedBase, attribs['xml:base']),
            );
            return;
          }
          // Channel/feed level fields.
          if (format === 'atom' && parent === 'feed') {
            if (name === 'title')
              startCapture('title', modeForAtomType(attribs['type'], 'title'), stack.length);
            else if (name === 'author') feedAuthorOpenAt = stack.length;
            else if (name === 'link' && siteUrl === null) {
              const rel = attribs['rel'] ?? '';
              if (rel === '' || rel === 'alternate') {
                siteUrl = resolveUrl(attribs['href'], composeBase(feedBase, attribs['xml:base']));
              }
            }
          } else if (format !== 'atom' && parent === 'channel') {
            if (name === 'title') startCapture('title', 'raw', stack.length);
            else if (name === 'link') startCapture('link', 'raw', stack.length);
          }
          if (format === 'atom' && name === 'name' && feedAuthorOpenAt === stack.length - 1) {
            startCapture('author', 'raw', stack.length);
          }
          return;
        }

        // Inside an item.
        const it = item;
        // Media and enclosure elements carry data in attributes, at any depth.
        if (name === 'media:thumbnail') {
          if (it.thumbnail === null && attribs['url']) {
            it.thumbnail = attribs['url'];
            it.thumbnailSize = declared(attribs);
          }
          return;
        }
        if (name === 'itunes:image') {
          it.itunesImage ??= attribs['href'] ?? null;
          return;
        }
        if (name === 'media:content') {
          const type = (attribs['type'] ?? '').toLowerCase();
          const medium = (attribs['medium'] ?? '').toLowerCase();
          const url = attribs['url'];
          // Some feeds (the Guardian) give no type or medium: take it unless it names a non-image file.
          const untyped =
            !type && !medium && !!url && !NON_IMAGE_EXT.test(url.split(/[?#]/)[0] ?? '');
          if (url && (medium === 'image' || type.startsWith('image/') || untyped)) {
            const size = declared(attribs);
            // Several renditions (the Guardian sends 140 and 460 wide): keep the widest.
            if (it.mediaImage === null || (size.width ?? 0) > (it.mediaSize.width ?? 0)) {
              it.mediaImage = url;
              it.mediaSize = size;
            }
          }
          return;
        }
        const direct = stack.length === it.depth + 1;
        if (direct) {
          if (name === 'enclosure') {
            const url = attribs['url'];
            if (url) {
              it.enclosureUrl ??= url;
              if ((attribs['type'] ?? '').toLowerCase().startsWith('image/')) {
                it.enclosureImage ??= url;
              }
            }
            return;
          }
          if (name === 'link') {
            if (format === 'atom') {
              const href = attribs['href'];
              if (href) {
                it.atomLinks.push({
                  href,
                  rel: attribs['rel'] ?? '',
                  base: composeBase(it.base, attribs['xml:base']),
                });
              }
            } else {
              it.linkBase = composeBase(it.base, attribs['xml:base']);
              startCapture('link', 'raw', stack.length);
            }
            return;
          }
          if (name === 'author') {
            if (format === 'atom') it.atomAuthorOpenAt = stack.length;
            else startCapture('author', 'raw', stack.length);
            return;
          }
          const field = ITEM_FIELD_BY_TAG[name];
          if (field === undefined) return;
          if (name === 'guid' && format === 'atom') return;
          if (name === 'id' && format !== 'atom') return;
          if (
            format === 'atom' &&
            (field === 'content' || field === 'summary' || field === 'title')
          ) {
            startCapture(field, modeForAtomType(attribs['type'], field), stack.length);
          } else if (field === 'content' && format !== 'atom') {
            return;
          } else {
            startCapture(field, 'raw', stack.length);
          }
          return;
        }
        // <author><name> in Atom.
        if (
          name === 'name' &&
          it.atomAuthorOpenAt === stack.length - 1 &&
          it.fields.author === undefined
        ) {
          startCapture('author', 'raw', stack.length);
        }
      },

      ontext(data) {
        if (stopped || capture === null) return;
        capture.text.append(
          capture.mode === 'xhtml'
            ? escapeHtml(data)
            : capture.mode === 'escape'
              ? escapeText(data)
              : data,
        );
      },

      onclosetag(name) {
        if (stopped || finishing) return;
        const len = stack.length;
        if (len === 0) return;
        stack.pop();

        if (capture) {
          if (len === capture.depth) {
            finishCapture();
          } else if (len > capture.depth) {
            if (capture.mode === 'xhtml' && !VOID_TAGS.has(name)) capture.text.append(`</${name}>`);
            return;
          }
        }
        if (feedAuthorOpenAt === len) feedAuthorOpenAt = -1;
        if (item) {
          if (item.atomAuthorOpenAt === len) item.atomAuthorOpenAt = -1;
          if (len === item.depth) {
            const done = item;
            item = null;
            finishItem(done);
            if (items.length >= maxItems) {
              stopped = true;
              parser.pause();
            }
          }
        }
      },

      onerror(err) {
        parseError = err.message;
      },
    },
    { xmlMode: true, decodeEntities: true },
  );

  parser.write(input);
  if (!stopped) {
    // Anything still open at the end is a truncated element: drop it rather than store half an
    // item (htmlparser2 force-closes the stack in `end()`; `finishing` makes us ignore that).
    finishing = true;
    parser.end();
  }

  if (tooDeep) {
    options.log?.('feed_parse_too_deep', { maxDepth: MAX_DEPTH, items: items.length });
    if (items.length === 0) {
      return {
        ok: false,
        error: { code: 'parse_error', message: `too_deep: more than ${MAX_DEPTH} nested elements` },
      };
    }
  }
  if (notAFeed || format === null) {
    return {
      ok: false,
      error: { code: 'not_a_feed', message: 'Document is not RSS, Atom or RDF' },
    };
  }
  if (parseError !== null && items.length === 0) {
    return { ok: false, error: { code: 'parse_error', message: parseError } };
  }

  const feed: ParsedFeed = {
    format,
    title: feedTitle,
    siteUrl: siteUrl ?? resolveUrl(channelLink),
    items,
    stoppedEarly: stopped,
    ...(tooDeep ? { truncated: 'too_deep' as const } : {}),
  };
  return { ok: true, feed };
}

function firstNonEmpty(...values: (string | undefined)[]): string | null {
  for (const v of values) {
    if (v !== undefined && v.trim() !== '') return v;
  }
  return null;
}
