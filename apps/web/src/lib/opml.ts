import {
  FOLDER_NAME_MAX,
  IMPORT_CHUNK_SIZE,
  SUBSCRIPTION_TITLE_MAX,
  type ImportFeed,
  type ImportOpmlRequest,
} from '@tidings/shared';
import { checkUrl } from '@tidings/shared/address';
import { cleanName } from '@tidings/shared/text';
import { canonicalizeHttpUrl } from '@tidings/shared/url';

/**
 * OPML parsing for the import screen (spec FR-OP-1, FR-OP-2). The browser parses the file with
 * `DOMParser`; nothing from it is rendered as HTML, and the API validates every URL again.
 */

/** Largest file we will read. A 1,000-feed export is well under 1 MB. */
export const MAX_OPML_BYTES = 5 * 1024 * 1024;

export class OpmlError extends Error {}

export interface OpmlEntry extends ImportFeed {
  /** Canonical feed URL (spec 6.4), the same form the server stores. */
  xmlUrl: string;
  /** Top-level folder name, or null for a feed outside any folder. */
  folder: string | null;
}

export interface ParsedOpml {
  /** Valid feeds, de-duplicated by canonical URL; the first folder wins. */
  entries: OpmlEntry[];
  /** Feed addresses the server would refuse (not http(s), or a private or internal address). */
  invalid: string[];
  /** Folders that hold at least one kept feed. */
  folderCount: number;
  /** Feeds that appeared in more than one folder (or in a folder and at the top level). */
  multiFolder: number;
}

function attr(el: Element, name: string): string {
  for (const a of Array.from(el.attributes)) {
    if (a.name.toLowerCase() === name) return a.value.trim();
  }
  return '';
}

const isOutline = (el: Element) => el.localName.toLowerCase() === 'outline';
const outlineChildren = (el: Element) => Array.from(el.children).filter(isOutline);
const label = (el: Element) => attr(el, 'title') || attr(el, 'text');
const folderKey = (name: string) => name.toLowerCase();

/**
 * `appOrigin` feeds the "app's own host" rule of the server's address check, so the preview
 * rejects exactly what `POST /api/import/opml` rejects (invalid_url and blocked_address).
 */
export function parseOpml(
  text: string,
  appOrigin: string = globalThis.location?.origin ?? '',
): ParsedOpml {
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  const root = doc.documentElement;
  if (
    doc.getElementsByTagName('parsererror').length > 0 ||
    root.localName.toLowerCase() !== 'opml'
  ) {
    throw new OpmlError('not_opml');
  }
  const body = Array.from(root.children).find((el) => el.localName.toLowerCase() === 'body');
  if (!body) throw new OpmlError('not_opml');

  const found: { xmlUrl: string; title: string; htmlUrl: string; folder: string | null }[] = [];
  // A feed outline is a feed even if it has children; any other outline is a folder at the top
  // level and is flattened into its top-level folder below that (FR-OP-2).
  const walk = (el: Element, folder: string | null) => {
    if (attr(el, 'xmlurl')) {
      found.push({
        xmlUrl: attr(el, 'xmlurl'),
        title: label(el),
        htmlUrl: attr(el, 'htmlurl'),
        folder,
      });
      return;
    }
    for (const child of outlineChildren(el)) walk(child, folder);
  };
  for (const top of outlineChildren(body)) {
    if (attr(top, 'xmlurl')) walk(top, null);
    else {
      const name = cleanName(label(top), FOLDER_NAME_MAX);
      for (const child of outlineChildren(top)) walk(child, name === '' ? null : name);
    }
  }
  if (found.length === 0) throw new OpmlError('empty');

  const invalid: string[] = [];
  const entries: OpmlEntry[] = [];
  const places = new Map<string, Set<string>>();
  const index = new Set<string>();
  const spelling = new Map<string, string>(); // folder key -> first spelling
  for (const f of found) {
    const canonical = canonicalizeHttpUrl(f.xmlUrl);
    if (!canonical.ok || !checkUrl(canonical.url, appOrigin, []).ok) {
      invalid.push(f.xmlUrl);
      continue;
    }
    let folder = f.folder;
    if (folder !== null) {
      const key = folderKey(folder);
      folder = spelling.get(key) ?? folder;
      spelling.set(key, folder);
    }
    const seen = places.get(canonical.url) ?? new Set<string>();
    seen.add(folder === null ? '' : folderKey(folder));
    places.set(canonical.url, seen);
    if (index.has(canonical.url)) continue;
    index.add(canonical.url);
    const entry: OpmlEntry = { xmlUrl: canonical.url, folder };
    const title = cleanName(f.title, SUBSCRIPTION_TITLE_MAX);
    if (title) entry.title = title;
    if (f.htmlUrl) entry.htmlUrl = f.htmlUrl;
    entries.push(entry);
  }
  const folderCount = new Set(
    entries.flatMap((e) => (e.folder === null ? [] : [folderKey(e.folder)])),
  ).size;
  return {
    entries,
    invalid,
    folderCount,
    multiFolder: [...places.values()].filter((s) => s.size > 1).length,
  };
}

/**
 * Requests of at most 100 feeds each (FR-OP-1). Feeds keep file order; within a request they are
 * grouped by folder. Folders are matched by name on the server, so a folder that spans two
 * requests is created once and reused.
 */
export function chunkEntries(
  entries: readonly OpmlEntry[],
  size = IMPORT_CHUNK_SIZE,
): ImportOpmlRequest[] {
  const out: ImportOpmlRequest[] = [];
  for (let i = 0; i < entries.length; i += size) {
    const folders = new Map<string, ImportFeed[]>();
    const feeds: ImportFeed[] = [];
    for (const { folder, ...feed } of entries.slice(i, i + size)) {
      if (folder === null) feeds.push(feed);
      else folders.set(folder, [...(folders.get(folder) ?? []), feed]);
    }
    out.push({ folders: [...folders].map(([name, fs]) => ({ name, feeds: fs })), feeds });
  }
  return out;
}
