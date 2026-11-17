import { useMemo } from 'react';
import { sanitizeArticleHtml } from '../lib/sanitize';

/**
 * The only component that injects HTML (spec 10.5; ESLint bans `dangerouslySetInnerHTML`
 * everywhere else). Its input is the entry's raw `contentHtml`, and it only ever renders what
 * `sanitizeArticleHtml` returns. Titles, authors and summaries never come through here: they are
 * rendered as text.
 */
export function ArticleContent({
  html,
  entryUrl,
}: {
  html: string;
  /** Resolves relative links and images. */
  entryUrl: string | null;
}) {
  const safe = useMemo(() => sanitizeArticleHtml(html, entryUrl), [html, entryUrl]);
  return (
    <div
      className="article-prose"
      data-testid="article-content"
      dangerouslySetInnerHTML={{ __html: safe }}
    />
  );
}
