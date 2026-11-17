import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Subscription } from '@tidings/shared';
import { App } from '../App';
import { SESSION_KEY } from '../lib/session';
import { toastStore } from '../lib/toast';
import { installFakeApi, type FakeApi } from '../test-api';
import { installMatchMedia } from '../test-utils';

// TID-013 UI (docs/ux/FLOWS.md 2.3): the add-feed screen at /manage/add, driven through the real
// App and shell against a fake API.

const OWNER = { id: 'u1', displayName: 'Matt', role: 'owner', settings: {} } as const;
const MARK = 'ORACLE-MARKER-7f3a';

function sub(over: Partial<Subscription> = {}): Subscription {
  return {
    id: 's1',
    folderId: null,
    title: 'Example Blog',
    customTitle: null,
    feedUrl: 'https://example.com/feed.xml',
    siteUrl: null,
    createdAt: '2026-11-10T12:00:00.000Z',
    health: {
      state: 'ok',
      lastSuccessAt: null,
      lastAttemptAt: null,
      errorCode: null,
      errorMessage: null,
      nextFetchAt: '2026-11-10T12:30:00.000Z',
      warning: null,
    },
    ...over,
  };
}

const apiError = (status: number, code: string, details?: unknown, message = 'x') => ({
  status,
  body: { error: { code, message, ...(details === undefined ? {} : { details }) } },
});

let api: FakeApi;

function Probe() {
  const location = useLocation();
  return <output data-testid="path">{location.pathname}</output>;
}

function renderAdd() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(SESSION_KEY, { user: OWNER, setupRequired: false, mustAddPasskey: false });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/manage/add']}>
        <App />
        <Probe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const path = () => screen.getByTestId('path').textContent;
const addButton = () => screen.getByRole('button', { name: /^Add feed|^Adding feed/ });
const urlField = () => screen.getByLabelText('Feed or website address');

function setOnline(value: boolean) {
  vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(value);
  act(() => {
    window.dispatchEvent(new Event(value ? 'online' : 'offline'));
  });
}

const posts = () => api.calls.filter((c) => c.method === 'POST' && c.path === '/api/subscriptions');

beforeEach(() => {
  localStorage.clear();
  installMatchMedia();
  api = installFakeApi();
  api.set('GET /api/folders', {
    body: {
      items: [
        { id: 'f1', name: 'Tech' },
        { id: 'f2', name: 'News' },
      ],
    },
  });
  toastStore.dismiss();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the form', () => {
  it('shows one address field, an optional folder and title, and an Add feed button', async () => {
    renderAdd();
    expect(urlField()).toBeInTheDocument();
    expect(screen.getByLabelText('Folder (optional)')).toBeInTheDocument();
    expect(screen.getByLabelText('Title (optional)')).toBeInTheDocument();
    expect(addButton()).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('option', { name: 'Tech' })).toBeInTheDocument());
    expect(screen.getByRole('option', { name: 'No folder' })).toBeInTheDocument();
  });

  it('an empty address is an inline error and sends nothing', async () => {
    const user = userEvent.setup();
    renderAdd();
    await user.click(addButton());
    expect(screen.getByText('Enter an address to continue.')).toBeInTheDocument();
    expect(urlField()).toHaveAttribute('aria-invalid', 'true');
    expect(posts()).toHaveLength(0);
  });

  it('offline: the button is disabled with "You\'re offline" helper text, and a press sends nothing', async () => {
    const user = userEvent.setup();
    renderAdd();
    setOnline(false);
    expect(addButton()).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText("You're offline")).toBeInTheDocument();
    await user.type(urlField(), 'https://example.com/feed.xml');
    await user.click(addButton());
    expect(posts()).toHaveLength(0);
    setOnline(true);
    expect(screen.queryByText("You're offline")).not.toBeInTheDocument();
  });
});

describe('AC1 and AC8: adding a feed', () => {
  it('posts the address, shows a toast, and opens the feed', async () => {
    api.set('POST /api/subscriptions', {
      status: 201,
      body: { subscription: sub(), fetch: { ok: true, newEntries: 10 } },
    });
    const user = userEvent.setup();
    renderAdd();
    await user.type(urlField(), '  https://example.com/feed.xml ');
    await user.click(addButton());

    await waitFor(() => expect(path()).toBe('/feeds/s1'));
    expect(posts()[0]?.body).toEqual({ url: 'https://example.com/feed.xml' });
    expect(toastStore.getSnapshot()?.message).toBe('Added Example Blog');
  });

  it('sends the chosen folder and the custom title', async () => {
    api.set('POST /api/subscriptions', {
      status: 201,
      body: { subscription: sub({ folderId: 'f1' }), fetch: { ok: true, newEntries: 3 } },
    });
    const user = userEvent.setup();
    renderAdd();
    await waitFor(() => expect(screen.getByRole('option', { name: 'Tech' })).toBeInTheDocument());
    await user.type(urlField(), 'https://example.com/feed.xml');
    await user.selectOptions(screen.getByLabelText('Folder (optional)'), 'Tech');
    await user.type(screen.getByLabelText('Title (optional)'), 'My news');
    await user.click(addButton());

    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.body).toEqual({
      url: 'https://example.com/feed.xml',
      folderId: 'f1',
      title: 'My news',
    });
  });

  it('Enter in the address field submits, once, even if pressed twice quickly', async () => {
    let resolve: () => void = () => undefined;
    api.set(
      'POST /api/subscriptions',
      () =>
        new Promise((r) => {
          resolve = () =>
            r({ status: 201, body: { subscription: sub(), fetch: { ok: true, newEntries: 1 } } });
        }),
    );
    const user = userEvent.setup();
    renderAdd();
    await user.type(urlField(), 'https://example.com/feed.xml{Enter}{Enter}');
    expect(addButton()).toHaveAttribute('aria-busy', 'true');
    expect(addButton()).toHaveTextContent('Adding feed...');
    resolve();
    await waitFor(() => expect(path()).toBe('/feeds/s1'));
    expect(posts()).toHaveLength(1);
  });
});

