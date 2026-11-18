import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Counts, Entry, EntrySummary, Subscription } from '@tidings/shared';
import { App } from '../App';
import { reportReachable } from '../lib/connectivity';
import { SESSION_KEY } from '../lib/session';
import { installFakeApi, type FakeApi } from '../test-api';
import { installMatchMedia } from '../test-utils';

// TID-019: the article view and read state, through the whole app against a fake API. The server
// side is tested in apps/worker/test/entry-read.test.ts; the sanitiser in lib/sanitize.test.ts.

const NOW = Date.parse('2026-11-17T12:00:00Z');

function entry(id: number, over: Partial<Entry> = {}): Entry {
  return {
    id: String(id),
    subscriptionId: 's1',
    feedTitle: 'Daring Fireball',
    title: `Title ${id}`,
    author: 'John Gruber',
    url: `https://example.com/post/${id}`,
    summary: `Summary ${id}`,
    imageUrl: null,
    publishedAt: new Date(NOW - id * 3_600_000).toISOString(),
    isRead: false,
    isStarred: false,
    contentHtml: `<p>Body of ${id}</p>`,
    ...over,
  };
}
const summary = (e: Entry): EntrySummary => {
  const rest: Partial<Entry> = { ...e };
  delete rest.contentHtml;
  return rest as EntrySummary;
};

function sub(id: string, title: string, folderId: string | null = null): Subscription {
  return {
    id,
    folderId,
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
  };
}

const page = (items: Entry[], nextCursor: string | null = null) => ({
  body: { items: items.map(summary), nextCursor, asOf: new Date(NOW).toISOString() },
});
const LIST = (view: string, state = 'unread', id?: string, cursor?: string) =>
  `GET /api/entries?view=${view}&state=${state}&limit=50${id ? `&id=${id}` : ''}${
    cursor ? `&cursor=${cursor}` : ''
  }`;
const COUNTS: Counts = { total: 3, folders: { f1: 3 }, subscriptions: { s1: 3 } };

let api: FakeApi;
let client: QueryClient;

function Probe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <div>
      <output data-testid="path">{`${location.pathname}${location.search}`}</output>
      <button type="button" onClick={() => navigate(-1)}>
        system back
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

const patches = () => api.calls.filter((c) => c.method === 'PATCH');
const counts = () => client.getQueryData<Counts>(['counts']);
const path = () => screen.getByTestId('path').textContent;
const entries = [entry(1), entry(2), entry(3)];

