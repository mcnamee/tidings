import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangeFeedUrlResponse, Subscription } from '@tidings/shared';
import { App } from '../App';
import { SESSION_KEY } from '../lib/session';
import { toastStore } from '../lib/toast';
import { installFakeApi, type FakeApi } from '../test-api';
import { installMatchMedia } from '../test-utils';

// TID-068: "Change feed address" in the feed options sheet on Manage, through the real App
// against a fake API. The fixed copy matches Add feed.

const OWNER = { id: 'u1', displayName: 'Matt', role: 'owner', settings: {} } as const;
const NEW_URL = 'https://new.example.com/feed.xml';

function sub(id: string, title: string): Subscription {
  return {
    id,
    folderId: null,
    title,
    customTitle: null,
    feedUrl: `https://${id}.example.com/feed.xml`,
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
  };
}

const apiError = (status: number, code: string, details?: unknown) => ({
  status,
  body: { error: { code, message: 'ORIGIN-TEXT-MUST-NOT-SHOW', details } },
});

let api: FakeApi;

beforeEach(() => {
  localStorage.clear();
  installMatchMedia({ 'min-width: 1024px': true });
  api = installFakeApi();
  api.set('GET /api/folders', { body: { items: [] } });
  api.set('GET /api/subscriptions', { body: { items: [sub('s1', 'Mango'), sub('s2', 'Zebra')] } });
  toastStore.dismiss();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function openSheet() {
  const user = userEvent.setup();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(SESSION_KEY, { user: OWNER, setupRequired: false, mustAddPasskey: false });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/manage']}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByRole('heading', { name: 'Folders' });
  await user.click(screen.getByRole('button', { name: 'Mango, options' }));
  await user.click(screen.getByRole('button', { name: 'Change feed address' }));
  return user;
}

const dialog = () => within(screen.getByRole('dialog'));
const field = () => dialog().getByLabelText('New feed or website address');
const posts = () => api.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/url'));

function answerOk(over: Partial<ChangeFeedUrlResponse> = {}) {
  api.set('POST /api/subscriptions/s1/url', () => ({
    body: {
      subscription: { ...sub('s1', 'Mango'), feedUrl: NEW_URL },
      fetch: { ok: true, newEntries: 3 },
      changed: true,
      ...over,
    },
  }));
}

async function submit(user: ReturnType<typeof userEvent.setup>, address = NEW_URL) {
  await user.type(field(), address);
  await user.click(dialog().getByRole('button', { name: 'Save' }));
}

describe('the sheet', () => {
  it('is an option on the feed sheet, shows the current address, a field, Save and Cancel', async () => {
    await openSheet();
    expect(dialog().getByRole('heading', { name: 'Change feed address' })).toBeVisible();
    expect(dialog().getByText('https://s1.example.com/feed.xml')).toBeVisible();
    expect(field()).toHaveFocus();
    expect(dialog().getByRole('button', { name: 'Save' })).toBeVisible();
    expect(dialog().getByRole('button', { name: 'Cancel' })).toBeVisible();
  });

  it('Cancel closes it without a request', async () => {
    const user = await openSheet();
    await user.click(dialog().getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });

  it('an empty address asks for one and sends nothing', async () => {
    const user = await openSheet();
    await user.click(dialog().getByRole('button', { name: 'Save' }));
    expect(dialog().getByText('Enter an address to continue.')).toBeVisible();
    expect(posts()).toHaveLength(0);
  });
});

describe('saving', () => {
  it('posts the trimmed address, closes, says so, and shows the new address in the list data', async () => {
    answerOk();
    const user = await openSheet();
    await submit(user, `  ${NEW_URL}  `);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(posts()[0]).toMatchObject({ path: '/api/subscriptions/s1/url', body: { url: NEW_URL } });
    expect(toastStore.getSnapshot()?.message).toBe('Feed address changed');
  });

  it('the same address (no-op) closes with its own message', async () => {
    answerOk({ changed: false });
    const user = await openSheet();
    await submit(user);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(toastStore.getSnapshot()?.message).toBe('That is already this feed’s address');
  });

  it('a first fetch that did not work: the address is saved, we keep trying, fixed reason only', async () => {
    answerOk({ fetch: { ok: false, newEntries: 0, errorCode: 'timeout' } });
    const user = await openSheet();
    await submit(user);
    const status = await screen.findByText(/The address is saved, but we couldn't load the feed/);
    expect(status).toHaveTextContent('Tidings will keep trying in the background.');
    await user.click(dialog().getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('errors use the Add feed copy, and never the server’s text', () => {
  it.each([
    ['blocked_address', 422, 'This address is not allowed.'],
    ['validation_failed', 400, 'Enter a web address, like https://example.com/feed.xml'],
    ['no_feed_found', 422, "We couldn't find a feed at that address."],
  ])('%s shows %s under the field and keeps the sheet open', async (code, status, copy) => {
    api.set('POST /api/subscriptions/s1/url', () => apiError(status, code));
    const user = await openSheet();
    await submit(user, 'https://x.example.com');
    expect(await dialog().findByText(copy)).toBeVisible();
    expect(field()).toHaveValue('https://x.example.com');
    expect(field()).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByText(/ORIGIN-TEXT/)).toBeNull();
  });

  it('already following: says so with an Open it link to that feed', async () => {
    api.set('POST /api/subscriptions/s1/url', () =>
      apiError(409, 'already_subscribed', { subscriptionId: 's2' }),
    );
    const user = await openSheet();
    await submit(user);
    expect(await dialog().findByText(/You already follow this feed/)).toBeVisible();
    const open = dialog().getByRole('link', { name: 'Open it' });
    expect(open).toHaveAttribute('href', '/feeds/s2');
    await user.click(open);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('a network failure and a server failure show fixed banners', async () => {
    api.set('POST /api/subscriptions/s1/url', () => apiError(500, 'internal'));
    const user = await openSheet();
    await submit(user);
    expect(await dialog().findByText('Something went wrong on our side. Try again.')).toBeVisible();
    expect(screen.queryByText(/ORIGIN-TEXT/)).toBeNull();
  });

  it('rate limited shows the fixed message', async () => {
    api.set('POST /api/subscriptions/s1/url', () => apiError(429, 'rate_limited'));
    const user = await openSheet();
    await submit(user);
    expect(await dialog().findByText('Too many requests. Try again in a minute.')).toBeVisible();
  });
});

describe('several feeds on a page', () => {
  const candidates = [
    { url: 'https://blog.example.com/a.xml', title: 'Posts', type: 'rss', supported: true },
    { url: 'https://blog.example.com/b.json', title: 'JSON', type: 'json', supported: false },
  ];

  it('lists them; choosing one posts that address; JSON Feed is not selectable', async () => {
    let n = 0;
    api.set('POST /api/subscriptions/s1/url', () => {
      n += 1;
      return n === 1
        ? apiError(422, 'feed_choice_required', { candidates })
        : {
            body: {
              subscription: { ...sub('s1', 'Mango'), feedUrl: candidates[0]?.url },
              fetch: { ok: true, newEntries: 1 },
              changed: true,
            },
          };
    });
    const user = await openSheet();
    await submit(user, 'https://blog.example.com/');

    expect(
      await dialog().findByRole('heading', { name: 'We found 2 feeds on this site' }),
    ).toBeVisible();
    expect(dialog().getByRole('button', { name: /JSON/ })).toBeDisabled();
    await user.click(dialog().getByRole('button', { name: /Posts/ }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(posts()[1]?.body).toEqual({ url: 'https://blog.example.com/a.xml' });
  });

  it('Try a different address goes back to the field', async () => {
    api.set('POST /api/subscriptions/s1/url', () =>
      apiError(422, 'feed_choice_required', { candidates }),
    );
    const user = await openSheet();
    await submit(user, 'https://blog.example.com/');
    await user.click(await dialog().findByRole('button', { name: 'Try a different address' }));
    expect(field()).toBeVisible();
  });
});
