import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Counts, EntrySummary, Subscription } from '@tidings/shared';
import { App } from '../App';
import { reportReachable } from '../lib/connectivity';
import { SESSION_KEY } from '../lib/session';
import { installFakeApi, type FakeApi } from '../test-api';
import { installMatchMedia } from '../test-utils';

// TID-018: the article lists, the feed tree and unread counts, through the whole app against a
// fake API (no real network). The server side is tested in apps/worker/test/entries-api.test.ts.

const NOW = Date.parse('2026-11-17T12:00:00Z');

function entry(id: number, over: Partial<EntrySummary> = {}): EntrySummary {
  return {
    id: String(id),
    subscriptionId: 's1',
    feedTitle: 'Daring Fireball',
    title: `Title ${id}`,
    author: null,
    url: `https://example.com/${id}`,
    summary: `Summary ${id}`,
    imageUrl: null,
    publishedAt: new Date(NOW - id * 3_600_000).toISOString(),
    isRead: false,
    isStarred: false,
    ...over,
  };
}

function sub(id: string, title: string, over: Partial<Subscription> = {}): Subscription {
  return {
    id,
    folderId: null,
    title,
    customTitle: null,
    feedUrl: `https://${id}.example.com/rss`,
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
    ...over,
  };
}

const page = (items: EntrySummary[], nextCursor: string | null = null) => ({
  body: { items, nextCursor, asOf: new Date(NOW).toISOString() },
});
const ENTRIES = (view: string, state: string, id?: string, cursor?: string) =>
  `GET /api/entries?view=${view}&state=${state}&limit=50${id ? `&id=${id}` : ''}${
    cursor ? `&cursor=${cursor}` : ''
  }`;
const COUNTS: Counts = { total: 0, folders: {}, subscriptions: {} };

let api: FakeApi;
let client: QueryClient;

function Probe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <div>
      <output data-testid="path">{location.pathname}</output>
      <button type="button" onClick={() => navigate(-1)}>
        system back
      </button>
      <button type="button" onClick={() => navigate('/manage')}>
        go manage
      </button>
    </div>
  );
}

