import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigate, useNavigationType } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry, EntrySummary } from '@tidings/shared';
import { App } from '../App';
import { reportReachable } from '../lib/connectivity';
import { SESSION_KEY } from '../lib/session';
import { installFakeApi, type FakeApi } from '../test-api';
import { resetEngagementForTests } from '../lib/engagement';
import { installMatchMedia } from '../test-utils';

// TID-058: native-feel transitions. The article slides in from the right over the list (which
// shifts left under a fading scrim) and out again on Back; pulling a list down stretches its
// content, never the header.
// (Setup shared in shape with layers.test.tsx.) TID-055: the swipe gestures on a phone in the installed app. The article is a layer above its
// list (the list stays mounted, inert and hidden, and moves with the finger); the drawer keeps
// the same element from the first peek through to open, and through a swipe-close.

const NOW = Date.parse('2026-11-17T12:00:00Z');
const entry = (id: number): Entry => ({
  id: String(id),
  subscriptionId: 's1',
  feedTitle: 'Feed',
  title: `Title ${id}`,
  author: null,
  url: `https://example.com/${id}`,
  summary: 'S',
  imageUrl: null,
  publishedAt: new Date(NOW - id * 3_600_000).toISOString(),
  isRead: false,
  isStarred: false,
  topics: [],
  contentHtml: `<p>Body ${id}</p>`,
});
const summary = (e: Entry): EntrySummary => {
  const rest: Partial<Entry> = { ...e };
  delete rest.contentHtml;
  return rest as EntrySummary;
};

let api: FakeApi;
let standalone = true;
function Where() {
  const l = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="path">{`${l.pathname}${l.search}`}</output>
      <output data-testid="navtype">{useNavigationType()}</output>
      <button type="button" onClick={() => void navigate(-1)}>
        history back
      </button>
    </>
  );
}
function renderApp(path: string | { pathname: string; state: unknown }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(SESSION_KEY, {
    user: { id: 'u1', displayName: 'M', role: 'owner', settings: {} },
    setupRequired: false,
    mustAddPasskey: false,
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <App />
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const path = () => screen.getByTestId('path').textContent;

beforeEach(() => {
  standalone = true;
  resetEngagementForTests();
  localStorage.clear();
  installMatchMedia(standalone ? { 'display-mode: standalone': true } : {});
  Object.defineProperty(window, 'innerWidth', { value: 375, configurable: true });
  api = installFakeApi();
  const entries = [entry(1), entry(2)];
  api.set('GET /api/folders', { body: { items: [] } });
  api.set('GET /api/subscriptions', { body: { items: [] } });
  api.set('GET /api/counts', { body: { total: 2, folders: {}, subscriptions: {} } });
  api.set('GET /api/entries?view=all&state=unread&limit=50', {
    body: { items: entries.map(summary), nextCursor: null, asOf: new Date(NOW).toISOString() },
  });
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
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const ready = async () => {
  await screen.findByRole('link', { name: /Title 1/ });
};

const navtype = () => screen.getByTestId('navtype').textContent;
const engagement = () => api.calls.filter((c) => c.path.endsWith('/engagement'));

async function openFirst() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('link', { name: /Title 1/ }));
  await screen.findByTestId('article-layer');
  return user;
}

describe('TID-070: no history in the installed app', () => {
  beforeEach(() => {
    for (const id of ['1', '2']) {
      api.set(`POST /api/entries/${id}/engagement`, { body: { recorded: true } });
    }
  });

  it('opening an article replaces the list entry, so history back has nowhere to go', async () => {
    renderApp('/all');
    const user = await openFirst();
    expect(navtype()).toBe('REPLACE');
    await user.click(screen.getByRole('button', { name: 'history back' }));
    expect(path()).toBe('/all/a/1?state=unread');
  });

  it('in a browser tab opening still pushes, and history back returns to the list', async () => {
    standalone = false;
    installMatchMedia({});
    renderApp('/all');
    const user = await openFirst();
    expect(navtype()).toBe('PUSH');
    await user.click(screen.getByRole('button', { name: 'history back' }));
    await waitFor(() => expect(path()).toBe('/all'));
  });

  it('Back goes to the parent list with replace and slides out first', async () => {
    renderApp('/all');
    const user = await openFirst();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(screen.queryByTestId('article-layer')).toBeNull(), {
      timeout: 1500,
    });
    expect(path()).toBe('/all?state=unread');
    expect(navtype()).toBe('REPLACE');
    await user.click(screen.getByRole('button', { name: 'history back' }));
    expect(path()).toBe('/all?state=unread');
  });

  it('Back after Next still goes to the list, not the previous article', async () => {
    renderApp('/all');
    const user = await openFirst();
    await user.click(await screen.findByRole('button', { name: /Next/ }));
    await screen.findByText('Body 2');
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(path()).toBe('/all?state=unread'), { timeout: 1500 });
  });

  it('restores the list scroll position after the replace', async () => {
    renderApp('/all');
    await ready();
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    Object.defineProperty(window, 'scrollY', { value: 420, configurable: true });
    fireEvent.scroll(window);
    const user = await openFirst();
    expect(screen.getByTestId('list-underlay').querySelector('main')?.style.top).toBe('-420px');
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(screen.queryByTestId('article-layer')).toBeNull(), {
      timeout: 1500,
    });
    expect(scrollTo).toHaveBeenLastCalledWith(0, 420);
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
  });

  it('counts one open for the tap and one per Next, nothing for Back or a reload', async () => {
    renderApp('/all');
    const user = await openFirst();
    await waitFor(() => expect(engagement()).toHaveLength(1));
    await user.click(await screen.findByRole('button', { name: /Next/ }));
    await screen.findByText('Body 2');
    await waitFor(() => expect(engagement()).toHaveLength(2));
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(screen.queryByTestId('article-layer')).toBeNull(), {
      timeout: 1500,
    });
    expect(engagement().map((c) => c.path)).toEqual([
      '/api/entries/1/engagement',
      '/api/entries/2/engagement',
    ]);
  });

  it('a reload of an article URL sends nothing even with a stale open mark in its state', async () => {
    renderApp({ pathname: '/all/a/2', state: { opened: 'an-earlier-page-life' } });
    await screen.findByText('Body 2');
    await new Promise((r) => setTimeout(r, 50));
    expect(engagement()).toEqual([]);
  });
});
