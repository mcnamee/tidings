import { IMAGE_SCAN_CHARS, MAX_SUMMARY_CHARS, SUMMARY_SOURCE_CHARS } from './limits';

/**
 * Text accumulator with a hard cap. `append` stops copying once the cap is reached, so the
 * buffer never grows past `cap` however much input arrives (ADR 0006 decision 4).
 */
export class CappedText {
  private text = '';
  private full = false;

  constructor(readonly cap: number) {}

  get length(): number {
    return this.text.length;
  }

  /** True once input was dropped because the cap was reached. */
  get truncated(): boolean {
    return this.full;
  }

  append(chunk: string): void {
    if (this.full || chunk.length === 0) return;
    const room = this.cap - this.text.length;
    if (chunk.length <= room) {
      this.text += chunk;
      if (this.text.length === this.cap) this.full = true;
      return;
    }
    let take = room;
    // Do not split a surrogate pair.
    if (take > 0 && isHighSurrogate(chunk.charCodeAt(take - 1))) take--;
    this.text += chunk.slice(0, take);
    this.full = true;
  }

  toString(): string {
    return this.text;
  }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
  laquo: '«',
  raquo: '»',
  bull: '•',
  middot: '·',
  euro: '€',
  pound: '£',
  eacute: 'é',
  egrave: 'è',
  euml: 'ë',
};

/** Decodes numeric and a small set of named HTML entities. Unknown names are left as written. */
export function decodeEntities(input: string): string {
  if (!input.includes('&')) return input;
  return input.replace(
    /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,15}));/g,
    (m, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (name !== undefined) return NAMED_ENTITIES[name] ?? m;
      const cp = dec !== undefined ? parseInt(dec, 10) : parseInt(hex ?? '0', 16);
      if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '�';
      return String.fromCodePoint(cp);
    },
  );
}

/**
 * WHATWG HTML element names (plus the common obsolete ones). Only a tag with one of these names
 * is stripped from plain-text fields and summaries, so `5 < 6`, `I <3 RSS` and `Vec<T>` survive
 * (ADR 0009 section 2). Accepted edge case: `List<Map>` loses `<Map>`.
 */
const HTML_ELEMENT_NAMES =
  'a|abbr|acronym|address|applet|area|article|aside|audio|b|base|basefont|bdi|bdo|bgsound|big|' +
  'blink|blockquote|body|br|button|canvas|caption|center|cite|code|col|colgroup|data|datalist|' +
  'dd|del|details|dfn|dialog|dir|div|dl|dt|em|embed|fieldset|figcaption|figure|font|footer|form|' +
  'frame|frameset|h[1-6]|head|header|hgroup|hr|html|i|iframe|img|input|ins|isindex|kbd|keygen|' +
  'label|legend|li|link|listing|main|map|mark|marquee|menu|menuitem|meta|meter|multicol|nav|' +
  'nextid|nobr|noembed|noframes|noscript|object|ol|optgroup|option|output|p|param|picture|' +
  'plaintext|pre|progress|q|rb|rp|rt|rtc|ruby|s|samp|script|search|section|select|slot|small|' +
  'source|spacer|span|strike|strong|style|sub|summary|sup|table|tbody|td|template|textarea|' +
  'tfoot|th|thead|time|title|tr|track|tt|u|ul|var|video|wbr|xmp|svg|math';
const HTML_TAG_RE = new RegExp(`</?(?:${HTML_ELEMENT_NAMES})(?=[\\s/>]|$)[^>]*(?:>|$)`, 'gi');

/** One strip pass. Every match is at least 2 chars and becomes at most 1, so it always shortens. */
function stripPass(text: string): string {
  return (
    text
      .replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
      .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
      // Block-level tags separate words; inline tags (em, a, span...) must not insert a space.
      .replace(
        /<\/?(?:p|div|br|li|ul|ol|h[1-6]|tr|td|th|table|blockquote|pre|section|article|hr)\b[^>]*(?:>|$)/gi,
        ' ',
      )
      .replace(HTML_TAG_RE, '')
  );
}

/** Safety net for the fixed-point loop; real input needs one or two passes. */
const MAX_STRIP_PASSES = 16;

/**
 * Strips tags until the text stops changing, so removing one tag cannot leave another formed from
 * its fragments (`<scr<b>ipt>`, DEF-011). Each changing pass shortens the text, so the loop ends;
 * the pass cap bounds the cost. If it is hit, the fallback deletes every `<` that is followed by
 * `/`, `!` or an ASCII letter (a superset of every tag and comment opener), taking a whole run of
 * `<` with it so `<<b` cannot collapse into `<b`, and repeats until nothing changes. Each round
 * shortens the text, so it ends, and its output has no such `<` left: that is final.
 */
function stripTags(text: string): string {
  let current = text;
  for (let i = 0; i < MAX_STRIP_PASSES; i++) {
    const next = stripPass(current);
    if (next === current) return current;
    current = next;
  }
  return dropOpeners(current);
}

/** Cap fallback: drop every `<` run that precedes `/`, `!` or an ASCII letter, to a fixed point. */
function dropOpeners(text: string): string {
  let current = text;
  for (;;) {
    const next = current.replace(/<+(?=[/!A-Za-z])/g, '');
    if (next === current) return current;
    current = next;
  }
}

