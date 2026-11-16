import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';

const code = `export const X = ({ h }: { h: string }) => <div dangerouslySetInnerHTML={{ __html: h }} />;\n`;

async function lint(filePath: string) {
  const eslint = new ESLint({ cwd: process.cwd() });
  const [result] = await eslint.lintText(code, { filePath });
  return result?.messages.filter((m) => m.ruleId === 'no-restricted-syntax') ?? [];
}

describe('dangerouslySetInnerHTML lint rule', () => {
  it('fails in any file other than ArticleContent.tsx', async () => {
    const messages = await lint('apps/web/src/Other.tsx');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toContain('ArticleContent.tsx');
  });

  it('is allowed in ArticleContent.tsx', async () => {
    expect(await lint('apps/web/src/components/ArticleContent.tsx')).toHaveLength(0);
  });
});
