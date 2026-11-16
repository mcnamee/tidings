import { describe, expect, it } from 'vitest';
import { Db } from './client';
import { decodeCursor, encodeCursor } from './cursor';
import { listEntries, type EntrySummaryRow } from './entries';
import { ValidationError } from './errors';

interface Call {
  sql: string;
  binds: unknown[];
}

/** Minimal fake D1 that records prepared SQL and bound values and returns canned rows. */
function fakeD1(rows: Partial<EntrySummaryRow>[] = []) {
  const calls: Call[] = [];
  const d1 = {
    prepare(sqlText: string) {
      const call: Call = { sql: sqlText, binds: [] };
      calls.push(call);
      const stmt = {
        bind(...b: unknown[]) {
          call.binds = b;
          return stmt;
        },
        async all() {
          return { results: rows, meta: { rows_read: rows.length } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db: new Db(d1), calls };
}

const row = (id: number, p: number): Partial<EntrySummaryRow> => ({
  entry_id: id,
  published_at: p,
});

describe('listEntries', () => {
  it('queries All/unread with the partial index, scoped by user, fetching limit + 1', async () => {
    const { db, calls } = fakeD1();
    await listEntries(db, 'u1', { view: 'all', unreadOnly: true, limit: 50 });
    const c = calls[0]!;
    expect(c.sql).toContain('INDEXED BY ue_unread_all');
    expect(c.sql).toContain('ue.user_id = ?');
    expect(c.sql).toContain('ue.is_read = 0');
    expect(c.sql).toContain('ORDER BY ue.published_at DESC, ue.entry_id DESC LIMIT ?');
    expect(c.sql).not.toContain('(ue.published_at, ue.entry_id) <');
    expect(c.binds).toEqual(['u1', 51]);
  });

  it('uses ue_all for state=all and omits the unread filter', async () => {
    const { db, calls } = fakeD1();
    await listEntries(db, 'u1', { view: 'all', unreadOnly: false, limit: 10 });
    expect(calls[0]!.sql).toContain('INDEXED BY ue_all ');
    expect(calls[0]!.sql).not.toContain('is_read = 0');
  });

  it('feed view filters by feed and uses the feed indexes', async () => {
    const { db, calls } = fakeD1();
    await listEntries(db, 'u1', { view: 'feed', id: '7', unreadOnly: true, limit: 5 });
    expect(calls[0]!.sql).toContain('INDEXED BY ue_unread_feed');
    expect(calls[0]!.sql).toContain('ue.feed_id = ?');
    expect(calls[0]!.binds).toEqual(['u1', 7, 6]);
    await listEntries(db, 'u1', { view: 'feed', id: 7, unreadOnly: false, limit: 5 });
    expect(calls[1]!.sql).toContain('INDEXED BY ue_feed ');
  });

  it('folder view scopes the subscription subquery by user as well', async () => {
    const { db, calls } = fakeD1();
    await listEntries(db, 'u1', { view: 'folder', id: 'f1', unreadOnly: true, limit: 5 });
    expect(calls[0]!.sql).toContain(
      'ue.feed_id IN (SELECT feed_id FROM subscriptions WHERE user_id = ? AND folder_id = ?)',
    );
    expect(calls[0]!.sql).not.toContain('INDEXED BY');
    expect(calls[0]!.binds).toEqual(['u1', 'u1', 'f1', 6]);
  });

  it('applies the cursor as a row-value comparison', async () => {
    const { db, calls } = fakeD1();
    const cursor = encodeCursor({ p: 1000, i: 9 });
    await listEntries(db, 'u1', { view: 'all', unreadOnly: true, limit: 2, cursor });
    expect(calls[0]!.sql).toContain('(ue.published_at, ue.entry_id) < (?, ?)');
    expect(calls[0]!.binds).toEqual(['u1', 1000, 9, 3]);
  });

  it('returns a nextCursor from the last served row when more rows exist', async () => {
    const { db } = fakeD1([row(3, 30), row(2, 20), row(1, 10)]);
    const page = await listEntries(db, 'u1', { view: 'all', unreadOnly: true, limit: 2 });
    expect(page.items.map((r) => r.entry_id)).toEqual([3, 2]);
    expect(decodeCursor(page.nextCursor!)).toEqual({ p: 20, i: 2 });
  });

  it('returns nextCursor null on the last page', async () => {
    const { db } = fakeD1([row(2, 20), row(1, 10)]);
    const page = await listEntries(db, 'u1', { view: 'all', unreadOnly: true, limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  it('exposes D1 meta', async () => {
    const { db } = fakeD1([row(1, 1)]);
    const page = await listEntries(db, 'u1', { view: 'all', unreadOnly: true, limit: 5 });
    expect(page.meta.rows_read).toBe(1);
  });

  it.each([0, 101, 1.5, Number.NaN])('rejects limit %s', async (limit) => {
    const { db, calls } = fakeD1();
    await expect(listEntries(db, 'u1', { view: 'all', unreadOnly: true, limit })).rejects.toThrow(
      ValidationError,
    );
    expect(calls).toHaveLength(0);
  });

  it('requires id unless view=all', async () => {
    const { db } = fakeD1();
    await expect(
      listEntries(db, 'u1', { view: 'feed', unreadOnly: true, limit: 5 }),
    ).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError for a malformed cursor before touching the DB', async () => {
    const { db, calls } = fakeD1();
    await expect(
      listEntries(db, 'u1', { view: 'all', unreadOnly: true, limit: 5, cursor: 'bad!' }),
    ).rejects.toThrow(ValidationError);
    expect(calls).toHaveLength(0);
  });
});
