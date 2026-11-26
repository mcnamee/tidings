import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Counts, EntrySummary, Subscription } from '@tidings/shared';
import { App } from '../App';
import { reportReachable } from '../lib/connectivity';
import { SESSION_KEY } from '../lib/session';
import { toast, toastStore } from '../lib/toast';
import { installFakeApi, type FakeApi } from '../test-api';
import { installMatchMedia } from '../test-utils';

// TID-020: mark all as read from the list header (the tick button, TID-074; it was the bottom bar), through the whole app against a fake API.
// The server side is tested in apps/worker/test/mark-all-read.test.ts.

const NOW = Date.parse('2026-11-17T12:00:00Z');
const AS_OF = new Date(NOW).toISOString();

function entry(id: number, over: Partial<EntrySummary> = {}): EntrySummary {
  return {
    id: String(id),
    subscriptionId: 's1',
    feedTitle: 'Daring Fireball',
    title: `Title ${id}`,
    author: null,
    url: `https://example.com/${id}`,
    summary: null,
    imageUrl: null,
    publishedAt: new Date(NOW - id * 3_600_000).toISOString(),
    isRead: false,
    isStarred: false,
    topics: [],
    ...over,
  };
}

const sub: Subscription = {
  id: 's1',
  folderId: 'f1',
  title: 'Daring Fireball',
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

const page = (items: EntrySummary[]) => ({
  body: { items, nextCursor: null, asOf: AS_OF },
});
const counts = (total: number): { body: Counts } => ({
  body: { total, folders: { f1: total }, subscriptions: { s1: total } },
});
const ENTRIES = (view: string, id?: string) =>
  `GET /api/entries?view=${view}&state=unread&limit=50${id ? `&id=${id}` : ''}`;
const MARK = 'POST /api/entries/mark-all-read';
const UNDO = 'POST /api/entries/read-state';

let api: FakeApi;
let client: QueryClient;

function renderApp(path: string) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

const posts = (key: string) =>
  api.calls.filter((c) => `${c.method} ${c.path}` === key).map((c) => c.body);
const markAllButton = () => screen.getByRole('button', { name: 'Mark all as read' });

beforeEach(() => {
  vi.useRealTimers();
  localStorage.clear();
  installMatchMedia();
  api = installFakeApi();
  api.set('GET /api/folders', { body: { items: [{ id: 'f1', name: 'Tech' }] } });
  api.set('GET /api/subscriptions', { body: { items: [sub] } });
  api.set('GET /api/counts', counts(3));
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  reportReachable(true);
});
afterEach(() => {
  toast.dismiss();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('TID-074: the tick button', () => {
  it('is an icon button in the header with a 44px target, and the list has no bottom bar', async () => {
    api.set(ENTRIES('all'), page([entry(1)]));
    renderApp('/all');
    await screen.findByText('Title 1');
    const tick = markAllButton();
    expect(tick.closest('header')).not.toBeNull();
    expect(tick).toHaveClass('size-11');
    expect(tick).toBeEnabled();
    expect(document.getElementById('bottom-bar')).toBeEmptyDOMElement();
    expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument();
  });

  it('is disabled when nothing is left to mark', async () => {
    api.set(ENTRIES('all'), page([entry(1, { isRead: true })]));
    api.set('GET /api/counts', counts(0));
    renderApp('/all');
    await screen.findByText('Title 1');
    expect(markAllButton()).toBeDisabled();
  });
});

describe('AC1, AC3, AC4: 20 or fewer entries', () => {
  it('marks at once with no dialog, sends the list’s asOf, shows the rows read, and offers Undo for 5 s', async () => {
    api.set(ENTRIES('all'), page([entry(1), entry(2), entry(3)]));
    api.set(MARK, { body: { updated: 3, entryIds: ['1', '2', '3'] } });
    renderApp('/all');
    await screen.findByText('Title 1');

    // The server's answer to the refetch after the change: nothing unread is left.
    api.set(ENTRIES('all'), page([]));
    api.set('GET /api/counts', counts(0));
    await userEvent.click(markAllButton());

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(posts(MARK)).toEqual([{ view: 'all', before: AS_OF }]);
    // TID-066: marking read is not an engagement signal.
    expect(api.calls.filter((c) => c.path.includes('/engagement'))).toEqual([]);
    const toastCard = await screen.findByText('Marked 3 as read');
    expect(within(toastCard.closest('div')!.parentElement!).getByText('Undo')).toBeInTheDocument();
    await screen.findByText('All caught up');
    expect(toastStore.getSnapshot()).toMatchObject({ kind: 'undo', duration: 5000 }); // 5 s
  });

  it('shows rows as read straight away, before the server answers, and the counts drop', async () => {
    api.set(ENTRIES('all'), page([entry(1), entry(2)]));
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    api.set(MARK, async () => {
      await gate;
      return { body: { updated: 2, entryIds: ['1', '2'] } };
    });
    renderApp('/all');
    await screen.findByText('Title 1');
    await userEvent.click(markAllButton());

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: 'Title 1' })).toHaveClass(
        'text-fg-muted',
      ),
    );
    expect(client.getQueryData<Counts>(['counts'])?.total).toBe(0);
    release();
    await screen.findByText('Marked 2 as read');
  });

  it('Undo sends the returned IDs to the batch mark-unread endpoint and the rows return', async () => {
    api.set(ENTRIES('all'), page([entry(1), entry(2)]));
    api.set(MARK, { body: { updated: 2, entryIds: ['1', '2'] } });
    api.set(UNDO, { body: { updated: 2 } });
    renderApp('/all');
    await screen.findByText('Title 1');
    api.set(ENTRIES('all'), page([]));
    await userEvent.click(markAllButton());
    await screen.findByText('All caught up');

    api.set(ENTRIES('all'), page([entry(1), entry(2)]));
    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await screen.findByText('Title 1');
    expect(posts(UNDO)).toEqual([{ entryIds: ['1', '2'], isRead: false }]);
  });
});

