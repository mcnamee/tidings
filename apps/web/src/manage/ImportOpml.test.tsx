import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImportOpmlRequest, Subscription } from '@tidings/shared';
import { App } from '../App';
import { SESSION_KEY } from '../lib/session';
import { installFakeApi, type FakeApi } from '../test-api';
import { installMatchMedia } from '../test-utils';

// TID-016 UI (docs/ux/FLOWS.md 2.2): /manage/import through the real App and shell, against a
// fake API. The API itself is tested in apps/worker/test/import.test.ts.

const OWNER = { id: 'u1', displayName: 'Matt', role: 'owner', settings: {} } as const;

function sub(id: string, url: string, state: Subscription['health']['state'] = 'ok', ok = true) {
  return {
    id,
    folderId: null,
    title: url,
    customTitle: null,
    feedUrl: url,
    siteUrl: null,
    createdAt: '2026-11-10T12:00:00.000Z',
    health: {
      state,
      lastSuccessAt: ok && state === 'ok' ? '2026-11-10T12:00:00.000Z' : null,
      lastAttemptAt: null,
      errorCode: null,
      errorMessage: null,
      nextFetchAt: '2026-11-10T12:30:00.000Z',
      warning: null,
    },
  } satisfies Subscription;
}

const feedTag = (url: string) => `<outline type="rss" text="${url}" xmlUrl="${url}"/>`;

/** 250 distinct feeds: 18 folders (one with a nested folder), 13 unfiled, 2 repeated, 2 invalid. */
function fixture(): string {
  let body = '';
  for (let i = 0; i < 18; i += 1) {
    let inner = '';
    for (let j = 0; j < 13; j += 1) inner += feedTag(`https://f${i}-${j}.example.com/feed.xml`);
    if (i === 0) {
      inner += `<outline text="Nested">${[0, 1, 2].map((k) => feedTag(`https://n${k}.example.com/feed.xml`)).join('')}</outline>`;
    }
    if (i === 5)
      inner +=
        feedTag('https://f1-0.example.com/feed.xml') + feedTag('https://f1-1.example.com/feed.xml');
    body += `<outline text="Folder ${i}" title="Folder ${i}">${inner}</outline>`;
  }
  for (let k = 0; k < 13; k += 1) body += feedTag(`https://t${k}.example.com/feed.xml`);
  body += feedTag('not a url') + feedTag('ftp://x.example.com/feed.xml');
  return `<?xml version="1.0"?><opml version="2.0"><head><title>Inoreader</title></head><body>${body}</body></opml>`;
}

let api: FakeApi;
/** What GET /api/subscriptions answers; tests change it to simulate fetching. */
let subs: Subscription[];

function Probe() {
  return <output data-testid="path">{useLocation().pathname}</output>;
}

function renderImport() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(SESSION_KEY, { user: OWNER, setupRequired: false, mustAddPasskey: false });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/manage/import']}>
        <App />
        <Probe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const posts = () =>
  api.calls
    .filter((c) => c.method === 'POST' && c.path === '/api/import/opml')
    .map((c) => c.body as ImportOpmlRequest);
const size = (r: ImportOpmlRequest) =>
  r.feeds.length + r.folders.reduce((n, f) => n + f.feeds.length, 0);

async function choose(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.upload(
    screen.getByLabelText(/Choose OPML file|Choose another file/),
    new File([text], 'inoreader.opml', { type: 'text/xml' }),
  );
}

function answerImports(over: { deferred?: (i: number) => number; fail?: number[] } = {}) {
  let i = 0;
  api.set('POST /api/import/opml', (body) => {
    const n = i;
    i += 1;
    if (over.fail?.includes(n))
      return { status: 502, body: { error: { code: 'internal', message: 'x' } } };
    const req = body as ImportOpmlRequest;
    return {
      body: { created: size(req), existing: 0, deferred: over.deferred?.(n) ?? 0, invalid: [] },
    };
  });
}

