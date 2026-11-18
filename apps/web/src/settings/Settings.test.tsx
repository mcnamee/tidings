import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionResponse, UserSettings } from '@tidings/shared';
import { App } from '../App';
import { SESSION_KEY } from '../lib/session';
import { installFakeApi, type FakeApi } from '../test-api';
import { installMatchMedia } from '../test-utils';

// TID-022: the Settings screen (AC1 to AC6, unit level). The server side is covered in
// apps/worker/test/settings-account.test.ts and the whole flow in e2e/specs/tid-022-settings.

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(async () => ({ id: 'assertion' })),
  startRegistration: vi.fn(async () => ({ id: 'registration' })),
}));

const PASSKEYS = {
  items: [
    { id: 'pk-a', name: 'iPhone', createdAt: 1_760_000_000, lastUsedAt: 1_760_100_000 },
    { id: 'pk-b', name: 'Work laptop', createdAt: 1_760_200_000, lastUsedAt: null },
  ],
};
const CODES = Array.from({ length: 10 }, (_, i) => `AAAA-BBBB-CCCC-${String(1000 + i)}`);

let api: FakeApi;
let client: QueryClient;

function renderSettings(settings: UserSettings = {}) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const session: SessionResponse = {
    user: { id: 'u1', displayName: 'Matt', role: 'owner', settings },
    setupRequired: false,
    mustAddPasskey: false,
    emailSignIn: false,
  };
  client.setQueryData(SESSION_KEY, session);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/settings']}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const sessionSettings = () => client.getQueryData<SessionResponse>(SESSION_KEY)?.user?.settings;
const patches = () => api.calls.filter((c) => c.method === 'PATCH' && c.path === '/api/me');

beforeEach(() => {
  installMatchMedia();
  localStorage.clear();
  vi.stubGlobal('PublicKeyCredential', class {});
  vi.stubGlobal('isSecureContext', true);
  api = installFakeApi();
  api.set('GET /api/auth/passkeys', { body: PASSKEYS });
  api.set('GET /api/health', { body: { ok: true, version: '1.2.3' } });
  api.set('PATCH /api/me', (body) => ({ body: { id: 'u1', ...(body as object) } }));
});
afterEach(() => vi.unstubAllGlobals());

describe('AC1: theme', () => {
  it('Light, Dark and System apply at once, are stored with PATCH /api/me, and mirror to localStorage', async () => {
    const user = userEvent.setup();
    renderSettings();
    expect(screen.getByRole('radio', { name: 'System' })).toBeChecked();
    const events = vi.fn();
    window.addEventListener('tidings:theme', events);

    await user.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked();
    await waitFor(() => expect(localStorage.getItem('tidings.theme')).toBe('dark'));
    expect(events).toHaveBeenCalled();
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]?.body).toEqual({ settings: { theme: 'dark' } });

    await user.click(screen.getByRole('radio', { name: 'Light' }));
    await waitFor(() => expect(localStorage.getItem('tidings.theme')).toBe('light'));
    await user.click(screen.getByRole('radio', { name: 'System' }));
    await waitFor(() => expect(localStorage.getItem('tidings.theme')).toBe('system'));
    window.removeEventListener('tidings:theme', events);
  });

  it('a device that signs in to an account with a stored theme adopts it (another device)', async () => {
    expect(localStorage.getItem('tidings.theme')).toBeNull();
    renderSettings({ theme: 'dark', textSize: 'l' });
    await waitFor(() => expect(localStorage.getItem('tidings.theme')).toBe('dark'));
    expect(localStorage.getItem('tidings.textSize')).toBe('l');
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked();
  });

  it('an account that never chose a theme leaves this device’s choice alone', () => {
    localStorage.setItem('tidings.theme', 'dark');
    renderSettings({});
    expect(localStorage.getItem('tidings.theme')).toBe('dark');
  });

  it('puts the old value back, with a toast, when the server refuses', async () => {
    const user = userEvent.setup();
    api.set('PATCH /api/me', { status: 500, body: { error: { code: 'internal', message: 'x' } } });
    renderSettings({ theme: 'light' });
    await user.click(screen.getByRole('radio', { name: 'Dark' }));
    await waitFor(() => expect(sessionSettings()).toEqual({ theme: 'light' }));
    expect(screen.getByRole('radio', { name: 'Light' })).toBeChecked();
    await waitFor(() => expect(localStorage.getItem('tidings.theme')).toBe('light'));
    expect(await screen.findByText(/Couldn.t save that setting/)).toBeInTheDocument();
  });
});

