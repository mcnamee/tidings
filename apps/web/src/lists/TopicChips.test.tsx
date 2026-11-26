import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOPICS, type Counts, type EntrySummary, type Subscription } from '@tidings/shared';
import { App } from '../App';
import { reportReachable } from '../lib/connectivity';
import { SESSION_KEY } from '../lib/session';
import { applyRead } from '../lib/readState';
import { toastStore } from '../lib/toast';
import { installFakeApi, type FakeApi } from '../test-api';
import { installMatchMedia } from '../test-utils';

// TID-078 (AC1 to AC5, AC8, AC10 at unit level): the chip row on All articles, the filter it applies, short
// topic pages and mark all as read for a topic, through the whole app against a fake API.

const NOW = Date.parse('2026-11-26T12:00:00Z');
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
    lastSuccessAt: '2026-11-26T11:00:00.000Z',
    lastAttemptAt: '2026-11-26T11:00:00.000Z',
    errorCode: null,
    errorMessage: null,
    nextFetchAt: '2026-11-26T13:00:00.000Z',
    warning: null,
  },
};
const page = (items: EntrySummary[], nextCursor: string | null = null) => ({
  body: { items, nextCursor, asOf: AS_OF, sort: 'newest' },
});
const LIST = (qs: string) => `GET /api/entries?${qs}`;
const ALL_UNREAD = LIST('view=all&state=unread&limit=50');
const topicUnread = (slug: string, cursor?: string) =>
  LIST(`view=all&state=unread&limit=50&topic=${slug}${cursor ? `&cursor=${cursor}` : ''}`);
const COUNTS: Counts = { total: 30, folders: { f1: 30 }, subscriptions: { s1: 30 } };
const TOPIC_LIST = {
  body: { items: TOPICS.map((t) => ({ id: t.slug, name: t.name })), version: 1 },
};

let api: FakeApi;
let client: QueryClient;

function Probe() {
  const location = useLocation();
  return <output data-testid="url">{`${location.pathname}${location.search}`}</output>;
}

