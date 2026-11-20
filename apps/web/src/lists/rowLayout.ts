export type RowLayout = 'hero' | 'thumb' | 'text';

/**
 * A preview image that loads narrower than this (natural pixels) is never stretched into a hero or a
 * card (TID-072): the row shows it as a small thumbnail and takes no featured or 2-column layout.
 */
export const MIN_FEATURE_WIDTH = 300;

/** Image URLs seen to load small, so a remounted row (Back, refetch) renders small straight away. */
const smallImages = new Set<string>();
export const isKnownSmall = (url: string | null): boolean => url !== null && smallImages.has(url);
export const rememberSmall = (url: string): void => {
  if (smallImages.size > 500) smallImages.clear();
  smallImages.add(url);
};

/** Roughly 1 in 5 image entries are hero rows. */
const HERO_ONE_IN = 5;

/** FNV-1a: a small, stable hash so a row's layout depends only on its id. */
export function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** The id-only rule: would this entry be a hero row if it has an image? */
export const heroByRule = (id: string): boolean => hashId(id) % HERO_ONE_IN === 0;

/**
 * Layout for one row. Pure in (entry, previous entry): never changes between renders, refetches
 * or Back. A hero directly after a would-be hero is demoted to a thumbnail row.
 */
export function rowLayout(
  entry: { id: string; imageUrl: string | null },
  prev?: { id: string; imageUrl: string | null },
): RowLayout {
  if (!entry.imageUrl) return 'text';
  if (heroByRule(entry.id) && !(prev?.imageUrl && heroByRule(prev.id))) return 'hero';
  return 'thumb';
}
