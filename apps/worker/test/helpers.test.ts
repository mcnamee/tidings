import { createFakeFetch, createFixedClock } from '@tidings/test-utils';
import { describe, expect, it } from 'vitest';
import atomXml from '../../../e2e/fixtures/feeds/atom-basic.xml?raw';
import { generatedFeed } from '../../../e2e/fixtures/generate-feeds';

// The shared helpers must behave the same inside workerd as in Node, since Worker code under test
// receives them by injection (`fetch`, `now`).
describe('test-utils inside workerd', () => {
  it('fake fetch serves a feed with conditional GET and never reaches the network', async () => {
    const f = createFakeFetch();
    f.serveFeed('https://feed.example.test/rss.xml', '<rss/>', { etag: '"e1"' });
    expect((await f.fetch('https://feed.example.test/rss.xml')).status).toBe(200);
    const again = await f.fetch('https://feed.example.test/rss.xml', {
      headers: { 'If-None-Match': '"e1"' },
    });
    expect(again.status).toBe(304);
    await expect(f.fetch('https://not-mocked.example.test/')).rejects.toThrow(/no route/);
  });

  it('fixture files import as raw text and generated feeds work in workerd', () => {
    expect(atomXml).toContain('<feed xmlns="http://www.w3.org/2005/Atom"');
    expect(generatedFeed('rss-typical').length).toBeGreaterThan(100_000);
  });

  it('fixed clock is stable', () => {
    const c = createFixedClock('2026-11-10T12:00:00Z');
    expect(c.now()).toBe(c.now());
    c.advance(30 * 60_000);
    expect(c.iso()).toBe('2026-11-10T12:30:00.000Z');
  });
});