function renderApp(path: string, settings: Record<string, unknown> = {}) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(SESSION_KEY, {
    user: { id: 'u1', displayName: 'Matt', role: 'owner', settings },
    setupRequired: false,
    mustAddPasskey: false,
    emailSignIn: false,
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
const CHIPS = { topicChips: ['ai', 'formula-1', 'uk-politics'] };
const url = () => screen.getByTestId('url').textContent;
const chipRow = () => screen.queryByRole('group', { name: 'Topics' });
const chip = (name: string) => screen.getByRole('button', { name });
const entryCalls = () => api.calls.filter((c) => c.path.startsWith('/api/entries'));

beforeEach(() => {
  localStorage.clear();
  installMatchMedia();
  api = installFakeApi();
  api.set('GET /api/folders', { body: { items: [{ id: 'f1', name: 'Tech' }] } });
  api.set('GET /api/subscriptions', { body: { items: [sub] } });
  api.set('GET /api/counts', { body: COUNTS });
  api.set('GET /api/topics', TOPIC_LIST);
  api.set(ALL_UNREAD, page([entry(1), entry(2)]));
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  reportReachable(true);
  toastStore.dismiss();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AC1: the chip row', () => {
  it('shows "All" first, then the chosen topics in the chosen order, as one group of buttons', async () => {
    renderApp('/all', { topicChips: ['uk-politics', 'ai', 'formula-1'] });
    const group = await screen.findByRole('group', { name: 'Topics' });
    const names = within(group)
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label') ?? b.textContent);
    expect(names).toEqual(['All topics', 'UK politics', 'AI', 'Formula 1']);
    // It does not wrap, and each chip is a 44 px target.
    expect(group.firstElementChild).toHaveClass('w-max');
    for (const b of within(group).getAllByRole('button')) {
      expect(b).toHaveClass('min-h-11', 'min-w-11');
    }
  });

  it('is not shown when no topics are chosen, and not on folder or feed views', async () => {
    const view = renderApp('/all', { topicChips: [] });
    await screen.findByText('Title 1');
    expect(chipRow()).toBeNull();
    view.unmount();

    api.set(LIST('view=folder&state=unread&limit=50&id=f1'), page([entry(3)]));
    renderApp('/folders/f1', CHIPS);
    await screen.findByText('Title 3');
    expect(chipRow()).toBeNull();
  });

  it('shows no row when the names are unavailable (no cache and the request failed), and no error', async () => {
    api.set('GET /api/topics', {
      status: 500,
      body: { error: { code: 'internal', message: 'x' } },
    });
    renderApp('/all', CHIPS);
    await screen.findByText('Title 1');
    await waitFor(() => expect(client.getQueryState(['topics'])?.status).toBe('error'));
    expect(chipRow()).toBeNull();
    expect(screen.queryByTestId('topic-chips-skeleton')).toBeNull();
    expect(screen.queryByText(/something went wrong/i)).toBeNull();
  });

  it('shows a skeleton of pills, not chips, while the names load', async () => {
    api.set('GET /api/topics', () => new Promise(() => undefined));
    renderApp('/all', CHIPS);
    expect(await screen.findByTestId('topic-chips-skeleton')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
    expect(chipRow()).toBeNull();
  });

  it('drops a chosen ID that is no longer a topic (retired) instead of showing a broken chip', async () => {
    renderApp('/all', { topicChips: ['ai', 'retired-topic', 'formula-1'] });
    const group = await screen.findByRole('group', { name: 'Topics' });
    expect(within(group).getAllByRole('button')).toHaveLength(3);
  });

  it('is one Tab stop (the pressed chip) and Left, Right, Home and End move between chips', async () => {
    const user = userEvent.setup();
    renderApp('/all', CHIPS);
    await screen.findByRole('group', { name: 'Topics' });
    const buttons = within(screen.getByRole('group', { name: 'Topics' })).getAllByRole('button');
    expect(buttons.map((b) => b.tabIndex)).toEqual([0, -1, -1, -1]);
    buttons[0]?.focus();
    await user.keyboard('{ArrowRight}');
    expect(buttons[1]).toHaveFocus();
    await user.keyboard('{End}');
    expect(buttons[3]).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(buttons[3]).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(buttons[2]).toHaveFocus();
    await user.keyboard('{Home}');
    expect(buttons[0]).toHaveFocus();
    await user.keyboard('{ArrowRight}{Enter}');
    expect(chip('AI')).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('AC2 and AC3: filtering and URL state', () => {
  it('selecting a chip filters, sets ?topic= (replace), presses it, announces it and shows it in the header; All clears it', async () => {
    const user = userEvent.setup();
    api.set(topicUnread('formula-1'), page([entry(7, { topics: ['formula-1'] })]));
    renderApp('/all', CHIPS);
    await screen.findByText('Title 1');
    expect(chip('All topics')).toHaveAttribute('aria-pressed', 'true');

    await user.click(chip('Formula 1'));
    expect(await screen.findByText('Title 7')).toBeInTheDocument();
    expect(screen.queryByText('Title 1')).toBeNull();
    expect(url()).toBe('/all?topic=formula-1');
    expect(chip('Formula 1')).toHaveAttribute('aria-pressed', 'true');
    expect(chip('All topics')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('topic-status')).toHaveTextContent('Showing Formula 1');
    // "All articles" kicker, then the topic, inside the one h1; the document title names both.
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1).toHaveTextContent('All articlesFormula 1');
    expect(document.title).toBe('Formula 1 - All articles - Tidings');
    expect(entryCalls().at(-1)?.path).toBe(
      '/api/entries?view=all&state=unread&limit=50&topic=formula-1',
    );

    await user.click(chip('All topics'));
    expect(await screen.findByText('Title 1')).toBeInTheDocument();
    expect(url()).toBe('/all');
    expect(screen.getByTestId('topic-status')).toHaveTextContent('Showing all articles');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('All articles');
    expect(document.title).toBe('All articles - Tidings');
  });

  it('a deep link selects the chip; an unknown, retired or not-chosen topic falls back to All with no error', async () => {
    api.set(topicUnread('formula-1'), page([entry(7)]));
    const first = renderApp('/all?topic=formula-1', CHIPS);
    expect(await screen.findByText('Title 7')).toBeInTheDocument();
    expect(chip('Formula 1')).toHaveAttribute('aria-pressed', 'true');
    first.unmount();

    for (const bad of ['nope', 'osint', '13']) {
      const view = renderApp(`/all?topic=${bad}`, CHIPS);
      expect(await screen.findByText('Title 1')).toBeInTheDocument();
      expect(chip('All topics')).toHaveAttribute('aria-pressed', 'true');
      await waitFor(() => expect(url()).toBe('/all'));
      expect(screen.queryByText(/something went wrong/i)).toBeNull();
      expect(entryCalls().some((c) => c.path.includes(`topic=${bad}`))).toBe(false);
      view.unmount();
    }
  });

  it('ignores and removes ?topic= on a folder', async () => {
    api.set(LIST('view=folder&state=unread&limit=50&id=f1'), page([entry(3)]));
    renderApp('/folders/f1?topic=ai', CHIPS);
    await screen.findByText('Title 3');
    await waitFor(() => expect(url()).toBe('/folders/f1'));
    expect(entryCalls().every((c) => !c.path.includes('topic='))).toBe(true);
  });

  it('the request carries topic, state and sort, and each topic has its own cache entry', async () => {
    const user = userEvent.setup();
    const recommended = (qs: string) =>
      LIST(`view=all&state=unread&limit=50&sort=recommended${qs}`);
    api.set(recommended(''), page([entry(1)]));
    api.set(recommended('&topic=ai'), page([entry(5, { topics: ['ai'] })]));
    api.set(
      LIST('view=all&state=all&limit=50&topic=ai'),
      page([entry(5, { topics: ['ai'], isRead: true }), entry(6, { topics: ['ai'] })]),
    );
    renderApp('/all?topic=ai', { ...CHIPS, listSort: 'recommended' });
    await screen.findByText('Title 5');
    expect(entryCalls().at(-1)?.path).toBe(recommended('&topic=ai').slice('GET '.length));

    // Unread only off: state=all within the topic.
    await user.click(screen.getByRole('button', { name: 'Filters' }));
    await user.click(await screen.findByRole('switch', { name: /unread only/i }));
    await screen.findByText('Title 6');
    expect(url()).toBe('/all?topic=ai&state=all');

    // Cache entries are separate per topic: the All list never shows the topic's rows.
    expect(client.getQueryData(['entries', 'all', null, 'unread', 'newest', 'ai'])).toBeUndefined();
    expect(
      client.getQueryData(['entries', 'all', null, 'unread', 'recommended', 'ai']),
    ).toBeDefined();
    expect(
      client.getQueryData(['entries', 'all', null, 'unread', 'recommended', null]),
    ).toBeUndefined();
  });

  it('rows link to the article with ?topic= so Back returns to the same filtered list', async () => {
    api.set(topicUnread('ai'), page([entry(5, { topics: ['ai'] })]));
    renderApp('/all?topic=ai', CHIPS);
    const link = (await screen.findByRole('link', { name: /Title 5/ })) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/all/a/5?state=unread&topic=ai');
  });
});

describe('AC4: short pages and the empty state', () => {
  it('keeps requesting while a topic page is empty with a cursor, then shows the rows (never the empty state)', async () => {
    api.set(topicUnread('ai'), page([], 'c1'));
    api.set(topicUnread('ai', 'c1'), page([], 'c2'));
    api.set(topicUnread('ai', 'c2'), page([entry(9, { topics: ['ai'] })]));
    renderApp('/all?topic=ai', CHIPS);
    expect(await screen.findByText('Title 9')).toBeInTheDocument();
    expect(screen.queryByText(/Nothing unread in/)).toBeNull();
    expect(entryCalls().map((c) => c.path)).toEqual(
      expect.arrayContaining([
        '/api/entries?view=all&state=unread&limit=50&topic=ai',
        '/api/entries?view=all&state=unread&limit=50&topic=ai&cursor=c1',
        '/api/entries?view=all&state=unread&limit=50&topic=ai&cursor=c2',
      ]),
    );
  });

  it('shows the loading skeleton while it keeps looking, and no empty state', async () => {
    api.set(topicUnread('ai'), page([], 'c1'));
    api.set(topicUnread('ai', 'c1'), () => new Promise(() => undefined));
    renderApp('/all?topic=ai', CHIPS);
    await waitFor(() => expect(entryCalls().some((c) => c.path.includes('cursor=c1'))).toBe(true));
    expect(screen.getByTestId('list-skeleton')).toBeInTheDocument();
    expect(screen.queryByText(/Nothing unread in/)).toBeNull();
  });

  it('shows the empty state only when there is no cursor and no items: names the topic, no hourly sentence, offers a way back', async () => {
    const user = userEvent.setup();
    api.set(topicUnread('ai'), page([]));
    api.set(LIST('view=all&state=all&limit=50&topic=ai'), page([entry(5, { isRead: true })]));
    renderApp('/all?topic=ai', CHIPS);
    expect(
      await screen.findByRole('heading', { name: 'Nothing unread in AI' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/within about an hour/i)).toBeNull();
    // The chip row stays, with the topic pressed.
    expect(chip('AI')).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: 'Show read articles too' }));
    expect(await screen.findByText('Title 5')).toBeInTheDocument();
    expect(url()).toBe('/all?topic=ai&state=all');
  });

  it('with Unread only off the title is "No articles about X yet", and Show all topics clears the topic', async () => {
    const user = userEvent.setup();
    api.set(LIST('view=all&state=all&limit=50&topic=formula-1'), page([]));
    api.set(LIST('view=all&state=all&limit=50'), page([entry(1)]));
    renderApp('/all?topic=formula-1&state=all', CHIPS);
    expect(
      await screen.findByRole('heading', { name: 'No articles about Formula 1 yet' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show read articles too' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Show all topics' }));
    expect(await screen.findByText('Title 1')).toBeInTheDocument();
    expect(url()).toBe('/all?state=all');
  });

  it('offline with a topic that was never loaded says so, with a way back to All', async () => {
    const user = userEvent.setup();
    const { onlineManager } = await import('@tanstack/react-query');
    onlineManager.setOnline(false);
    try {
      renderApp('/all?topic=ai', CHIPS);
      expect(
        await screen.findByRole('heading', { name: "This topic isn't saved on this device" }),
      ).toBeInTheDocument();
      expect(screen.getByText('Reconnect to load AI.')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Show all topics' }));
      await waitFor(() => expect(url()).toBe('/all'));
    } finally {
      onlineManager.setOnline(true);
    }
  });
});

describe('AC5: mark all as read with a topic', () => {
  it('sends topic and before, and marks only that topic’s rows read; the toast names the topic and Undo works', async () => {
    const user = userEvent.setup();
    api.set(
      topicUnread('ai'),
      page([entry(5, { topics: ['ai'] }), entry(6, { topics: ['ai', 'technology'] })]),
    );
    api.set('POST /api/entries/mark-all-read', { body: { updated: 2, entryIds: ['5', '6'] } });
    api.set('POST /api/entries/read-state', { body: { updated: 2 } });
    renderApp('/all?topic=ai', CHIPS);
    await screen.findByText('Title 5');
    // A cached All list holds an ai row and an other row: only the ai row changes.
    client.setQueryData(['entries', 'all', null, 'unread', 'newest', null], {
      pages: [
        {
          items: [entry(5, { topics: ['ai'] }), entry(1)],
          nextCursor: null,
          asOf: AS_OF,
          sort: 'newest',
        },
      ],
      pageParams: [null],
    });

    await user.click(screen.getByRole('button', { name: 'Mark all as read' }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.path === '/api/entries/mark-all-read')?.body).toEqual({
        view: 'all',
        before: AS_OF,
        topic: 'ai',
      }),
    );
    const all = client.getQueryData<{ pages: { items: EntrySummary[] }[] }>([
      'entries',
      'all',
      null,
      'unread',
      'newest',
      null,
    ]);
    // Refetch may already have replaced it; what matters is that the unrelated row was never marked read first.
    if (all) expect(all.pages[0]?.items.find((i) => i.id === '1')?.isRead).toBe(false);
    await waitFor(() =>
      expect(toastStore.getSnapshot()?.message).toBe('Marked 2 AI articles as read'),
    );
    expect(toastStore.getSnapshot()?.action?.label).toBe('Undo');
    toastStore.getSnapshot()?.action?.run();
    await waitFor(() =>
      expect(api.calls.find((c) => c.path === '/api/entries/read-state')?.body).toEqual({
        entryIds: ['5', '6'],
        isRead: false,
      }),
    );
  });

  it('asks first above 20 and the confirmation names the topic', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 21 }, (_, i) => entry(100 + i, { topics: ['formula-1'] }));
    api.set(topicUnread('formula-1'), page(many));
    api.set('POST /api/entries/mark-all-read', { body: { updated: 21, entryIds: null } });
    renderApp('/all?topic=formula-1', CHIPS);
    await screen.findByText('Title 100');
    await user.click(screen.getByRole('button', { name: 'Mark all as read' }));
    const sheet = await screen.findByRole('dialog', {
      name: 'Mark 21 Formula 1 articles as read?',
    });
    expect(api.calls.some((c) => c.path === '/api/entries/mark-all-read')).toBe(false);
    await user.click(within(sheet).getByRole('button', { name: 'Mark 21 as read' }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.path === '/api/entries/mark-all-read')?.body).toMatchObject({
        topic: 'formula-1',
      }),
    );
  });

  it('without a topic the request has no topic key', async () => {
    const user = userEvent.setup();
    api.set('GET /api/counts', { body: { total: 2, folders: {}, subscriptions: { s1: 2 } } });
    api.set('POST /api/entries/mark-all-read', { body: { updated: 2, entryIds: ['1', '2'] } });
    renderApp('/all', CHIPS);
    await screen.findByText('Title 1');
    await user.click(screen.getByRole('button', { name: 'Mark all as read' }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.path === '/api/entries/mark-all-read')?.body).toEqual({
        view: 'all',
        before: AS_OF,
      }),
    );
  });
});