describe('AC2: a website with several feeds, or none', () => {
  const candidates = [
    { url: 'https://example.com/rss.xml', title: 'Posts', type: 'rss', supported: true },
    { url: 'https://example.com/atom.xml', title: null, type: 'atom', supported: true },
    { url: 'https://example.com/f.json', title: 'JSON', type: 'json', supported: false },
  ];

  it('lists the candidates, JSON Feed disabled as "Not supported yet"; picking one subscribes to it', async () => {
    api.set('POST /api/subscriptions', (body) => {
      const url = (body as { url: string }).url;
      return url === 'https://example.com'
        ? apiError(422, 'feed_choice_required', { candidates })
        : { status: 201, body: { subscription: sub(), fetch: { ok: true, newEntries: 2 } } };
    });
    const user = userEvent.setup();
    renderAdd();
    await user.type(urlField(), 'https://example.com');
    await user.click(addButton());

    const heading = await screen.findByRole('heading', { name: 'We found 3 feeds on this site' });
    expect(heading).toHaveFocus();
    const json = screen.getByRole('button', { name: /JSON.*Not supported yet/ });
    expect(json).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /Posts/ }));
    await waitFor(() => expect(path()).toBe('/feeds/s1'));
    expect(posts().map((p) => p.body)).toEqual([
      { url: 'https://example.com' },
      { url: 'https://example.com/rss.xml' },
    ]);
  });

  it('"Try a different address" returns to the form with the address kept', async () => {
    api.set('POST /api/subscriptions', apiError(422, 'feed_choice_required', { candidates }));
    const user = userEvent.setup();
    renderAdd();
    await user.type(urlField(), 'https://example.com');
    await user.click(addButton());
    await user.click(await screen.findByRole('button', { name: 'Try a different address' }));
    expect(urlField()).toHaveValue('https://example.com');
  });

  it('none found: the UX copy appears under the field', async () => {
    api.set('POST /api/subscriptions', apiError(422, 'no_feed_found'));
    const user = userEvent.setup();
    renderAdd();
    await user.type(urlField(), 'https://example.com');
    await user.click(addButton());
    expect(await screen.findByText("We couldn't find a feed at that address.")).toBeInTheDocument();
    expect(urlField()).toHaveAttribute('aria-invalid', 'true');
    expect(urlField()).toHaveFocus();
  });
});

describe('AC3: already subscribed', () => {
  it('says so and offers to open the existing feed', async () => {
    api.set(
      'POST /api/subscriptions',
      apiError(409, 'already_subscribed', { subscriptionId: 's9' }),
    );
    const user = userEvent.setup();
    renderAdd();
    await user.type(urlField(), 'https://example.com/feed.xml');
    await user.click(addButton());
    expect(await screen.findByText(/You already follow this feed/)).toBeInTheDocument();
    const open = screen.getByRole('link', { name: 'Open it' });
    expect(open).toHaveAttribute('href', '/feeds/s9');
    await user.click(open);
    expect(path()).toBe('/feeds/s9');
  });
});

describe('AC5: the first fetch failed', () => {
  it('the subscription exists: the screen explains that it will retry, with the fixed reason', async () => {
    api.set('POST /api/subscriptions', {
      status: 201,
      body: {
        subscription: sub({ health: { ...sub().health, state: 'failing' } }),
        fetch: { ok: false, newEntries: 0, errorCode: 'timeout' },
      },
    });
    const user = userEvent.setup();
    renderAdd();
    await user.type(urlField(), 'https://example.com/feed.xml');
    await user.click(addButton());

    expect(await screen.findByRole('heading', { name: 'Added Example Blog' })).toHaveFocus();
    expect(
      screen.getByText(
        "We couldn't load it just now (Timed out after 10 s). Tidings will keep trying in the background.",
      ),
    ).toBeInTheDocument();
    expect(path()).toBe('/manage/add');
    expect(screen.getByRole('link', { name: 'Open feed' })).toHaveAttribute('href', '/feeds/s1');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Add another feed' }));
    expect(urlField()).toHaveValue('');
  });
});

