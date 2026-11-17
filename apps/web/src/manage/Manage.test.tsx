import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Folder, Subscription } from '@tidings/shared';
import { App } from '../App';
import { SESSION_KEY } from '../lib/session';
import { toastStore } from '../lib/toast';
import { installFakeApi, type FakeApi } from '../test-api';
import { installMatchMedia } from '../test-utils';

// TID-014 UI (docs/ux/FLOWS.md 2.4): /manage through the real App and shell against a fake API
// that keeps state, so the manage list and the drawer (the desktop sidebar, same component) are
// both checked after each action. AC9 (UX review) is deferred to the end-of-MVP UX pass.

const OWNER = { id: 'u1', displayName: 'Matt', role: 'owner', settings: {} } as const;

function sub(id: string, title: string, over: Partial<Subscription> = {}): Subscription {
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
    ...over,
  };
}

const apiError = (status: number, code: string) => ({
  status,
  body: { error: { code, message: 'x' } },
});

let api: FakeApi;
let folders: Folder[];
let subs: Subscription[];
let nextFolder: number;

/** A tiny server: the routes TID-014 added, keeping state in the two arrays above. */
function serve() {
  api.set('GET /api/folders', () => ({
    body: { items: [...folders].sort((a, b) => a.name.localeCompare(b.name)) },
  }));
  api.set('GET /api/subscriptions', () => ({ body: { items: subs } }));
  api.set('POST /api/folders', (body) => {
    const name = (body as { name: string }).name;
    if (folders.some((f) => f.name.toLowerCase() === name.toLowerCase())) {
      return apiError(409, 'conflict');
    }
    if (folders.length >= 200) return apiError(422, 'limit_reached');
    const folder = { id: `f${nextFolder++}`, name };
    folders.push(folder);
    return { status: 201, body: folder };
  });
  for (const f of folders) {
    api.set(`PATCH /api/folders/${f.id}`, (body) => {
      const name = (body as { name: string }).name;
      if (folders.some((o) => o.id !== f.id && o.name.toLowerCase() === name.toLowerCase())) {
        return apiError(409, 'conflict');
      }
      f.name = name;
      return { body: f };
    });
    api.set(`DELETE /api/folders/${f.id}`, () => {
      folders = folders.filter((o) => o.id !== f.id);
      subs = subs.map((s) => (s.folderId === f.id ? { ...s, folderId: null } : s));
      return { status: 204 };
    });
  }
  for (const s of subs) {
    api.set(`PATCH /api/subscriptions/${s.id}`, (body) => {
      const b = body as { title?: string | null; folderId?: string | null };
      const i = subs.findIndex((o) => o.id === s.id);
      const cur = subs[i] as Subscription;
      const customTitle = b.title === undefined ? cur.customTitle : b.title;
      subs[i] = {
        ...cur,
        customTitle,
        title: b.title === undefined ? cur.title : (customTitle ?? 'Feed title'),
        folderId: b.folderId === undefined ? cur.folderId : b.folderId,
      };
      return { body: subs[i] };
    });
    api.set(`DELETE /api/subscriptions/${s.id}`, () => {
      subs = subs.filter((o) => o.id !== s.id);
      return { status: 204 };
    });
  }
}

function renderManage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(SESSION_KEY, { user: OWNER, setupRequired: false, mustAddPasskey: false });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/manage']}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const drawer = () => within(screen.getByRole('navigation', { name: 'Feeds and folders' }));
const main = () => within(screen.getByRole('main'));
const calls = (method: string, prefix: string) =>
  api.calls.filter((c) => c.method === method && c.path.startsWith(prefix));

