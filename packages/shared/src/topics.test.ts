import { describe, expect, it } from 'vitest';
import { RETIRED_TOPIC_IDS, TOPICS, TOPICS_VERSION } from './topics';

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
