import { fireEvent, render, screen } from '@testing-library/react';
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
  topics: [],
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

// TID-072: a small preview image is never stretched into a hero or card.
describe('ArticleRow small images', () => {
  const load = (img: HTMLElement, naturalWidth: number) => {
    Object.defineProperty(img, 'naturalWidth', { value: naturalWidth, configurable: true });
    fireEvent.load(img);
  };

  it('turns a hero row into a small thumbnail when the image loads under 300px', () => {
    const { container } = renderRow(make(HERO_ID, { imageUrl: 'https://img.example.com/h1.jpg' }));
    const li = container.querySelector('li')!;
    expect(li.dataset.layout).toBe('hero');
    load(container.querySelector('img')!, 100);
    expect(li.dataset.layout).toBe('small');
    expect(li.className).not.toContain('lg:col-span-2');
    const img = container.querySelector('img')!;
    expect(img.className).toContain('object-contain');
    expect(img.className).toContain('max-w-24');
    expect(img.className).not.toContain('w-full');
    expect(img.className).not.toContain('aspect-video');
    expect(container.querySelector('a')!.className).not.toContain('lg:flex-col');
    expect(container.querySelector('h2')!.className).not.toContain('lg:mt-3');
  });

  it('turns a thumbnail row into a small thumbnail so a desktop card does not stretch it', () => {
    const { container } = renderRow(make(THUMB_ID, { imageUrl: 'https://img.example.com/t1.jpg' }));
    expect(container.querySelector('img')!.className).toContain('lg:w-full');
    load(container.querySelector('img')!, 150);
    expect(container.querySelector('li')!.dataset.layout).toBe('small');
    expect(container.querySelector('img')!.className).not.toContain('lg:w-full');
  });

  it('keeps hero and thumbnail layouts for images at 300px or wider, or of unknown width', () => {
    const a = renderRow(make(HERO_ID, { imageUrl: 'https://img.example.com/h2.jpg' }));
    load(a.container.querySelector('img')!, 300);
    expect(a.container.querySelector('li')!.dataset.layout).toBe('hero');
    a.unmount();
    const b = renderRow(make(HERO_ID, { imageUrl: 'https://img.example.com/h3.jpg' }));
    load(b.container.querySelector('img')!, 0); // jsdom and some SVGs report 0: unknown
    expect(b.container.querySelector('li')!.dataset.layout).toBe('hero');
  });

  it('remembers a small image so a remounted row renders small at once', () => {
    const url = 'https://img.example.com/h4.jpg';
    const a = renderRow(make(HERO_ID, { imageUrl: url }));
    load(a.container.querySelector('img')!, 64);
    a.unmount();
    const b = renderRow(make(HERO_ID, { imageUrl: url }));
    expect(b.container.querySelector('li')!.dataset.layout).toBe('small');
  });

  it('still falls back to text-only when the image fails', () => {
    const { container } = renderRow(make(HERO_ID, { imageUrl: 'https://img.example.com/h5.jpg' }));
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('li')!.dataset.layout).toBe('text');
    expect(container.querySelector('img')).toBeNull();
  });
});
