/**
 * Topic tagging, pure parts (TID-077, ADR 0021): the packed `entries.topics` column, the tagging
 * prompt, and the strict parser for the model's answer. No I/O, so every rule is unit-tested.
 *
 * Packing, from the least significant bit: 0-7 first topic ID, 8-15 second, 16-23 third (0 = empty
 * slot), 24-25 source (1 model, 2 embedding fallback). NULL is "not tagged". A value with only the
 * source bits is "tagged, no topic".
 */
import { RETIRED_TOPIC_IDS, TOPICS, type SystemTopic } from '@tidings/shared';
import { embeddingText } from './embed';

export const MAX_TOPICS_PER_ENTRY = 3;
export const SOURCE_MODEL = 1;
export const SOURCE_EMBEDDING = 2;
export type TagSource = typeof SOURCE_MODEL | typeof SOURCE_EMBEDDING;

const BY_ID = new Map<number, SystemTopic>(TOPICS.map((t) => [t.id, t]));
const RETIRED = new Set<number>(RETIRED_TOPIC_IDS);

export const isActiveTopicId = (id: number): boolean => BY_ID.has(id);

/** Packs up to 3 distinct topic IDs (1 to 255, most relevant first) and the source into one integer. */
export function packTopics(ids: readonly number[], source: TagSource): number {
  let v = source << 24;
  ids.slice(0, MAX_TOPICS_PER_ENTRY).forEach((id, i) => {
    if (!Number.isInteger(id) || id < 1 || id > 255) throw new RangeError('topic id out of range');
    v |= id << (8 * i);
  });
  return v;
}

export interface UnpackedTopics {
  /** IDs in stored order, empty slots dropped. */
  ids: number[];
  source: number;
}

export function unpackTopics(value: number): UnpackedTopics {
  const ids: number[] = [];
  for (let i = 0; i < MAX_TOPICS_PER_ENTRY; i++) {
    const id = (value >> (8 * i)) & 255;
    if (id !== 0) ids.push(id);
  }
  return { ids, source: (value >> 24) & 3 };
}

/**
 * The API's `topics` for a stored value: active topic slugs, most relevant first. Retired and unknown
 * IDs are left out, and NULL (not tagged) is `[]`.
 */
export function topicSlugs(value: number | null | undefined): string[] {
  if (value === null || value === undefined) return [];
  const out: string[] = [];
  for (const id of unpackTopics(value).ids) {
    const t = BY_ID.get(id);
    if (t && !RETIRED.has(id)) out.push(t.slug);
  }
  return out;
}

/** The slug for an ID, or null when it is unknown or retired. */
export const slugOf = (id: number): string | null => BY_ID.get(id)?.slug ?? null;

export interface TagItem {
  title: string | null;
  summary: string | null;
}

export interface TagPrompt {
  system: string;
  user: string;
  /** `20 × articles + 20`: room for three topic names a line (about 7 tokens used), and a bound on the spend. */
  maxTokens: number;
}

/**
 * The topics, one per line: name and description. The model answers by name: in the TID-077 accuracy
 * run, numeric answers misread the topic numbers (a hostage story answered "Middle East", 74% first
 * tag right on 19 articles) where names did not (84%; docs/testing/topic-tagging-2026-11-26), for 5%
 * more neurons. Names are parsed back to IDs against the exact list, and the text is never stored.
 */
const TOPIC_LINES = TOPICS.slice()
  .sort((a, b) => a.id - b.id)
  .map((t) => `- ${t.name}: ${t.description}`)
  .join('\n');

const SYSTEM_PROMPT =
  `You tag news articles with topics. Topics:\n${TOPIC_LINES}\n\n` +
  'For each numbered article, give 1 to 3 topic names from the list, most relevant first. ' +
  'Only add a second or third topic if the article is clearly about it too. ' +
  'If no topic fits, answer None. Use the exact topic names. ' +
  'Answer with one line per article in the form "N: Topic; Topic" and nothing else.';

/**
 * The prompt for one batch. Article text is only ever `title` and `summary`, whitespace collapsed
 * (so an article can't start a new numbered line) and clipped to 400 characters, as embedded.
 */
export function buildTagPrompt(items: readonly TagItem[]): TagPrompt {
  const user = items.map((it, i) => `${i + 1}. ${embeddingText(it.title, it.summary)}`).join('\n');
  return { system: SYSTEM_PROMPT, user, maxTokens: 20 * items.length + 20 };
}

/** What the model said for each article: IDs (empty = "no topic"). A missing key = no valid line. */
export type TagAnswers = Map<number, number[]>;

const LINE = /^\s*(\d{1,3})\s*:\s*(\S.*?)\s*$/;
const ID_BY_NAME = new Map<string, number>(TOPICS.map((t) => [t.name.toLowerCase(), t.id]));

/** A topic ID from one answer token: an exact topic name (any case) or a bare number. Null if neither. */
function topicIdOf(token: string): number | null {
  const t = token.trim();
  if (/^\d{1,3}$/.test(t)) return Number(t);
  return ID_BY_NAME.get(t.toLowerCase()) ?? null;
}

/**
 * Strict parser. A line counts only if it is `<article>: <topics>`, the topics separated by `;` or `,`
 * and each an exact topic name or a topic number, so extra text makes a token (and, if it was the only
 * one, the line) unusable. Answers are keyed by article number (not line order), articles outside
 * `1..count` and repeated lines are ignored, and each article keeps at most 3 distinct active topic
 * IDs in the model's order. A line with topics but none valid is not an answer (the article gets the
 * fallback); `None` or `0` alone is "no topic". Model text is never stored: only the IDs are.
 */
export function parseTagAnswer(text: string, count: number): TagAnswers {
  const out: TagAnswers = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (!m) continue;
    const article = Number(m[1]);
    if (article < 1 || article > count || out.has(article)) continue;
    const body = m[2] as string;
    if (/^(none|0)\.?$/i.test(body)) {
      out.set(article, []);
      continue;
    }
    // Numbers may be separated by spaces too ("13 12"); names may not.
    const tokens = /^[\d\s,;]+$/.test(body) ? body.split(/[\s,;]+/) : body.split(/[;,]/);
    const ids: number[] = [];
    for (const token of tokens) {
      const id = topicIdOf(token);
      if (id !== null && isActiveTopicId(id) && !ids.includes(id)) ids.push(id);
      if (ids.length === MAX_TOPICS_PER_ENTRY) break;
    }
    if (ids.length > 0) out.set(article, ids);
  }
  return out;
}
