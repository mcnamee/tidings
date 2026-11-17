/**
 * Scenarios for the deployed CPU gate (TID-012 AC13, ADR 0006, spec §9.7). Shared by the origin
 * Worker, the driver Worker, the runner and the analyser, so the four cannot drift apart.
 *
 * Plain data only: no Node or Workers APIs, so tests can import it in workerd.
 */

export type ScenarioKind =
  /** New items in the body every time: the full parse, dedup and write path. Gate p95 <= 8 ms. */
  | 'changed'
  /** Byte-identical body: read and hash only. Gate p95 <= 2 ms. */
  | 'unchanged'
  /** Over the 1 MiB cap: rejected as too_large. Gate p95 <= 2 ms. */
  | 'too_large'
  /** Recorded, not gated (body read + SHA-256 at 1 MiB and 2 MiB). */
  | 'info';

export interface Scenario {
  id: string;
  kind: ScenarioKind;
  /** Path (and query) on the origin Worker. */
  path: string;
  /** The `RefreshResult` or error code every measured run must produce (sanity check). */
  expect: { result: 'updated' | 'unchanged' | 'failed'; errorCode?: string };
  /** p95 ceiling in ms for the whole invocation, when gated. */
  p95Ms?: number;
}

/** Items per request that are brand new (the rest keep their guids). AC4's typical case. */
export const DEFAULT_NEW_ITEMS = 3;

export const FIXTURES = ['rss-small', 'rss-typical', 'atom-typical', 'rdf-typical'] as const;
export const MIB = 1_048_576;

export function scenarios(newItems = DEFAULT_NEW_ITEMS): Scenario[] {
  return [
    ...FIXTURES.map((name): Scenario => ({
      id: `changed:${name}`,
      kind: 'changed',
      path: `/feed/${name}.xml?new=${newItems}`,
      expect: { result: 'updated' },
      p95Ms: 8,
    })),
    ...FIXTURES.map((name): Scenario => ({
      id: `unchanged:${name}`,
      kind: 'unchanged',
      path: `/static/${name}.xml`,
      expect: { result: 'unchanged' },
      p95Ms: 2,
    })),
    ...(['rss-large', 'rss-huge'] as const).map((name): Scenario => ({
      id: `too_large:${name}`,
      kind: 'too_large',
      path: `/static/${name}.xml`,
      expect: { result: 'failed', errorCode: 'too_large' },
      p95Ms: 2,
    })),
    {
      id: 'info:body-1mib',
      kind: 'info',
      path: `/pad/${MIB}.xml`,
      expect: { result: 'unchanged' },
    },
    {
      // `cap` is read only by the benchmark callee, which raises the body cap for this URL.
      id: 'info:body-2mib',
      kind: 'info',
      path: `/pad/${2 * MIB}.xml?cap=${2 * MIB}`,
      expect: { result: 'unchanged' },
    },
  ];
}

/** A scenario's first call inserts its feed's items; it is measured separately as `first`. */
export const FIRST_SUFFIX = ':first';
export const COLD_ID = 'cold';