const TOPIC_COUNTS = 'GET /api/counts/topics';
const chipNames = () =>
  within(screen.getByRole('group', { name: 'Topics' }))
    .getAllByRole('button')
    .map((b) => b.getAttribute('aria-label') ?? b.textContent);

describe('Owner request: a chip shows only while its topic has unread articles', () => {
  it('hides a chosen topic with none unread; "All" stays; the row is fed by the per-topic counts', async () => {
    api.set(TOPIC_COUNTS, { body: { topics: { ai: 4, 'uk-politics': 1 } } });
    renderApp('/all', CHIPS);
    await waitFor(() => expect(chipNames()).toEqual(['All topics', 'AI', 'UK politics']));
    expect(api.calls.some((c) => c.path === '/api/counts/topics')).toBe(true);
  });

  it('keeps the selected chip even at 0 unread, so the person is not stranded', async () => {
    api.set(TOPIC_COUNTS, { body: { topics: { ai: 4 } } });
    api.set(topicUnread('formula-1'), page([]));
    renderApp('/all?topic=formula-1', CHIPS);
    await waitFor(() => expect(chipNames()).toEqual(['All topics', 'AI', 'Formula 1']));
    expect(chip('Formula 1')).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows no row at all when no chosen topic has unread articles', async () => {
    api.set(TOPIC_COUNTS, { body: { topics: { technology: 9 } } });
    renderApp('/all', CHIPS);
    await screen.findByText('Title 1');
    await waitFor(() => expect(api.calls.some((c) => c.path === '/api/counts/topics')).toBe(true));
    await waitFor(() => expect(chipRow()).toBeNull());
    expect(screen.queryByTestId('topic-chips-skeleton')).toBeNull();
  });

  it('shows every chosen chip with Unread only off (read articles are in the list), and when the counts cannot load', async () => {
    api.set(TOPIC_COUNTS, { body: { topics: {} } });
    api.set(LIST('view=all&state=all&limit=50'), page([entry(1)]));
    const view = renderApp('/all?state=all', CHIPS);
    await screen.findByText('Title 1');
    expect(chipNames()).toEqual(['All topics', 'AI', 'Formula 1', 'UK politics']);
    expect(api.calls.some((c) => c.path === '/api/counts/topics')).toBe(false);
    view.unmount();

    api.set(TOPIC_COUNTS, { status: 500, body: { error: { code: 'internal', message: 'x' } } });
    renderApp('/all', CHIPS);
    await screen.findByText('Title 1');
    await waitFor(() =>
      expect(chipNames()).toEqual(['All topics', 'AI', 'Formula 1', 'UK politics']),
    );
  });

  it('refetches the topic counts after a read-state change (the counts cadence)', async () => {
    api.set(TOPIC_COUNTS, { body: { topics: { ai: 1, 'formula-1': 2 } } });
    renderApp('/all', CHIPS);
    await waitFor(() => expect(chipNames()).toEqual(['All topics', 'AI', 'Formula 1']));
    const before = api.calls.filter((c) => c.path === '/api/counts/topics').length;
    api.set(TOPIC_COUNTS, { body: { topics: { 'formula-1': 2 } } });
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['counts'] });
    });
    await waitFor(() => expect(chipNames()).toEqual(['All topics', 'Formula 1']));
    expect(api.calls.filter((c) => c.path === '/api/counts/topics').length).toBeGreaterThan(before);
  });
});

