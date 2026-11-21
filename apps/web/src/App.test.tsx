import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { fetchHealth } from './api';
import { SESSION_KEY } from './lib/session';
import { toast } from './lib/toast';
import { installFakeApi, type FakeApi } from './test-api';
import { installMatchMedia, type FakeMedia } from './test-utils';

describe('fetchHealth', () => {
  it('returns the parsed health response', async () => {
    const fake = (async () =>
      new Response(JSON.stringify({ ok: true, version: '1.2.3' }))) as unknown as typeof fetch;
    await expect(fetchHealth(fake)).resolves.toEqual({ ok: true, version: '1.2.3' });
  });

  it('throws on a non-2xx response', async () => {
    const fake = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch;
    await expect(fetchHealth(fake)).rejects.toThrow(/500/);
  });
});

function Probe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <div>
      <output data-testid="path">{location.pathname}</output>
      <button type="button" onClick={() => navigate(-1)}>
        system back
      </button>
    </div>
  );
}

// Every test starts with "a user exists, nobody is signed in"; setup tests change it.
let api: FakeApi;
beforeEach(() => {
  api = installFakeApi();
  // The feed tree and the lists read these (TID-018). One folder and one feed that the route
  // fixtures below use; the lists themselves are tested in lists/ArticleList.test.tsx.
  api.set('GET /api/folders', { body: { items: [{ id: 'f1', name: 'Tech' }] } });
  api.set('GET /api/subscriptions', { body: { items: [] } });
  api.set('GET /api/counts', { body: { total: 0, folders: {}, subscriptions: {} } });
});
afterEach(() => vi.unstubAllGlobals());

const OWNER = { id: 'u1', displayName: 'Matt', role: 'owner', settings: {} } as const;

