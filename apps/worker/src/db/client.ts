/**
 * Thin typed wrapper over D1. All SQL goes through `prepare()` with `bind()` placeholders
 * (ESLint forbids template-literal interpolation in `prepare()`). Every result exposes D1's
 * `meta` so tests can assert `rows_read` / `rows_written` (NFR-7).
 */
export type SqlValue = string | number | null | ArrayBuffer;

export interface Statement {
  sql: string;
  params: readonly SqlValue[];
}

export function sql(text: string, ...params: SqlValue[]): Statement {
  return { sql: text, params };
}

export type Meta = D1Meta & Record<string, unknown>;

export interface QueryResult<T> {
  rows: T[];
  meta: Meta;
}

export class Db {
  constructor(readonly d1: D1Database) {}

  private prepare(s: Statement): D1PreparedStatement {
    return this.d1.prepare(s.sql).bind(...s.params);
  }

  async all<T>(s: Statement): Promise<QueryResult<T>> {
    const r = await this.prepare(s).all<T>();
    return { rows: r.results, meta: r.meta };
  }

  async first<T>(s: Statement): Promise<T | null> {
    return this.prepare(s).first<T>();
  }

  async run(s: Statement): Promise<Meta> {
    const r = await this.prepare(s).run();
    return r.meta;
  }

  /** Runs statements in one D1 batch (a single implicit transaction). Keep batches bounded. */
  async batch(statements: readonly Statement[]): Promise<D1Result[]> {
    if (statements.length === 0) return [];
    return this.d1.batch(statements.map((s) => this.prepare(s)));
  }
}