beforeEach(() => {
  localStorage.clear();
  installMatchMedia();
  api = installFakeApi();
  subs = [
    sub('s1', 'https://f0-0.example.com/feed.xml'),
    sub('s2', 'https://f0-1.example.com/feed.xml'),
    sub('s3', 'https://f0-2.example.com/feed.xml'),
  ];
  api.set('GET /api/subscriptions', () => ({ body: { items: subs } }));
  api.set('GET /api/folders', { body: { items: [] } });
  api.set('GET /api/counts', { body: { all: 0, folders: {}, feeds: {} } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AC1: the preview comes before anything is sent', () => {
  it('shows feed and folder counts, already subscribed, invalid and repeated feeds', async () => {
    const user = userEvent.setup();
    renderImport();
    await choose(user, fixture());
    // 250 feeds + 2 invalid addresses, 18 folders; 3 already followed; 2 feeds in two folders.
    expect(
      await screen.findByRole('heading', { name: 'Found 252 feeds in 18 folders' }),
    ).toBeInTheDocument();
    expect(screen.getByText('3 already subscribed')).toBeInTheDocument();
    expect(screen.getByText('2 invalid')).toBeInTheDocument();
    expect(screen.getByText(/2 feeds in more than one folder/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import 247 feeds' })).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });
});

describe('AC2 and AC4: sending in requests of at most 100, then progress every 5 s', () => {
  it('sends 100, 100 and 47 feeds, then shows "Fetched X of N feeds" and updates it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    answerImports();
    renderImport();
    await choose(user, fixture());
    await user.click(await screen.findByRole('button', { name: 'Import 247 feeds' }));

    expect(await screen.findByText('Fetched 0 of 247 feeds')).toBeInTheDocument();
    const sent = posts();
    expect(sent.map(size)).toEqual([100, 100, 47]);
    expect(sent.every((r) => size(r) <= 100)).toBe(true);
    // Folders keep their names, nested folders are flattened, the repeated feed is sent once.
    const all = sent.flatMap((r) => [...r.folders.flatMap((f) => f.feeds), ...r.feeds]);
    expect(new Set(all.map((f) => f.xmlUrl)).size).toBe(247);
    expect(sent[0]?.folders[0]?.name).toBe('Folder 0');
    expect(sent.flatMap((r) => r.folders.map((f) => f.name))).not.toContain('Nested');
    expect(screen.queryByRole('link', { name: 'Start reading' })).not.toBeInTheDocument();

    // New feeds appear as pending, then leave pending as the dispatcher fetches them.
    const fresh = all.map((f, k) => ({ f, id: `n${k}` }));
    subs = [...subs, ...fresh.map(({ f, id }) => sub(id, f.xmlUrl, 'pending'))];
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(await screen.findByText('Fetched 0 of 247 feeds')).toBeInTheDocument();

    subs = [
      ...subs.slice(0, 3),
      ...fresh.map(({ f, id }, k) => sub(id, f.xmlUrl, k < 120 ? 'ok' : 'pending')),
    ];
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(await screen.findByText('Fetched 120 of 247 feeds')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Start reading' })).toHaveAttribute('href', '/all');

    subs = [
      ...subs.slice(0, 3),
      ...fresh.map(({ f, id }, k) => sub(id, f.xmlUrl, k < 5 ? 'failing' : 'ok')),
    ];
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(await screen.findByText('Fetched 247 of 247 feeds')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Import complete' })).toBeInTheDocument();
    expect(screen.getByText(/5 feeds couldn.t be fetched/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See which' })).toHaveAttribute('href', '/manage');

    // Polling has stopped: no further subscription requests after completion.
    const calls = api.calls.filter((c) => c.path === '/api/subscriptions').length;
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(api.calls.filter((c) => c.path === '/api/subscriptions').length).toBe(calls);
  });
});

describe('AC5: importing the same file again', () => {
  it('shows everything as already subscribed and offers nothing to import', async () => {
    const user = userEvent.setup();
    const all = [...fixture().matchAll(/xmlUrl="(https:[^"]+)"/g)].map((m) => m[1] as string);
    subs = [...new Set(all)].map((u, k) => sub(`s${k}`, u));
    renderImport();
    await choose(user, fixture());
    expect(await screen.findByText('250 already subscribed')).toBeInTheDocument();
    expect(screen.getByText('Everything in this file is already in Tidings.')).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Import 0 feeds' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    await user.click(button);
    expect(posts()).toHaveLength(0);
  });
});

describe('AC7: a file that is not OPML', () => {
  it.each([
    ['plain text', 'just some text'],
    ['malformed XML', '<opml><body><outline xmlUrl="https://a.example.com/f"></opml>'],
    ['an RSS feed', '<rss version="2.0"><channel><title>x</title></channel></rss>'],
  ])('%s shows an error and sends nothing', async (_n, text) => {
    const user = userEvent.setup();
    renderImport();
    await choose(user, text);
    expect(
      await screen.findByText("That file doesn't look like an OPML export"),
    ).toBeInTheDocument();
    expect(screen.getByText('Choose another file')).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
    expect(api.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });
});

describe('AC9: feeds deferred to tomorrow', () => {
  it('says how many feeds will start fetching tomorrow and does not wait for them', async () => {
    const user = userEvent.setup();
    answerImports({ deferred: (i) => (i === 2 ? 47 : 0) }); // the last request is deferred
    renderImport();
    await choose(user, fixture());
    await user.click(await screen.findByRole('button', { name: 'Import 247 feeds' }));
    expect(await screen.findByText('Fetched 0 of 200 feeds')).toBeInTheDocument();
    expect(screen.getByText(/47 feeds will start fetching tomorrow/)).toBeInTheDocument();
  });
});

describe('failures and offline', () => {
  it('a failed request pauses the import and Try again resumes from that request', async () => {
    const user = userEvent.setup();
    answerImports({ fail: [1] });
    renderImport();
    await choose(user, fixture());
    await user.click(await screen.findByRole('button', { name: 'Import 247 feeds' }));
    expect(await screen.findByRole('heading', { name: 'Import paused' })).toBeInTheDocument();
    expect(screen.getByText('Sent 100 of 247 feeds')).toBeInTheDocument();
    expect(screen.getByText('Something went wrong on our side. Try again.')).toBeInTheDocument();
    expect(posts().map(size)).toEqual([100, 100]);

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByText(/Fetched \d+ of 247 feeds/)).toBeInTheDocument());
    expect(posts().map(size)).toEqual([100, 100, 100, 47]); // the failed request was sent again
  });

  it('offline: the import button is blocked with "You\'re offline"', async () => {
    const user = userEvent.setup();
    renderImport();
    await choose(user, fixture());
    const button = await screen.findByRole('button', { name: 'Import 247 feeds' });
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByText("You're offline")).toBeInTheDocument();
    await user.click(button);
    expect(posts()).toHaveLength(0);
    vi.restoreAllMocks();
    act(() => {
      window.dispatchEvent(new Event('online')); // react-query's online manager keeps its state
    });
  });
});

describe('entry point', () => {
  it('Manage links to the import screen', async () => {
    api.set('GET /api/folders', { body: { items: [] } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(SESSION_KEY, { user: OWNER, setupRequired: false, mustAddPasskey: false });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/manage']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('link', { name: 'Import from OPML' })).toHaveAttribute(
      'href',
      '/manage/import',
    );
  });
});
