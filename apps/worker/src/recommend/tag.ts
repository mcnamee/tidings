/**
 * The tag step (TID-077, ADR 0021, spec 7.9): gives each recent untagged article up to 3 topics from
 * the system list, in its own invocation, outside any user request and outside the refresh.
 *
 * It is separate from the embed step on purpose (ADR 0021 amendment): embedding stays every minute, so
 * the Recommended order never waits for tagging, and tagging runs as an hourly batch that finds its
 * own work. The work list is "recent entries whose `topics` is NULL and that are linked to
 * someone (read or unread, so a filter with read articles shown still finds them)", read with a primary-key range scan, so no queue rows are written and the only write per
 * article is the one `UPDATE entries SET topics`. One model call tags up to 20 articles (the fixed
 * prompt part is the bulk of a call's cost). Past the daily neuron cap, or when the call fails, an
 * article with an embedding gets one topic by cosine against the topic vectors. Every statement is
 * parameterised, and model output is only ever parsed as integers.
 */
import { TOPICS, TOPICS_VERSION } from '@tidings/shared';
import type { AiBinding } from '../../env';
import { Db, sql, type Meta, type Statement } from '../db';
import {
  addUsageStatements,
  readDailyUsage,
  DAILY_TOKEN_CAP,
  estimateTokens,
  type Embedder,
} from './embed';
import {
  buildTagPrompt,
  packTopics,
  parseTagAnswer,
  SOURCE_EMBEDDING,
  SOURCE_MODEL,
  type TagPrompt,
} from './topics';
import { DIMS, decodeEmbedding, encodeEmbedding } from './vector';

export const TAG_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
/** Articles per model call. Validated at 20 in docs/testing/topic-tagging-2026-11-26 (AC3). */
export const TAG_BATCH = 20;
/** Calls (and so batches of 20) one run may make: 200 articles. Keeps a run under the 50-query limit. */
export const TAG_MAX_BATCHES = 10;
/** How far back the work list looks: the newest this many entry IDs (IDs are dense: about 2 days at 400 a day). */
export const TAG_LOOKBACK_IDS = 1_000;
/** UTC minute of the hourly run, clear of the :17 maintenance run. */
export const TAG_FLUSH_MINUTE = 41;
/** Neurons per UTC day tagging may spend: 25% of the free 10,000. */
export const TAG_DAILY_NEURON_CAP = 2_500;
/** Workers AI price for the model: neurons per million input and output tokens (spec 9.1). */
export const TAG_NEURONS_PER_M_INPUT = 26_668;
export const TAG_NEURONS_PER_M_OUTPUT = 204_805;
export const TAG_TIMEOUT_MS = 30_000;
/** `rate_limits` keys: the day's tag spend, and "more work is waiting" (so the next minute runs again). */
export const TAG_SPEND_KEY = 'ai:tag';
export const TAG_MORE_KEY = 'ai:tagmore';
const DAY = 86_400;

export interface TagResult {
  /** The model's raw text answer. Parsed, never stored or logged. */
  text: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}
export type Tagger = (prompt: TagPrompt) => Promise<TagResult>;

/** Production tagger over the Workers AI binding. Throws on a malformed answer. */
export function workersAiTagger(ai: AiBinding): Tagger {
  return async (p) => {
    const out = (await ai.run(TAG_MODEL, {
      messages: [
        { role: 'system', content: p.system },
        { role: 'user', content: p.user },
      ],
      max_tokens: p.maxTokens,
      temperature: 0,
    })) as { response?: unknown; usage?: TagResult['usage'] } | null;
    if (typeof out?.response !== 'string') throw new Error('unexpected Workers AI tag response');
    return { text: out.response, usage: out.usage };
  };
}

/** Neurons for a number of input and output tokens, at the model's price. */
export const tagNeurons = (inputTokens: number, outputTokens: number): number =>
  (inputTokens * TAG_NEURONS_PER_M_INPUT + outputTokens * TAG_NEURONS_PER_M_OUTPUT) / 1_000_000;

/**
 * The most a call can cost: prompt characters divided by 3 as input tokens (an over-estimate) plus
 * `max_tokens` as output tokens.
 */
export const tagUpperBound = (p: TagPrompt): number =>
  tagNeurons(Math.ceil((p.system.length + p.user.length) / 3), p.maxTokens);