/** Shell tests start signed in (the session cache is seeded, so nothing is fetched). */
function renderApp(entries: string[], index?: number, { signedIn = true } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (signedIn) {
    client.setQueryData(SESSION_KEY, { user: OWNER, setupRequired: false, mustAddPasskey: false });
  }
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter
        initialEntries={entries}
        {...(index === undefined ? {} : { initialIndex: index })}
      >
        <App />
        <Probe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const path = () => screen.getByTestId('path').textContent;
const SHELL_ROUTES: Array<[string, string]> = [
  ['/all', 'All articles'],
  ['/all/a/e1', 'All articles'],
  ['/manage', 'Manage feeds'],
  ['/manage/add', 'Add a feed'],
  ['/manage/import', 'Import from OPML'],
  ['/settings', 'Settings'],
];
const AUTH_ROUTES: Array<[string, string]> = [
  ['/setup', 'Set up Tidings'],
  ['/login', 'Sign in'],
  ['/recover', 'Use a recovery code'],
];

describe('routing placeholders (spec 11.1)', () => {
  let media: FakeMedia;
  beforeEach(() => {
    localStorage.clear();
    media = installMatchMedia();
  });

  it.each(SHELL_ROUTES)('%s renders the shell with one h1 "%s"', (route, title) => {
    renderApp([route]);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(title);
    expect(document.title).toBe(`${title} - Tidings`);
    expect(screen.getByRole('banner')).toBeInTheDocument();
    // /manage/add (TID-013), /manage/import (TID-016), /manage (TID-014) and the lists (TID-018) are built; every other
    // route is a placeholder.
    if (route === '/manage') {
      expect(screen.getByRole('main')).not.toHaveTextContent("This screen isn't built yet.");
    } else if (route === '/manage/add') {
      expect(screen.getByLabelText('Feed or website address')).toBeInTheDocument();
    } else if (route === '/manage/import') {
      expect(screen.getByText('Choose OPML file')).toBeInTheDocument(); // TID-016
    } else if (route === '/settings') {
      expect(screen.getByRole('heading', { level: 2, name: 'Appearance' })).toBeInTheDocument(); // TID-022
    } else if (route === '/all') {
      expect(screen.getByTestId('list-skeleton')).toBeInTheDocument();
    } else if (route === '/all/a/e1') {
      expect(screen.getByTestId('article-skeleton')).toBeInTheDocument(); // TID-019
    } else {
      expect(screen.getByRole('main')).toHaveTextContent("This screen isn't built yet.");
    }
    expect(screen.getByRole('region', { name: 'Notifications' })).toBeInTheDocument();
  });

  // The header never says "Feed" or "Folder" (spec 11.1): a skeleton, with the word only in document.title.
  it.each([
    ['/folders/f1/a/e1', 'Folder'],
    ['/feeds/s1/a/e1', 'Feed'],
  ])('%s shows a skeleton in the header while the name loads', (route, fallback) => {
    renderApp([route]);
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1).toHaveAttribute('aria-busy', 'true');
    expect(h1).not.toHaveTextContent(fallback);
    expect(document.title).toBe(`${fallback} - Tidings`);
  });

  it.each(AUTH_ROUTES)(
    '%s renders the auth layout without header or navigation',
    async (route, title) => {
      // /setup only shows its form while setup is open.
      api.set('GET /api/auth/session', {
        body: { user: null, setupRequired: route === '/setup', mustAddPasskey: false },
      });
      renderApp([route], undefined, { signedIn: false });
      expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(title);
      expect(screen.queryByRole('banner')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Open navigation' })).not.toBeInTheDocument();
      expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    },
  );

  it('All articles shows the Tidings logo in the header, keeping the heading name; other lists keep their title', async () => {
    renderApp(['/all']);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'All articles' }),
    ).toBeInTheDocument();
    expect(await screen.findByTestId('header-logo')).toHaveTextContent('Tidings');
    renderApp(['/manage']);
    expect(await screen.findAllByTestId('header-logo')).toHaveLength(1);
  });

  it('shows Menu on top-level screens and Back on sub-pages and articles', () => {
    renderApp(['/manage']);
    expect(screen.getByRole('button', { name: 'Open navigation' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
    renderApp(['/manage/add']);
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
  });

  it('Back on an article opened directly goes to its list', async () => {
    renderApp(['/feeds/s1/a/e1']);
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    // The layer slides out first (TID-058).
    await vi.waitFor(() => expect(path()).toBe('/feeds/s1'), { timeout: 1500 });
  });

  it('Back on Add a feed and Import goes one entry back when the app has history', async () => {
    renderApp(['/all', '/manage/add'], 1);
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(path()).toBe('/all');
  });

  it('Back on Import opened directly goes to Manage', async () => {
    renderApp(['/manage/import']);
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(path()).toBe('/manage');
  });

  it('Back on Add a feed opened directly goes to Manage', async () => {
    renderApp(['/manage/add']);
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(path()).toBe('/manage');
  });

  it('unknown routes show the not found screen', () => {
    renderApp(['/nope/at/all']);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Page not found');
    expect(document.title).toBe('Page not found - Tidings');
    expect(screen.getByText("We couldn't find that page.")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to All articles' })).toHaveAttribute(
      'href',
      '/all',
    );
  });

  it('/ redirects to /all with no stored list', () => {
    renderApp(['/']);
    expect(path()).toBe('/all');
  });

  it('/ redirects to the last viewed list when it still exists (TID-018 AC11)', async () => {
    localStorage.setItem('tidings.lastList', '/folders/f1');
    renderApp(['/']);
    await vi.waitFor(() => expect(path()).toBe('/folders/f1'));
  });

  it('/ falls back to /all when the stored folder or feed no longer exists (TID-018 AC11)', async () => {
    localStorage.setItem('tidings.lastList', '/folders/f9');
    renderApp(['/']);
    await vi.waitFor(() => expect(path()).toBe('/all'));
  });

  it('/ falls back to /all for a stored feed that no longer exists (TID-018 AC11)', async () => {
    localStorage.setItem('tidings.lastList', '/feeds/gone');
    renderApp(['/']);
    await vi.waitFor(() => expect(path()).toBe('/all'));
  });

  it('/ ignores a stored value that is not a list path', () => {
    localStorage.setItem('tidings.lastList', 'https://evil.example/');
    renderApp(['/']);
    expect(path()).toBe('/all');
  });

  it('remembers list screens but not articles or settings', () => {
    renderApp(['/feeds/s1']);
    expect(localStorage.getItem('tidings.lastList')).toBe('/feeds/s1');
    renderApp(['/settings']);
    renderApp(['/feeds/s1/a/e1']);
    expect(localStorage.getItem('tidings.lastList')).toBe('/feeds/s1');
  });

  it('at 1024px and up renders the sidebar and no Menu button', () => {
    media.set('min-width: 1024px', true);
    renderApp(['/all']);
    expect(screen.queryByRole('button', { name: 'Open navigation' })).not.toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Feeds and folders' });
    expect(nav).toBeInTheDocument();
    expect(screen.getAllByRole('navigation')).toHaveLength(1);
    // Sidebar comes before the header in the DOM so the skip link has something to skip.
    expect(nav.compareDocumentPosition(screen.getByRole('banner'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('below 1024px the navigation is not in the DOM until the drawer opens', () => {
    renderApp(['/all']);
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('has a skip link to main and a focusable main', () => {
    renderApp(['/all']);
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute('href', '#main');
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main');
    expect(screen.getByRole('main')).toHaveAttribute('tabindex', '-1');
  });

  it('shows the offline banner as a status and hides it when back online', () => {
    renderApp(['/all']);
    expect(screen.queryByText("You're offline. Showing saved articles.")).not.toBeInTheDocument();
    act(() => {
      Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
      window.dispatchEvent(new Event('offline'));
    });
    expect(
      screen.getByText("You're offline. Showing saved articles.").closest('[role=status]'),
    ).not.toBeNull();
    act(() => {
      Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
      window.dispatchEvent(new Event('online'));
    });
    expect(screen.queryByText("You're offline. Showing saved articles.")).not.toBeInTheDocument();
  });

  it.each(['/manage', '/manage/add', '/manage/import', '/settings'])(
    'says changes cannot be saved, not "saved articles", on %s',
    (path) => {
      renderApp([path]);
      act(() => {
        Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
        window.dispatchEvent(new Event('offline'));
      });
      expect(screen.getByText("You're offline. Changes can't be saved.")).toBeInTheDocument();
      expect(screen.queryByText(/Showing saved articles/)).not.toBeInTheDocument();
      act(() => {
        Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
        window.dispatchEvent(new Event('online'));
      });
    },
  );
});

describe('navigation drawer (AC4)', () => {
  beforeEach(() => {
    localStorage.clear();
    installMatchMedia();
  });

  async function openDrawer() {
    const user = userEvent.setup();
    renderApp(['/all']);
    const menu = screen.getByRole('button', { name: 'Open navigation' });
    await user.click(menu);
    return { user, menu };
  }

  it('opens from the header Menu control with the documented semantics', async () => {
    const { menu } = await openDrawer();
    const dialog = screen.getByRole('dialog', { name: 'Navigation' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('id', 'nav-drawer');
    expect(menu).toHaveAttribute('aria-expanded', 'true');
    expect(menu).toHaveAttribute('aria-controls', 'nav-drawer');
    expect(menu).toHaveAttribute('aria-haspopup', 'dialog');
    expect(within(dialog).getByRole('navigation', { name: 'Feeds and folders' })).toBeVisible();
    expect(document.documentElement).toHaveClass('scroll-locked');
  });

  it('puts first focus on Close and makes the page behind inert', async () => {
    await openDrawer();
    expect(screen.getByRole('button', { name: 'Close navigation' })).toHaveFocus();
    expect(screen.getByRole('main').closest('[inert]')).not.toBeNull();
  });

  it('traps Tab and Shift+Tab inside the drawer', async () => {
    const { user } = await openDrawer();
    const dialog = screen.getByRole('dialog');
    const inside = () => dialog.contains(document.activeElement);
    for (let i = 0; i < 15; i++) {
      await user.tab();
      expect(inside()).toBe(true);
    }
    for (let i = 0; i < 15; i++) {
      await user.tab({ shift: true });
      expect(inside()).toBe(true);
    }
  });

  it('wraps from the last control to the first and back', async () => {
    const { user } = await openDrawer();
    const dialog = screen.getByRole('dialog');
    const close = within(dialog).getByRole('button', { name: 'Close navigation' });
    await user.tab({ shift: true });
    expect(within(dialog).getByRole('link', { name: 'Settings' })).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
  });

  it('closes on Escape and returns focus to Menu', async () => {
    const { user, menu } = await openDrawer();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(menu).toHaveFocus();
    expect(menu).toHaveAttribute('aria-expanded', 'false');
    expect(document.documentElement).not.toHaveClass('scroll-locked');
    expect(path()).toBe('/all');
  });

  it('slides out on every close: stays mounted, hidden, until the slide ends', async () => {
    const { user } = await openDrawer();
    await user.keyboard('{Escape}');
    const panel = document.getElementById('nav-drawer');
    expect(panel).not.toBeNull();
    // The page card slides back over it (TID-075); the panel parallaxes back under the card.
    expect(screen.getByTestId('list-underlay').style.transform).toBe('translateX(0px)');
    expect(panel!.style.transform).toBe('translateX(-96px)');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(document.getElementById('nav-drawer')).toBeNull());
  });

  it('closes on a tap on the page strip and returns focus to Menu', async () => {
    const { user, menu } = await openDrawer();
    await user.click(screen.getByTestId('drawer-scrim'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(menu).toHaveFocus();
  });

  it('closes with the Close button', async () => {
    const { user, menu } = await openDrawer();
    await user.click(screen.getByRole('button', { name: 'Close navigation' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(menu).toHaveFocus();
  });

  it('pushes a history entry so system Back closes the drawer without leaving the screen', async () => {
    const { user } = await openDrawer();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'system back' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(path()).toBe('/all');
  });

  it('choosing a destination navigates, closes the drawer and focuses the new h1', async () => {
    const { user } = await openDrawer();
    await user.click(within(screen.getByRole('dialog')).getByRole('link', { name: 'Settings' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(path()).toBe('/settings');
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toHaveFocus();
  });

  it('replaces the drawer entry on navigation so Back leaves no open drawer behind', async () => {
    const { user } = await openDrawer();
    await user.click(within(screen.getByRole('dialog')).getByRole('link', { name: 'Manage' }));
    expect(path()).toBe('/manage');
    // History is [/all, /manage]: one Back returns to the list with the drawer closed.
    await user.click(screen.getByRole('button', { name: 'system back' }));
    expect(path()).toBe('/all');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes when the viewport grows to 1024px', async () => {
    const media = installMatchMedia();
    const user = userEvent.setup();
    renderApp(['/all']);
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    act(() => media.set('min-width: 1024px', true));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Feeds and folders' })).toBeInTheDocument();
  });

  it('ignores a stale drawer history entry from before a reload', () => {
    renderApp(['/all']);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('gives every drawer control a hit area of at least 44px (class contract)', async () => {
    await openDrawer();
    const dialog = screen.getByRole('dialog');
    const controls = [
      ...within(dialog).getAllByRole('link'),
      ...within(dialog).getAllByRole('button'),
    ];
    expect(controls.length).toBeGreaterThanOrEqual(7);
    for (const el of controls) {
      expect(el.className, el.textContent || el.getAttribute('aria-label') || '').toMatch(
        /\bmin-h-11\b|\bsize-11\b/,
      );
    }
  });
});

describe('toast region', () => {
  beforeEach(() => installMatchMedia());

  it('renders persistent polite and alert regions and announces messages', async () => {
    renderApp(['/all']);
    const region = screen.getByRole('region', { name: 'Notifications' });
    expect(within(region).getByRole('status')).toBeEmptyDOMElement();
    expect(within(region).getByRole('alert')).toBeEmptyDOMElement();
    act(() => void toast.success('Saved'));
    expect(within(within(region).getByRole('status')).getByText('Saved')).toBeInTheDocument();
    act(() => void toast.error('Nope'));
    expect(within(within(region).getByRole('alert')).getByText('Nope')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(within(region).getByRole('alert')).toBeEmptyDOMElement();
  });

  it('runs and dismisses on Undo', async () => {
    renderApp(['/all']);
    let undone = false;
    act(() => void toast.undo('Marked 14 as read', () => (undone = true)));
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(undone).toBe(true);
    expect(screen.queryByText('Marked 14 as read')).not.toBeInTheDocument();
  });
});
