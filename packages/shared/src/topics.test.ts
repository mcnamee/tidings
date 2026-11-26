import { describe, expect, it } from 'vitest';
import {
  RETIRED_TOPIC_IDS,
  TOPICS,
  TOPICS_VERSION,
  TOPIC_CHIPS_MAX,
  TOPIC_SCAN_LIMIT,
  isTopicSlug,
  topicIdOfSlug,
} from './topics';
import { entriesQuerySchema, markAllReadRequestSchema, userSettingsPatchSchema } from './schemas';

// TID-077 AC2: the system topic list.
describe('TOPICS', () => {
  it('has the 28 topics of spec 7.9, with UK politics right after US politics', () => {
    expect(TOPICS).toHaveLength(28);
    expect(TOPICS_VERSION).toBe(1);
    expect(RETIRED_TOPIC_IDS).toEqual([]);
    const slugs = TOPICS.map((t) => t.slug);
    expect(slugs.indexOf('uk-politics')).toBe(slugs.indexOf('us-politics') + 1);
    expect(TOPICS.find((t) => t.id === 28)).toMatchObject({ slug: 'uk-politics' });
    expect(TOPICS.find((t) => t.id === 13)).toMatchObject({ slug: 'ai', name: 'AI' });
    expect(TOPICS.find((t) => t.id === 12)).toMatchObject({ slug: 'technology' });
    expect(TOPICS.find((t) => t.id === 21)).toMatchObject({ slug: 'formula-1' });
  });

  it('has unique IDs (1 to 255) and slugs, and a name and description for each', () => {
    expect(new Set(TOPICS.map((t) => t.id)).size).toBe(TOPICS.length);
    expect(new Set(TOPICS.map((t) => t.slug)).size).toBe(TOPICS.length);
    for (const t of TOPICS) {
      expect(Number.isInteger(t.id) && t.id >= 1 && t.id <= 255).toBe(true);
      expect(t.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(10);
    }
  });

  it('never reuses a retired ID', () => {
    const active = new Set(TOPICS.map((t) => t.id));
    for (const id of RETIRED_TOPIC_IDS) expect(active.has(id)).toBe(false);
  });
});

// TID-078: slugs on the wire.
describe('topic slugs and the schemas that take them', () => {
  it('knows active slugs and nothing else', () => {
    expect(TOPIC_CHIPS_MAX).toBe(TOPICS.length);
    expect(TOPIC_SCAN_LIMIT).toBe(1000);
    expect(isTopicSlug('ai')).toBe(true);
    expect(topicIdOfSlug('uk-politics')).toBe(28);
    for (const bad of ['', 'AI', 'nope', '13', 13, null, undefined])
      expect(isTopicSlug(bad)).toBe(false);
    expect(topicIdOfSlug('nope')).toBeNull();
  });

  it('topicChips: active, unique, at most 28; the empty list is valid', () => {
    const ok = (topicChips: unknown) => userSettingsPatchSchema.safeParse({ topicChips }).success;
    expect(ok([])).toBe(true);
    expect(ok(['ai', 'formula-1'])).toBe(true);
    expect(ok(TOPICS.map((t) => t.slug))).toBe(true);
    expect(ok(['ai', 'ai'])).toBe(false);
    expect(ok(['ai', 'nope'])).toBe(false);
    expect(ok([...TOPICS.map((t) => t.slug), 'ai'])).toBe(false);
    expect(ok('ai')).toBe(false);
  });

  it('topic is accepted only with view=all, on lists and on mark all as read', () => {
    const q = (o: object) => entriesQuerySchema.safeParse(o).success;
    expect(q({ view: 'all', topic: 'ai' })).toBe(true);
    expect(q({ view: 'feed', id: 'x', topic: 'ai' })).toBe(false);
    expect(q({ view: 'folder', id: 'x', topic: 'ai' })).toBe(false);
    expect(q({ view: 'all', topic: 'nope' })).toBe(false);
    const m = (o: object) =>
      markAllReadRequestSchema.safeParse({ before: '2026-11-26T00:00:00Z', ...o }).success;
    expect(m({ view: 'all', topic: 'ai' })).toBe(true);
    expect(m({ view: 'feed', id: 'x', topic: 'ai' })).toBe(false);
    expect(m({ view: 'all', topic: 'nope' })).toBe(false);
  });
});
