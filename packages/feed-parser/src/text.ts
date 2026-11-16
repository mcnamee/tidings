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
 * Plain text from markup: strips script/style bodies and tags over a bounded window, decodes
 * entities and collapses whitespace. Never inspects more than `limit` characters.
 */
export function htmlToText(html: string, limit = SUMMARY_SOURCE_CHARS): string {
  const window = html.length > limit ? html.slice(0, limit) : html;
  const stripped = window
    .replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    // Block-level tags separate words; inline tags (em, a, span...) must not insert a space.
    .replace(
      /<\/?(?:p|div|br|li|ul|ol|h[1-6]|tr|td|th|table|blockquote|pre|section|article|hr)\b[^>]*(?:>|$)/gi,
      ' ',
    )
    .replace(/<[^>]*(?:>|$)/g, '');
  return decodeEntities(stripped).replace(/\s+/g, ' ').trim();
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

/** First `<img src>` in the first 8 KB of content, raw (caller validates the URL). */
export function firstImgSrc(html: string): string | null {
  const window = html.length > IMAGE_SCAN_CHARS ? html.slice(0, IMAGE_SCAN_CHARS) : html;
  const m = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(window);
  if (!m) return null;
  const v = m[1] ?? m[2] ?? m[3];
  return v === undefined ? null : decodeEntities(v);
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, '&quot;');
}