describe('AC2: reading options and text size', () => {
  it('shows the defaults: unread only on, mark on open on, mark on scroll on, hide feeds off', () => {
    renderSettings();
    expect(screen.getByRole('switch', { name: 'Show unread only by default' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Mark as read when opened' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Mark as read when scrolled past' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Hide feeds with no unread' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'Medium' })).toBeChecked();
  });

  it('each switch stores its own key', async () => {
    const user = userEvent.setup();
    renderSettings();
    await user.click(screen.getByRole('switch', { name: 'Show unread only by default' }));
    await user.click(screen.getByRole('switch', { name: 'Mark as read when opened' }));
    await user.click(screen.getByRole('switch', { name: 'Mark as read when scrolled past' }));
    await user.click(screen.getByRole('switch', { name: 'Hide feeds with no unread' }));
    await waitFor(() => expect(patches()).toHaveLength(4));
    expect(patches().map((p) => p.body)).toEqual([
      { settings: { unreadOnly: false } },
      { settings: { markReadOnOpen: false } },
      { settings: { markReadOnScroll: false } },
      { settings: { hideReadFeeds: true } },
    ]);
    expect(sessionSettings()).toEqual({
      unreadOnly: false,
      markReadOnOpen: false,
      markReadOnScroll: false,
      hideReadFeeds: true,
    });
  });

  it('text size stores, mirrors to localStorage and sets data-text-size', async () => {
    const user = userEvent.setup();
    renderSettings();
    await user.click(screen.getByRole('radio', { name: 'Large' }));
    await waitFor(() => expect(localStorage.getItem('tidings.textSize')).toBe('l'));
    await waitFor(() => expect(patches()[0]?.body).toEqual({ settings: { textSize: 'l' } }));
  });
});

describe('AC3: passkeys', () => {
  it('lists each passkey with name, created and last used', async () => {
    renderSettings();
    const rows = await screen.findAllByTestId('passkey-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByText('iPhone')).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).getByText(/Added .*Last used /)).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText(/Never used/)).toBeInTheDocument();
  });

  it('renames a passkey with PATCH and refreshes the list', async () => {
    const user = userEvent.setup();
    api.set('PATCH /api/auth/passkeys/pk-a', (body) => ({
      body: { ...PASSKEYS.items[0], ...(body as object) },
    }));
    renderSettings();
    await user.click(await screen.findByRole('button', { name: 'Rename iPhone' }));
    const input = screen.getByLabelText('Name');
    await user.clear(input);
    await user.type(input, 'Pixel');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.calls).toContainEqual({
        method: 'PATCH',
        path: '/api/auth/passkeys/pk-a',
        body: { name: 'Pixel' },
      }),
    );
  });

  it('removes a passkey after a confirm', async () => {
    const user = userEvent.setup();
    api.set('DELETE /api/auth/passkeys/pk-b', { status: 204 });
    renderSettings();
    await user.click(await screen.findByRole('button', { name: 'Remove Work laptop' }));
    await user.click(screen.getByRole('button', { name: 'Remove passkey' }));
    await waitFor(() =>
      expect(api.calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/pk-b'))).toBe(true),
    );
    expect(await screen.findByText('Passkey removed.')).toBeInTheDocument();
  });

  it('409 last_passkey explains why, and the passkey stays', async () => {
    const user = userEvent.setup();
    api.set('GET /api/auth/passkeys', { body: { items: [PASSKEYS.items[0]] } });
    api.set('DELETE /api/auth/passkeys/pk-a', {
      status: 409,
      body: { error: { code: 'last_passkey', message: 'x' } },
    });
    renderSettings();
    expect(await screen.findByText(/This is your only passkey/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove iPhone' }));
    await user.click(screen.getByRole('button', { name: 'Remove passkey' }));
    const alert = await screen.findByText(/can.t remove your only passkey/);
    expect(alert).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('adds a passkey: options, device prompt, verify, then the list refreshes', async () => {
    const user = userEvent.setup();
    api.set('POST /api/auth/passkeys/options', { body: { challenge: 'c' } });
    api.set('POST /api/auth/passkeys/verify', {
      status: 201,
      body: { id: 'pk-c', name: 'Passkey', createdAt: 1, lastUsedAt: null },
    });
    renderSettings();
    await user.click(await screen.findByRole('button', { name: 'Add a passkey' }));
    expect(await screen.findByText('Passkey added.')).toBeInTheDocument();
    const paths = api.calls.filter((c) => c.method === 'POST').map((c) => c.path);
    expect(paths).toEqual(['/api/auth/passkeys/options', '/api/auth/passkeys/verify']);
    expect(
      api.calls.filter((c) => c.path === '/api/auth/passkeys' && c.method === 'GET'),
    ).toHaveLength(2);
  });
});

describe('AC4: recovery codes', () => {
  it('asks first, then shows 10 new codes once', async () => {
    const user = userEvent.setup();
    api.set('POST /api/auth/recovery-codes', { body: { recoveryCodes: CODES } });
    renderSettings();
    await user.click(screen.getByRole('button', { name: 'Make new recovery codes' }));
    expect(api.calls.some((c) => c.path === '/api/auth/recovery-codes')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Make new codes' }));
    const list = await screen.findByTestId('new-recovery-codes');
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    expect(within(list).getByText(CODES[0] as string)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /I.ve saved these/ }));
    expect(screen.queryByText(CODES[0] as string)).not.toBeInTheDocument();
    // Never kept in the query cache.
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain(CODES[0]);
  });

  it('403 reauth_required runs a passkey sign-in, then retries and shows the codes', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    api.set('POST /api/auth/recovery-codes', () => {
      attempts += 1;
      return attempts === 1
        ? { status: 403, body: { error: { code: 'reauth_required', message: 'x' } } }
        : { body: { recoveryCodes: CODES } };
    });
    api.set('POST /api/auth/login/options', { body: { challenge: 'c' } });
    api.set('POST /api/auth/login/verify', {
      body: { user: { id: 'u1', displayName: 'Matt', role: 'owner', settings: {} } },
    });
    renderSettings();
    await user.click(screen.getByRole('button', { name: 'Make new recovery codes' }));
    await user.click(screen.getByRole('button', { name: 'Make new codes' }));
    expect(await screen.findByTestId('new-recovery-codes')).toBeInTheDocument();
    expect(api.calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([
      '/api/auth/recovery-codes',
      '/api/auth/login/options',
      '/api/auth/login/verify',
      '/api/auth/recovery-codes',
    ]);
  });

  it('says so when the passkey sign-in fails, and shows no codes', async () => {
    const user = userEvent.setup();
    api.set('POST /api/auth/recovery-codes', {
      status: 403,
      body: { error: { code: 'reauth_required', message: 'x' } },
    });
    api.set('POST /api/auth/login/options', { body: { challenge: 'c' } });
    const { startAuthentication } = await import('@simplewebauthn/browser');
    vi.mocked(startAuthentication).mockRejectedValueOnce(
      Object.assign(new Error('no'), { name: 'NotAllowedError' }),
    );
    renderSettings();
    await user.click(screen.getByRole('button', { name: 'Make new recovery codes' }));
    await user.click(screen.getByRole('button', { name: 'Make new codes' }));
    expect(await screen.findByText('Sign-in was cancelled. Try again.')).toBeInTheDocument();
    expect(screen.queryByTestId('new-recovery-codes')).not.toBeInTheDocument();
  });
});

describe('AC5: sign out', () => {
  it('Sign out ends this session only', async () => {
    const user = userEvent.setup();
    api.set('POST /api/auth/logout', { status: 204 });
    renderSettings();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(api.calls.some((c) => c.path === '/api/auth/logout')).toBe(true));
    expect(api.calls.some((c) => c.path === '/api/auth/logout-all')).toBe(false);
  });

  it('Sign out everywhere confirms first, then calls logout-all and leaves the app', async () => {
    const user = userEvent.setup();
    api.set('POST /api/auth/logout-all', { status: 204 });
    renderSettings();
    await user.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
    expect(api.calls.some((c) => c.path === '/api/auth/logout-all')).toBe(false);
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Sign out everywhere' }),
    );
    await waitFor(() =>
      expect(api.calls.some((c) => c.path === '/api/auth/logout-all')).toBe(true),
    );
    await waitFor(() => expect(client.getQueryData<SessionResponse>(SESSION_KEY)?.user).toBeNull());
  });
});

describe('AC6 and small things: data section, name and version', () => {
  it('Import OPML goes to /manage/import; Export OPML is hidden until TID-017', () => {
    renderSettings();
    expect(screen.getByRole('link', { name: 'Import OPML' })).toHaveAttribute(
      'href',
      '/manage/import',
    );
    // Hidden until TID-017 builds the export route.
    expect(screen.queryByRole('link', { name: 'Export OPML' })).not.toBeInTheDocument();
    expect(screen.getByText('Articles are kept for 30 days after you read them.')).toBeVisible();
  });

  it('shows the app version small', async () => {
    renderSettings();
    expect(await screen.findByTestId('app-version')).toHaveTextContent('Tidings 1.2.3');
  });

  it('renames the account', async () => {
    const user = userEvent.setup();
    renderSettings();
    const input = screen.getByLabelText('Your name');
    await user.clear(input);
    await user.type(input, 'Matthew');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(patches().map((p) => p.body)).toContainEqual({ displayName: 'Matthew' }),
    );
    expect(await screen.findByText('Name saved.')).toBeInTheDocument();
  });
});
