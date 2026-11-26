import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script without type declarations
import { buildSeedSql } from '../apps/worker/scripts/seed.mjs';

// TID-077 AC1: migration 0013 applied on a populated 0012 database (the Worker tests start from an
// empty one). Plain SQLite, the engine D1 runs.
const dir = path.join(__dirname, '../apps/worker/migrations');
const read = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8');

describe('migration 0013_topic_tags.sql on a populated 0012 database', () => {
  const db = new DatabaseSync(':memory:');
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of files.filter((f) => f < '0013')) db.exec(read(f));
  db.exec((buildSeedSql as () => string)());
  const before = db.prepare('SELECT * FROM entries ORDER BY id').all();
  const queueBefore = db.prepare('SELECT COUNT(*) AS c FROM embed_queue').get() as { c: number };
  db.exec(read('0013_topic_tags.sql'));
  const after = db.prepare('SELECT * FROM entries ORDER BY id').all() as Record<string, unknown>[];

  it('adds a nullable topics column with no index, and changes no existing value', () => {
    expect(before).toHaveLength(500);
    expect(after).toHaveLength(500);
    expect(after.every((r) => r.topics === null)).toBe(true);
    // Every old column is identical; `topics` is the only new key.
    for (const [i, row] of after.entries()) {
      expect(Object.keys(row).filter((k) => k !== 'topics')).toEqual(Object.keys(before[i] ?? {}));
      expect({ ...row, topics: undefined }).toEqual({ ...before[i], topics: undefined });
    }
    const col = db
      .prepare(
        "SELECT type, \"notnull\" AS nn FROM pragma_table_info('entries') WHERE name = 'topics'",
      )
      .get() as { type: string; nn: number };
    expect(col).toEqual({ type: 'INTEGER', nn: 0 });
    const indexed = db
      .prepare(
        `SELECT COUNT(*) AS c FROM pragma_index_list('entries') il
          WHERE EXISTS (SELECT 1 FROM pragma_index_info(il.name) ii WHERE ii.name = 'topics')`,
      )
      .get() as { c: number };
    expect(indexed.c).toBe(0);
  });

  it('creates topic_vectors and queues nothing', () => {
    const cols = db
      .prepare("SELECT name FROM pragma_table_info('topic_vectors') ORDER BY cid")
      .all();
    expect(cols).toEqual([{ name: 'topic_id' }, { name: 'version' }, { name: 'vec' }]);
    const queueAfter = db.prepare('SELECT COUNT(*) AS c FROM embed_queue').get() as { c: number };
    expect(queueAfter.c).toBe(queueBefore.c);
  });
});
