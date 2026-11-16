import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FEEDS_DIR = path.resolve(here, '../../../e2e/fixtures/feeds');
export const EXPECTED_DIR = path.resolve(here, '../test/expected');

/** 2026-11-10T12:00:00Z, the "now" the fixtures were written against. */
export const FETCHED_AT = Date.UTC(2026, 10, 10, 12, 0, 0) / 1000;

export function readFixture(name: string): string {
  return readFileSync(path.join(FEEDS_DIR, name), 'utf8');
}
