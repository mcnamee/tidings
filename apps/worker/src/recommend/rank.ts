/**
 * The recommended list (TID-067, ADR 0018, spec 8.6). Unread only, scoped to `userId`.
 *
 * Phase 1 ranks the newest {@link CANDIDATE_LIMIT} unread entries of the view by
 * `cosine(profile, entry) + freshness`; phase 2 serves the rest newest first, so nothing is
 * unreachable. The cursor of phase 1 freezes the clock (`t`) and the candidate boundary, so a page
 * boundary is an exact position `(score, id)` that does not move while the user scrolls, and an entry
 * marked read meanwhile only drops out. A cursor of phase 2 is an ordinary newest-first cursor.
 */
import {
  Db,
  decodeJsonCursor,
  encodeCursor,
  encodeJsonCursor,
  listEntries,
  sql,
  ValidationError,
  type EntryPage,
  type EntrySummaryRow,
  type ListEntriesParams,
  type SqlValue,
} from '../db';
import { blendScore, CANDIDATE_LIMIT, scoreKey } from './score';
import { decodeProfile, dotEncoded } from './vector';

/** Extra candidates allowed on later pages for entries that arrived after the first page. */
const ARRIVAL_SLACK = 200;

interface RankCursor {
  /** Frozen clock, epoch seconds. */
  t: number;
  /** Position of the last item served: score key and entry id. */
  s: number;
  i: number;
  /** Boundary of the ranked set: its oldest candidate (published_at, entry id). */
  bp: number;
  bi: number;
  /** 1 when older unread entries exist beyond the boundary. */
  x: 0 | 1;
}

function parseRankCursor(raw: Record<string, unknown>): RankCursor {
  const ints = ['t', 's', 'i', 'bp', 'bi'] as const;
  for (const k of ints) {
    if (!Number.isSafeInteger(raw[k])) throw malformed();
  }
  if (raw.x !== 0 && raw.x !== 1) throw malformed();
  if ((raw.t as number) < 0 || (raw.i as number) < 0 || (raw.bp as number) < 0) throw malformed();
  return raw as unknown as RankCursor;
}

const malformed = () => new ValidationError('Malformed cursor', { field: 'cursor' });

export interface RecommendedParams extends Omit<ListEntriesParams, 'unreadOnly'> {
  /** Base64 float32 profile text from `user_profiles.vec`. */
  profile: string;
  /** Seconds; ignored when the cursor carries its own frozen clock. */
  now: number;
  /** Test hook: the ranked set size, default {@link CANDIDATE_LIMIT}. */
  candidateLimit?: number;
}

const SELECT_ROW =
  'SELECT ue.entry_id, ue.feed_id, ue.published_at, ue.is_read, ue.is_starred, ' +
  'e.title, e.author, e.url, e.summary, e.image_url ';

/** The user's stored profile, or null when none has been built. One row read. */
export async function loadProfile(
  db: Db,
  userId: string,
): Promise<{ vec: string; signals: number } | null> {
  return db.first<{ vec: string; signals: number }>(
    sql('SELECT vec, signals FROM user_profiles WHERE user_id = ?', userId),
  );
}

export async function listRecommended(
  db: Db,
  userId: string,
  params: RecommendedParams,
): Promise<EntryPage & { rowsRead: number }> {
  const { view, limit } = params;
  const profile = decodeProfile(params.profile);
  if (!profile) throw new Error('unreadable profile');

  let cursor: RankCursor | null = null;
  if (params.cursor) {
    const raw = decodeJsonCursor(params.cursor);
    if (raw.m !== 'r') {
      // Phase 2: an ordinary newest-first cursor over the older unread entries.
      const page = await listEntries(db, userId, { ...params, unreadOnly: true });
      return { ...page, rowsRead: Number(page.meta.rows_read ?? 0) };
    }
    cursor = parseRankCursor(raw);
  }
  const t = cursor?.t ?? params.now;
  const cap = params.candidateLimit ?? CANDIDATE_LIMIT;

  // Candidates: unread rows of the view, newest first, with the embedding beside each.
  const binds: SqlValue[] = [userId];
  const index = view === 'feed' ? 'ue_unread_feed' : 'ue_unread_all';
  let text =
    'SELECT ue.entry_id AS id, ue.published_at AS p, ee.vec AS v FROM user_entries ue INDEXED BY ' +
    index +
    ' LEFT JOIN entry_embeddings ee ON ee.entry_id = ue.entry_id WHERE ue.user_id = ? AND ue.is_read = 0';
  if (view === 'feed') {
    text += ' AND ue.feed_id = ?';
    binds.push(Number(params.id));
  } else if (view === 'folder') {
    text +=
      ' AND ue.feed_id IN (SELECT feed_id FROM subscriptions WHERE user_id = ? AND folder_id = ?)';
    binds.push(userId, String(params.id));
  }
  if (cursor) {
    text += ' AND (ue.published_at, ue.entry_id) >= (?, ?)';
    binds.push(cursor.bp, cursor.bi);
  }
  text += ' ORDER BY ue.published_at DESC, ue.entry_id DESC LIMIT ?';
  binds.push(cursor ? cap + ARRIVAL_SLACK : cap + 1);

  const { rows: cands, meta } = await db.all<{ id: number; p: number; v: string | null }>(
    sql(text, ...binds),
  );

  let bp = cursor?.bp ?? 0;
  let bi = cursor?.bi ?? 0;
  let more: 0 | 1 = cursor?.x ?? 0;
  let ranked = cands;
  if (!cursor && cands.length > cap) {
    ranked = cands.slice(0, cap);
    const last = ranked[cap - 1] as { id: number; p: number };
    bp = last.p;
    bi = last.id;
    more = 1;
  }

  const scored: { id: number; key: number }[] = [];
  for (const c of ranked) {
    const cos = c.v === null ? null : dotEncoded(profile, c.v);
    const key = scoreKey(blendScore(cos, c.p, t));
    if (cursor && (key > cursor.s || (key === cursor.s && c.id >= cursor.i))) continue;
    scored.push({ id: c.id, key });
  }
  scored.sort((a, b) => b.key - a.key || b.id - a.id);

  const page = scored.slice(0, limit);
  const last = page[page.length - 1];
  let nextCursor: string | null = null;
  if (scored.length > limit && last) {
    nextCursor = encodeJsonCursor({ m: 'r', t, s: last.key, i: last.id, bp, bi, x: more });
  } else if (more === 1) {
    nextCursor = encodeCursor({ p: bp, i: bi });
  }

  if (page.length === 0)
    return { items: [], nextCursor, meta, rowsRead: Number(meta.rows_read ?? 0) };
  const detail = await db.all<EntrySummaryRow>(
    sql(
      SELECT_ROW +
        'FROM user_entries ue JOIN entries e ON e.id = ue.entry_id ' +
        'WHERE ue.user_id = ? AND ue.entry_id IN (SELECT value FROM json_each(?))',
      userId,
      JSON.stringify(page.map((s) => s.id)),
    ),
  );
  const byId = new Map(detail.rows.map((r) => [r.entry_id, r]));
  const items = page.flatMap((s) => {
    const r = byId.get(s.id);
    return r ? [r] : [];
  });
  return {
    items,
    nextCursor,
    meta: detail.meta,
    rowsRead: Number(meta.rows_read ?? 0) + Number(detail.meta.rows_read ?? 0),
  };
}