beforeEach(() => {
  localStorage.clear();
  installMatchMedia({ 'min-width: 1024px': true }); // the sidebar is the drawer's FeedNav
  api = installFakeApi();
  folders = [{ id: 'f1', name: 'Tech' }];
  subs = [sub('s1', 'Zebra Blog'), sub('s2', 'alpha news', { folderId: 'f1' }), sub('s3', 'Mango')];
  nextFolder = 2;
  serve();
  toastStore.dismiss();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function ready() {
  renderManage();
  await screen.findByRole('heading', { name: 'Folders' });
}

describe('AC1: create a folder', () => {
  it('it appears in the manage list and the drawer, sorted case-insensitively', async () => {
    const user = userEvent.setup();
    await ready();
    await user.click(screen.getByRole('button', { name: 'New folder' }));
    await user.type(screen.getByLabelText('Folder name'), 'apps');
    await user.click(screen.getByRole('button', { name: 'Create folder' }));

    await waitFor(() => expect(main().getByText('apps')).toBeInTheDocument());
    expect(calls('POST', '/api/folders')[0]?.body).toEqual({ name: 'apps' });
    const links = drawer()
      .getAllByRole('link')
      .map((l) => l.textContent)
      .filter((t) => t === 'apps' || t === 'Tech');
    expect(links).toEqual(['apps', 'Tech']);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('AC2 and AC3: names', () => {
  it('a duplicate shows the inline error and keeps the sheet open', async () => {
    const user = userEvent.setup();
    await ready();
    await user.click(screen.getByRole('button', { name: 'New folder' }));
    await user.type(screen.getByLabelText('Folder name'), 'tech');
    await user.click(screen.getByRole('button', { name: 'Create folder' }));
    expect(
      (await screen.findAllByText('You already have a folder with that name.'))[0],
    ).toBeVisible();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText('Folder name')).toHaveAttribute('aria-invalid', 'true');
  });

  it('an empty name or one of 65 characters is refused before any request', async () => {
    const user = userEvent.setup();
    await ready();
    await user.click(screen.getByRole('button', { name: 'New folder' }));
    await user.click(screen.getByRole('button', { name: 'Create folder' }));
    expect((await screen.findAllByText('Enter a name to continue.'))[0]).toBeVisible();
    await user.type(screen.getByLabelText('Folder name'), 'x'.repeat(65));
    await user.click(screen.getByRole('button', { name: 'Create folder' }));
    expect((await screen.findAllByText('Use 64 characters or fewer.'))[0]).toBeVisible();
    expect(calls('POST', '/api/folders')).toHaveLength(0);
  });

  it('renaming a folder to another folder’s name shows the inline error', async () => {
    folders.push({ id: 'f2', name: 'News' });
    serve();
    const user = userEvent.setup();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Rename News' }));
    const field = screen.getByLabelText('Folder name');
    await user.clear(field);
    await user.type(field, 'TECH');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      (await screen.findAllByText('You already have a folder with that name.'))[0],
    ).toBeVisible();
  });

  it('renaming a folder updates the list and the drawer', async () => {
    const user = userEvent.setup();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Rename Tech' }));
    const field = screen.getByLabelText('Folder name');
    await user.clear(field);
    await user.type(field, 'Technology');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(drawer().getByRole('link', { name: 'Technology' })).toBeVisible());
    expect(main().getAllByText('Technology')[0]).toBeVisible();
  });
});

describe('AC4: move a feed', () => {
  it('into a folder it shows under it in the drawer; to No folder it is top level again', async () => {
    const user = userEvent.setup();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Zebra Blog, options' }));
    await user.click(screen.getByRole('button', { name: 'Move to folder' }));
    await user.click(screen.getByRole('button', { name: 'Tech' }));
    await waitFor(() => expect(calls('PATCH', '/api/subscriptions/s1')).toHaveLength(1));
    expect(calls('PATCH', '/api/subscriptions/s1')[0]?.body).toEqual({ folderId: 'f1' });
    // Drawer order: Tech, then its feeds (alpha news, Zebra Blog), then loose feeds (Mango).
    // Folders start collapsed in the drawer (TID-018 AC6), so open Tech first.
    await user.click(drawer().getByRole('button', { name: 'Expand Tech' }));
    await waitFor(() =>
      expect(
        drawer()
          .getAllByRole('link')
          .map((l) => l.textContent),
      ).toEqual(expect.arrayContaining(['Tech', 'alpha news', 'Zebra Blog', 'Mango'])),
    );
    const order = drawer()
      .getAllByRole('link')
      .map((l) => l.textContent)
      .filter((t) => ['Tech', 'alpha news', 'Zebra Blog', 'Mango'].includes(t ?? ''));
    expect(order).toEqual(['Tech', 'alpha news', 'Zebra Blog', 'Mango']);

    await user.click(screen.getByRole('button', { name: 'Zebra Blog, options' }));
    await user.click(screen.getByRole('button', { name: 'Move to folder' }));
    await user.click(screen.getByRole('button', { name: 'No folder' }));
    await waitFor(() => expect(calls('PATCH', '/api/subscriptions/s1')).toHaveLength(2));
    expect(calls('PATCH', '/api/subscriptions/s1')[1]?.body).toEqual({ folderId: null });
    await waitFor(() => {
      const after = drawer()
        .getAllByRole('link')
        .map((l) => l.textContent)
        .filter((t) => ['Tech', 'alpha news', 'Zebra Blog', 'Mango'].includes(t ?? ''));
      expect(after).toEqual(['Tech', 'alpha news', 'Mango', 'Zebra Blog']);
    });
  });

  it('a failed move rolls back and says so', async () => {
    api.set('PATCH /api/subscriptions/s1', () => apiError(500, 'internal'));
    const user = userEvent.setup();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Zebra Blog, options' }));
    await user.click(screen.getByRole('button', { name: 'Move to folder' }));
    await user.click(screen.getByRole('button', { name: 'Tech' }));
    await waitFor(() => expect(toastStore.getSnapshot()?.message).toMatch(/Couldn't move/));
    expect(subs.find((s) => s.id === 's1')?.folderId).toBeNull();
  });
});

describe('AC5: rename a feed', () => {
  it('sets the name, and clearing it sends null so the feed’s title returns', async () => {
    const user = userEvent.setup();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Zebra Blog, options' }));
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    await user.type(screen.getByLabelText('Feed name'), 'My Blog');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(drawer().getByRole('link', { name: 'My Blog' })).toBeVisible());
    expect(calls('PATCH', '/api/subscriptions/s1')[0]?.body).toEqual({ title: 'My Blog' });

    await user.click(screen.getByRole('button', { name: 'My Blog, options' }));
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    await user.clear(screen.getByLabelText('Feed name'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(drawer().getByRole('link', { name: 'Feed title' })).toBeVisible());
    expect(calls('PATCH', '/api/subscriptions/s1')[1]?.body).toEqual({ title: null });
  });
});

describe('UX review: a feed row is announced with its folder and health', () => {
  it('describes the options button with the folder and any problem', async () => {
    await ready();
    const button = screen.getByRole('button', { name: 'alpha news, options' });
    expect(button).toHaveAccessibleDescription(/No folder|Tech/);
  });
});

describe('AC6: delete a folder', () => {
  it('asks first with the feed count, then the folder goes and its feeds stay at the top level', async () => {
    const user = userEvent.setup();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Delete Tech' }));
    expect(
      screen.getByText('Its 1 feed moves out of the folder. Nothing is unsubscribed.'),
    ).toBeVisible();
    expect(calls('DELETE', '/api/folders')).toHaveLength(0); // nothing until confirmed
    await user.click(screen.getByRole('button', { name: 'Delete folder' }));
    await waitFor(() => expect(calls('DELETE', '/api/folders/f1')).toHaveLength(1));
    await waitFor(() => expect(drawer().queryByRole('link', { name: 'Tech' })).toBeNull());
    expect(drawer().getByRole('link', { name: 'alpha news' })).toBeVisible();
    expect(subs.every((s) => s.folderId === null)).toBe(true);
    expect(calls('DELETE', '/api/subscriptions')).toHaveLength(0);
  });

  it('opens with Cancel focused, so Enter cannot delete by accident (UX review)', async () => {
    const user = userEvent.setup();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Delete Tech' }));
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('Cancel deletes nothing', async () => {
    const user = userEvent.setup();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Delete Tech' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(calls('DELETE', '/api/folders')).toHaveLength(0);
  });
});

describe('AC7: unsubscribe', () => {
  it('asks first, then the feed is gone from the list and the drawer', async () => {
    const user = userEvent.setup();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Mango, options' }));
    await user.click(screen.getByRole('button', { name: 'Unsubscribe' }));
    expect(screen.getByText('Your read history for this feed will be removed.')).toBeVisible();
    expect(calls('DELETE', '/api/subscriptions')).toHaveLength(0);
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Unsubscribe' }),
    );
    await waitFor(() => expect(calls('DELETE', '/api/subscriptions/s3')).toHaveLength(1));
    await waitFor(() => expect(drawer().queryByRole('link', { name: 'Mango' })).toBeNull());
    expect(main().queryByRole('button', { name: 'Mango, options' })).toBeNull();
  });

  it('a failed unsubscribe brings the feed back with an error toast', async () => {
    api.set('DELETE /api/subscriptions/s3', () => apiError(500, 'internal'));
    const user = userEvent.setup();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Mango, options' }));
    await user.click(screen.getByRole('button', { name: 'Unsubscribe' }));
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Unsubscribe' }),
    );
    await waitFor(() => expect(toastStore.getSnapshot()?.message).toMatch(/Couldn't unsubscribe/));
    await waitFor(() => expect(drawer().getByRole('link', { name: 'Mango' })).toBeVisible());
  });
});

describe('AC8: the folder limit', () => {
  it('limit_reached shows the fixed message inline', async () => {
    api.set('POST /api/folders', () => apiError(422, 'limit_reached'));
    const user = userEvent.setup();
    await ready();
    await user.click(screen.getByRole('button', { name: 'New folder' }));
    await user.type(screen.getByLabelText('Folder name'), 'One more');
    await user.click(screen.getByRole('button', { name: 'Create folder' }));
    expect(
      (await screen.findAllByText("You've reached the limit of 200 folders."))[0],
    ).toBeVisible();
  });
});

describe('the screen', () => {
  it('shows a feed’s health note and warning with an icon and words', async () => {
    subs[2] = sub('s3', 'Mango', {
      health: {
        ...sub('x', 'x').health,
        state: 'failing',
        errorMessage: 'We could not reach this feed.',
      },
    });
    subs[0] = sub('s1', 'Zebra Blog', {
      health: { ...sub('x', 'x').health, warning: 'Too many new items at once.' },
    });
    await ready();
    expect(main().getByText('We could not reach this feed.')).toBeVisible();
    expect(main().getByText('Too many new items at once.')).toBeVisible();
  });

  it('Escape closes a sheet and returns focus to the button that opened it', async () => {
    const user = userEvent.setup();
    await ready();
    const opener = screen.getByRole('button', { name: 'Mango, options' });
    await user.click(opener);
    expect(screen.getByRole('dialog')).toBeVisible();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('with nothing yet, says so and offers Add feed', async () => {
    folders = [];
    subs = [];
    serve();
    await ready();
    expect(screen.getByText(/No folders yet/)).toBeVisible();
    expect(screen.getByText(/aren.t following any feeds yet/)).toBeVisible();
    expect(main().getByRole('link', { name: 'Add feed' })).toHaveAttribute('href', '/manage/add');
  });
});