/** What a finished call is charged: its `usage` when both counts are present, else the upper bound. */
export function tagCharge(result: TagResult | null, p: TagPrompt): number {
  const u = result?.usage;
  if (
    u &&
    Number.isFinite(u.prompt_tokens) &&
    Number.isFinite(u.completion_tokens) &&
    (u.prompt_tokens as number) >= 0 &&
    (u.completion_tokens as number) >= 0
  ) {
    return tagNeurons(u.prompt_tokens as number, u.completion_tokens as number);
  }
  return tagUpperBound(p);
}

const dayStart = (now: number): number => now - (now % DAY);

/** Upsert that adds to a per-UTC-day counter and resets it on a new day (as the embed counters do). */
function addToCounter(key: string, now: number, n: number): Statement {
  return sql(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, ?3)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start = excluded.window_start
                    THEN rate_limits.count + excluded.count ELSE excluded.count END,
       window_start = excluded.window_start`,
    key,
    dayStart(now),
    Math.ceil(n),
  );
}

export interface TagSummary {
  /** Entries found waiting this run. */
  entries: number;
  /** Model calls made. */
  calls: number;
  tagModel: number;
  tagFallback: number;
  /** Entries left NULL (no valid answer and no embedding, or the fallback was unavailable). */
  untagged: number;
  /** Neurons added to `ai:tag` this run, rounded up per call. */
  neuronsCharged: number;
  /** True when the run stopped at its limit with more waiting, so the next minute runs again. */
  more: boolean;
  rowsWritten: number;
  rowsRead: number;
}

export interface TagDeps {
  db: Db;
  tagger: Tagger;
  /** For the topic vectors only. Null when the fallback can't embed. */
  embedder: Embedder | null;
  /** Milliseconds, like `Date.now`. */
  clock: () => number;
  /** Resolves after `ms`; tests pass a fake. Default `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

const written = (m: Meta): number => Number(m.rows_written ?? 0);
const readRows = (m: Meta): number => Number(m.rows_read ?? 0);

class TagTimeout extends Error {}

async function withTimeout<T>(p: Promise<T>, ms: number, sleep: (ms: number) => Promise<void>) {
  let done = false;
  const timer = sleep(ms).then(() => {
    if (!done) throw new TagTimeout('tag call timed out');
    return undefined as never;
  });
  try {
    return await Promise.race([p, timer]);
  } finally {
    done = true;
  }
}

interface Candidate {
  id: number;
  title: string | null;
  summary: string | null;
}

/**
 * Recent entries that are untagged, linked to some user (read or not), not purged and have text, newest
 * first. A primary-key range over the newest {@link TAG_LOOKBACK_IDS} IDs: bounded reads, no index.
 */
export async function findUntagged(db: Db, limit: number) {
  return db.all<Candidate>(
    sql(
      `SELECT e.id, e.title, e.summary FROM entries e
        WHERE e.id > (SELECT MAX(id) FROM entries) - ?1
          AND e.topics IS NULL AND e.purged_at IS NULL
          AND (COALESCE(e.title, '') <> '' OR COALESCE(e.summary, '') <> '')
          AND EXISTS (SELECT 1 FROM user_entries ue WHERE ue.entry_id = e.id)
        ORDER BY e.id DESC LIMIT ?2`,
      TAG_LOOKBACK_IDS,
      limit,
    ),
  );
}

export type TopicVectors = { id: number; vec: Float32Array }[];

/**
 * The topic vectors, recomputed (one embed call of the plain descriptions) when a row is missing or
 * older than {@link TOPICS_VERSION}. Null when they are not available (embed budget spent, no
 * embedder, or the call failed): the fallback is then skipped and those entries stay untagged.
 */
async function loadTopicVectors(
  deps: TagDeps,
  now: number,
  out: TagSummary,
): Promise<TopicVectors | null> {
  const { db } = deps;
  const read = await db.all<{ topic_id: number; version: number; vec: string }>(
    sql('SELECT topic_id, version, vec FROM topic_vectors'),
  );
  out.rowsRead += readRows(read.meta);
  const byId = new Map(read.rows.map((r) => [r.topic_id, r]));
  const current = () => TOPICS.every((t) => (byId.get(t.id)?.version ?? 0) >= TOPICS_VERSION);

  if (!current() && deps.embedder) {
    const usage = await readDailyUsage(db, now);
    if (usage.tokens < DAILY_TOKEN_CAP) {
      try {
        const texts = TOPICS.map((t) => t.description);
        const vectors = await deps.embedder(texts);
        if (vectors.length !== texts.length || vectors.some((v) => v.length !== DIMS)) {
          throw new Error('wrong embeddings');
        }
        const rows = TOPICS.map((t, i) => [
          t.id,
          TOPICS_VERSION,
          encodeEmbedding(vectors[i] as number[]),
        ]);
        const results = await db.batch([
          sql(
            `INSERT OR REPLACE INTO topic_vectors (topic_id, version, vec)
             SELECT json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]')
               FROM json_each(?) j`,
            JSON.stringify(rows),
          ),
          // The embed budget pays for these (about 2 neurons); no entries are counted.
          ...addUsageStatements(now, estimateTokens(texts), 0),
        ]);
        out.rowsWritten += results.reduce((n, r) => n + written(r.meta), 0);
        for (const r of rows) {
          byId.set(r[0] as number, {
            topic_id: r[0] as number,
            version: TOPICS_VERSION,
            vec: r[2] as string,
          });
        }
      } catch {
        // Keep whatever is stored; this run just has no fallback.
      }
    }
  }
  const vectors: TopicVectors = [];
  for (const t of TOPICS) {
    const row = byId.get(t.id);
    const v = row && row.version >= TOPICS_VERSION ? decodeEmbedding(row.vec) : null;
    if (v) vectors.push({ id: t.id, vec: v });
  }
  return vectors.length === TOPICS.length ? vectors : null;
}

/** The topic with the highest cosine (both are unit length, so a dot product; 4 accumulators for speed). */
export function nearestTopic(entry: Float32Array, topics: TopicVectors): number {
  let best = topics[0]?.id ?? 0;
  let bestScore = -Infinity;
  for (const t of topics) {
    const v = t.vec;
    let a = 0;
    let b = 0;
    let c = 0;
    let d = 0;
    for (let i = 0; i < DIMS; i += 4) {
      a += (entry[i] as number) * (v[i] as number);
      b += (entry[i + 1] as number) * (v[i + 1] as number);
      c += (entry[i + 2] as number) * (v[i + 2] as number);
      d += (entry[i + 3] as number) * (v[i + 3] as number);
    }
    const dot = a + b + c + d;
    if (dot > bestScore) {
      bestScore = dot;
      best = t.id;
    }
  }
  return best;
}

async function readMoreFlag(db: Db): Promise<boolean> {
  const row = await db.first<{ count: number }>(
    sql('SELECT count FROM rate_limits WHERE key = ?', TAG_MORE_KEY),
  );
  return (row?.count ?? 0) > 0;
}

/**
 * One bounded run: up to {@link TAG_MAX_BATCHES} batches of {@link TAG_BATCH}, newest first. Each batch
 * is one model call when today's tag budget covers its upper bound (else, or when the call fails or
 * times out, the embedding fallback) and one D1 batch holding one `UPDATE` for the batch and the
 * `ai:tag` counter.
 */
export async function runTagPending(deps: TagDeps): Promise<TagSummary> {
  const { db } = deps;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = Math.floor(deps.clock() / 1000);
  const out: TagSummary = {
    entries: 0,
    calls: 0,
    tagModel: 0,
    tagFallback: 0,
    untagged: 0,
    neuronsCharged: 0,
    more: false,
    rowsWritten: 0,
    rowsRead: 0,
  };

  const limit = TAG_BATCH * TAG_MAX_BATCHES;
  const found = await findUntagged(db, limit + 1);
  out.rowsRead += readRows(found.meta);
  const candidates = found.rows.slice(0, limit);
  out.entries = candidates.length;
  out.more = found.rows.length > limit;

  if (candidates.length > 0) {
    const spentRow = await db.first<{ count: number; window_start: number }>(
      sql('SELECT count, window_start FROM rate_limits WHERE key = ?', TAG_SPEND_KEY),
    );
    let spent = spentRow && spentRow.window_start === dayStart(now) ? spentRow.count : 0;
    let modelWorks = true;
    let vectors: TopicVectors | null | undefined;

    for (let b = 0; b < candidates.length; b += TAG_BATCH) {
      const chunk = candidates.slice(b, b + TAG_BATCH);
      const prompt = buildTagPrompt(chunk);
      let answers = new Map<number, number[]>();
      let charge = 0;
      let called = false;

      if (modelWorks && spent + tagUpperBound(prompt) <= TAG_DAILY_NEURON_CAP) {
        called = true;
        out.calls++;
        try {
          const result = await withTimeout(deps.tagger(prompt), TAG_TIMEOUT_MS, sleep);
          answers = parseTagAnswer(result.text, chunk.length);
          charge = tagCharge(result, prompt);
        } catch (err) {
          // No later call this run. A timeout may still have cost the upper bound; a thrown error not.
          modelWorks = false;
          charge = err instanceof TagTimeout ? tagUpperBound(prompt) : 0;
        }
      }

      // Entries with no valid line (or no call at all) get one topic from the embedding, if any.
      const updates: [number, number][] = [];
      const needFallback: Candidate[] = [];
      chunk.forEach((c, i) => {
        const ids = answers.get(i + 1);
        if (ids === undefined) needFallback.push(c);
        else {
          updates.push([c.id, packTopics(ids, SOURCE_MODEL)]);
          out.tagModel++;
        }
      });
      if (needFallback.length > 0) {
        if (vectors === undefined) vectors = await loadTopicVectors(deps, now, out);
        const embeddings = vectors
          ? await db.all<{ entry_id: number; vec: string }>(
              sql(
                'SELECT entry_id, vec FROM entry_embeddings WHERE entry_id IN (SELECT value FROM json_each(?))',
                JSON.stringify(needFallback.map((c) => c.id)),
              ),
            )
          : null;
        if (embeddings) out.rowsRead += readRows(embeddings.meta);
        const vecById = new Map((embeddings?.rows ?? []).map((r) => [r.entry_id, r.vec]));
        for (const c of needFallback) {
          const e = vectors ? decodeEmbedding(vecById.get(c.id)) : null;
          if (vectors && e) {
            updates.push([c.id, packTopics([nearestTopic(e, vectors)], SOURCE_EMBEDDING)]);
            out.tagFallback++;
          } else {
            out.untagged++;
          }
        }
      }

      const statements: Statement[] = [];
      if (updates.length > 0) {
        // `topics IS NULL` makes an overlapping run harmless: the second write changes nothing.
        statements.push(
          sql(
            `UPDATE entries SET topics = j.v
               FROM (SELECT json_extract(value, '$[0]') AS id, json_extract(value, '$[1]') AS v
                       FROM json_each(?)) j
              WHERE entries.id = j.id AND entries.topics IS NULL`,
            JSON.stringify(updates),
          ),
        );
      }
      if (called && charge > 0) {
        statements.push(addToCounter(TAG_SPEND_KEY, now, charge));
        spent += Math.ceil(charge);
        out.neuronsCharged += Math.ceil(charge);
      }
      if (statements.length > 0) {
        const results = await db.batch(statements);
        out.rowsWritten += results.reduce((n, r) => n + written(r.meta), 0);
      }
    }
  }

  // Remember whether work is waiting, so the next minute's tick runs again (written only on a change).
  // Only when this run made progress: entries that can't be tagged (no valid answer, no embedding)
  // must not keep a backlog flag, and so a run every minute, alive.
  out.more = out.more && out.tagModel + out.tagFallback > 0;
  const was = await readMoreFlag(db);
  if (was !== out.more) {
    out.rowsWritten += written(
      await db.run(
        sql(
          `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, ?3)
           ON CONFLICT (key) DO UPDATE SET count = excluded.count, window_start = excluded.window_start`,
          TAG_MORE_KEY,
          now,
          out.more ? 1 : 0,
        ),
      ),
    );
  }
  return out;
}

/** True when the dispatcher should run the tag step now: the hourly minute, or a backlog is waiting. */
export async function tagStepDue(db: Db, nowMs: number): Promise<boolean> {
  if (new Date(nowMs).getUTCMinutes() === TAG_FLUSH_MINUTE) return true;
  return readMoreFlag(db);
}
