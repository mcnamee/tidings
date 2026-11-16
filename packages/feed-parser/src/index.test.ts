import { describe, expect, it } from 'vitest';
import { FEED_PARSER_PACKAGE } from './index';

describe('feed-parser', () => {
  it('exports its package marker', () => {
    expect(FEED_PARSER_PACKAGE).toBe('@tidings/feed-parser');
  });
});