describe('AC3: more than 20 entries', () => {
  it('asks first with the number; Cancel sends nothing, the confirm button marks', async () => {
    api.set(ENTRIES('all'), page([entry(1), entry(2)]));
    api.set('GET /api/counts', counts(84));
    api.set(MARK, {
      body: { updated: 84, entryIds: Array.from({ length: 84 }, (_, i) => `${i}`) },
    });
    renderApp('/all');
    await screen.findByText('Title 1');
    await waitFor(() => expect(client.getQueryData<Counts>(['counts'])?.total).toBe(84));

    await userEvent.click(markAllButton());
    const dialog = screen.getByRole('dialog', { name: 'Mark 84 articles as read?' });
    expect(posts(MARK)).toEqual([]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(posts(MARK)).toEqual([]);

    await userEvent.click(markAllButton());
    await userEvent.click(screen.getByRole('button', { name: 'Mark 84 as read' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await screen.findByText('Marked 84 as read');
    expect(posts(MARK)).toEqual([{ view: 'all', before: AS_OF }]);
  });

  it('formats a large count with a thousands separator', async () => {
    api.set(ENTRIES('all'), page([entry(1)]));
    api.set('GET /api/counts', counts(1500));
    renderApp('/all');
    await screen.findByText('Title 1');
    await waitFor(() => expect(client.getQueryData<Counts>(['counts'])?.total).toBe(1500));
    await userEvent.click(markAllButton());
    expect(screen.getByRole('dialog', { name: 'Mark 1,500 articles as read?' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Mark 1,500 as read' })).toBeVisible();
  });

  it('exactly 21 asks (boundary)', async () => {
    api.set(ENTRIES('all'), page([entry(1)]));
    api.set('GET /api/counts', counts(21));
    api.set(MARK, { body: { updated: 21, entryIds: ['1'] } });
    renderApp('/all');
    await screen.findByText('Title 1');
    await waitFor(() => expect(client.getQueryData<Counts>(['counts'])?.total).toBe(21));
    await userEvent.click(markAllButton());
    expect(screen.getByRole('dialog', { name: 'Mark 21 articles as read?' })).toBeVisible();
    expect(posts(MARK)).toEqual([]);
  });

  it('exactly 20 does not ask', async () => {
    api.set(ENTRIES('all'), page([entry(1)]));
    api.set('GET /api/counts', counts(20));
    api.set(MARK, { body: { updated: 20, entryIds: ['1'] } });
    renderApp('/all');
    await screen.findByText('Title 1');
    await waitFor(() => expect(client.getQueryData<Counts>(['counts'])?.total).toBe(20));
    await userEvent.click(markAllButton());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(posts(MARK)).toHaveLength(1));
  });
});

describe('AC4: more than 1,000 entries', () => {
  it('confirms, then the toast has no Undo', async () => {
    api.set(ENTRIES('all'), page([entry(1)]));
    api.set('GET /api/counts', counts(1500));
    api.set(MARK, { body: { updated: 1500, entryIds: null } });
    renderApp('/all');
    await screen.findByText('Title 1');
    await waitFor(() => expect(client.getQueryData<Counts>(['counts'])?.total).toBe(1500));
    await userEvent.click(markAllButton());
    await userEvent.click(screen.getByRole('button', { name: 'Mark 1,500 as read' }));
    await screen.findByText('Marked 1500 as read');
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });
});

describe('AC5: a folder or feed view sends its own scope', () => {
  it.each([
    ['/folders/f1', 'folder', 'f1'],
    ['/feeds/s1', 'feed', 's1'],
  ])('%s', async (path, view, id) => {
    api.set(ENTRIES(view, id), page([entry(1)]));
    api.set(MARK, { body: { updated: 3, entryIds: ['1'] } });
    renderApp(path);
    await screen.findByText('Title 1');
    await userEvent.click(markAllButton());
    await screen.findByText('Marked 3 as read');
    expect(posts(MARK)).toEqual([{ view, id, before: AS_OF }]);
  });
});

describe('AC7: Undo fails', () => {
  it('reads exactly "Couldn’t undo. Your change was kept.", the entries stay read and the counts match the server', async () => {
    api.set(ENTRIES('all'), page([entry(1), entry(2)]));
    api.set(MARK, { body: { updated: 2, entryIds: ['1', '2'] } });
    api.set(UNDO, { status: 500, body: { error: { code: 'internal', message: 'x' } } });
    renderApp('/all');
    await screen.findByText('Title 1');
    api.set(ENTRIES('all'), page([]));
    api.set('GET /api/counts', counts(0));
    await userEvent.click(markAllButton());
    await screen.findByText('All caught up');

    const countCalls = () => api.calls.filter((c) => c.path === '/api/counts').length;
    const before = countCalls();
    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(await screen.findByText("Couldn't undo. Your change was kept.")).toBeInTheDocument();
    expect(screen.getByText('All caught up')).toBeInTheDocument();
    await waitFor(() => expect(countCalls()).toBeGreaterThan(before));
    expect(client.getQueryData<Counts>(['counts'])?.total).toBe(0);
  });
});

describe('a failed mark all', () => {
  it('puts the rows and counts back and says so', async () => {
    api.set(ENTRIES('all'), page([entry(1), entry(2)]));
    api.set(MARK, { status: 500, body: { error: { code: 'internal', message: 'x' } } });
    renderApp('/all');
    await screen.findByText('Title 1');
    await userEvent.click(markAllButton());
    expect(await screen.findByText("Couldn't mark these as read. Try again.")).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Title 1' })).not.toHaveClass(
      'text-fg-muted',
    );
    expect(client.getQueryData<Counts>(['counts'])?.total).toBe(3);
  });

  it('is not shown while there is nothing to list', async () => {
    api.set(ENTRIES('all'), page([]));
    api.set('GET /api/counts', counts(0));
    renderApp('/all');
    await screen.findByText('All caught up');
    expect(screen.queryByRole('button', { name: /Mark all as read/ })).not.toBeInTheDocument();
  });
});

describe('AC1, AC5: optimistic counts in a folder view', () => {
  it('only the folder’s subscriptions drop to 0; other feeds and folders keep their counts', async () => {
    const other: Subscription = { ...sub, id: 's2', folderId: null, title: 'Outside' };
    api.set('GET /api/subscriptions', { body: { items: [sub, other] } });
    api.set('GET /api/counts', {
      body: { total: 5, folders: { f1: 3 }, subscriptions: { s1: 3, s2: 2 } },
    });
    api.set(ENTRIES('folder', 'f1'), page([entry(1)]));
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    api.set(MARK, async () => {
      await gate;
      return { body: { updated: 3, entryIds: ['1'] } };
    });
    renderApp('/folders/f1');
    await screen.findByText('Title 1');
    await waitFor(() => expect(client.getQueryData<Counts>(['counts'])?.total).toBe(5));
    await waitFor(() =>
      expect(client.getQueryData<Subscription[]>(['subscriptions'])).toHaveLength(2),
    );
    await userEvent.click(markAllButton());
    await waitFor(() =>
      expect(client.getQueryData<Counts>(['counts'])).toEqual({
        total: 2,
        folders: { f1: 0 },
        subscriptions: { s1: 0, s2: 2 },
      }),
    );
    release();
    await screen.findByText('Marked 3 as read');
  });
});
