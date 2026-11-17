import { describe, expect, it } from 'vitest';
import {
  feedErrorMessage,
  feedWarningMessage,
  httpErrorCode,
  isFeedErrorCode,
} from './feed-errors';

describe('feed error table (FR-FH-1)', () => {
  it('maps fixed codes and http statuses to fixed messages', () => {
    expect(feedErrorMessage('timeout')).toBe('Timed out after 10 s');
    expect(feedErrorMessage('too_large')).toBe('Too large (over 1 MB)');
    expect(feedErrorMessage('parse_error')).toBe("Couldn't parse the feed");
    expect(feedErrorMessage(httpErrorCode(404))).toBe('The server returned 404 Not Found');
    expect(feedErrorMessage('http_599')).toBe('The server returned 599');
    expect(feedErrorMessage(null)).toBeNull();
  });

  it('never echoes an unknown code', () => {
    expect(feedErrorMessage('<script>alert(1)</script>')).toBeNull();
    expect(feedErrorMessage('toString')).toBeNull();
    expect(isFeedErrorCode('http_4040')).toBe(false);
    expect(isFeedErrorCode('http_404')).toBe(true);
    expect(isFeedErrorCode('whatever')).toBe(false);
  });
});

describe('feed warning table (TID-046)', () => {
  it('maps new_item_cap to a fixed message and anything else to null', () => {
    expect(feedWarningMessage('new_item_cap')).toMatch(/too many new items/);
    expect(feedWarningMessage(null)).toBeNull();
    expect(feedWarningMessage('toString')).toBeNull();
  });
});
