import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry, EntrySummary } from '@tidings/shared';
import { App } from '../App';
import { reportReachable } from '../lib/connectivity';
import { SESSION_KEY } from '../lib/session';
import { installFakeApi, type FakeApi } from '../test-api';
import { installMatchMedia } from '../test-utils';

// TID-055: the swipe gestures on a phone in the installed app. The article is a layer above its
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
  contentHtml: `<p>Body ${id}</p>`,
});
const summary = (e: Entry): EntrySummary => {
  const rest: Partial<Entry> = { ...e };
  delete rest.contentHtml;
  return rest as EntrySummary;
};

let api: FakeApi;
function Where() {
  const l = useLocation();
  return <output data-testid="path">{`${l.pathname}${l.search}`}</output>;
}
function renderApp(path: string) {
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
const path = () => screen.getByTestId('path').textContent;

beforeEach(() => {
  localStorage.clear();
  installMatchMedia({ 'display-mode: standalone': true });
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

describe('article layer (swipe back)', () => {
  async function openArticle() {
    const user = userEvent.setup();
    renderApp('/all');
    await user.click(await screen.findByRole('link', { name: /Title 1/ }));
    return screen.findByTestId('article-layer');
  }

  it('keeps the list underneath, inert and hidden, with one h1 exposed', async () => {
    const layer = await openArticle();
    const under = screen.getByTestId('list-underlay');
    expect(under).toHaveAttribute('inert');
    expect(under).toHaveAttribute('aria-hidden', 'true');
    expect(under.querySelector('ul')).not.toBeNull();
    expect(under).not.toContainElement(layer);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Back' })).toHaveLength(1);
    expect(document.querySelectorAll('#main')).toHaveLength(1);
  });

  it('shows the list moving and un-dimming while the article is dragged, then commits', async () => {
    const layer = await openArticle();
    const under = screen.getByTestId('list-underlay');
    const list = under.querySelector('ul');
    fire('pointerdown', 5);
    fire('pointermove', 20); // locks the direction
    fire('pointermove', 120);
    expect(layer.style.transform).toBe('translateX(100px)');
    expect(under.style.transform).toMatch(/^translateX\(-\d/);
    const dx = parseFloat(under.style.transform.slice(11));
    expect(dx).toBeGreaterThan(-0.3 * 375);
    expect(dx).toBeLessThan(0);
    const scrim = Number(screen.getByTestId('article-scrim').style.opacity);
    expect(scrim).toBeGreaterThan(0);
    expect(scrim).toBeLessThan(1);

    fire('pointermove', 300);
    fire('pointerup', 300);
    await waitFor(() => expect(path()).toBe('/all'), { timeout: 1000 });
    expect(screen.queryByTestId('article-layer')).toBeNull();
    // The same list, in place, with the page put back.
    expect(screen.getByTestId('list-underlay').querySelector('ul')).toBe(list);
    expect(under.style.transform).toBe('');
    expect(under).not.toHaveAttribute('inert');
  });

  it('slides back on cancel and leaves the history alone', async () => {
    const layer = await openArticle();
    const under = screen.getByTestId('list-underlay');
    fire('pointerdown', 5);
    fire('pointermove', 20);
    fire('pointermove', 30);
    expect(layer.style.transform).toMatch(/^translateX/);
    fire('pointerup', 30);
    await waitFor(() => expect(layer.style.transform).toBe(''), { timeout: 1000 });
    expect(under.style.transform).toBe('');
    expect(path()).toMatch(/^\/all\/a\/1/);
    expect(screen.getByTestId('article-layer')).toBe(layer);
  });

  it('starts each article at the top of its own scroll container', async () => {
    const user = userEvent.setup();
    await openArticle();
    const first = screen.getByTestId('article-scroll');
    first.scrollTop = 300;
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { level: 2, name: 'Title 2' });
    expect(screen.getByTestId('article-scroll').scrollTop).toBe(0);
  });
});

describe('drawer (swipe open and close)', () => {
  const drawer = () => document.getElementById('nav-drawer');

  it('opens from the edge in place: same element, no entrance animation after commit', async () => {
    renderApp('/all');
    await screen.findByRole('link', { name: /Title 1/ });
    fire('pointerdown', 5);
    fire('pointermove', 20);
    fire('pointermove', 200);
    const peek = drawer();
    expect(peek).not.toBeNull();
    expect(peek).not.toHaveClass('drawer-panel');
    fire('pointermove', 300);
    fire('pointerup', 300);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Close navigation' })).toBeInTheDocument(),
    );
    expect(drawer()).toBe(peek);
    await new Promise((r) => setTimeout(r, 300));
    expect(drawer()).toBe(peek);
    expect(peek).not.toHaveClass('drawer-panel');
    expect(screen.getByTestId('drawer-scrim')).not.toHaveClass('drawer-scrim');
    expect(peek?.style.transform).toBe('');
    expect(screen.getByTestId('drawer-scrim').style.opacity).toBe('');
  });

  it('cancels back to closed and removes the peek', async () => {
    renderApp('/all');
    await screen.findByRole('link', { name: /Title 1/ });
    fire('pointerdown', 5);
    fire('pointermove', 20);
    fire('pointermove', 35);
    expect(drawer()).not.toBeNull();
    fire('pointerup', 35);
    await waitFor(() => expect(drawer()).toBeNull(), { timeout: 1000 });
  });

  it('a swipe-close continues to closed: same element, parked off screen, no snap-back', async () => {
    const user = userEvent.setup();
    renderApp('/all');
    await user.click(await screen.findByRole('button', { name: 'Open navigation' }));
    const panel = await waitFor(() => {
      const el = drawer();
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    fire('pointerdown', 250, panel);
    fire('pointermove', 240, panel);
    fire('pointermove', 100, panel);
    fire('pointermove', 20, panel);
    fire('pointerup', 20, panel);
    expect(panel.style.transform).toBe('translateX(-100%)');
    expect(screen.getByTestId('drawer-scrim').style.opacity).toBe('0');
    expect(drawer()).toBe(panel);
    await waitFor(() => expect(drawer()).toBeNull(), { timeout: 1000 });
  });
});
