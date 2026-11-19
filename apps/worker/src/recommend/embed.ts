/**
 * The embed step (TID-067, ADR 0018): turns queued entries into stored embeddings, in a bounded batch
 * per run, outside any user request and outside the refresh. A failed or refused AI call leaves the
 * entries queued and changes nothing a user sees. Every statement is parameterised.
 */
import type { AiBinding } from '../../env';
import { Db, sql, type Meta } from '../db';
import { DIMS, encodeEmbedding } from './vector';

export const EMBED_MODEL = '@cf/baai/bge-small-en-v1.5';
/** Entries per AI call and per run (the model takes arrays; one call is one subrequest). */
export const EMBED_BATCH = 25;
/** Characters sent per entry: about 100 tokens. */
export const EMBED_TEXT_CHARS = 400;
/** Failed calls before an entry is left alone. */
export const EMBED_MAX_TRIES = 3;
/** Workers AI Free: 1,841 neurons per million input tokens (ADR 0018, measured by the owner). */
export const NEURONS_PER_MILLION_TOKENS = 1_841;
/** Neurons per UTC day this feature may spend: 30% of the 10,000 free (rest is headroom). */
export const DAILY_NEURON_CAP = 3_000;
/** Entries embedded per UTC day, which bounds D1 writes (3 rows each) rather than neurons. */
export const DAILY_ENTRY_CAP = 3_000;
const DAY = 86_400;

export type Embedder = (texts: string[]) => Promise<number[][]>;

/** Title and summary as plain text, whitespace collapsed, clipped to about 100 tokens. */
export function embeddingText(title: string | null, summary: string | null): string {
  const t = (title ?? '').replace(/\s+/g, ' ').trim();
  const s = (summary ?? '').replace(/\s+/g, ' ').trim();
  const joined = t && s ? `${t}. ${s}` : t || s;
  return joined.length > EMBED_TEXT_CHARS ? joined.slice(0, EMBED_TEXT_CHARS) : joined;
}

/** Input tokens for the budget. A deliberate over-estimate (3 characters a token, plus 2). */
export function estimateTokens(texts: readonly string[]): number {
  let n = 0;
  for (const t of texts) n += Math.ceil(t.length / 3) + 2;
  return n;
}

export const neuronsFor = (tokens: number): number =>
  (tokens * NEURONS_PER_MILLION_TOKENS) / 1_000_000;

export const DAILY_TOKEN_CAP = Math.floor((DAILY_NEURON_CAP / NEURONS_PER_MILLION_TOKENS) * 1e6);

/** Production embedder over the Workers AI binding. Throws on a malformed answer. */
export function workersAiEmbedder(ai: AiBinding): Embedder {
  return async (texts) => {
    const out = (await ai.run(EMBED_MODEL, { text: texts })) as { data?: unknown } | null;
    const data = out?.data;
    if (
      !Array.isArray(data) ||
      data.length !== texts.length ||
      data.some((v) => !Array.isArray(v) || v.length !== DIMS)
    ) {
      throw new Error('unexpected Workers AI embedding response');
    }
    return data as number[][];
  };
}

const dayStart = (now: number): number => now - (now % DAY);

/** Today's spend so far: `[tokens, entries]`, from the two `rate_limits` counters. */
export async function readDailyUsage(
  db: Db,
  now: number,
): Promise<{ tokens: number; entries: number }> {
  const { rows } = await db.all<{ key: string; count: number }>(
    sql(
      `SELECT key, count FROM rate_limits WHERE key IN ('ai:tokens', 'ai:entries') AND window_start = ?`,
      dayStart(now),
    ),
  );
  const get = (k: string) => rows.find((r) => r.key === k)?.count ?? 0;
  return { tokens: get('ai:tokens'), entries: get('ai:entries') };
}

