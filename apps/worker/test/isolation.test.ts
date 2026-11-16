import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

// smoke.test.ts creates tid005_probe in its own database. Storage is isolated per test file, so
// this file must start without it: nothing leaks between files (and files can run in any order).
describe('per-file storage isolation', () => {
  it('AC1: tables created by another test file are not visible here', async () => {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'tid005_probe'",
    ).first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it('AC1: migrations are applied to this file too', async () => {
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM d1_migrations').first<{
      n: number;
    }>();
    expect(row?.n).toBe(env.TEST_MIGRATIONS.length);
  });
});