describe('AC6 and AC7: refusals', () => {
  it('a blocked address is a field error with the fixed message', async () => {
    api.set('POST /api/subscriptions', apiError(422, 'blocked_address'));
    const user = userEvent.setup();
    renderAdd();
    await user.type(urlField(), 'http://127.0.0.1/');
    await user.click(addButton());
    expect(await screen.findByText('This address is not allowed.')).toBeInTheDocument();
  });

  it('a bad address (400) asks for a web address', async () => {
    api.set('POST /api/subscriptions', apiError(400, 'validation_failed'));
    const user = userEvent.setup();
    renderAdd();
    await user.type(urlField(), 'nonsense');
    await user.click(addButton());
    expect(
      await screen.findByText('Enter a web address, like https://example.com/feed.xml'),
    ).toBeInTheDocument();
  });

  it('1,000 feeds: the limit message in an alert', async () => {
    api.set('POST /api/subscriptions', apiError(422, 'limit_reached'));
    const user = userEvent.setup();
    renderAdd();
    await user.type(urlField(), 'https://example.com/feed.xml');
    await user.click(addButton());
    const alert = await screen.findByText("You've reached the limit of 1,000 feeds.");
    expect(alert.closest('[role="alert"]')).not.toBeNull();
  });

  it('a folder that no longer exists is reported and the list is refetched', async () => {
    api.set('POST /api/subscriptions', apiError(404, 'not_found'));
    const user = userEvent.setup();
    renderAdd();
    await waitFor(() => expect(screen.getByRole('option', { name: 'Tech' })).toBeInTheDocument());
    await user.type(urlField(), 'https://example.com/feed.xml');
    await user.selectOptions(screen.getByLabelText('Folder (optional)'), 'Tech');
    await user.click(addButton());
    expect(
      await screen.findByText('That folder no longer exists. Choose another folder.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Folder (optional)')).toHaveValue('');
    expect(api.calls.filter((c) => c.path === '/api/folders').length).toBeGreaterThan(1);
  });

  it('rate limited, a network failure and a server error each get their own fixed message', async () => {
    const user = userEvent.setup();
    renderAdd();
    await user.type(urlField(), 'https://example.com/feed.xml');

    api.set('POST /api/subscriptions', apiError(429, 'rate_limited'));
    await user.click(addButton());
    expect(
      await screen.findByText('Too many requests. Try again in a minute.'),
    ).toBeInTheDocument();

    api.set('POST /api/subscriptions', apiError(500, 'internal'));
    await user.click(addButton());
    expect(
      await screen.findByText('Something went wrong on our side. Try again.'),
    ).toBeInTheDocument();

    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    await user.click(addButton());
    expect(
      await screen.findByText("Couldn't reach Tidings. Check your connection and try again."),
    ).toBeInTheDocument();
  });
});

describe('AC10: only fixed messages reach the screen', () => {
  it('a server error whose message carries a marker: the marker is never shown', async () => {
    api.set(
      'POST /api/subscriptions',
      apiError(500, 'internal', { leaked: MARK }, `stack trace ${MARK}`),
    );
    const user = userEvent.setup();
    renderAdd();
    await user.type(urlField(), 'https://example.com/feed.xml');
    await user.click(addButton());
    await screen.findByText('Something went wrong on our side. Try again.');
    expect(document.body.textContent).not.toContain(MARK);
  });

  it('a failed first fetch shows the fixed message for its code, and nothing for an unknown code', async () => {
    api.set('POST /api/subscriptions', {
      status: 201,
      body: {
        subscription: sub(),
        fetch: { ok: false, newEntries: 0, errorCode: 'http_503' },
      },
    });
    const user = userEvent.setup();
    renderAdd();
    await user.type(urlField(), 'https://example.com/feed.xml');
    await user.click(addButton());
    expect(
      await screen.findByText(/The server returned 503 Service Unavailable/),
    ).toBeInTheDocument();

    api.set('POST /api/subscriptions', {
      status: 201,
      body: { subscription: sub(), fetch: { ok: false, newEntries: 0, errorCode: MARK } },
    });
    await user.click(screen.getByRole('button', { name: 'Add another feed' }));
    await user.type(urlField(), 'https://example.com/other.xml');
    await user.click(addButton());
    await screen.findByText(/It did not respond/);
    expect(document.body.textContent).not.toContain(MARK);
  });

  it('candidate titles are shown as text, never as markup', async () => {
    api.set(
      'POST /api/subscriptions',
      apiError(422, 'feed_choice_required', {
        candidates: [
          {
            url: 'https://example.com/a.xml',
            title: '<img src=x onerror=alert(1)>',
            type: 'rss',
            supported: true,
          },
          { url: 'https://example.com/b.xml', title: null, type: 'atom', supported: true },
        ],
      }),
    );
    const user = userEvent.setup();
    renderAdd();
    await user.type(urlField(), 'https://example.com');
    await user.click(addButton());
    const list = await screen.findByRole('list');
    expect(within(list).getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(list.querySelector('img')).toBeNull();
  });
});
