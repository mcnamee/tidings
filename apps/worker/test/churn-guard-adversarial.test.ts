import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from '../src/db';
import { refreshFeed } from '../src/refresh';
import {
  count,
  createFixture,
  db,
  feedRow,
  FEED_URL,
  jobFor,
  resetData,
  rss,
  seedFeed,
  type Fixture,
  type Item,
} from './support/refresh-harness';

// TID-046 adversarial cases added by QA, beyond churn-guard.test.ts. Fixed clock throughout.

let fx: Fixture;

beforeEach(async () => {
  await resetData();
  fx = createFixture();
  fx.clock.set('2026-11-10T20:00:00Z');
});

async function refresh(feedId: number) {
  return refreshFeed(await jobFor(feedId), fx.deps);
}

const today = () => Math.floor(fx.clock.now() / 86_400_000);

async function setCounter(id: number, day: number, n: number, warning: string | null = null) {
  await db.run(
    sql(
      'UPDATE feeds SET new_entries_day = ?, new_entries_count = ?, warning_code = ? WHERE id = ?',
      day,
      n,
      warning,
      id,
    ),
  );
}

/** `n` items whose guid, link and title are all new for fetch `tag`. */
const fresh = (n: number, tag: string): Item[] =>
  Array.from({ length: n }, (_, k) => ({
    guid: `${tag}-${k}`,
    title: `T ${tag}-${k}`,
    link: `https://site.example.com/${tag}/${k}`,
  }));

