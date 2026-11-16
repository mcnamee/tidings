import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index';
import { describe, expect, it } from 'vitest';

// TID-005 AC1: Worker integration tests run inside workerd against a migrated local D1.
describe('test infrastructure: workerd + migrated D1', () => {
  it('AC1: applies ./migrations per test file and can query D1', async () => {
    const row = await env.DB.prepare('SELECT 1 AS one').first<{ one: number }>();
    expect(row?.one).toBe(1);
    const applied = await env.DB.prepare('SELECT COUNT(*) AS n FROM d1_migrations').first<{
      n: number;
    }>();
    expect(applied?.n).toBe(env.TEST_MIGRATIONS.length);
  });

  it('AC1: applyD1Migrations applies a migration once and records it (throwaway probe)', async () => {
    const probe = [
      {
        name: '9999_tid005_probe.sql',
        queries: ['CREATE TABLE tid005_probe (id INTEGER PRIMARY KEY, v TEXT NOT NULL)'],
      },
    ];
    await applyD1Migrations(env.DB, probe);
    await applyD1Migrations(env.DB, probe); // idempotent: a second run must not fail or re-apply
    await env.DB.prepare('INSERT INTO tid005_probe (v) VALUES (?)').bind('x').run();
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM tid005_probe').first<{ n: number }>();
    expect(n?.n).toBe(1);
    const rec = await env.DB.prepare('SELECT COUNT(*) AS n FROM d1_migrations WHERE name = ?')
      .bind('9999_tid005_probe.sql')
      .first<{ n: number }>();
    expect(rec?.n).toBe(1);
  });

  it('AC1: the Worker entry is reachable in-process', async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch!(
      new Request('http://example.com/api/health') as never,
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
  });
});
