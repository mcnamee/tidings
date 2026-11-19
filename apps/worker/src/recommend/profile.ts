/**
 * The profile step (TID-067, ADR 0018): per user, the weighted mean of the embeddings of their most
 * recent engagement signals, stored as one `user_profiles` row. Run from the hourly cron, bounded to
 * {@link PROFILE_USERS_PER_RUN} users and {@link PROFILE_SIGNAL_LIMIT} signals each.
 *
 * A signal's embedding comes from the signal row (copied when it was recorded), else from the entry
 * while it still exists (and is then copied onto the signal), else it is embedded again from the
 * title the signal stored, within the same daily budget as the embed step. A signal that still has
 * none is skipped. Every statement puts `user_id = ?` in its SQL.
 */
import { Db, sql, type Statement } from '../db';
import {
  addUsageStatements,
  DAILY_ENTRY_CAP,
  DAILY_TOKEN_CAP,
  embeddingText,
  estimateTokens,
  readDailyUsage,
  type Embedder,
} from './embed';
import { buildProfile, PROFILE_SIGNAL_LIMIT, type ProfileInput } from './score';
import { decodeEmbedding, encodeEmbedding, encodeProfile } from './vector';

export const PROFILE_USERS_PER_RUN = 10;
/** Signals embedded again from their stored title per run (two AI calls of 50). */
export const REEMBED_PER_RUN = 100;
const REEMBED_CALL = 50;

export interface ProfileSummary {
  users: number;
  profilesWritten: number;
  profilesDeleted: number;
  reembedded: number;
  copied: number;
}

export interface ProfileDeps {
  db: Db;
  /** Absent when Workers AI is: signals without an embedding are then skipped. */
  embedder: Embedder | null;
  clock: () => number;
}

interface SignalRow {
  entry_id: number;
  title: string | null;
  opened_at: number | null;
  clicked_at: number | null;
  last_at: number;
  embedding: string | null;
  entry_vec: string | null;
}

export async function runProfiles(deps: ProfileDeps): Promise<ProfileSummary> {
  const { db } = deps;
  const now = Math.floor(deps.clock() / 1000);
  const out: ProfileSummary = {
    users: 0,
    profilesWritten: 0,
    profilesDeleted: 0,
    reembedded: 0,
    copied: 0,
  };
  const { rows: users } = await db.all<{ id: string }>(
    sql(
      `SELECT u.id FROM users u LEFT JOIN user_profiles p ON p.user_id = u.id
        WHERE EXISTS (SELECT 1 FROM engagement g WHERE g.user_id = u.id)
        ORDER BY COALESCE(p.computed_at, 0) LIMIT ?`,
      PROFILE_USERS_PER_RUN,
    ),
  );
  for (const u of users) {
    out.users += 1;
    await recomputeProfile(deps, u.id, now, out);
  }
  return out;
}

async function recomputeProfile(
  deps: ProfileDeps,
  userId: string,
  now: number,
  out: ProfileSummary,
): Promise<void> {
  const { db } = deps;
  const { rows } = await db.all<SignalRow>(
    sql(
      `SELECT g.entry_id, g.title, g.opened_at, g.clicked_at, g.last_at, g.embedding,
              ee.vec AS entry_vec
         FROM engagement g LEFT JOIN entry_embeddings ee ON ee.entry_id = g.entry_id
        WHERE g.user_id = ? ORDER BY g.last_at DESC LIMIT ?`,
      userId,
      PROFILE_SIGNAL_LIMIT,
    ),
  );

  const vecText = new Map<number, string>();
  const writes: Statement[] = [];
  const needTitle: SignalRow[] = [];
  let copies = 0;
  for (const r of rows) {
    if (r.embedding) vecText.set(r.entry_id, r.embedding);
    else if (r.entry_vec) {
      vecText.set(r.entry_id, r.entry_vec);
      // Copied onto the signal so it survives the entry's purge; bounded per run, the rest next hour.
      if (copies < REEMBED_PER_RUN) {
        writes.push(copyOnto(userId, r.entry_id, r.entry_vec));
        copies += 1;
        out.copied += 1;
      }
    } else if (r.title && embeddingText(r.title, null) !== '') needTitle.push(r);
  }

  if (deps.embedder && needTitle.length > 0) {
    await reembed(deps, userId, now, needTitle.slice(0, REEMBED_PER_RUN), vecText, writes, out);
  }

  const inputs: ProfileInput[] = [];
  for (const r of rows) {
    const vec = decodeEmbedding(vecText.get(r.entry_id));
    if (vec) {
      inputs.push({ opened_at: r.opened_at, clicked_at: r.clicked_at, last_at: r.last_at, vec });
    }
  }
  const profile = buildProfile(inputs, now);
  if (profile) {
    writes.push(
      sql(
        `INSERT INTO user_profiles (user_id, vec, signals, computed_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET vec = excluded.vec, signals = excluded.signals,
                                             computed_at = excluded.computed_at`,
        userId,
        encodeProfile(profile.vec),
        profile.signals,
        now,
      ),
    );
    out.profilesWritten += 1;
  } else {
    writes.push(sql('DELETE FROM user_profiles WHERE user_id = ?', userId));
    out.profilesDeleted += 1;
  }
  await db.batch(writes);
}

const copyOnto = (userId: string, entryId: number, vec: string): Statement =>
  sql(
    'UPDATE engagement SET embedding = ? WHERE user_id = ? AND entry_id = ? AND embedding IS NULL',
    vec,
    userId,
    entryId,
  );

async function reembed(
  deps: ProfileDeps,
  userId: string,
  now: number,
  todo: SignalRow[],
  vecText: Map<number, string>,
  writes: Statement[],
  out: ProfileSummary,
): Promise<void> {
  const embedder = deps.embedder as Embedder;
  const usage = await readDailyUsage(deps.db, now);
  let tokens = usage.tokens;
  let entries = usage.entries;
  for (let i = 0; i < todo.length; i += REEMBED_CALL) {
    if (tokens >= DAILY_TOKEN_CAP || entries >= DAILY_ENTRY_CAP) return;
    const chunk = todo.slice(i, i + REEMBED_CALL);
    const texts = chunk.map((r) => embeddingText(r.title, null));
    let vectors: number[][];
    try {
      vectors = await embedder(texts);
      if (vectors.length !== chunk.length) throw new Error('wrong number of embeddings');
    } catch {
      return; // try again next hour; the profile is built from what it has
    }
    chunk.forEach((r, j) => {
      const text = encodeEmbedding(vectors[j] as number[]);
      vecText.set(r.entry_id, text);
      writes.push(copyOnto(userId, r.entry_id, text));
    });
    const spent = estimateTokens(texts);
    tokens += spent;
    entries += chunk.length;
    writes.push(...addUsageStatements(now, spent, chunk.length));
    out.reembedded += chunk.length;
  }
}
