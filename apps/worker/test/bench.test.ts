import { env } from 'cloudflare:workers';
import { createExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseFeed } from '@tidings/feed-parser';
import { FeedRefresher as BenchRefresher } from '../bench/bench-worker';
import { handle, paddedFeed } from '../bench/origin-worker';
import { runBatch, setup, type DriverEnv } from '../bench/driver-worker';
import {
  buildQuery,
  evaluate,
  overall,
  parseSchema,
  parseWindow,
  pickQuantileFields,
  toMarkdown,
  type GraphqlResponse,
  type Window,
} from '../bench/analysis';
import { FIXTURES, MIB, scenarios } from '../bench/scenarios';
import { count, resetData } from './support/refresh-harness';

// TID-012 AC13 harness, dry-run in workerd: the origin Worker, the benchmark callee (the real
// FeedRefresher plus the benchmark-only body cap), the driver and the analysis, without deploying.
// The deployed measurement itself needs the user's approval (see the runbook in docs/BACKLOG.md).

const ORIGIN = 'https://bench-origin.example.com';
const get = (path: string) => handle(new Request(ORIGIN + path));
const keys = async (path: string) => {
  const parsed = parseFeed(await (await get(path)).text(), { fetchedAt: 1_800_000_000 });
  if (!parsed.ok) throw new Error('parse failed');
  return parsed.feed.items.map((i) => i.guidKey);
};

describe('origin Worker', () => {
  it.each(FIXTURES)(
    '%s: each request has exactly N brand-new items and the same item count',
    async (name) => {
      const a = await keys(`/feed/${name}.xml?new=3`);
      const b = await keys(`/feed/${name}.xml?new=3`);
      expect(a.length).toBe(b.length);
      expect(b.filter((k) => !a.includes(k))).toHaveLength(3);
      // The other items keep their identity, so dedup finds them known.
      expect(a.filter((k) => b.includes(k))).toHaveLength(a.length - 3);
    },
  );

  it('serves identical static bytes and no validators', async () => {
    const r1 = await get('/static/rss-typical.xml');
    const r2 = await get('/static/rss-typical.xml');
    expect(await r1.text()).toBe(await r2.text());
    expect(r1.headers.get('ETag')).toBeNull();
    expect(r1.headers.get('Last-Modified')).toBeNull();
  });

  it('pads to exactly the requested size and the pad is a valid feed', async () => {
    for (const bytes of [MIB, 2 * MIB]) {
      const xml = paddedFeed(bytes);
      expect(new TextEncoder().encode(xml).length).toBe(bytes);
    }
    expect(parseFeed(paddedFeed(5000), { fetchedAt: 1 }).ok).toBe(true);
  });

  it('the over-cap fixtures really exceed 1 MiB and the typical ones stay under', async () => {
    const size = async (n: string) =>
      (await (await get(`/static/${n}.xml`)).arrayBuffer()).byteLength;
    expect(await size('rss-large')).toBeGreaterThan(MIB);
    expect(await size('rss-huge')).toBeGreaterThan(MIB);
    expect(await size('rss-typical')).toBeLessThan(MIB);
  });
});