beforeEach(() => {
  vi.useRealTimers();
  localStorage.clear();
  installMatchMedia();
  api = installFakeApi();
  api.set('GET /api/folders', { body: { items: [{ id: 'f1', name: 'Tech' }] } });
  api.set('GET /api/subscriptions', {
    body: { items: [sub('s1', 'Daring Fireball', 'f1')] },
  });
  api.set('GET /api/counts', { body: COUNTS });
  api.set(LIST('all'), page(entries));
  for (const e of entries) {
    api.set(`GET /api/entries/${e.id}`, { body: e });
    api.set(`PATCH /api/entries/${e.id}`, { body: { ...summary(e), isRead: true } });
  }
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  reportReachable(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('AC1: the article', () => {
  it('shows title, feed, author, date and content, and Open original opens a new tab safely', async () => {
    const user = userEvent.setup();
    renderApp('/all');
    await user.click(await screen.findByRole('link', { name: /Title 2/ }));

    expect(await screen.findByRole('heading', { level: 2, name: 'Title 2' })).toBeInTheDocument();
    const article = screen.getByRole('article');
    expect(within(article).getByText('Daring Fireball')).toBeInTheDocument();
    expect(within(article).getByText('John Gruber')).toBeInTheDocument();
    expect(within(article).getByText(/2026/)).toBeInTheDocument();
    expect(await within(article).findByText('Body of 2')).toBeInTheDocument();

    const original = screen.getByRole('link', { name: 'Open original' });
    expect(original).toHaveAttribute('href', 'https://example.com/post/2');
    expect(original).toHaveAttribute('target', '_blank');
    expect(original.getAttribute('rel')).toMatch(/noopener/);
    expect(original.getAttribute('rel')).toMatch(/noreferrer/);
  });

  it('an entry with no URL has no Open original, and one with no content says so', async () => {
    api.set('GET /api/entries/1', { body: entry(1, { url: null, contentHtml: null }) });
    renderApp('/all/a/1');
    expect(await screen.findByText('This article has no content here.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open original' })).toBeNull();
  });

  it('a missing article says so, with no retry', async () => {
    api.set('GET /api/entries/9', {
      status: 404,
      body: { error: { code: 'not_found', message: 'x' } },
    });
    renderApp('/all/a/9');
    expect(await screen.findByText("We couldn't find that article.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});

describe('header title on article routes (TID-018 open point)', () => {
  it('never says "Feed" or "Folder": a skeleton while the name loads, then the name', async () => {
    let release: () => void = () => undefined;
    api.set('GET /api/subscriptions', async () => {
      await new Promise<void>((r) => (release = r));
      return { body: { items: [sub('s1', 'Daring Fireball')] } };
    });
    renderApp('/feeds/s1/a/1');
    const h1 = await screen.findByRole('heading', { level: 1 });
    expect(h1).toHaveAttribute('aria-busy', 'true');
    expect(h1).not.toHaveTextContent(/Feed|Folder/);
    expect(document.title).toBe('Feed - Tidings');
    release();
    await waitFor(() => expect(h1).toHaveTextContent('Daring Fireball'));
    expect(document.title).toBe('Daring Fireball - Tidings');
  });

  it('is the folder name under a folder, and "All articles" under All', async () => {
    api.set(LIST('folder', 'unread', 'f1'), page(entries));
    renderApp('/folders/f1/a/1');
    expect(await screen.findByRole('heading', { level: 1, name: 'Tech' })).toBeInTheDocument();
  });

  it('is "All articles" under All, with no skeleton', async () => {
    renderApp('/all/a/1');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('All articles');
  });
});

describe('AC2: mark as read when opened', () => {
  it('shows as read and drops the counts at once, then PATCHes {isRead:true}', async () => {
    // The server does not answer until the end: everything seen below is the optimistic state.
    let answer: () => void = () => undefined;
    api.set('PATCH /api/entries/2', async () => {
      await new Promise<void>((r) => (answer = r));
      return { body: {} };
    });
    const user = userEvent.setup();
    renderApp('/all');
    await user.click(await screen.findByRole('link', { name: /Title 2/ }));

    expect(await screen.findByRole('button', { name: 'Mark as unread' })).toBeInTheDocument();
    expect(counts()).toEqual({ total: 2, folders: { f1: 2 }, subscriptions: { s1: 2 } });
    expect(patches()).toEqual([
      { method: 'PATCH', path: '/api/entries/2', body: { isRead: true } },
    ]);
    // The list row is read too, and stays in the list.
    const list = client.getQueryData<{ pages: { items: EntrySummary[] }[] }>([
      'entries',
      'all',
      null,
      'unread',
    ]);
    expect(list?.pages[0]?.items.map((i) => [i.id, i.isRead])).toEqual([
      ['1', false],
      ['2', true],
      ['3', false],
    ]);
    answer();
  });

  it('with the setting off, opening sends nothing', async () => {
    renderApp('/all/a/1', { markReadOnOpen: false });
    await screen.findByRole('button', { name: 'Mark as read' });
    await new Promise((r) => setTimeout(r, 50));
    expect(patches()).toHaveLength(0);
  });

  it('an article that is already read is not sent again', async () => {
    api.set('GET /api/entries/3', { body: entry(3, { isRead: true }) });
    renderApp('/all/a/3');
    await screen.findByRole('button', { name: 'Mark as unread' });
    expect(patches()).toHaveLength(0);
  });
});

describe('AC3: a failed change rolls back', () => {
  it('restores the read state and the counts, and shows a toast', async () => {
    api.set('PATCH /api/entries/2', {
      status: 500,
      body: { error: { code: 'internal', message: 'x' } },
    });
    const user = userEvent.setup();
    renderApp('/all');
    await user.click(await screen.findByRole('link', { name: /Title 2/ }));

    expect(await screen.findByText("Couldn't update that article. Try again.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark as read' })).toBeInTheDocument();
    expect(counts()).toEqual(COUNTS);
    const list = client.getQueryData<{ pages: { items: EntrySummary[] }[] }>([
      'entries',
      'all',
      null,
      'unread',
    ]);
    expect(list?.pages[0]?.items.find((i) => i.id === '2')?.isRead).toBe(false);
  });
});

describe('AC4: mark as unread', () => {
  it('becomes unread again, in the entry, the list and the counts', async () => {
    api.set('PATCH /api/entries/2', { body: {} });
    const user = userEvent.setup();
    renderApp('/all');
    await user.click(await screen.findByRole('link', { name: /Title 2/ }));
    await user.click(await screen.findByRole('button', { name: 'Mark as unread' }));

    expect(await screen.findByRole('button', { name: 'Mark as read' })).toBeInTheDocument();
    expect(counts()).toEqual(COUNTS);
    expect(patches().map((p) => p.body)).toEqual([{ isRead: true }, { isRead: false }]);
    // It stays unread: opening is only marked once.
    await new Promise((r) => setTimeout(r, 50));
    expect(patches()).toHaveLength(2);
  });
});

describe('AC7: Next and Previous', () => {
  it('walk the list in its order with replace, and Back goes straight to the list', async () => {
    const user = userEvent.setup();
    renderApp('/all');
    await user.click(await screen.findByRole('link', { name: /Title 1/ }));
    expect(path()).toBe('/all/a/1?state=unread');
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Title 2' })).toBeInTheDocument();
    expect(path()).toBe('/all/a/2?state=unread');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Title 3' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Title 2' })).toBeInTheDocument();

    // One system Back from any article returns to the list: the articles replaced each other.
    await user.click(screen.getByRole('button', { name: 'system back' }));
    expect(path()).toBe('/all');
    expect(await screen.findByRole('link', { name: /Title 1/ })).toBeInTheDocument();
    // The list was not refetched: it shows what was loaded, with the articles read meanwhile.
    expect(api.calls.filter((c) => c.path.startsWith('/api/entries?'))).toHaveLength(1);
  });

  // DEF-070: current Chromium's window.scrollTo returns a Promise; the article's mount effect
  // returned it, so React treated it as a cleanup and threw when the article was replaced.
  it('DEF-070: Next works when window.scrollTo returns a Promise', async () => {
    vi.spyOn(window, 'scrollTo').mockImplementation((() => Promise.resolve()) as never);
    const user = userEvent.setup();
    renderApp('/all');
    await user.click(await screen.findByRole('link', { name: /Title 1/ }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Title 2' })).toBeInTheDocument();
  });

  it('Next at the end of the loaded pages loads the next page first', async () => {
    api.set(LIST('all'), page([entry(1), entry(2)], 'CUR1'));
    api.set(LIST('all', 'unread', undefined, 'CUR1'), page([entry(3)]));
    const user = userEvent.setup();
    renderApp('/all');
    await user.click(await screen.findByRole('link', { name: /Title 2/ }));
    const next = await screen.findByRole('button', { name: 'Next' });
    expect(next).toBeEnabled();
    await user.click(next);
    expect(await screen.findByRole('heading', { level: 2, name: 'Title 3' })).toBeInTheDocument();
    expect(path()).toBe('/all/a/3?state=unread');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('keeps the list’s filter: an All articles list steps through read ones too', async () => {
    api.set(LIST('all', 'all'), page([entry(1, { isRead: true }), entry(2, { isRead: true })]));
    const user = userEvent.setup();
    renderApp('/all?state=all');
    await user.click(await screen.findByRole('link', { name: /Title 1/ }));
    expect(path()).toBe('/all/a/1?state=all');
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Title 2' })).toBeInTheDocument();
  });

  it('keeps the list mounted under the article, so Back finds it as it was (no scroll restore)', async () => {
    const scrollTo = vi.fn();
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
    const user = userEvent.setup();
    renderApp('/all');
    await user.click(await screen.findByRole('link', { name: /Title 1/ }));
    const list = screen.getByTestId('list-underlay').querySelector('ul');
    expect(list).not.toBeNull();
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('button', { name: 'Previous' }));
    await user.click(screen.getByRole('button', { name: 'system back' }));
    await screen.findByRole('link', { name: /Title 1/ });
    expect(screen.getByTestId('list-underlay').querySelector('ul')).toBe(list);
    expect(scrollTo).not.toHaveBeenCalled();
  });
});

describe('AC11: feed text is text', () => {
  it('shows a title, author and feed title containing markup as literal characters', async () => {
    api.set('GET /api/entries/1', {
      body: entry(1, {
        title: 'Vec<T> & <b>x</b><script>alert(1)</script>',
        author: '<img src=x onerror=alert(2)>',
        feedTitle: '<i>Feed</i>',
        contentHtml: '<p>Safe</p>',
      }),
    });
    renderApp('/all/a/1');
    const article = await screen.findByRole('article');
    expect(
      await within(article).findByRole('heading', {
        level: 2,
        name: 'Vec<T> & <b>x</b><script>alert(1)</script>',
      }),
    ).toBeInTheDocument();
    expect(within(article).getByText('<img src=x onerror=alert(2)>')).toBeInTheDocument();
    expect(within(article).getByText('<i>Feed</i>')).toBeInTheDocument();
    expect(article.querySelector('script, img, b, i')).toBeNull();
    await within(article).findByText('Safe');
  });
});
