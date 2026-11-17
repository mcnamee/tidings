import { env, exports } from 'cloudflare:workers';
import { createExecutionContext, createScheduledController } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeFetch, createFixedClock } from '@tidings/test-utils';
import { Db, sql } from '../src/db';
import {
  CPU_LIMIT_MESSAGE,
  FeedRefresher,
  handleScheduled,
  PARKED_AT,
  REFRESH_BATCH_SIZE,
  runDispatcher,
  type RefreshJob,
  type RefreshOutcome,
} from '../src/refresh';
import worker from '../src/index';
import {
  count,
  db,
  feedRow,
  items,
  jobFor,
  resetData,
  rss,
  seedFeed,
} from './support/refresh-harness';

// TID-012 AC1, AC7, AC10, AC11, AC12 (logic), AC16 and the real ctx.exports fan-out, in workerd.

const clock = createFixedClock();
const NOW = Math.floor(clock.now() / 1000);

const ok = (job: RefreshJob): RefreshOutcome => ({
  feedId: job.feedId,
  result: 'unchanged',
  newEntries: 0,
  errorCode: null,
  usage: { rowsRead: 0, rowsWritten: 0, statements: 0 },
});

function dispatch(refresh: (job: RefreshJob) => Promise<RefreshOutcome>, batchSize?: number) {
  return runDispatcher({
    db,
    clock: () => clock.now(),
    random: () => 0.5,
    refresh,
    batchSize,
  });
}

