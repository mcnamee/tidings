import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Counts, Entry, EntrySummary, Subscription } from '@tidings/shared';
import { App } from './App';
import { reportReachable } from './lib/connectivity';
import { SESSION_KEY } from './lib/session';
import { toastStore } from './lib/toast';
import { installFakeApi, type FakeApi } from './test-api';
import { installMatchMedia, type FakeMedia } from './test-utils';

// TID-054 (title link), TID-026 (mark as read on scroll) and TID-055 (edge swipes), through the
// whole app against a fake API. The gesture hook itself: lib/useSwipe.test.tsx; the batching
// rules: lib/readOnScroll.test.ts.

const NOW = Date.parse('2026-11-18T12:00:00Z');

function entry(id: number, over: Partial<Entry> = {}): Entry {
  return {
    id: String(id),
    subscriptionId: 's1',
    feedTitle: 'Daring Fireball',
    title: `Title ${id}`,
    author: null,
    url: `https://example.com/post/${id}`,
    summary: null,
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
const sub: Subscription = {
  id: 's1',
  folderId: null,
  title: 'Daring Fireball',
  customTitle: null,
  feedUrl: 'https://s1.example.com/rss',
  siteUrl: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  health: {
    state: 'ok',
    lastSuccessAt: '2026-11-18T11:00:00.000Z',
    lastAttemptAt: '2026-11-18T11:00:00.000Z',
    errorCode: null,
    errorMessage: null,
    nextFetchAt: '2026-11-18T13:00:00.000Z',
    warning: null,
  },
};
const ENTRIES = [entry(1), entry(2), entry(3)];
const COUNTS: Counts = { total: 3, folders: {}, subscriptions: { s1: 3 } };

let api: FakeApi;
let client: QueryClient;
let media: FakeMedia;

function Probe() {
  const location = useLocation();
  return <output data-testid="path">{location.pathname}</output>;
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
const path = () => screen.getByTestId('path').textContent;
const readStateCalls = () => api.calls.filter((c) => c.path === '/api/entries/read-state');

beforeEach(() => {
  localStorage.clear();
  media = installMatchMedia();
  api = installFakeApi();
  api.set('GET /api/folders', { body: { items: [] } });
  api.set('GET /api/subscriptions', { body: { items: [sub] } });
  api.set('GET /api/counts', { body: COUNTS });
  api.set('GET /api/entries?view=all&state=unread&limit=50', {
    body: { items: ENTRIES.map(summary), nextCursor: null, asOf: new Date(NOW).toISOString() },
  });
  for (const e of ENTRIES) api.set(`GET /api/entries/${e.id}`, { body: e });
  api.set('POST /api/entries/read-state', { body: { updated: 1 } });
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  reportReachable(true);
  toastStore.dismiss();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('TID-054: the title opens the original', () => {
  it('is a link to the URL in a new tab, still the heading', async () => {
    renderApp('/all/a/2');
    const link = await screen.findByRole('link', { name: 'Title 2' });
    expect(link).toHaveAttribute('href', 'https://example.com/post/2');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link.closest('h2')).not.toBeNull();
    expect(link.className).toMatch(/no-underline/);
    expect(link.className).not.toMatch(/(^| )underline/);
  });

  it('stays plain text when the article has no URL', async () => {
    api.set('GET /api/entries/2', { body: entry(2, { url: null }) });
    renderApp('/all/a/2');
    const heading = await screen.findByRole('heading', { level: 2, name: 'Title 2' });
    expect(heading.querySelector('a')).toBeNull();
  });
});

describe('TID-026: mark as read on scroll', () => {
  type Hit = Partial<IntersectionObserverEntry> & { target: Element };
  let fire: (hits: Hit[]) => void;
  let options: IntersectionObserverInit | undefined;
  let observed: Element[];
  beforeEach(() => {
    observed = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: (h: Hit[]) => void, o?: IntersectionObserverInit) {
          fire = (hits) => act(() => cb(hits));
          options = o;
        }
        observe(el: Element) {
          observed.push(el);
        }
        disconnect() {}
      },
    );
  });
  const rowEl = (n: number) =>
    observed.find((el) => el.getAttribute('data-entry-id') === String(n))!;
  const onScreen = (n: number): Hit => ({ target: rowEl(n), isIntersecting: true });
  const above = (n: number): Hit => ({
    target: rowEl(n),
    isIntersecting: false,
    boundingClientRect: { bottom: 50 } as DOMRectReadOnly,
    rootBounds: { top: 60 } as DOMRectReadOnly,
  });
  const below = (n: number): Hit => ({
    target: rowEl(n),
    isIntersecting: false,
    boundingClientRect: { bottom: 900 } as DOMRectReadOnly,
    rootBounds: { top: 60 } as DOMRectReadOnly,
  });

  it('marks a row read once it has been seen and then scrolls above the viewport, in one batched call', async () => {
    renderApp('/all');
    await screen.findByText('Title 3');
    // TID-064: the shell's main is the scroll container, so it is the observer root.
    expect(options?.root).toBe(screen.getByTestId('main-scroll'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    fire([onScreen(1), onScreen(2), onScreen(3)]);
    fire([above(1)]);
    fire([above(2)]);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole('heading', { name: 'Title 1' })).toHaveClass('text-fg-muted');
    expect(screen.getByRole('heading', { name: 'Title 3' })).toHaveClass('font-semibold');
    expect(client.getQueryData<Counts>(['counts'])?.total).toBe(1);
    expect(readStateCalls()).toHaveLength(0);

    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(readStateCalls()).toHaveLength(1);
    expect(readStateCalls()[0]?.body).toEqual({ entryIds: ['1', '2'], isRead: true });
    // Unread-only mode: the rows stay in the list.
    expect(screen.getByText('Title 1')).toBeInTheDocument();
  });

  it('leaves rows alone that were never seen on screen (restore, jump) or went below', async () => {
    renderApp('/all');
    await screen.findByText('Title 3');
    fire([above(1)]); // above the start position: never seen
    fire([onScreen(2)]);
    fire([below(2)]); // scrolled back up past it
    fire([onScreen(3)]);
    expect(client.getQueryData<Counts>(['counts'])?.total).toBe(3);
    expect(screen.getByRole('heading', { name: 'Title 1' })).toHaveClass('font-semibold');
    expect(readStateCalls()).toHaveLength(0);
  });

  it('flushes when the page is hidden and when the list unmounts', async () => {
    const view = renderApp('/all');
    await screen.findByText('Title 3');
    fire([onScreen(1), onScreen(2)]);
    fire([above(1)]);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    await waitFor(() => expect(readStateCalls()).toHaveLength(1));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });

    fire([above(2)]);
    view.unmount();
    await waitFor(() => expect(readStateCalls()).toHaveLength(2));
    expect(readStateCalls()[1]?.body).toEqual({ entryIds: ['2'], isRead: true });
  });

  it('rolls back and shows one toast when the call fails', async () => {
    api.set('POST /api/entries/read-state', { status: 500, body: {} });
    renderApp('/all');
    await screen.findByText('Title 3');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fire([onScreen(1), onScreen(2)]);
    fire([above(1), above(2)]);
    expect(client.getQueryData<Counts>(['counts'])?.total).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(2000));
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(client.getQueryData<Counts>(['counts'])?.total).toBe(3);
    expect(screen.getByRole('heading', { name: 'Title 1' })).toHaveClass('font-semibold');
    expect(toastStore.getSnapshot()).toMatchObject({
      kind: 'error',
      message: "Couldn't mark articles as read. Try again.",
    });
  });

  it('does nothing when markReadOnScroll is false', async () => {
    renderApp('/all', { markReadOnScroll: false });
    await screen.findByText('Title 3');
    expect(observed.filter((el) => el.hasAttribute('data-entry-id'))).toHaveLength(0);
    expect(readStateCalls()).toHaveLength(0);
  });
});

