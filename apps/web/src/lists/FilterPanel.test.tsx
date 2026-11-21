import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntrySummary, Subscription } from '@tidings/shared';
import { App } from '../App';
import { reportReachable } from '../lib/connectivity';
import { SESSION_KEY } from '../lib/session';
import { installFakeApi, type FakeApi } from '../test-api';
import { installMatchMedia } from '../test-utils';

// TID-074: the filter panel (Unread only, Recommended order, Refresh) opened from the header's
// Filters button. Through the whole app against a fake API.

const NOW = Date.parse('2026-11-17T12:00:00Z');
const entry = (id: number, over: Partial<EntrySummary> = {}): EntrySummary => ({
  id: String(id),
  subscriptionId: 's1',
  feedTitle: 'Feed',
  title: `Title ${id}`,
  author: null,
  url: `https://example.com/${id}`,
  summary: null,
  imageUrl: null,
  publishedAt: new Date(NOW - id * 3_600_000).toISOString(),
  isRead: false,
  isStarred: false,
  ...over,
});
const page = (items: EntrySummary[]) => ({
  body: { items, nextCursor: null, asOf: new Date(NOW).toISOString() },
});
const sub: Subscription = {
  id: 's1',
  folderId: null,
  title: 'Feed',
  customTitle: null,
  feedUrl: 'https://s1.example.com/rss',
  siteUrl: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  health: {
    state: 'ok',
    lastSuccessAt: '2026-11-17T11:00:00.000Z',
    lastAttemptAt: '2026-11-17T11:00:00.000Z',
    errorCode: null,
    errorMessage: null,
    nextFetchAt: '2026-11-17T13:00:00.000Z',
    warning: null,
  },
};
const UNREAD = 'GET /api/entries?view=all&state=unread&limit=50';
const ALL = 'GET /api/entries?view=all&state=all&limit=50';
const RECOMMENDED = `${UNREAD}&sort=recommended`;

let api: FakeApi;

function Where() {
  const l = useLocation();
  return (
    <output data-testid="loc">{`${l.key}|${l.pathname}${l.search}|${String(l.state)}`}</output>
  );
}