beforeEach(async () => {
  await resetData();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('lease (AC1, AC7, AC11)', () => {
  it('AC1: 50 due feeds, batch 20: leases exactly the 20 oldest and advances next_fetch_at', async () => {
    // Feed n is due since n seconds after epoch 100, so ids ascend with next_fetch_at.
    const ids: number[] = [];
    for (let n = 1; n <= 50; n++) ids.push(await seedFeed({ nextFetchAt: 100 + n }));
    const seen: number[] = [];

    const summary = await dispatch(async (job) => {
      seen.push(job.feedId);
      return ok(job);
    });

    expect(REFRESH_BATCH_SIZE).toBe(20);
    expect(summary).toMatchObject({ leased: 20, fulfilled: 20, rejected: 0 });
    expect(seen.sort((a, b) => a - b)).toEqual(ids.slice(0, 20));
    for (const id of ids.slice(0, 20)) {
      expect(await feedRow(id)).toMatchObject({
        next_fetch_at: NOW + 1800,
        last_attempt_at: NOW,
      });
    }
    for (const id of ids.slice(20)) {
      expect((await feedRow(id)).last_attempt_at).toBeNull();
    }
    // The lease is one statement and costs one row written per leased feed (spec 9.4).
    expect(summary.rowsWritten).toBe(20);
  });

  it('AC1: two concurrent dispatcher runs lease 40 distinct feeds', async () => {
    for (let n = 1; n <= 50; n++) await seedFeed({ nextFetchAt: 100 + n });
    const seenA: number[] = [];
    const seenB: number[] = [];

    const [a, b] = await Promise.all([
      dispatch(async (j) => (seenA.push(j.feedId), ok(j))),
      dispatch(async (j) => (seenB.push(j.feedId), ok(j))),
    ]);

    expect(a.leased).toBe(20);
    expect(b.leased).toBe(20);
    expect(new Set([...seenA, ...seenB]).size).toBe(40);
  });

  it('only feeds that are due are leased', async () => {
    const due = await seedFeed({ nextFetchAt: NOW });
    await seedFeed({ nextFetchAt: NOW + 1 });
    const seen: number[] = [];
    await dispatch(async (j) => (seen.push(j.feedId), ok(j)));
    expect(seen).toEqual([due]);
  });

  it('AC7: a gone feed is never leased, even when overdue', async () => {
    await seedFeed({ state: 'gone', nextFetchAt: 0 });
    const live = await seedFeed({ nextFetchAt: 0 });
    const seen: number[] = [];
    await dispatch(async (j) => (seen.push(j.feedId), ok(j)));
    expect(seen).toEqual([live]);
  });

  it('AC11: a parked feed (no subscribers) is never leased', async () => {
    await seedFeed({ nextFetchAt: PARKED_AT, subscribers: [] });
    const summary = await dispatch(async (j) => ok(j));
    expect(summary.leased).toBe(0);
  });

  it('dead feeds are still leased when due (daily retry)', async () => {
    const id = await seedFeed({ state: 'dead', errorCount: 30, nextFetchAt: NOW - 10 });
    const seen: number[] = [];
    await dispatch(async (j) => (seen.push(j.feedId), ok(j)));
    expect(seen).toEqual([id]);
  });

  it('the dispatcher scan reads every feed row once and nothing else (spec 9.5)', async () => {
    for (let n = 1; n <= 30; n++) await seedFeed({ nextFetchAt: NOW + 1000 });
    const summary = await dispatch(async (j) => ok(j));
    expect(summary.leased).toBe(0);
    expect(summary.rowsWritten).toBe(0);
    expect(summary.rowsRead).toBeLessThanOrEqual(30 + 5);
  });
});

describe('a callee that rejects (AC10)', () => {
  it('records cpu_limit for the exact CPU-kill message, with backoff', async () => {
    const id = await seedFeed({ nextFetchAt: 0, errorCount: 1, state: 'failing' });
    const summary = await dispatch(async () => {
      throw new Error(CPU_LIMIT_MESSAGE);
    });
    expect(CPU_LIMIT_MESSAGE).toBe('Worker exceeded CPU time limit.');
    expect(summary).toMatchObject({ leased: 1, rejected: 1, cpuLimit: 1 });
    // error_count 1 -> 2: 1800 x 2^2 = 7200 (jitter factor 1.0).
    expect(await feedRow(id)).toMatchObject({
      last_error_code: 'cpu_limit',
      error_count: 2,
      state: 'failing',
      next_fetch_at: NOW + 7200,
      last_status: null,
    });
  });

  it('records internal for any other rejection and never stores its message', async () => {
    const id = await seedFeed({ nextFetchAt: 0 });
    const summary = await dispatch(async () => {
      throw new Error('boom: ZZ-SECRET-MARKER');
    });
    expect(summary).toMatchObject({ rejected: 1, cpuLimit: 0 });
    const row = await feedRow(id);
    expect(row).toMatchObject({
      last_error_code: 'internal',
      error_count: 1,
      state: 'failing',
      next_fetch_at: NOW + 3600,
    });
    expect(JSON.stringify(row)).not.toContain('ZZ-SECRET-MARKER');
  });

  it('treats a non-Error rejection, or a near-miss message, as internal', async () => {
    const a = await seedFeed({ nextFetchAt: 0 });
    const b = await seedFeed({ nextFetchAt: 0 });
    await dispatch(async (job) => {
      if (job.feedId === a) throw 'a string';
      throw new Error(`${CPU_LIMIT_MESSAGE} (extra)`);
    });
    expect((await feedRow(a)).last_error_code).toBe('internal');
    expect((await feedRow(b)).last_error_code).toBe('internal');
  });

  it('one rejection does not affect the others in the batch', async () => {
    const bad = await seedFeed({ nextFetchAt: 0 });
    const good = await seedFeed({ nextFetchAt: 0 });
    const summary = await dispatch(async (job) => {
      if (job.feedId === bad) throw new Error('x');
      return ok(job);
    });
    expect(summary).toMatchObject({ leased: 2, fulfilled: 1, rejected: 1 });
    expect((await feedRow(good)).error_count).toBe(0);
    expect((await feedRow(bad)).error_count).toBe(1);
  });

  it('the 20th consecutive failure recorded by the dispatcher makes the feed dead', async () => {
    const id = await seedFeed({ nextFetchAt: 0, errorCount: 19, state: 'failing' });
    await dispatch(async () => {
      throw new Error(CPU_LIMIT_MESSAGE);
    });
    expect(await feedRow(id)).toMatchObject({ state: 'dead', next_fetch_at: NOW + 86_400 });
  });
});

describe('real fan-out through ctx.exports (ADR 0004, AC12 logic)', () => {
  it('the scheduled handler leases due feeds and each FeedRefresher.refresh call fetches and stores', async () => {
    const fake = createFakeFetch();
    vi.stubGlobal('fetch', fake.fetch);
    const urls: string[] = [];
    for (let n = 1; n <= 3; n++) {
      const url = `https://feed${n}.example.com/rss.xml`;
      urls.push(url);
      fake.serveFeed(url, rss(items(1, n + 1)));
      await seedFeed({ id: n, url, nextFetchAt: 0, state: 'pending', lastSuccessAt: null });
    }
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await worker.scheduled(
      createScheduledController({ cron: '* * * * *', scheduledTime: clock.now() }),
      env,
      createExecutionContext(),
    );

    expect(fake.calls.map((c) => c.url).sort()).toEqual(urls.sort());
    expect(await count('entries', 'feed_id = 1')).toBe(2);
    expect(await count('entries', 'feed_id = 3')).toBe(4);
    for (let n = 1; n <= 3; n++) expect((await feedRow(n)).state).toBe('ok');
    expect(String(log.mock.calls.at(-1)?.[0])).toContain('"leased":3,"fulfilled":3,"rejected":0');
  });

  it('a real RPC rejection from the callee is recorded as internal by the dispatcher', async () => {
    const id = await seedFeed({ nextFetchAt: 0 });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const refresher = exports as unknown as { FeedRefresher: FeedRefresher };
    await handleScheduled(
      createScheduledController({ cron: '* * * * *', scheduledTime: clock.now() }),
      env,
      createExecutionContext(),
      {
        clock: () => clock.now(),
        // A malformed job makes the real entrypoint throw, so the RPC promise rejects.
        refresh: () => refresher.FeedRefresher.refresh(null as never),
      },
    );
    expect(await feedRow(id)).toMatchObject({ last_error_code: 'internal', error_count: 1 });
  });

  it('the maintenance cron does not dispatch refreshes', async () => {
    await seedFeed({ nextFetchAt: 0 });
    await worker.scheduled(
      createScheduledController({ cron: '17 * * * *', scheduledTime: clock.now() }),
      env,
      createExecutionContext(),
    );
    expect(
      (await feedRow((await db.all<{ id: number }>(sql('SELECT id FROM feeds'))).rows[0]!.id))
        .last_attempt_at,
    ).toBeNull();
  });
});

describe('FeedRefresher config guard (AC16)', () => {
  const PROD_ENV = {
    ...env,
    APP_ORIGIN: 'https://tidings.mcn.am',
    ALLOW_FETCH_HOSTS: '127.0.0.1:8790',
  };

  it('makes no fetch and logs the configuration error when invoked directly', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('must not be called')));
    vi.stubGlobal('fetch', fetchSpy);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const id = await seedFeed({ url: 'http://127.0.0.1:8790/feed.xml' });

    const refresher = new FeedRefresher(createExecutionContext() as never, PROD_ENV);
    const out = await refresher.refresh(await jobFor(id));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out).toMatchObject({ result: 'skipped', usage: { statements: 0 } });
    expect(err).toHaveBeenCalledWith(expect.stringContaining('configuration error'));
    // It also writes nothing: the feed is untouched.
    expect(await feedRow(id)).toMatchObject({ error_count: 0, last_error_code: null });
  });

  it('the scheduled dispatcher makes no fetch and leases nothing under the same config', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('must not be called')));
    vi.stubGlobal('fetch', fetchSpy);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const id = await seedFeed({ nextFetchAt: 0 });
    await worker.scheduled(
      createScheduledController({ cron: '* * * * *', scheduledTime: clock.now() }),
      PROD_ENV,
      createExecutionContext(),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await feedRow(id)).last_attempt_at).toBeNull();
  });

  it('runs normally with a local APP_ORIGIN and the allow-list (the E2E configuration)', async () => {
    const fake = createFakeFetch();
    vi.stubGlobal('fetch', fake.fetch);
    fake.serveFeed('http://127.0.0.1:8790/feed.xml', rss(items(1, 2)));
    const id = await seedFeed({ url: 'http://127.0.0.1:8790/feed.xml' });
    const refresher = new FeedRefresher(createExecutionContext() as never, {
      ...env,
      APP_ORIGIN: 'http://localhost:8788',
      ALLOW_FETCH_HOSTS: '127.0.0.1:8790',
    });
    const out = await refresher.refresh(await jobFor(id));
    expect(out).toMatchObject({ result: 'updated', newEntries: 2 });
  });
});

// Keeps the unused import list honest if a case above is removed.
void Db;