/** Raw RSS items for cases the harness cannot express (no link, no date). */
function rawRss(items: { guid: string; title?: string; link?: string; date?: string }[]): string {
  const body = items
    .map(
      (i) =>
        `<item>${i.title ? `<title>${i.title}</title>` : ''}${i.link ? `<link>${i.link}</link>` : ''}` +
        `<guid isPermaLink="false">${i.guid}</guid>${i.date ? `<pubDate>${i.date}</pubDate>` : ''}</item>`,
    )
    .join('');
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Raw</title>${body}</channel></rss>`;
}

describe('cap boundary at exactly 200 (AC3)', () => {
  it('199 used + 1 candidate: stored, no warning', async () => {
    const id = await seedFeed({ url: FEED_URL });
    await setCounter(id, today(), 199);
    fx.fake.route(FEED_URL, { status: 200, body: rss(fresh(1, 'a')) });
    expect((await refresh(id)).newEntries).toBe(1);
    const row = await feedRow(id);
    expect(row.new_entries_count).toBe(200);
    expect(row.warning_code).toBeNull();
  });

  it('199 used + 2 candidates: exactly 1 stored, 1 refused, warning set', async () => {
    const id = await seedFeed({ url: FEED_URL });
    await setCounter(id, today(), 199);
    fx.fake.route(FEED_URL, { status: 200, body: rss(fresh(2, 'a')) });
    expect((await refresh(id)).newEntries).toBe(1);
    const row = await feedRow(id);
    expect(row.new_entries_count).toBe(200);
    expect(row.warning_code).toBe('new_item_cap');
  });

  it('200 used and the fetch has no new items: nothing refused, so no warning is raised', async () => {
    const id = await seedFeed({ url: FEED_URL });
    await setCounter(id, today(), 200);
    fx.fake.route(FEED_URL, { status: 200, body: rss(fresh(0, 'a')) });
    await refresh(id);
    expect((await feedRow(id)).warning_code).toBeNull();
  });
});

describe('UTC day rollover (AC3)', () => {
  it('23:59:59Z is day D, 00:00:00Z is day D+1: the counter resets exactly at midnight', async () => {
    const id = await seedFeed({ url: FEED_URL });
    fx.clock.set('2026-11-10T23:59:59Z');
    await setCounter(id, today(), 200, 'new_item_cap');
    fx.fake.route(FEED_URL, { status: 200, body: rss(fresh(5, 'a')) });
    expect((await refresh(id)).newEntries).toBe(0);

    fx.clock.set('2026-11-11T00:00:00Z');
    fx.fake.route(FEED_URL, { status: 200, body: rss(fresh(5, 'b')) });
    expect((await refresh(id)).newEntries).toBe(5);
    const row = await feedRow(id);
    expect(row.new_entries_count).toBe(5);
    expect(row.new_entries_day).toBe(today());
    expect(row.warning_code).toBeNull();
  });

  it('a new day that is itself over the cap keeps the warning and allows exactly 200', async () => {
    const id = await seedFeed({ url: FEED_URL });
    await setCounter(id, today() - 1, 200, 'new_item_cap');
    for (let n = 0; n < 5; n++) {
      fx.fake.route(FEED_URL, { status: 200, body: rss(fresh(50, `d${n}`)) });
      await refresh(id);
    }
    const row = await feedRow(id);
    expect(row.new_entries_count).toBe(200);
    expect(row.warning_code).toBe('new_item_cap');
    expect(await count('entries', 'feed_id = ?', id)).toBe(200);
  });
});

describe('warning lifetime (AC3)', () => {
  it('same UTC day: a changed fetch with nothing new does not clear the warning', async () => {
    const id = await seedFeed({ url: FEED_URL });
    await setCounter(id, today(), 200, 'new_item_cap');
    fx.fake.route(FEED_URL, { status: 200, body: rss([]) });
    await refresh(id);
    expect((await feedRow(id)).warning_code).toBe('new_item_cap');
  });
});

describe('known defects', () => {
  // DEF-020: AC3 says the warning clears on the first refresh of a new UTC day that stays under the
  // cap. A feed that stops changing (304 or identical body) never reaches the code that clears it.
  it.fails(
    'DEF-020: a quiet feed (identical body) on a later UTC day clears the warning',
    async () => {
      const id = await seedFeed({ url: FEED_URL });
      const body = rss(fresh(3, 'a'));
      fx.fake.route(FEED_URL, { status: 200, body });
      await refresh(id);
      await setCounter(id, today(), 200, 'new_item_cap');
      fx.clock.set('2026-11-12T08:00:00Z');
      fx.fake.route(FEED_URL, { status: 200, body });
      await refresh(id);
      expect((await feedRow(id)).warning_code).toBeNull();
    },
  );
});

describe('churning feeds (AC2, AC3)', () => {
  it('50 items identical in link AND title with a new guid every fetch: only the cap bounds it', async () => {
    // The shared key is ignored by design, so these are not suppressed; the cap is the backstop.
    const id = await seedFeed({ url: FEED_URL });
    for (let n = 0; n < 6; n++) {
      const same = Array.from({ length: 50 }, (_, k) => ({
        guid: `h${n}-${k}`,
        title: 'Same title',
        link: 'https://site.example.com/',
      }));
      fx.fake.route(FEED_URL, { status: 200, body: rss(same) });
      await refresh(id);
    }
    expect(await count('entries', 'feed_id = ?', id)).toBe(200);
    expect((await feedRow(id)).warning_code).toBe('new_item_cap');
  });

  it('a churning feed over the cap writes exactly 1 row per refresh', async () => {
    const id = await seedFeed({ url: FEED_URL, subscribers: ['u1', 'u2'] });
    await setCounter(id, today(), 200);
    fx.fake.route(FEED_URL, { status: 200, body: rss(fresh(50, 'a')) });
    const out = await refresh(id);
    expect(out.usage.rowsWritten).toBe(1);
  });

  it('recent_keys stays valid JSON of at most 50 short strings', async () => {
    const id = await seedFeed({ url: FEED_URL });
    fx.fake.route(FEED_URL, { status: 200, body: rss(fresh(50, 'a')) });
    await refresh(id);
    const keys = JSON.parse((await feedRow(id)).recent_keys ?? 'null') as string[];
    expect(keys).toHaveLength(50);
    expect(new Set(keys).size).toBe(50);
    expect(keys.every((k) => /^[0-9a-f]{16}$/.test(k))).toBe(true);
  });

  it.each(['{"a":1}', 'null', '[1,2,3]', 'not json', ''])(
    'a corrupt recent_keys value (%j) does not break a refresh',
    async (junk) => {
      const id = await seedFeed({ url: FEED_URL });
      await db.run(sql('UPDATE feeds SET recent_keys = ? WHERE id = ?', junk, id));
      fx.fake.route(FEED_URL, { status: 200, body: rss(fresh(3, 'a')) });
      const out = await refresh(id);
      expect(out.result).toBe('updated');
      expect(out.newEntries).toBe(3);
    },
  );
});

describe('items with nothing to key on (PM question 4, characterisation)', () => {
  it('no link and no date: not suppressed across fetches, so only the cap bounds them', async () => {
    const id = await seedFeed({ url: FEED_URL });
    fx.fake.route(FEED_URL, {
      status: 200,
      body: rawRss([{ guid: 'n1', title: 'Untethered' }]),
    });
    await refresh(id);
    fx.clock.set('2026-11-10T20:01:00Z');
    fx.fake.route(FEED_URL, {
      status: 200,
      body: rawRss([{ guid: 'n2', title: 'Untethered' }]),
    });
    const out = await refresh(id);
    // Documents today's behaviour: a missing date falls back to the fetch time, so the key moves.
    expect(out.newEntries).toBe(1);
  });
});

describe('cap-refused items (PM question 3, characterisation)', () => {
  it('their keys are remembered, so they are never stored later, even on a new day with room', async () => {
    const id = await seedFeed({ url: FEED_URL });
    await setCounter(id, today(), 200);
    const body = rss(fresh(10, 'p'));
    fx.fake.route(FEED_URL, { status: 200, body });
    expect((await refresh(id)).newEntries).toBe(0);

    // Next UTC day the same 10 articles come back under fresh guids: still known by key.
    fx.clock.set('2026-11-11T09:00:00Z');
    fx.fake.route(FEED_URL, {
      status: 200,
      body: rss(fresh(10, 'p').map((i) => ({ ...i, guid: `q-${i.guid}` }))),
    });
    expect((await refresh(id)).newEntries).toBe(0);
    expect(await count('entries', 'feed_id = ?', id)).toBe(0);
  });
});
