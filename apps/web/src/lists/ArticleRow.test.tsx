import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { EntrySummary } from '@tidings/shared';
import { ArticleRow, LIST_GRID } from './ArticleRow';
import { heroByRule } from './rowLayout';

// TID-062: featured cards and summaries on desktop.

const ids = Array.from({ length: 50 }, (_, i) => String(1000 + i));
const HERO_ID = ids.find((id) => heroByRule(id))!;
const THUMB_ID = ids.find((id) => !heroByRule(id))!;

const make = (id: string, over: Partial<EntrySummary> = {}): EntrySummary => ({
  id,
  subscriptionId: 's1',
  feedTitle: 'Feed',
  title: `Title ${id}`,
  author: null,
  url: null,
  summary: null,
  imageUrl: 'https://img.example.com/a.jpg',
  publishedAt: '2026-11-17T10:00:00.000Z',
  isRead: false,
  isStarred: false,
  ...over,
});

const renderRow = (entry: EntrySummary) =>
  render(
    <MemoryRouter>
      <ul>
        <ArticleRow entry={entry} to="/all/a/1" now={Date.parse('2026-11-17T12:00:00Z')} />
      </ul>
    </MemoryRouter>,
  );

describe('ArticleRow featured cards', () => {
  it('spans two columns for a hero entry only, and the grid packs densely', () => {
    expect(LIST_GRID).toContain('lg:grid-flow-dense');
    const { container, unmount } = renderRow(make(HERO_ID));
    expect(container.querySelector('li')!.className).toContain('lg:col-span-2');
    unmount();
    const thumb = renderRow(make(THUMB_ID));
    expect(thumb.container.querySelector('li')!.className).not.toContain('lg:col-span-2');
  });

  it('shows the summary as clamped plain text, hidden below lg', () => {
    renderRow(make(THUMB_ID, { summary: '  A <b>plain</b>\n  summary. ' }));
    const p = screen.getByTestId('entry-summary');
    expect(p.textContent).toBe('A <b>plain</b> summary.');
    expect(p.querySelector('b')).toBeNull();
    expect(p.className).toContain('hidden');
    expect(p.className).toContain('lg:line-clamp-3');
  });

  it('clamps a featured summary to four lines and omits an empty summary', () => {
    const { unmount } = renderRow(make(HERO_ID, { summary: 'Text' }));
    expect(screen.getByTestId('entry-summary').className).toContain('lg:line-clamp-4');
    unmount();
    renderRow(make(HERO_ID, { summary: '   ' }));
    expect(screen.queryByTestId('entry-summary')).toBeNull();
  });

  it('shows summaries on text-only cards too', () => {
    renderRow(make(THUMB_ID, { imageUrl: null, summary: 'Words' }));
    expect(screen.getByTestId('entry-summary')).toHaveTextContent('Words');
  });
});
