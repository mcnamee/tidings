import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';

async function lint(code: string) {
  const eslint = new ESLint({ cwd: process.cwd() });
  const [result] = await eslint.lintText(code, { filePath: 'apps/worker/src/db/example.ts' });
  return result?.messages.filter((m) => m.ruleId === 'no-restricted-syntax') ?? [];
}

describe('SQL template-literal lint rule (TID-004 AC6)', () => {
  it('fails when prepare() receives a template literal with interpolation', async () => {
    const messages = await lint(
      'export const q = (db: D1Database, id: string) => db.prepare(`SELECT * FROM t WHERE id = ${id}`);\n',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toContain('bind()');
  });

  it('allows static SQL, including a template literal without interpolation', async () => {
    expect(
      await lint(
        'export const q = (db: D1Database) => db.prepare(`SELECT 1`).bind();\n' +
          "export const r = (db: D1Database) => db.prepare('SELECT * FROM t WHERE id = ?').bind(1);\n",
      ),
    ).toHaveLength(0);
  });
});
