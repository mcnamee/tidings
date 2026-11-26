import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntrySummary } from '@tidings/shared';
import { App } from '../App';
import { SESSION_KEY } from '../lib/session';
import { SIDEBAR_HIDDEN_KEY, readSidebarHidden, saveSidebarHidden } from '../lib/sidebar';
import { installFakeApi } from '../test-api';
import { installMatchMedia } from '../test-utils';

// TID-062: the collapsible desktop sidebar and the card grid.

const entry = (id: number, imageUrl: string | null): EntrySummary => ({
  id: String(id),
  subscriptionId: 's1',
  feedTitle: 'Feed',
  title: `Title ${id}`,
  author: null,
  url: `https://example.com/${id}`,
  summary: null,
  imageUrl,
  publishedAt: '2026-11-17T10:00:00.000Z',
  isRead: false,
  isStarred: false,
  topics: [],
});

function renderApp(path = '/all') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(SESSION_KEY, {
    user: { id: 'u1', displayName: 'Matt', role: 'owner', settings: {} },
    setupRequired: false,
    mustAddPasskey: false,
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  const api = installFakeApi();
  api.set('GET /api/folders', { body: { items: [] } });
  api.set('GET /api/subscriptions', { body: { items: [] } });
  api.set('GET /api/counts', { body: { total: 0, folders: {}, subscriptions: {} } });
  api.set('GET /api/entries?view=all&state=unread&limit=50', {
    body: {
      items: [entry(1, 'https://img.example.com/a.jpg'), entry(2, null)],
      nextCursor: null,
      asOf: '2026-11-17T12:00:00.000Z',
    },
  });
});
afterEach(() => vi.restoreAllMocks());

describe('sidebar storage', () => {
  it('round-trips and survives blocked storage', () => {
    expect(readSidebarHidden()).toBe(false);
    saveSidebarHidden(true);
    expect(localStorage.getItem(SIDEBAR_HIDDEN_KEY)).toBe('1');
    expect(readSidebarHidden()).toBe(true);
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readSidebarHidden(blocked)).toBe(false);
    expect(() => saveSidebarHidden(true, blocked)).not.toThrow();
  });
});

describe('desktop sidebar toggle', () => {
  it('hides and shows the sidebar, with aria state, and remembers the choice', async () => {
    installMatchMedia({ 'min-width: 1024px': true });
    const user = userEvent.setup();
    const { unmount } = renderApp();
    const hide = await screen.findByRole('button', { name: 'Hide sidebar' });
    expect(hide).toHaveAttribute('aria-expanded', 'true');
    expect(hide).toHaveAttribute('aria-controls', 'sidebar');
    const aside = document.getElementById('sidebar')!;
    expect(aside).not.toHaveAttribute('inert');

    await user.click(hide);
    const show = screen.getByRole('button', { name: 'Show sidebar' });
    expect(show).toHaveAttribute('aria-expanded', 'false');
    expect(show).toHaveFocus();
    expect(aside).toHaveAttribute('inert');
    expect(localStorage.getItem(SIDEBAR_HIDDEN_KEY)).toBe('1');

    unmount();
    renderApp();
    expect(await screen.findByRole('button', { name: 'Show sidebar' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show sidebar' }));
    expect(localStorage.getItem(SIDEBAR_HIDDEN_KEY)).toBe('0');
  });

  it('keeps the mobile drawer button on narrow screens', async () => {
    installMatchMedia();
    renderApp();
    const menu = await screen.findByRole('button', { name: 'Open navigation' });
    expect(menu).toHaveAttribute('aria-controls', 'nav-drawer');
    expect(document.getElementById('sidebar')).toBeNull();
  });
});

describe('article card grid', () => {
  it('uses 2 columns beside the sidebar, 3 from xl, and 3 when the sidebar is hidden', async () => {
    installMatchMedia({ 'min-width: 1024px': true });
    renderApp();
    const grid = await screen.findByTestId('article-grid');
    expect(grid.className).toContain('lg:grid-cols-2');
    expect(grid.className).toContain('xl:grid-cols-3');
    expect(grid.className).toContain('group-data-[sidebar=hidden]/shell:lg:grid-cols-3');
    expect(grid.closest('[data-sidebar]')).toHaveAttribute('data-sidebar', 'shown');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Hide sidebar' }));
    expect(grid.closest('[data-sidebar]')).toHaveAttribute('data-sidebar', 'hidden');
  });

  it('keeps data-entry-id on every card and gives text-only cards no image box', async () => {
    installMatchMedia({ 'min-width: 1024px': true });
    renderApp();
    const grid = await screen.findByTestId('article-grid');
    const cards = grid.querySelectorAll('li[data-entry-id]');
    expect([...cards].map((c) => c.getAttribute('data-entry-id'))).toEqual(['1', '2']);
    expect(cards[0]!.querySelector('img')).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(cards[1]!.querySelector('img')).toBeNull();
    expect(cards[1]).toHaveAttribute('data-layout', 'text');
  });
});
