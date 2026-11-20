/**
 * Image decisions at refresh time (TID-072, ADR 0020): for each new entry, which image to store and
 * whether the entry needs the image step. Junk (icons, logos, site-wide defaults) is dropped, a small
 * but real picture is kept as a fallback, and both small and missing images queue the entry.
 */
import { sql, type Db, type Meta } from '../db';
import { isSiteDefault, judgeImage, upgradeToHttps } from './weak';

export interface PlannedImage {
  /** The image to store (https-upgraded), or null for none. */
  image: string | null;
  /** True when the entry should wait in `image_queue` for a better image. */
  needsImage: boolean;
}

interface Candidate {
  hash: string;
  item: {
    link: string | null;
    imageUrl: string | null;
    imageWidth?: number | null;
    imageHeight?: number | null;
  };
}

/**
 * How many entries of this feed already use each of these image URLs. One indexed read (the feed's
 * rows via `(feed_id, guid_hash)`), skipped when no new item carries an image.
 */
async function storedUses(
  db: Db,
  feedId: number,
  urls: string[],
  onMeta?: (m: Meta) => void,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (urls.length === 0) return out;
  const { rows, meta } = await db.all<{ image_url: string; n: number }>(
    sql(
      `SELECT image_url, COUNT(*) AS n FROM entries
        WHERE feed_id = ? AND image_url IN (SELECT value FROM json_each(?))
        GROUP BY image_url`,
      feedId,
      JSON.stringify(urls),
    ),
  );
  onMeta?.(meta);
  for (const r of rows) out.set(r.image_url, Number(r.n));
  return out;
}

export async function planImages(
  db: Db,
  feedId: number,
  items: Candidate[],
  onMeta?: (m: Meta) => void,
): Promise<Map<string, PlannedImage>> {
  const urls = [...new Set(items.map((c) => c.item.imageUrl).filter((u): u is string => !!u))];
  const stored = await storedUses(db, feedId, urls, onMeta);
  const inBatch = new Map<string, number>();
  for (const c of items) {
    const u = c.item.imageUrl;
    if (u) inBatch.set(u, (inBatch.get(u) ?? 0) + 1);
  }
  const plan = new Map<string, PlannedImage>();
  for (const c of items) {
    const { link, imageUrl } = c.item;
    const queueable = link !== null;
    if (!imageUrl) {
      plan.set(c.hash, { image: null, needsImage: queueable });
      continue;
    }
    const others = (stored.get(imageUrl) ?? 0) + (inBatch.get(imageUrl) ?? 1) - 1;
    const verdict = judgeImage(
      imageUrl,
      { width: c.item.imageWidth ?? null, height: c.item.imageHeight ?? null },
      isSiteDefault(others),
    );
    if (verdict === 'junk') plan.set(c.hash, { image: null, needsImage: queueable });
    else {
      plan.set(c.hash, {
        image: upgradeToHttps(imageUrl, link),
        // An image of unknown size on plain http is usually an aggregator's thumbnail (Techmeme's
        // feed <IMG> has no width/height): keep it, but look for a better one.
        needsImage:
          queueable &&
          (verdict === 'small' ||
            (imageUrl.startsWith('http:') && !c.item.imageWidth && !c.item.imageHeight)),
      });
    }
  }
  return plan;
}