describe('driver + real refresher dry run', () => {
  beforeEach(async () => {
    await resetData();
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(handle(new Request(input, init))),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('every scenario behaves as the gate expects, including the benchmark-only 2 MiB cap', async () => {
    const refresher = new BenchRefresher(createExecutionContext() as never, {
      ...env,
      APP_ORIGIN: 'https://tidings-bench.example.com',
    });
    const driverEnv: DriverEnv = {
      DB: env.DB,
      REFRESHER: { refresh: (job) => refresher.refresh(job) },
      BENCH_TOKEN: 'x',
    };
    const list = scenarios(3);
    const { feeds } = await setup(driverEnv, {
      origin: ORIGIN,
      scenarios: list.map((s) => ({ id: s.id, path: s.path })),
    });
    expect(Object.keys(feeds)).toHaveLength(list.length);

    for (const s of list) {
      const feedId = feeds[s.id] as number;
      await runBatch(driverEnv, feedId, 1); // the first refresh stores the document
      const sum = await runBatch(driverEnv, feedId, 3);
      expect(sum.rejected, s.id).toBe(0);
      expect(sum.results, s.id).toEqual({ [s.expect.result]: 3 });
      if (s.expect.errorCode) expect(sum.errorCodes, s.id).toEqual({ [s.expect.errorCode]: 3 });
      if (s.kind === 'changed') expect(sum.newEntries, s.id).toBe(9); // 3 new items x 3 calls
      if (s.kind === 'unchanged' || s.kind === 'info') expect(sum.rowsWritten.max, s.id).toBe(0);
    }
    // Only one entry set per feed that stored content; the over-cap feeds stored none.
    expect(await count('entries', 'feed_id = ?', feeds['too_large:rss-huge'] as number)).toBe(0);
  });

  it('caps the benchmark run at 20 calls per request and refuses a bad origin', async () => {
    const driverEnv: DriverEnv = {
      DB: env.DB,
      REFRESHER: { refresh: () => Promise.reject(new Error('x')) },
      BENCH_TOKEN: 'x',
    };
    await expect(
      setup(driverEnv, { origin: 'http://insecure.example.com', scenarios: [] }),
    ).rejects.toThrow(/https/);
    const { feeds } = await setup(driverEnv, {
      origin: ORIGIN,
      scenarios: [{ id: 'a', path: '/static/rss-small.xml' }],
    });
    const sum = await runBatch(driverEnv, feeds['a'] as number, 500);
    expect(sum.calls).toBe(20);
    expect(sum.rejected).toBe(20);
  });
});

describe('analysis', () => {
  const win: Window = {
    id: 'changed:rss-typical',
    role: 'measure',
    from: '2026-11-17T01:00:00Z',
    to: '2026-11-17T01:01:00Z',
    calls: 200,
  };
  const scenario = scenarios().find((s) => s.id === win.id);
  const response = (
    statuses: Record<string, number>,
    q: Record<string, number>,
  ): GraphqlResponse => ({
    data: {
      viewer: {
        accounts: [
          {
            workersInvocationsAdaptive: Object.entries(statuses).map(([status, requests]) => ({
              dimensions: { status },
              sum: { requests },
              quantiles: q,
            })),
          },
        ],
      },
    },
  });

  it('builds the documented query, with and without the threshold filter', () => {
    const q = buildQuery(['cpuTimeP50', 'cpuTimeP99']);
    expect(q).toContain('workersInvocationsAdaptive');
    expect(q).toContain('quantiles { cpuTimeP50 cpuTimeP99 }');
    expect(q).not.toContain('cpuTimeUs_gt');
    expect(buildQuery(['cpuTimeP50'], { thresholdUs: 8000 })).toContain('cpuTimeUs_gt: 8000');
  });

  it('reads the schema and picks only quantile fields that exist', () => {
    expect(
      parseSchema({
        group: { fields: [{ name: 'quantiles', type: { name: null, ofType: { name: 'QType' } } }] },
        filter: { inputFields: [{ name: 'cpuTimeUs_gt' }] },
      }),
    ).toEqual({ quantilesType: 'QType', hasThresholdFilter: true });
    expect(pickQuantileFields(['cpuTimeP50', 'cpuTimeP99', 'other'])).toEqual([
      'cpuTimeP50',
      'cpuTimeP99',
    ]);
  });

  it('converts microseconds to milliseconds and counts exceededCpu', () => {
    const stats = parseWindow(
      response({ success: 198, exceededCpu: 2 }, { cpuTimeP50: 3200, cpuTimeP90: 6100 }),
    );
    expect(stats).toMatchObject({ requests: 200, exceededCpu: 2 });
    expect(stats.quantilesMs.cpuTimeP50).toBeCloseTo(3.2);
  });

  it('fails on any exceededCpu, however good the quantiles', () => {
    const stats = parseWindow(response({ success: 199, exceededCpu: 1 }, { cpuTimeP50: 1000 }));
    expect(evaluate(win, scenario, stats, null).verdict).toBe('FAIL');
  });

  it('judges p95 exactly when exposed, by the share above the ceiling when not, else provisionally', () => {
    const ok = parseWindow(response({ success: 200 }, { cpuTimeP90: 6000, cpuTimeP95: 7500 }));
    expect(evaluate(win, scenario, ok, null).verdict).toBe('PASS');
    const bad = parseWindow(response({ success: 200 }, { cpuTimeP90: 6000, cpuTimeP95: 8500 }));
    expect(evaluate(win, scenario, bad, null).verdict).toBe('FAIL');

    const noP95 = parseWindow(response({ success: 200 }, { cpuTimeP90: 6000, cpuTimeP99: 12000 }));
    expect(evaluate(win, scenario, noP95, 10).verdict).toBe('PASS'); // 5.0% above 8 ms
    expect(evaluate(win, scenario, noP95, 11).verdict).toBe('FAIL');
    expect(evaluate(win, scenario, noP95, null).verdict).toBe('PROVISIONAL');
    const p90High = parseWindow(response({ success: 200 }, { cpuTimeP90: 9000 }));
    expect(evaluate(win, scenario, p90High, null).verdict).toBe('FAIL');
  });

  it('does not gate cold, first and info windows, and reports the overall result', () => {
    const stats = parseWindow(response({ success: 1 }, { cpuTimeP50: 20_000 }));
    const cold: Window = { ...win, id: 'cold', role: 'cold', calls: 1 };
    expect(evaluate(cold, scenario, stats, null).verdict).toBe('INFO');
    const rowPass = evaluate(
      win,
      scenario,
      parseWindow(response({ success: 200 }, { cpuTimeP95: 5000 })),
      null,
    );
    const rowFail = evaluate(
      win,
      scenario,
      parseWindow(response({ success: 200, exceededCpu: 1 }, {})),
      null,
    );
    expect(overall([rowPass])).toBe('PASS');
    expect(overall([rowPass, rowFail])).toBe('FAIL');
    expect(toMarkdown([rowPass, rowFail])).toContain(
      '| changed:rss-typical | measure | 200 | 200 |',
    );
    expect(
      evaluate(
        win,
        scenario,
        parseWindow({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [] }] } } }),
        null,
      ).verdict,
    ).toBe('NO DATA');
  });

  it('surfaces GraphQL errors instead of reading them as no data', () => {
    expect(() => parseWindow({ errors: [{ message: 'unknown field' }] })).toThrow(/unknown field/);
  });
});
