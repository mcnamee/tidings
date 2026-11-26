import { describe, expect, it } from 'vitest';
import { topicChipsPref, topicFromParams, topicName } from './topics';

// TID-078: URL state and setting parsing for the topic chips.
describe('topicChipsPref', () => {
  it('defaults to none and drops unknown, retired, repeated and non-string entries', () => {
    expect(topicChipsPref(undefined)).toEqual([]);
    expect(topicChipsPref({})).toEqual([]);
    expect(topicChipsPref({ topicChips: ['ai', 'nope', 'ai', 'formula-1'] })).toEqual([
      'ai',
      'formula-1',
    ]);
    expect(topicChipsPref({ topicChips: 'ai' as unknown as string[] })).toEqual([]);
  });
});

describe('topicFromParams', () => {
  const chips = ['ai', 'formula-1'];
  const p = (qs: string) => new URLSearchParams(qs);
  it('selects a chosen topic on All articles only', () => {
    expect(topicFromParams(p('topic=ai'), 'all', chips)).toBe('ai');
    expect(topicFromParams(p('topic=ai'), 'folder', chips)).toBeNull();
    expect(topicFromParams(p('topic=ai'), 'feed', chips)).toBeNull();
  });
  it('treats an unknown, retired, not-chosen or empty topic as All', () => {
    expect(topicFromParams(p('topic=nope'), 'all', chips)).toBeNull();
    expect(topicFromParams(p('topic=osint'), 'all', chips)).toBeNull();
    expect(topicFromParams(p('topic='), 'all', chips)).toBeNull();
    expect(topicFromParams(p(''), 'all', chips)).toBeNull();
    expect(topicFromParams(p('topic=ai'), 'all', [])).toBeNull();
  });
});

describe('topicName', () => {
  it('prefers the API name and falls back to the built-in list', () => {
    expect(topicName('ai', [{ id: 'ai', name: 'Artificial intelligence' }])).toBe(
      'Artificial intelligence',
    );
    expect(topicName('formula-1', undefined)).toBe('Formula 1');
    expect(topicName('mystery', undefined)).toBe('mystery');
  });
});
