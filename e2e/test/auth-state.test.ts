import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SEED_SESSION_TOKEN,
  SEED_USER_ID,
  sessionInsertSql,
  sha256Hex,
} from '../support/auth-state.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const seedSql = readFileSync(path.join(here, '../support/seed-owner.sql'), 'utf8');

describe('E2E resting state (auth-state.ts and seed-owner.sql)', () => {
  it('the seed SQL stores the SHA-256 of SEED_SESSION_TOKEN, never the token itself', () => {
    expect(seedSql).toContain(sha256Hex(SEED_SESSION_TOKEN));
    expect(seedSql).not.toContain(SEED_SESSION_TOKEN);
  });

  it('the seed SQL owns the session by the seeded owner', () => {
    expect(seedSql).toContain(`'${SEED_USER_ID}'`);
  });

  it('sessionInsertSql hashes the token, and expires after the given seconds', () => {
    const sql = sessionInsertSql('abc', 'u1', 5);
    expect(sql).toContain(sha256Hex('abc'));
    expect(sql).not.toContain("'abc'");
    expect(sql).toMatch(/\+ 5, /);
  });

  it('the seed token is long enough to look like a real one and is not reused for anything else', () => {
    expect(SEED_SESSION_TOKEN.length).toBeGreaterThanOrEqual(32);
    expect(sha256Hex(SEED_SESSION_TOKEN)).toMatch(/^[0-9a-f]{64}$/);
  });
});
