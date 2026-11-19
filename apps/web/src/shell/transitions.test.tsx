import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry, EntrySummary } from '@tidings/shared';
import { App } from '../App';
import { reportReachable } from '../lib/connectivity';
import { SESSION_KEY } from '../lib/session';
import { installFakeApi, type FakeApi } from '../test-api';
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

const ready = async () => {
  await screen.findByRole('link', { name: /Title 1/ });
};
async function open() {
  const user = userEvent.setup();
  renderApp('/all');
  await user.click(await screen.findByRole('link', { name: /Title 1/ }));
  return screen.findByTestId('article-layer');
}
const under = () => screen.getByTestId('list-underlay');
const h1 = () => screen.getByRole('heading', { level: 1 });

describe('article slide-in and out (TID-058)', () => {
  it('slides in from the right while the list shifts left and the scrim fades in, then settles', async () => {
    const layer = await open();
    const scrim = screen.getByTestId('article-scrim');
    expect(layer.style.transition).toContain('300ms');
    expect(layer.style.transform).toBe('translateX(0px)'); // the end of the transition, set after the start
    expect(under().style.transform).toBe('translateX(-112.5px)');
    expect(scrim.style.opacity).toBe('1');
    // Focus waits for the slide to end, then lands on the heading.
    expect(h1()).not.toHaveFocus();
    await waitFor(() => expect(h1()).toHaveFocus(), { timeout: 1500 });
    expect(layer.style.transform).toBe('');
    expect(layer.style.transition).toBe('');
    expect(under().style.transform).toBe('');
    expect(scrim.style.opacity).toBe('');
    expect(under()).toHaveAttribute('inert');
    expect(under()).toHaveAttribute('aria-hidden', 'true');
  });

  it('Back slides the layer out and the list back in, then goes back', async () => {
    const layer = await open();
    await waitFor(() => expect(h1()).toHaveFocus(), { timeout: 1500 });
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(layer.style.transform).toBe('translateX(375px)');
    expect(layer.style.transition).toContain('300ms');
    expect(under().style.transform).toBe('translateX(0px)');
    expect(screen.getByTestId('article-scrim').style.opacity).toBe('0');
    expect(path()).toBe('/all/a/1?state=unread'); // not yet: the slide goes first
    await waitFor(() => expect(screen.queryByTestId('article-layer')).toBeNull(), {
      timeout: 1500,
    });
    expect(path()).toBe('/all');
    expect(under().style.transform).toBe('');
  });

  it('does not animate for a direct link or reload', async () => {
    renderApp('/all/a/1');
    const layer = await screen.findByTestId('article-layer');
    expect(layer.style.transition).toBe('');
    expect(layer.style.transform).toBe('');
    expect(under().style.transform).toBe('');
  });

  it('does not animate with reduced motion, and focuses the heading at once', async () => {
    installMatchMedia({ 'prefers-reduced-motion': true });
    const layer = await open();
    expect(layer.style.transition).toBe('');
    expect(layer.style.transform).toBe('');
    expect(under().style.transform).toBe('');
    await waitFor(() => expect(h1()).toHaveFocus());
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(path()).toBe('/all'); // no waiting for a slide
  });

  it('Next slides the new article in from the right, Previous from the left', async () => {
    await open();
    await waitFor(() => expect(h1()).toHaveFocus(), { timeout: 1500 });
    await userEvent.click(await screen.findByRole('button', { name: /Next/ }));
    await screen.findByText('Body 2');
    const main = screen.getByTestId('article-scroll');
    expect(main.style.transition).toContain('180ms');
    await waitFor(() => expect(main.style.transition).toBe(''), { timeout: 1000 });
    await userEvent.click(await screen.findByRole('button', { name: /Previous/ }));
    await screen.findByText('Body 1');
    expect(screen.getByTestId('article-scroll').style.transition).toContain('180ms');
  });
});

describe('pull to refresh stretches the content, not the header (TID-058)', () => {
  const header = () => screen.getByRole('banner').parentElement as HTMLElement;
  const content = () => screen.getByRole('list').closest('div.relative') as HTMLElement;
  // TID-064: touches land on the shell's scrolling main (not on the window).
  const main = () => screen.getByTestId('main-scroll');

  it('moves the list content down with resistance and leaves the header alone, then springs back', async () => {
    renderApp('/all');
    await ready();
    fireEvent.touchStart(main(), { touches: [{ clientY: 100 }] });
    const move = (y: number) =>
      fireEvent.touchMove(main(), { touches: [{ clientY: y }], cancelable: true });
    move(140);
    expect(content().style.transform).toBe('translateY(20px)'); // half the finger travel
    expect(header().style.transform).toBe('');
    expect(screen.getByText('Pull to refresh')).toBeInTheDocument();
    move(600); // far past the threshold: stiffer, and capped
    const px = parseFloat(content().style.transform.slice(11));
    expect(px).toBeGreaterThan(64);
    expect(px).toBeLessThan(104);
    expect(header().style.transform).toBe('');
    expect(screen.getByText('Release to refresh')).toBeInTheDocument();
    fireEvent.touchEnd(main());
    await waitFor(() => expect(content().style.transform).toBe(''), { timeout: 2000 });
    expect(header().style.transform).toBe('');
  });

  it('a pull does not block ordinary scrolling: only a downward pull from the top is cancelled', async () => {
    renderApp('/all');
    await ready();
    fireEvent.touchStart(main(), { touches: [{ clientY: 300 }] });
    // Scrolling up is never cancelled (and there is no JS stretch at the bottom any more).
    const up = new TouchEvent('touchmove', {
      touches: [{ clientY: 200 } as Touch],
      cancelable: true,
    });
    act(() => void main().dispatchEvent(up));
    expect(up.defaultPrevented).toBe(false);
    const down = new TouchEvent('touchmove', {
      touches: [{ clientY: 380 } as Touch],
      cancelable: true,
    });
    act(() => void main().dispatchEvent(down));
    expect(down.defaultPrevented).toBe(true);
    fireEvent.touchEnd(main());
  });

  it('with reduced motion nothing stretches, the indicator still shows', async () => {
    installMatchMedia({ 'prefers-reduced-motion': true });
    renderApp('/all');
    await ready();
    fireEvent.touchStart(main(), { touches: [{ clientY: 100 }] });
    fireEvent.touchMove(main(), { touches: [{ clientY: 300 }] });
    expect(await screen.findByText('Release to refresh')).toBeInTheDocument();
    expect(content().style.transform).toBe('');
    fireEvent.touchEnd(main());
  });
});