/** Statement that adds to both daily counters (resetting them on a new UTC day). */
export function addUsageStatements(now: number, tokens: number, entries: number) {
  const upsert = (key: string, n: number) =>
    sql(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, ?3)
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start = excluded.window_start
                      THEN rate_limits.count + excluded.count ELSE excluded.count END,
         window_start = excluded.window_start`,
      key,
      dayStart(now),
      n,
    );
  return [upsert('ai:tokens', tokens), upsert('ai:entries', entries)];
}

export interface EmbedSummary {
  /** Entries given an embedding this run. */
  embedded: number;
  /** Entries dropped from the queue because they have no text. */
  skippedEmpty: number;
  /** Why the run did nothing or failed: `idle`, `daily_cap`, `ai_error`, or null. */
  stopped: 'idle' | 'daily_cap' | 'ai_error' | null;
  tokens: number;
  rowsWritten: number;
}

export interface EmbedDeps {
  db: Db;
  embedder: Embedder;
  /** Milliseconds, like `Date.now`. */
  clock: () => number;
}

const written = (m: Meta): number => Number(m.rows_written ?? 0);

/**
 * One bounded run: take up to {@link EMBED_BATCH} queued entries (newest first), embed them in one
 * AI call, store the vectors and dequeue them in one D1 batch, and add the spend to today's counters.
 */
export async function runEmbedPending(deps: EmbedDeps): Promise<EmbedSummary> {
  const { db } = deps;
  const now = Math.floor(deps.clock() / 1000);
  const out: EmbedSummary = {
    embedded: 0,
    skippedEmpty: 0,
    stopped: null,
    tokens: 0,
    rowsWritten: 0,
  };

  const { rows } = await db.all<{ entry_id: number; title: string | null; summary: string | null }>(
    sql(
      `SELECT q.entry_id, e.title, e.summary FROM embed_queue q JOIN entries e ON e.id = q.entry_id
        WHERE q.tries < ? ORDER BY q.entry_id DESC LIMIT ?`,
      EMBED_MAX_TRIES,
      EMBED_BATCH,
    ),
  );
  if (rows.length === 0) return { ...out, stopped: 'idle' };

  const usage = await readDailyUsage(db, now);
  if (usage.tokens >= DAILY_TOKEN_CAP || usage.entries >= DAILY_ENTRY_CAP) {
    return { ...out, stopped: 'daily_cap' };
  }

  const items = rows
    .map((r) => ({ id: r.entry_id, text: embeddingText(r.title, r.summary) }))
    .filter((r) => r.text !== '');
  const empty = rows.filter((r) => embeddingText(r.title, r.summary) === '').map((r) => r.entry_id);
  const ids = items.map((i) => i.id);

  const dequeue = (list: number[]) =>
    sql(
      'DELETE FROM embed_queue WHERE entry_id IN (SELECT value FROM json_each(?))',
      JSON.stringify(list),
    );

  if (items.length === 0) {
    const meta = (await db.batch([dequeue(empty)]))[0]?.meta as Meta;
    return { ...out, skippedEmpty: empty.length, rowsWritten: written(meta) };
  }

  const tokens = estimateTokens(items.map((i) => i.text));
  let vectors: number[][];
  try {
    vectors = await deps.embedder(items.map((i) => i.text));
    if (vectors.length !== items.length) throw new Error('wrong number of embeddings');
  } catch {
    // Leave them queued; count the failure so one bad entry cannot block the queue for ever.
    const meta = await db.run(
      sql(
        'UPDATE embed_queue SET tries = tries + 1 WHERE entry_id IN (SELECT value FROM json_each(?))',
        JSON.stringify(ids),
      ),
    );
    return { ...out, stopped: 'ai_error', rowsWritten: written(meta) };
  }

  const pairs = items.map((it, i) => [it.id, encodeEmbedding(vectors[i] as number[])]);
  const results = await db.batch([
    // An entry deleted since the read is skipped by the join (no foreign-key failure).
    sql(
      `INSERT OR REPLACE INTO entry_embeddings (entry_id, vec)
       SELECT e.id, json_extract(j.value, '$[1]') FROM json_each(?) j
         JOIN entries e ON e.id = json_extract(j.value, '$[0]')`,
      JSON.stringify(pairs),
    ),
    dequeue([...ids, ...empty]),
    ...addUsageStatements(now, tokens, items.length),
  ]);
  out.rowsWritten = results.reduce((n, r) => n + written(r.meta), 0);
  return { ...out, embedded: items.length, skippedEmpty: empty.length, tokens };
}
