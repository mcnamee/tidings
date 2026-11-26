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
  topics: [],
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
    await waitFor(() => expect(path()).toBe('/all?state=unread'), { timeout: 1000 });
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
  // TID-075: the page card moves aside (by the drawer's 320 px) to reveal the panel under it.
  const page = () => screen.getByTestId('list-underlay');
  const pageX = () => parseFloat(page().style.transform.slice(11));

  it('opens from the edge in place: same element, the page follows and ends 320 px aside', async () => {
    renderApp('/all');
    await screen.findByRole('link', { name: /Title 1/ });
    fire('pointerdown', 5);
    fire('pointermove', 20);
    fire('pointermove', 200);
    const peek = drawer();
    expect(peek).not.toBeNull();
    // Mid-drag: the page is a detached, rounded card that has followed the finger, the shade is
    // partway, and the panel underneath is still parallaxing in.
    expect(page()).toHaveClass('reveal-card');
    expect(page().className).toContain('max-lg:fixed');
    expect(pageX()).toBeGreaterThan(0);
    expect(pageX()).toBeLessThan(320);
    expect(page().style.borderRadius).toMatch(/px 0px 0px \d/);
    const shade = Number(screen.getByTestId('drawer-scrim').style.opacity);
    expect(shade).toBeGreaterThan(0);
    expect(shade).toBeLessThan(1);
    expect(peek?.style.transform).toMatch(/^translateX\(-/);
    fire('pointermove', 300);
    fire('pointerup', 300);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Close navigation' })).toBeInTheDocument(),
    );
    expect(drawer()).toBe(peek);
    await new Promise((r) => setTimeout(r, 400));
    expect(drawer()).toBe(peek);
    expect(pageX()).toBe(320);
    expect(page().style.borderRadius).toBe('28px 0px 0px 28px');
    expect(peek?.style.transform).toBe('translateX(0px)');
    expect(screen.getByTestId('drawer-scrim').style.opacity).toBe('0.7');
    // Open: only the page's contents are inert (not the shade, the visible strip that closes).
    expect(screen.getByRole('main').closest('[inert]')).not.toBeNull();
    expect(screen.getByTestId('drawer-scrim').closest('[inert]')).toBeNull();
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
    // The page is a normal in-flow page again.
    expect(page().style.transform).toBe('');
    expect(page().className).not.toContain('reveal-card');
  });

  it('a swipe-close drags the page back, then continues to closed with no snap-back', async () => {
    const user = userEvent.setup();
    renderApp('/all');
    await user.click(await screen.findByRole('button', { name: 'Open navigation' }));
    const panel = await waitFor(() => {
      const el = drawer();
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    await waitFor(() => expect(pageX()).toBe(320));
    fire('pointerdown', 250, panel);
    fire('pointermove', 240, panel);
    fire('pointermove', 100, panel);
    expect(pageX()).toBeLessThan(320);
    fire('pointermove', 20, panel);
    fire('pointerup', 20, panel);
    expect(pageX()).toBe(0); // heading for closed, same element
    expect(screen.getByTestId('drawer-scrim').style.opacity).toBe('0');
    expect(drawer()).toBe(panel);
    await waitFor(() => expect(drawer()).toBeNull(), { timeout: 1000 });
    expect(page().style.transform).toBe('');
  });

  it('a tap on the visible strip of the page closes it (the scrim is the strip)', async () => {
    const user = userEvent.setup();
    renderApp('/all');
    await user.click(await screen.findByRole('button', { name: 'Open navigation' }));
    await waitFor(() => expect(pageX()).toBe(320));
    await user.click(screen.getByTestId('drawer-scrim'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(drawer()).toBeNull(), { timeout: 1000 });
  });

  it('reopening during the slide-out starts from where the page is, not from closed', async () => {
    const user = userEvent.setup();
    renderApp('/all');
    await user.click(await screen.findByRole('button', { name: 'Open navigation' }));
    await waitFor(() => expect(pageX()).toBe(320));
    await user.keyboard('{Escape}');
    expect(pageX()).toBe(0); // sliding out
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    await waitFor(() => expect(pageX()).toBe(320));
    expect(screen.getByRole('dialog', { name: 'Navigation' })).toBeInTheDocument();
    expect(page().className).toContain('max-lg:fixed');
  });

  it('keeps the list scroll: the page is frozen while the drawer is up and restored exactly', async () => {
    const scrollTo = vi.fn();
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
    Object.defineProperty(window, 'scrollY', { value: 240, configurable: true });
    const user = userEvent.setup();
    renderApp('/all');
    await screen.findByRole('link', { name: /Title 1/ });
    act(() => void window.dispatchEvent(new Event('scroll')));
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    // Frozen: content shifted up by the scroll it had, the document scrolled to the top.
    expect(screen.getByTestId('main-scroll').style.top).toBe('-240px');
    expect(scrollTo).toHaveBeenLastCalledWith(0, 0);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(drawer()).toBeNull(), { timeout: 1000 });
    expect(screen.getByTestId('main-scroll').style.top).toBe('');
    expect(scrollTo).toHaveBeenLastCalledWith(0, 240);
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
  });

  it('closing through a link to another list starts that list at the top', async () => {
    const scrollTo = vi.fn();
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
    Object.defineProperty(window, 'scrollY', { value: 240, configurable: true });
    const user = userEvent.setup();
    renderApp('/all');
    await screen.findByRole('link', { name: /Title 1/ });
    act(() => void window.dispatchEvent(new Event('scroll')));
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    await user.click(screen.getByRole('link', { name: 'Settings' }));
    await waitFor(() => expect(drawer()).toBeNull(), { timeout: 1000 });
    expect(scrollTo).toHaveBeenLastCalledWith(0, 0);
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
  });
});