function renderApp(path: string, settings: Record<string, unknown> = {}) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(SESSION_KEY, {
    user: { id: 'u1', displayName: 'Matt', role: 'owner', settings },
    setupRequired: false,
    mustAddPasskey: false,
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <App />
        <Probe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const entryCalls = () => api.calls.filter((c) => c.path.startsWith('/api/entries'));
const row = (title: string) => screen.getByRole('heading', { level: 2, name: title }).closest('li');

beforeEach(() => {
  vi.useRealTimers();
  localStorage.clear();
  installMatchMedia();
  api = installFakeApi();
  api.set('GET /api/folders', { body: { items: [{ id: 'f1', name: 'Tech' }] } });
  api.set('GET /api/subscriptions', {
    body: { items: [sub('s1', 'Daring Fireball', { folderId: 'f1' })] },
  });
  api.set('GET /api/counts', { body: COUNTS });
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  reportReachable(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('AC1: the list views', () => {
  it('/all, /folders/:id and /feeds/:id each ask for their own view and show every field', async () => {
    api.set(
      ENTRIES('all', 'unread'),
      page([
        entry(1, { imageUrl: 'https://img.example.com/a.jpg' }),
        entry(2, { summary: null, publishedAt: '2026-11-10T00:00:00.000Z' }),
      ]),
    );
    renderApp('/all');
    expect(await screen.findByText('Title 1')).toBeInTheDocument();
    const first = row('Title 1');
    expect(within(first!).getByText('Daring Fireball')).toBeInTheDocument();
    expect(within(first!).getByText('1h')).toBeInTheDocument();
    expect(within(first!).getByText('Summary 1')).toBeInTheDocument();
    expect(first!.querySelector('img')).toHaveAttribute('src', 'https://img.example.com/a.jpg');
    const second = row('Title 2')!;
    expect(second.querySelector('img')).toBeNull();
    expect(within(second).getByText('10 Nov')).toBeInTheDocument();
    expect(first!.compareDocumentPosition(second)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(entryCalls().map((c) => c.path)).toEqual([
      '/api/entries?view=all&state=unread&limit=50',
    ]);
  });

  it.each([
    ['/folders/f1', 'folder', 'f1'],
    ['/feeds/s1', 'feed', 's1'],
  ])('%s requests view=%s&id=%s', async (path, view, id) => {
    api.set(ENTRIES(view, 'unread', id), page([entry(7)]));
    renderApp(path);
    expect(await screen.findByText('Title 7')).toBeInTheDocument();
  });

  it('shows a skeleton bar, never the word Folder or Feed, while the name loads', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    api.set('GET /api/folders', async () => {
      await gate;
      return { body: { items: [{ id: 'f1', name: 'Tech' }] } };
    });
    api.set(ENTRIES('folder', 'unread', 'f1'), page([]));
    renderApp('/folders/f1');
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1).toHaveAttribute('aria-busy', 'true');
    expect(h1).toHaveAttribute('aria-label', 'Loading');
    expect(h1).not.toHaveTextContent(/folder|feed/i);
    expect(document.title).toBe('Folder - Tidings');
    release();
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Tech'),
    );
    expect(document.title).toBe('Tech - Tidings');
  });

  it('uses the custom title for a feed, and says "Page not found" for an unknown one', async () => {
    api.set('GET /api/subscriptions', {
      body: { items: [sub('s1', 'My name for it', { customTitle: 'My name for it' })] },
    });
    api.set(ENTRIES('feed', 'unread', 's1'), page([]));
    renderApp('/feeds/s1');
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('My name for it'),
    );
  });

  it('a feed the API says is not found shows Page not found in the header and the body', async () => {
    api.set(ENTRIES('feed', 'unread', 'nope'), {
      status: 404,
      body: { error: { code: 'not_found', message: 'Not found' } },
    });
    renderApp('/feeds/nope');
    expect(await screen.findByText("We couldn't find that page.")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Page not found'),
    );
  });
});

describe('AC2: unread only and the setting', () => {
  it('toggles between unread only and all articles', async () => {
    api.set(ENTRIES('all', 'unread'), page([entry(1)]));
    api.set(ENTRIES('all', 'all'), page([entry(1), entry(2, { isRead: true })]));
    renderApp('/all');
    await screen.findByText('Title 1');
    const toggle = screen.getByRole('button', { name: 'Unread only' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('Title 2')).not.toBeInTheDocument();

    await userEvent.click(toggle);
    expect(await screen.findByText('Title 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unread only' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Unread only' }));
    await waitFor(() => expect(screen.queryByText('Title 2')).not.toBeInTheDocument());
  });

  it('starts as All articles when the setting unreadOnly is false', async () => {
    api.set(ENTRIES('all', 'all'), page([entry(2, { isRead: true })]));
    renderApp('/all', { unreadOnly: false });
    expect(await screen.findByText('Title 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unread only' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('read rows look read and unread rows look unread', async () => {
    api.set(ENTRIES('all', 'all'), page([entry(1), entry(2, { isRead: true })]));
    renderApp('/all', { unreadOnly: false });
    await screen.findByText('Title 1');
    expect(screen.getByRole('heading', { name: 'Title 1' })).toHaveClass('font-semibold');
    expect(screen.getByRole('heading', { name: 'Title 2' })).toHaveClass('text-fg-muted');
    expect(within(row('Title 1')!).getByText('Unread.')).toBeInTheDocument();
    expect(within(row('Title 2')!).queryByText('Unread.')).not.toBeInTheDocument();
  });
});

describe('AC3: the next page loads at the end of the list', () => {
  it('loads page 2 with nextCursor when the sentinel scrolls into view, then stops', async () => {
    let onHit: (hits: Array<{ isIntersecting: boolean }>) => void = () => undefined;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: typeof onHit) {
          onHit = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
    api.set(ENTRIES('all', 'unread'), page([entry(1), entry(2)], 'CUR1'));
    api.set(ENTRIES('all', 'unread', undefined, 'CUR1'), page([entry(3)]));
    renderApp('/all');
    await screen.findByText('Title 2');
    expect(screen.queryByText('Title 3')).not.toBeInTheDocument();

    act(() => onHit([{ isIntersecting: true }]));
    expect(await screen.findByText('Title 3')).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Title 1',
      'Title 2',
      'Title 3',
    ]);
    expect(entryCalls()).toHaveLength(2);
  });
});

describe('AC6: the drawer', () => {
  function seedTree() {
    api.set('GET /api/folders', {
      body: {
        items: [
          { id: 'f2', name: 'News' },
          { id: 'f1', name: 'Tech' },
        ],
      },
    });
    api.set('GET /api/subscriptions', {
      body: {
        items: [
          sub('s1', 'Ars', { folderId: 'f1' }),
          sub('s2', 'Zed Feed', { folderId: 'f1' }),
          sub('s3', 'BBC', { folderId: 'f2' }),
          sub('s4', 'Loose Quiet'),
          sub('s5', 'Loose Busy'),
          sub('s6', 'Broken Blog', { health: { ...sub('x', 'x').health, state: 'failing' } }),
        ],
      },
    });
    api.set('GET /api/counts', {
      body: {
        total: 1500,
        folders: { f1: 34, f2: 0 },
        subscriptions: { s1: 30, s2: 4, s3: 0, s4: 0, s5: 1200, s6: 0 },
      },
    });
    api.set(ENTRIES('all', 'unread'), page([]));
  }

  it('lists All, folders A to Z, then loose feeds, with counts, and dims zero-count items', async () => {
    installMatchMedia({ 'min-width: 1024px': true });
    seedTree();
    renderApp('/all');
    const nav = screen.getByRole('navigation', { name: 'Feeds and folders' });
    const all = await within(nav).findByRole('link', { name: 'All articles 999+ unread' });
    expect(all).toHaveTextContent('999+');
    const tech = within(nav).getByRole('link', { name: 'Tech 34 unread' });
    expect(tech).toHaveTextContent('34');
    // DEF-051: no aria-label; the name is the visible text plus a hidden "unread" (WCAG 2.5.3).
    for (const link of [all, tech]) expect(link).not.toHaveAttribute('aria-label');
    const news = within(nav).getByRole('link', { name: 'News' }); // zero: no count, dimmed
    expect(news).toHaveTextContent(/^News$/);
    expect(news).toHaveClass('text-fg-muted');
    expect(tech).not.toHaveClass('text-fg-muted');

    const names = within(nav)
      .getAllByRole('link')
      .map((l) => l.getAttribute('aria-label') ?? l.textContent);
    // Folders are collapsed by default; loose feeds follow, A to Z.
    expect(names.slice(0, 5)).toEqual([
      'All articles 999+ unread',
      'News',
      'Tech 34 unread',
      'Broken Blog',
      'Loose Busy 999+ unread',
    ]);
    expect(within(nav).getByRole('link', { name: 'Loose Quiet' })).toHaveClass('text-fg-muted');
    expect(within(nav).getByRole('img', { name: 'This feed has problems' })).toBeInTheDocument();
  });

  it('expands a folder with its chevron, remembers it, and opens the folder holding the current feed', async () => {
    installMatchMedia({ 'min-width: 1024px': true });
    seedTree();
    api.set(ENTRIES('feed', 'unread', 's3'), page([]));
    renderApp('/feeds/s3');
    const nav = screen.getByRole('navigation', { name: 'Feeds and folders' });
    // The folder that holds the current feed is open, its feed is the current page.
    const bbc = await within(nav).findByRole('link', { name: 'BBC' });
    expect(bbc).toHaveAttribute('aria-current', 'page');
    expect(within(nav).queryByRole('link', { name: /^Ars/ })).not.toBeInTheDocument();

    await userEvent.click(within(nav).getByRole('button', { name: 'Expand Tech' }));
    expect(within(nav).getByRole('link', { name: 'Ars 30 unread' })).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: 'Collapse Tech' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(JSON.parse(localStorage.getItem('tidings.navOpen') ?? '[]')).toEqual(['f1']);
  });

  it('hides zero-count feeds in unread-only mode when "Hide read feeds" is on', async () => {
    installMatchMedia({ 'min-width: 1024px': true });
    seedTree();
    renderApp('/all', { hideReadFeeds: true });
    const nav = screen.getByRole('navigation', { name: 'Feeds and folders' });
    await within(nav).findByRole('link', { name: 'Tech 34 unread' });
    expect(within(nav).queryByRole('link', { name: 'News' })).not.toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Loose Quiet' })).not.toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Loose Busy 999+ unread' })).toBeInTheDocument();
  });

  it('shows a skeleton while loading and an error with Try again when it cannot load', async () => {
    installMatchMedia({ 'min-width: 1024px': true });
    api.set('GET /api/folders', {
      status: 500,
      body: { error: { code: 'internal', message: 'x' } },
    });
    api.set(ENTRIES('all', 'unread'), page([]));
    renderApp('/all');
    const nav = screen.getByRole('navigation', { name: 'Feeds and folders' });
    expect(within(nav).getByTestId('tree-skeleton')).toHaveAttribute('aria-busy', 'true');
    expect(await within(nav).findByText("Couldn't load your feeds.")).toBeInTheDocument();
    api.set('GET /api/folders', { body: { items: [] } });
    api.set('GET /api/subscriptions', { body: { items: [] } });
    await userEvent.click(within(nav).getByRole('button', { name: 'Try again' }));
    expect(await within(nav).findByText('No feeds yet')).toBeInTheDocument();
  });
});

describe('AC7: empty states', () => {
  it('no subscriptions', async () => {
    api.set('GET /api/subscriptions', { body: { items: [] } });
    api.set(ENTRIES('all', 'unread'), page([]));
    renderApp('/all');
    const main = screen.getByRole('main');
    expect(await within(main).findByText('No feeds yet')).toBeInTheDocument();
    expect(within(main).getByRole('link', { name: 'Add a feed' })).toHaveAttribute(
      'href',
      '/manage/add',
    );
  });

  it('nothing unread: "All caught up", and Show all articles switches to All', async () => {
    api.set(ENTRIES('all', 'unread'), page([]));
    api.set(ENTRIES('all', 'all'), page([entry(5, { isRead: true })]));
    renderApp('/all');
    expect(await screen.findByText('All caught up')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show all articles' }));
    expect(await screen.findByText('Title 5')).toBeInTheDocument();
  });

  it('a feed that was never fetched', async () => {
    api.set('GET /api/subscriptions', {
      body: {
        items: [
          sub('s1', 'New Feed', {
            health: { ...sub('x', 'x').health, state: 'pending', lastSuccessAt: null },
          }),
        ],
      },
    });
    api.set(ENTRIES('feed', 'unread', 's1'), page([]));
    renderApp('/feeds/s1');
    expect(await screen.findByText('Waiting for the first fetch')).toBeInTheDocument();
  });

  it('a failing feed names the problem and links to Manage', async () => {
    api.set('GET /api/subscriptions', {
      body: {
        items: [
          sub('s1', 'Bad Feed', {
            health: {
              ...sub('x', 'x').health,
              state: 'failing',
              errorMessage: 'The site did not answer.',
            },
          }),
        ],
      },
    });
    api.set(ENTRIES('feed', 'unread', 's1'), page([]));
    renderApp('/feeds/s1');
    expect(await screen.findByText('This feed has problems')).toBeInTheDocument();
    expect(screen.getByText('The site did not answer.')).toBeInTheDocument();
    expect(
      within(screen.getByRole('main')).getByRole('link', { name: 'Manage feeds' }),
    ).toHaveAttribute('href', '/manage');
  });

  it('a server error shows Try again in place of the list', async () => {
    api.set(ENTRIES('all', 'unread'), {
      status: 500,
      body: { error: { code: 'internal', message: 'x' } },
    });
    renderApp('/all');
    expect(await screen.findByText('Something went wrong on our side.')).toBeInTheDocument();
    api.set(ENTRIES('all', 'unread'), page([entry(1)]));
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Title 1')).toBeInTheDocument();
  });
});

describe('AC9: pull to refresh', () => {
  it('refetches the list and the counts, and never fetches a feed', async () => {
    api.set(ENTRIES('all', 'unread'), page([entry(1)]));
    renderApp('/all');
    await screen.findByText('Title 1');
    await waitFor(() => expect(api.calls.some((c) => c.path === '/api/counts')).toBe(true));
    const before = api.calls.length;
    api.set(ENTRIES('all', 'unread'), page([entry(1), entry(9)]));

    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
    fireEvent.touchStart(window, { touches: [{ clientY: 100 }] });
    fireEvent.touchMove(window, { touches: [{ clientY: 300 }] });
    expect(await screen.findByText('Release to refresh')).toBeInTheDocument();
    fireEvent.touchEnd(window);

    expect(await screen.findByText('Title 9')).toBeInTheDocument();
    const added = api.calls.slice(before);
    expect(added.map((c) => `${c.method} ${c.path}`).sort()).toEqual([
      'GET /api/counts',
      'GET /api/entries?view=all&state=unread&limit=50',
    ]);
    expect(api.calls.some((c) => c.path.includes('/refresh') || c.method === 'POST')).toBe(false);
  });

  it('a short pull does nothing', async () => {
    api.set(ENTRIES('all', 'unread'), page([entry(1)]));
    renderApp('/all');
    await screen.findByText('Title 1');
    const before = entryCalls().length;
    fireEvent.touchStart(window, { touches: [{ clientY: 100 }] });
    fireEvent.touchMove(window, { touches: [{ clientY: 140 }] });
    fireEvent.touchEnd(window);
    expect(entryCalls()).toHaveLength(before);
  });

  it('the Refresh button does the same for non-touch users', async () => {
    api.set(ENTRIES('all', 'unread'), page([entry(1)]));
    renderApp('/all');
    await screen.findByText('Title 1');
    api.set(ENTRIES('all', 'unread'), page([entry(1), entry(8)]));
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Title 8')).toBeInTheDocument();
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
  });
});

describe('TID-063: rubber band at the end and room past the last article', () => {
  const stretched = () =>
    (screen.getByTestId('article-grid').parentElement as HTMLElement).style.transform;

  it('pushing up at the end of the page stretches the content up with resistance, then springs back', async () => {
    api.set(ENTRIES('all', 'unread'), page([entry(1)]));
    renderApp('/all');
    await screen.findByText('Title 1');
    // jsdom has no layout, so the page counts as scrolled to its end.
    fireEvent.touchStart(window, { touches: [{ clientY: 400, clientX: 100 }] });
    fireEvent.touchMove(window, { touches: [{ clientY: 380, clientX: 100 }] });
    fireEvent.touchMove(window, { touches: [{ clientY: 300, clientX: 100 }] });
    // The push began at 400: 100px of finger is 50px of content.
    expect(stretched()).toBe('translateY(-50px)');
    expect(screen.queryByText('Pull to refresh')).not.toBeInTheDocument();
    fireEvent.touchEnd(window);
    expect(screen.getByTestId('article-grid').parentElement?.style.transition).toContain(
      'var(--ease-ios)',
    );
    await waitFor(() => expect(stretched()).toBe(''));
  });

  it('does not stretch for a sideways swipe', async () => {
    api.set(ENTRIES('all', 'unread'), page([entry(1)]));
    renderApp('/all');
    await screen.findByText('Title 1');
    fireEvent.touchStart(window, { touches: [{ clientY: 400, clientX: 300 }] });
    fireEvent.touchMove(window, { touches: [{ clientY: 380, clientX: 100 }] });
    fireEvent.touchMove(window, { touches: [{ clientY: 300, clientX: 100 }] });
    expect(stretched()).toBe('');
  });

  it('does not stretch with reduced motion', async () => {
    installMatchMedia({ 'prefers-reduced-motion': true });
    api.set(ENTRIES('all', 'unread'), page([entry(1)]));
    renderApp('/all');
    await screen.findByText('Title 1');
    fireEvent.touchStart(window, { touches: [{ clientY: 400, clientX: 100 }] });
    fireEvent.touchMove(window, { touches: [{ clientY: 380, clientX: 100 }] });
    fireEvent.touchMove(window, { touches: [{ clientY: 300, clientX: 100 }] });
    expect(stretched()).toBe('');
  });

  it('does not stretch while the page can still scroll down', async () => {
    api.set(ENTRIES('all', 'unread'), page([entry(1)]));
    renderApp('/all');
    await screen.findByText('Title 1');
    vi.spyOn(document.documentElement, 'scrollHeight', 'get').mockReturnValue(5000);
    fireEvent.touchStart(window, { touches: [{ clientY: 400, clientX: 100 }] });
    fireEvent.touchMove(window, { touches: [{ clientY: 380, clientX: 100 }] });
    fireEvent.touchMove(window, { touches: [{ clientY: 300, clientX: 100 }] });
    expect(stretched()).toBe('');
  });

  it('adds end space once no more pages can load: "End of list" while unread rows remain', async () => {
    api.set(ENTRIES('all', 'unread'), page([entry(1), entry(2, { isRead: true })]));
    renderApp('/all');
    await screen.findByText('Title 1');
    const end = screen.getByTestId('list-end');
    expect(end).toHaveTextContent('End of list');
    expect(end.className).toContain('100dvh');
  });

  it('says "You\'re all caught up" when every row above is read', async () => {
    api.set(ENTRIES('all', 'all'), page([entry(1, { isRead: true }), entry(2, { isRead: true })]));
    renderApp('/all', { unreadOnly: false });
    await screen.findByText('Title 1');
    expect(screen.getByTestId('list-end')).toHaveTextContent("You're all caught up");
  });

  it('has no end space while another page can load, or on an empty list', async () => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    api.set(ENTRIES('all', 'unread'), page([entry(1)], 'CUR1'));
    renderApp('/all');
    await screen.findByText('Title 1');
    expect(screen.queryByTestId('list-end')).not.toBeInTheDocument();
  });

  it('has no end space on an empty list', async () => {
    api.set(ENTRIES('all', 'unread'), page([]));
    renderApp('/all');
    await screen.findByText('All caught up');
    expect(screen.queryByTestId('list-end')).not.toBeInTheDocument();
  });
});

describe('AC12: the offline banner follows failed requests', () => {
  it('appears when a request gets no response while online, and goes when one succeeds', async () => {
    expect(navigator.onLine).toBe(true);
    api.set(ENTRIES('all', 'unread'), page([entry(1)]));
    renderApp('/all');
    await screen.findByText('Title 1');
    expect(screen.queryByText(/You're offline/)).not.toBeInTheDocument();

    const ok = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(
      await screen.findByText(/You're offline/, undefined, { timeout: 1000 }),
    ).toBeInTheDocument();

    vi.stubGlobal('fetch', ok);
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.queryByText(/You're offline/)).not.toBeInTheDocument());
  });

  it('goes away on the online event', async () => {
    api.set(ENTRIES('all', 'unread'), page([entry(1)]));
    renderApp('/all');
    await screen.findByText('Title 1');
    act(() => reportReachable(false));
    expect(screen.getByText(/You're offline/)).toBeInTheDocument();
    act(() => void window.dispatchEvent(new Event('online')));
    expect(screen.queryByText(/You're offline/)).not.toBeInTheDocument();
  });

  it('an error response (the server answered) is not an outage', async () => {
    api.set(ENTRIES('all', 'unread'), {
      status: 500,
      body: { error: { code: 'internal', message: 'x' } },
    });
    renderApp('/all');
    await screen.findByText('Something went wrong on our side.');
    expect(screen.queryByText(/You're offline/)).not.toBeInTheDocument();
  });
});

describe('AC13: a row read in unread-only mode stays until the list is left and re-entered', () => {
  it('stays, shown as read, after Back from the article; goes after leaving and returning', async () => {
    api.set(ENTRIES('all', 'unread'), page([entry(1), entry(2)]));
    renderApp('/all');
    await screen.findByText('Title 1');

    await userEvent.click(screen.getByRole('link', { name: /Title 1/ }));
    expect(screen.getByTestId('path')).toHaveTextContent('/all/a/1');
    // What the article screen's optimistic update does (TID-019): mark the cached row read.
    act(() => {
      client.setQueryData<{ pages: Array<{ items: EntrySummary[] }>; pageParams: unknown[] }>(
        ['entries', 'all', null, 'unread'],
        (d) =>
          d && {
            ...d,
            pages: d.pages.map((p) => ({
              ...p,
              items: p.items.map((i) => (i.id === '1' ? { ...i, isRead: true } : i)),
            })),
          },
      );
    });
    // The server now (correctly) leaves the read article out.
    api.set(ENTRIES('all', 'unread'), page([entry(2)]));
    const before = entryCalls().length;

    await userEvent.click(screen.getByRole('button', { name: 'system back' }));
    expect(screen.getByTestId('path')).toHaveTextContent(/^\/all$/);
    const kept = screen.getByRole('heading', { level: 2, name: 'Title 1' });
    expect(kept).toHaveClass('text-fg-muted');
    expect(screen.getByRole('heading', { level: 2, name: 'Title 2' })).toBeInTheDocument();
    expect(entryCalls()).toHaveLength(before); // nothing was refetched under the thumb

    // Leave the list, come back by the drawer link (not Back): the read row is gone.
    await userEvent.click(screen.getByRole('button', { name: 'go manage' }));
    await userEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('link', { name: 'All articles' }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('heading', { level: 2, name: 'Title 1' })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Title 2' })).toBeInTheDocument();
  });
});

describe('AC14: feed text is text', () => {
  it('shows markup in a title and summary as literal characters and creates no elements from it', async () => {
    const title = 'Vec<T> & <b>x</b>';
    const summary = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    const alertSpy = vi.fn();
    vi.stubGlobal('alert', alertSpy);
    api.set(ENTRIES('all', 'unread'), page([entry(1, { title, summary })]));
    renderApp('/all');
    const heading = await screen.findByRole('heading', { level: 2 });
    expect(heading.textContent).toBe(title);
    expect(heading.querySelector('b')).toBeNull();
    const item = heading.closest('li')!;
    expect(item).toHaveTextContent(summary);
    expect(item.querySelector('script, img')).toBeNull();
    expect(document.querySelector('main img')).toBeNull();
    expect(alertSpy).not.toHaveBeenCalled();
  });
});
