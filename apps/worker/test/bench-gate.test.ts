import { describe, expect, it } from 'vitest';
import {
  evaluate,
  gatedScenarioIds,
  overall,
  overallLine,
  parseWindow,
  requiredCalls,
  toMarkdown,
  type GraphqlResponse,
  type Window,
} from '../bench/analysis';
import { scenarios } from '../bench/scenarios';

// TID-012 AC13 gate logic, adversarial (tester). DEF-016 and DEF-017 are fixed, so their markers
// are removed and the assertions are unchanged.

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
  it('a window with killed or crashed invocations is not a PASS', () => {
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

  it('analytics seeing far fewer invocations than were made is not a PASS', () => {
    const stats = parseWindow(response({ success: 120 }, GOOD));
    expect(verdictFor('changed:rss-typical', 200, stats)).not.toBe('PASS');
  });
});

describe('gate completeness (DEF-017)', () => {
  it('fewer than 200 measured calls cannot PASS (AC13 says at least 200)', () => {
    const stats = parseWindow(response({ success: 5 }, GOOD));
    expect(verdictFor('changed:rss-typical', 5, stats)).not.toBe('PASS');
  });

  it('overall is not PASS with no gated rows, or with gated scenarios missing', () => {
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

const rowFor = (id: string, success = 200, calls = 200, extra: Record<string, number> = {}) =>
  evaluate(
    win(id, calls),
    scenario(id),
    parseWindow(response({ success, ...extra }, { cpuTimeP95: 1500 })),
    null,
    200,
  );
const fullPlan = () => gatedScenarioIds().map((id) => rowFor(id));

describe('gate conditions added for DEF-016 and DEF-017 (engineer)', () => {
  it('any non-success status fails, including exceededCpu and unknown values', () => {
    for (const status of ['exceededCpu', 'exceededResources', 'somethingNew', 'unknown']) {
      const row = rowFor('changed:rss-typical', 199, 200, { [status]: 1 });
      expect(row.verdict).toBe('FAIL');
      expect(row.note).toContain(`1 ${status}`);
    }
  });

  it('a missing status dimension counts as a non-success status', () => {
    const res: GraphqlResponse = {
      data: {
        viewer: { accounts: [{ workersInvocationsAdaptive: [{ sum: { requests: 200 } }] }] },
      },
    };
    expect(verdictFor('changed:rss-typical', 200, parseWindow(res))).toBe('FAIL');
  });

  it('a window where analytics saw under 98% of the calls is NEEDS PM; exactly 98% is fine', () => {
    expect(rowFor('changed:rss-typical', 195).verdict).toBe('NEEDS PM');
    expect(rowFor('changed:rss-typical', 196).verdict).toBe('PASS');
  });

  it('low coverage does not hide a p95 failure', () => {
    const stats = parseWindow(response({ success: 150 }, { cpuTimeP95: 9000 }));
    expect(verdictFor('changed:rss-typical', 200, stats)).toBe('FAIL');
  });

  it('the results table reports the per-status counts', () => {
    const row = rowFor('changed:rss-typical', 190, 200, { exceededCpu: 10 });
    const md = toMarkdown([row]);
    expect(md).toContain('| Statuses |');
    expect(md).toContain('success 190, exceededCpu 10');
  });

  it('calls below the required count are INCOMPLETE, not PASS, and requiredCalls floors at 200', () => {
    expect(rowFor('changed:rss-typical', 199, 199).verdict).toBe('INCOMPLETE');
    expect(rowFor('changed:rss-typical', 200, 200).verdict).toBe('PASS');
    expect(requiredCalls({})).toBe(200);
    expect(requiredCalls({ runs: 5 })).toBe(200);
    expect(requiredCalls({ runs: 300 })).toBe(300);
    const stats = parseWindow(response({ success: 250 }, GOOD));
    expect(
      evaluate(win('changed:rss-typical', 250), scenario('changed:rss-typical'), stats, null, 300)
        .verdict,
    ).toBe('INCOMPLETE');
  });

  it('every gated scenario in the plan must be present, and the full plan passes', () => {
    const rows = fullPlan();
    expect(rows.length).toBe(gatedScenarioIds().length);
    expect(overall(rows)).toBe('PASS');
    expect(overall(rows.slice(1))).toBe('INCOMPLETE');
    expect(overall(rows.slice(0, 1))).toBe('INCOMPLETE');
  });

  it('a partial run says PARTIAL, never Overall: PASS', () => {
    const partial = overall([rowFor('changed:rss-typical')]);
    expect(partial).toBe('INCOMPLETE');
    expect(overallLine(partial)).toBe('PARTIAL: not a gate result');
    expect(overallLine('PASS')).toBe('Overall: PASS');
  });

  it('a FAIL in a partial run is still reported as FAIL', () => {
    const bad = rowFor('changed:rss-typical', 199, 200, { exceededMemory: 1 });
    expect(overall([bad])).toBe('FAIL');
  });

  it('runner warnings stop a full run from passing', () => {
    expect(overall(fullPlan(), { warnings: ['changed:rss-typical: expected 20 x updated'] })).toBe(
      'NEEDS PM',
    );
    expect(overall(fullPlan(), { warnings: [] })).toBe('PASS');
  });

  it('a provisional or low-coverage row in a full plan needs the PM', () => {
    const rows = fullPlan();
    rows[0] = rowFor('changed:rss-small', 150);
    expect(overall(rows)).toBe('NEEDS PM');
  });
});