describe('TID-055: swipe gestures in the installed app', () => {
  let t = 0;
  beforeEach(() => {
    t = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => t);
  });
  const fire = (type: string, x: number, target: EventTarget = document, y = 300) =>
    act(() => {
      target.dispatchEvent(
        new PointerEvent(type, {
          // Swipes start beyond the strip iOS keeps for its own swipe-back (IOS_EDGE_PX).
          clientX: x + 40,
          clientY: y,
          pointerId: 1,
          pointerType: 'touch',
          isPrimary: true,
          bubbles: true,
        }),
      );
    });
  /** Slow drag (80 ms per step) so it is never mistaken for a flick. */
  function swipe(x0: number, xs: number[], target: EventTarget = document, release = true) {
    fire('pointerdown', x0, target);
    for (const x of xs) {
      t += 80;
      fire('pointermove', x, target);
    }
    t += 200;
    if (release) fire('pointerup', xs[xs.length - 1] ?? x0, target);
  }
  const drawer = () => screen.queryByRole('dialog', { name: 'Navigation' });
  const standalone = () => media.set('display-mode: standalone', true);

  it('a left-edge swipe on a list drags the drawer in and opens it past 40%', async () => {
    standalone();
    renderApp('/all');
    await screen.findByText('Title 1');
    fire('pointerdown', 10);
    t += 80;
    fire('pointermove', 30);
    t += 80;
    fire('pointermove', 80);
    expect(drawer()?.style.transform).toMatch(/^translateX\(-\d/); // following the finger
    t += 80;
    fire('pointermove', 200);
    t += 200;
    fire('pointerup', 200);
    await waitFor(() => expect(drawer()).not.toBeNull());
    await waitFor(() => expect(drawer()?.style.transform).toBe(''));
    expect(path()).toBe('/all');
  });

  it('releasing short of 40% snaps back and leaves no drawer', async () => {
    standalone();
    renderApp('/all');
    await screen.findByText('Title 1');
    swipe(10, [30, 60, 80]);
    expect(drawer()).not.toBeNull();
    await waitFor(() => expect(drawer()).toBeNull());
  });

  it('does nothing in a browser tab, or on a start inside the iOS edge strip', async () => {
    renderApp('/all');
    await screen.findByText('Title 1');
    swipe(10, [30, 100, 200, 300]);
    expect(drawer()).toBeNull();
    expect(document.documentElement).not.toHaveClass('swipe-nav');

    standalone();
    // Starts at x = 5: iOS's own swipe-back owns that strip, so the app leaves it alone.
    swipe(-35, [-15, 60, 160, 260]);
    expect(drawer()).toBeNull();
  });

  it('is off at desktop width', async () => {
    standalone();
    media.set('min-width: 1024px', true);
    renderApp('/all');
    await screen.findByText('Title 1');
    swipe(10, [30, 100, 200, 300]);
    expect(drawer()).toBeNull();
  });

  it('with reduced motion the drawer just opens, with nothing dragged', async () => {
    standalone();
    media.set('prefers-reduced-motion', true);
    renderApp('/all');
    await screen.findByText('Title 1');
    swipe(10, [30, 100, 150, 200]);
    await waitFor(() => expect(drawer()).not.toBeNull());
    expect(drawer()?.style.transform).toBe('');
  });

  it('the open drawer swipes left to close, in a browser tab too', async () => {
    renderApp('/all');
    await screen.findByText('Title 1');
    act(() => screen.getByRole('button', { name: 'Open navigation' }).click());
    const panel = await waitFor(() => drawer()!);
    swipe(300, [280, 200, 100], panel, false);
    expect(panel.style.transform).toMatch(/^translateX\(-/);
    fire('pointerup', 100, panel);
    await waitFor(() => expect(drawer()).toBeNull());
  });

  it('a short swipe left leaves the drawer open', async () => {
    renderApp('/all');
    await screen.findByText('Title 1');
    act(() => screen.getByRole('button', { name: 'Open navigation' }).click());
    const panel = await waitFor(() => drawer()!);
    swipe(300, [280, 260], panel);
    await waitFor(() => expect(panel.style.transform).toBe(''));
    expect(drawer()).not.toBeNull();
  });

  it('on an article a left-edge swipe past 35% goes back like the Back button', async () => {
    standalone();
    renderApp('/all/a/2');
    await screen.findByRole('link', { name: 'Title 2' });
    swipe(10, [30, 200, 400]); // 370 of 1024 px is 36%
    await waitFor(() => expect(path()).toBe('/all'));
  });

  it('on an article a short swipe snaps back and stays; a browser tab never swipes', async () => {
    standalone();
    renderApp('/all/a/2');
    await screen.findByRole('link', { name: 'Title 2' });
    swipe(10, [30, 50, 70, 90, 110]); // slow and short: 100 px of 1024
    await new Promise((r) => setTimeout(r, 300));
    expect(path()).toBe('/all/a/2');
  });

  it('does not swipe back on an article in a browser tab', async () => {
    renderApp('/all/a/2');
    await screen.findByRole('link', { name: 'Title 2' });
    swipe(10, [30, 200, 400, 600]);
    await new Promise((r) => setTimeout(r, 300));
    expect(path()).toBe('/all/a/2');
  });
});