/**
 * Plain text from markup: strips script/style bodies and tags over a bounded window, decodes
 * entities and collapses whitespace. Never inspects more than `limit` characters.
 */
export function htmlToText(html: string, limit = SUMMARY_SOURCE_CHARS): string {
  const window = html.length > limit ? html.slice(0, limit) : html;
  return decodeEntities(stripTags(window)).replace(/\s+/g, ' ').trim();
}

/** Summary (spec §6.5): plain text of the first 4 KB, truncated to 300 chars at a word boundary. */
export function summarise(html: string): string {
  const text = htmlToText(html);
  if (text.length <= MAX_SUMMARY_CHARS) return text;
  let cut = text.slice(0, MAX_SUMMARY_CHARS - 1);
  if (isHighSurrogate(cut.charCodeAt(cut.length - 1))) cut = cut.slice(0, -1);
  const space = cut.lastIndexOf(' ');
  if (space > MAX_SUMMARY_CHARS / 2) cut = cut.slice(0, space);
  return cut.replace(/[\s.,;:!?-]+$/, '') + '…';
}

/** Title-like fields are plain text: if the feed put markup or entities in, flatten them. */
export function plainField(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.includes('<') && !trimmed.includes('&')) return trimmed;
  return htmlToText(trimmed, 4096);
}

/**
 * First `<img>` in the first 8 KB of content: its raw `src` (caller validates the URL) and the
 * declared `width`/`height` attributes when they are plain integers (TID-072).
 */
export function firstImg(
  html: string,
): { src: string; width: number | null; height: number | null } | null {
  const window = html.length > IMAGE_SCAN_CHARS ? html.slice(0, IMAGE_SCAN_CHARS) : html;
  const tag = /<img\b[^>]*>/i.exec(window)?.[0];
  if (!tag) return null;
  const attr = (name: string): string | null => {
    const m = new RegExp(`(?<![\\w-])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(
      tag,
    );
    const v = m ? (m[1] ?? m[2] ?? m[3]) : undefined;
    return v === undefined ? null : v;
  };
  const src = attr('src');
  if (src === null) return null;
  const dim = (v: string | null): number | null =>
    v !== null && /^\s*\d{1,6}\s*$/.test(v) ? Number(v) : null;
  return { src: decodeEntities(src), width: dim(attr('width')), height: dim(attr('height')) };
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, '&quot;');
}

/** Escapes text for storage as HTML: `&`, `<`, `>` and `"` (Atom `type="text"`, ADR 0009). */
export function escapeText(text: string): string {
  return escapeAttr(text);
}

/**
 * Tags that make untyped Atom text count as HTML: the spec 10.5 sanitiser allowlist plus `div`
 * and `span` (ADR 0009 section 1). `script`, `iframe` and `style` are deliberately absent.
 */
const SNIFF_TAGS =
  'p|br|a|strong|em|b|i|u|s|blockquote|q|cite|code|pre|kbd|ul|ol|li|dl|dt|dd|h[1-6]|hr|img|' +
  'picture|source|figure|figcaption|table|thead|tbody|tfoot|tr|th|td|caption|sup|sub|small|' +
  'abbr|time|mark|del|ins|details|summary|video|audio|div|span';
const SNIFF_RE = new RegExp(`</?(?:${SNIFF_TAGS})(?=[\\s/>])`, 'i');
const SNIFF_CHARS = 4096;

/**
 * Value of an Atom `content`/`summary` with no `type`: HTML if the first 4 KB contains an
 * allowlisted tag, otherwise plain text, so it is escaped (RFC 4287 default). The escaped form is
 * cut back to `cap` without leaving half an entity or a split surrogate pair.
 */
export function sniffedHtml(decoded: string, cap: number): string {
  if (SNIFF_RE.test(decoded.length > SNIFF_CHARS ? decoded.slice(0, SNIFF_CHARS) : decoded)) {
    return decoded;
  }
  const escaped = escapeText(decoded);
  if (escaped.length <= cap) return escaped;
  let cut = escaped.slice(0, cap);
  const amp = cut.lastIndexOf('&');
  if (amp > cap - 8 && cut.indexOf(';', amp) === -1) cut = cut.slice(0, amp);
  if (cut.length > 0 && isHighSurrogate(cut.charCodeAt(cut.length - 1))) cut = cut.slice(0, -1);
  return cut;
}

// eslint-disable-next-line no-control-regex -- matching U+0000 is the point (ADR 0009 section 6)
const BAD_UTF16 = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Removes U+0000 and replaces lone surrogates with U+FFFD (ADR 0009 section 6). The parser runs
 * this over the whole document before any cap is applied, so every stored string is clean.
 */
export function cleanText(input: string): string {
  return input.replace(BAD_UTF16, (m) => (m === '\u0000' ? '' : '\uFFFD'));
}

/** `slice(0, n)` that does not leave half a surrogate pair at the end. */
export function safeSlice(text: string, n: number): string {
  if (text.length <= n) return text;
  let cut = text.slice(0, n);
  if (isHighSurrogate(cut.charCodeAt(cut.length - 1))) cut = cut.slice(0, -1);
  return cut;
}