function renderApp(settings: Record<string, unknown> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(SESSION_KEY, {
    user: { id: 'u1', displayName: 'M', role: 'owner', settings },
    setupRequired: false,
    mustAddPasskey: false,
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/all']}>
        <App />
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const filtersButton = () => screen.getByRole('button', { name: 'Filters' });
const dialog = () => screen.queryByRole('dialog', { name: 'Filters' });
const open = async () => {
  await userEvent.click(filtersButton());
  return within(await screen.findByRole('dialog', { name: 'Filters' }));
};
const gone = () => waitFor(() => expect(dialog()).not.toBeInTheDocument(), { timeout: 1000 });
const fire = (type: string, x: number, target: EventTarget) =>
  act(() => {
    target.dispatchEvent(
      new PointerEvent(type, {
        clientX: x + 40,
        clientY: 300,
        pointerId: 1,
        pointerType: 'touch',
        isPrimary: true,
        bubbles: true,
      }),
    );
  });

beforeEach(() => {
  vi.useRealTimers();
  localStorage.clear();
  installMatchMedia();
  api = installFakeApi();
  api.set('GET /api/folders', { body: { items: [] } });
  api.set('GET /api/subscriptions', { body: { items: [] } });
  api.set('GET /api/counts', { body: { total: 2, folders: {}, subscriptions: {} } });
  api.set(UNREAD, page([entry(1), entry(2)]));
  api.set(ALL, page([entry(1), entry(2), entry(3, { isRead: true })]));
  api.set('PATCH /api/me', (body) => ({ body: { id: 'u1', ...(body as object) } }));
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  reportReachable(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('opening', () => {
  it('opens a modal "Filters" panel from the header button, moves focus in, and makes the page inert', async () => {
    renderApp();
    await screen.findByText('Title 1');
    expect(dialog()).not.toBeInTheDocument();
    expect(filtersButton()).toHaveAttribute('aria-expanded', 'false');
    expect(filtersButton().closest('header')).not.toBeNull();
    expect(filtersButton()).toHaveClass('size-11');

    await open();
    const panel = screen.getByRole('dialog', { name: 'Filters' });
    expect(panel).toHaveAttribute('aria-modal', 'true');
    expect(within(panel).getByRole('heading', { name: 'Filters' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close filters' })).toHaveFocus();
    expect(filtersButton()).toHaveAttribute('aria-expanded', 'true');
    expect(document.documentElement).toHaveClass('scroll-locked');
    expect(document.getElementById('main')?.closest('[inert]')).not.toBeNull();
    // Its own content is not inert, and it slides in from the right, from CSS (no style attribute).
    expect(panel.closest('[inert]')).toBeNull();
    expect(panel).toHaveClass('filter-panel', 'right-0');
  });

  it('pushes no history entry and changes no route', async () => {
    renderApp();
    await screen.findByText('Title 1');
    const before = screen.getByTestId('loc').textContent;
    await open();
    expect(screen.getByTestId('loc').textContent).toBe(before);
  });
});

describe('closing: every way slides out, and focus returns to the button', () => {
  it.each([
    ['Escape', async () => userEvent.keyboard('{Escape}')],
    ['the scrim', async () => userEvent.click(screen.getByTestId('filter-scrim'))],
    [
      'the close button',
      async () => userEvent.click(screen.getByRole('button', { name: 'Close filters' })),
    ],
  ])('%s', async (_name, close) => {
    renderApp();
    await screen.findByText('Title 1');
    await open();
    await close();
    // Still there for the slide-out, but out of the accessibility tree and tab order.
    const leaving = document.querySelector('.filter-panel')?.closest('[aria-hidden="true"]');
    expect(leaving).not.toBeNull();
    expect(leaving).toHaveAttribute('inert');
    await gone();
    await waitFor(() => expect(filtersButton()).toHaveFocus());
    expect(document.documentElement).not.toHaveClass('scroll-locked');
    expect(document.getElementById('main')?.closest('[inert]')).toBeNull();
    expect(filtersButton()).toHaveAttribute('aria-expanded', 'false');
  });

  it('a swipe right on the panel follows the finger, parks it off screen, then closes', async () => {
    renderApp();
    await screen.findByText('Title 1');
    await open();
    const panel = screen.getByRole('dialog', { name: 'Filters' });
    fire('pointerdown', 100, panel);
    fire('pointermove', 110, panel);
    fire('pointermove', 200, panel);
    expect(panel.style.transform).toMatch(/^translateX\(/);
    fire('pointermove', 300, panel);
    fire('pointerup', 300, panel);
    expect(panel.style.transform).toBe('translateX(100%)');
    expect(screen.getByTestId('filter-scrim').style.opacity).toBe('0');
    await gone();
  });

  it('a short swipe springs back and stays open', async () => {
    renderApp();
    await screen.findByText('Title 1');
    await open();
    const panel = screen.getByRole('dialog', { name: 'Filters' });
    fire('pointerdown', 100, panel);
    fire('pointermove', 110, panel);
    fire('pointermove', 125, panel);
    fire('pointerup', 125, panel);
    await waitFor(() => expect(panel.style.transform).toBe(''), { timeout: 1000 });
    expect(dialog()).toBeInTheDocument();
  });

  it('reopening during the slide-out brings the same panel back in and keeps it open', async () => {
    renderApp();
    await screen.findByText('Title 1');
    await open();
    await userEvent.keyboard('{Escape}');
    // Still sliding out (it has left the accessibility tree), and the button is tapped again.
    expect(dialog()).not.toBeInTheDocument();
    await userEvent.click(filtersButton());
    const panel = await screen.findByRole('dialog', { name: 'Filters' });
    await new Promise((r) => setTimeout(r, 400));
    expect(panel).toBeInTheDocument();
    expect(panel.style.transform).toBe('');
    expect(screen.getByRole('dialog', { name: 'Filters' })).toBe(panel);
    expect(panel.closest('[inert]')).toBeNull();
  });

  it('with reduced motion it just goes, with no slide', async () => {
    installMatchMedia({ 'prefers-reduced-motion': true });
    renderApp();
    await screen.findByText('Title 1');
    await open();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(dialog()).not.toBeInTheDocument(), { timeout: 100 });
  });

  it('Tab and Shift+Tab stay inside the panel', async () => {
    renderApp();
    await screen.findByText('Title 1');
    const panel = await open();
    const refresh = panel.getByRole('button', { name: 'Refresh' });
    refresh.focus();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Close filters' })).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(refresh).toHaveFocus();
  });
});

describe('the settings apply immediately', () => {
  it('Unread only switches the list between unread and all, with the panel still open', async () => {
    renderApp();
    await screen.findByText('Title 1');
    const panel = await open();
    const unread = panel.getByRole('switch', { name: 'Unread only' });
    expect(unread).toBeChecked();
    expect(screen.queryByText('Title 3')).not.toBeInTheDocument();
    await userEvent.click(unread);
    expect(await screen.findByText('Title 3')).toBeInTheDocument();
    expect(unread).not.toBeChecked();
    expect(dialog()).toBeInTheDocument();
    // Recommended only makes sense for unread lists.
    expect(panel.queryByRole('switch', { name: 'Recommended order' })).not.toBeInTheDocument();
    await userEvent.click(unread);
    await waitFor(() => expect(screen.queryByText('Title 3')).not.toBeInTheDocument());
    expect(panel.getByRole('switch', { name: 'Recommended order' })).toBeInTheDocument();
  });

  it('Recommended order saves the setting and loads the recommended list', async () => {
    api.set(RECOMMENDED, {
      body: { ...page([entry(2), entry(1)]).body, sort: 'recommended' },
    });
    renderApp();
    await screen.findByText('Title 1');
    const panel = await open();
    const rec = panel.getByRole('switch', { name: 'Recommended order' });
    expect(rec).not.toBeChecked();
    await userEvent.click(rec);
    await waitFor(() => expect(rec).toBeChecked());
    expect(api.calls.find((c) => c.path === '/api/me')?.body).toEqual({
      settings: { listSort: 'recommended' },
    });
    await waitFor(() => {
      const titles = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
      expect(titles.slice(0, 2)).toEqual(['Title 2', 'Title 1']);
    });
    await userEvent.click(rec);
    await waitFor(() => expect(rec).not.toBeChecked());
    expect(api.calls.filter((c) => c.path === '/api/me').at(-1)?.body).toEqual({
      settings: { listSort: 'newest' },
    });
  });

  it('Refresh refetches the list and counts, never a feed, and leaves the panel open', async () => {
    renderApp();
    await screen.findByText('Title 1');
    await waitFor(() => expect(api.calls.some((c) => c.path === '/api/counts')).toBe(true));
    const before = api.calls.length;
    api.set(UNREAD, page([entry(1), entry(2), entry(9)]));
    const panel = await open();
    await userEvent.click(panel.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Title 9')).toBeInTheDocument();
    expect(
      api.calls
        .slice(before)
        .map((c) => `${c.method} ${c.path}`)
        .sort(),
    ).toEqual(['GET /api/counts', 'GET /api/entries?view=all&state=unread&limit=50']);
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
    expect(dialog()).toBeInTheDocument();
  });
});

describe('the filter dot', () => {
  it('shows only while the list is not in the state this person starts lists in', async () => {
    renderApp();
    await screen.findByText('Title 1');
    expect(screen.queryByTestId('filter-dot')).not.toBeInTheDocument();
    const panel = await open();
    await userEvent.click(panel.getByRole('switch', { name: 'Unread only' }));
    expect(await screen.findByTestId('filter-dot')).toBeInTheDocument();
  });
});

describe('the header on an empty list', () => {
  it('keeps the Filters button (to turn Unread only off) and hides the tick', async () => {
    api.set(UNREAD, page([]));
    api.set('GET /api/subscriptions', { body: { items: [sub] } });
    renderApp();
    await screen.findByText('All caught up');
    expect(filtersButton()).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark all as read' })).not.toBeInTheDocument();
  });
});
