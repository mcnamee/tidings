import { describe, expect, it } from 'vitest';
import {
  evaluate,
  overall,
  parseWindow,
  type GraphqlResponse,
  type Window,
} from '../bench/analysis';
import { scenarios } from '../bench/scenarios';

// TID-012 AC13 gate logic, adversarial (tester). Each it.fails documents an open defect: it passes
// while the defect exists and errors once the harness is fixed, so the fix must remove the marker.

const win = (id: string, calls = 200): Window => ({
  id,
  role: 'measure',
  from: '2026-11-17T01:00:00Z',
  to: '2026-11-17T01:01:00Z',
  calls,
});
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
const scenario = (id: string) => scenarios().find((s) => s.id === id);
const GOOD = { cpuTimeP95: 3000 };
const verdictFor = (id: string, calls: number, stats: ReturnType<typeof parseWindow>) =>
  evaluate(win(id, calls), scenario(id), stats, null).verdict;

describe('gate rejects invocations that died for any reason (DEF-016)', () => {
  it.fails('a window with killed or crashed invocations is not a PASS', () => {
    for (const status of [
      'exceededResources',
      'exceededMemory',
      'scriptThrewException',
      'internalError',
    ]) {
      const stats = parseWindow(response({ success: 190, [status]: 10 }, GOOD));
      expect(verdictFor('changed:rss-typical', 200, stats)).not.toBe('PASS');
    }
  });

  it.fails('analytics seeing far fewer invocations than were made is not a PASS', () => {
    const stats = parseWindow(response({ success: 120 }, GOOD));
    expect(verdictFor('changed:rss-typical', 200, stats)).not.toBe('PASS');
  });
});

describe('gate completeness (DEF-017)', () => {
  it.fails('fewer than 200 measured calls cannot PASS (AC13 says at least 200)', () => {
    const stats = parseWindow(response({ success: 5 }, GOOD));
    expect(verdictFor('changed:rss-typical', 5, stats)).not.toBe('PASS');
  });

  it.fails('overall is not PASS with no gated rows, or with gated scenarios missing', () => {
    expect(overall([])).not.toBe('PASS');
    const one = evaluate(
      win('changed:rss-typical'),
      scenario('changed:rss-typical'),
      parseWindow(response({ success: 200 }, GOOD)),
      null,
    );
    expect(overall([one])).not.toBe('PASS'); // 7 of the 8 gated scenarios never ran
  });
});

describe('gate basics that hold', () => {
  it('uses each scenario ceiling: 8 ms changed, 2 ms unchanged and too_large', () => {
    const stats = parseWindow(response({ success: 200 }, { cpuTimeP95: 2500 }));
    expect(verdictFor('changed:rss-typical', 200, stats)).toBe('PASS');
    expect(verdictFor('unchanged:rss-typical', 200, stats)).toBe('FAIL');
    expect(verdictFor('too_large:rss-huge', 200, stats)).toBe('FAIL');
  });

  it('p95 exactly at the ceiling passes; just above fails', () => {
    const at = parseWindow(response({ success: 200 }, { cpuTimeP95: 8000 }));
    const over = parseWindow(response({ success: 200 }, { cpuTimeP95: 8001 }));
    expect(verdictFor('changed:rss-typical', 200, at)).toBe('PASS');
    expect(verdictFor('changed:rss-typical', 200, over)).toBe('FAIL');
  });
});
