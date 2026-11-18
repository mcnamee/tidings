export type RowLayout = 'hero' | 'thumb' | 'text';

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