describe('Owner request: choosing a chip counts as leaving the list (FR-RD-4)', () => {
  it('read some articles in a topic, then All: the ones read are not shown, and All was fetched again', async () => {
    const user = userEvent.setup();
    const aiRow = entry(2, { topics: ['ai'] });
    api.set(ALL_UNREAD, page([entry(1), aiRow, entry(3)]));
    api.set(topicUnread('ai'), page([aiRow, entry(4, { topics: ['ai'] })]));
    renderApp('/all', CHIPS);
    await screen.findByText('Title 3');

    await user.click(chip('AI'));
    await screen.findByText('Title 4');
    // The person reads Title 2 in the AI view (mark read on scroll, or opening it): every cached list changes.
    act(() => applyRead(client, { id: '2', subscriptionId: 's1' }, true));
    // The server's All list no longer has it.
    api.set(ALL_UNREAD, page([entry(1), entry(3)]));
    const allCalls = () => entryCalls().filter((c) => c.path === ALL_UNREAD.slice('GET '.length));
    const before = allCalls().length;

    await user.click(chip('All topics'));
    await waitFor(() => expect(allCalls().length).toBe(before + 1));
    await screen.findByText('Title 3');
    expect(screen.queryByText('Title 2')).toBeNull();
    // Not even as a greyed row while the list loads: the cached read row was dropped on the way in.
    expect(screen.queryByRole('heading', { level: 2, name: 'Title 2' })).toBeNull();
  });

  it('drops a row read elsewhere from the cached list before it is shown, even if the refetch is slow', async () => {
    const user = userEvent.setup();
    api.set(ALL_UNREAD, page([entry(1), entry(2, { topics: ['ai'] })]));
    api.set(topicUnread('ai'), page([entry(2, { topics: ['ai'] })]));
    renderApp('/all', CHIPS);
    await screen.findByText('Title 2');
    await user.click(chip('AI'));
    await waitFor(() => expect(url()).toBe('/all?topic=ai'));
    act(() => applyRead(client, { id: '2', subscriptionId: 's1' }, true));
    // The All answer never arrives.
    api.set(ALL_UNREAD, { body: {}, status: 500 });
    await user.click(chip('All topics'));
    await screen.findByText('Title 1');
    expect(screen.queryByRole('heading', { level: 2, name: 'Title 2' })).toBeNull();
  });

  it('with Unread only off the read rows stay (they belong to that list), and the list is still fetched again', async () => {
    const user = userEvent.setup();
    const all = LIST('view=all&state=all&limit=50');
    const ai = LIST('view=all&state=all&limit=50&topic=ai');
    api.set(all, page([entry(1), entry(2, { topics: ['ai'] })]));
    api.set(ai, page([entry(2, { topics: ['ai'] })]));
    renderApp('/all?state=all', CHIPS);
    await screen.findByText('Title 1');
    await user.click(chip('AI'));
    await waitFor(() => expect(url()).toBe('/all?state=all&topic=ai'));
    act(() => applyRead(client, { id: '2', subscriptionId: 's1' }, true));
    api.set(all, page([entry(1), entry(2, { topics: ['ai'], isRead: true })]));
    const before = entryCalls().filter((c) => c.path.includes('state=all&limit=50')).length;
    await user.click(chip('All topics'));
    await waitFor(() =>
      expect(entryCalls().filter((c) => c.path.includes('state=all&limit=50')).length).toBe(
        before + 1,
      ),
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Title 2' })).toHaveClass('text-fg-muted');
  });
});
