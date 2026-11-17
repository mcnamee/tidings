import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { apiGet } from '../api';
import { CACHE_DB_NAME } from '../lib/cache';
import { SESSION_KEY } from '../lib/session';
import { hasSignedInHint, markSignedIn } from '../lib/signedInHint';
import { resetExplicitSignOut } from '../lib/signOut';
import { installFakeApi, type FakeApi } from '../test-api';
import { installMatchMedia } from '../test-utils';

// TID-008 UI (docs/ux/screens/login.md): every state, the redirects, session end and sign out.
const startAuthentication = vi.fn();
vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: (...args: unknown[]) => startAuthentication(...args) as unknown,
}));

const OPTIONS = { challenge: 'abc', rpId: 'localhost', allowCredentials: [] };
const ASSERTION = { id: 'cred', rawId: 'cred', type: 'public-key', response: {} };
const USER = { id: 'u1', displayName: 'Matt', role: 'owner', settings: {} };
const SIGNED_OUT = { user: null, setupRequired: false, mustAddPasskey: false };

let api: FakeApi;
let client: QueryClient;

function Probe() {
  const location = useLocation();
  return (
    <div>
      <output data-testid="path">{`${location.pathname}${location.search}`}</output>
      <output data-testid="state">{JSON.stringify(location.state)}</output>
    </div>
  );
}

function renderAt(path: string, state?: unknown) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[state === undefined ? path : { pathname: path, state }]}>
        <App />
        <Probe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const path = () => screen.getByTestId('path').textContent;
const routeState = () => JSON.parse(screen.getByTestId('state').textContent || 'null') as unknown;
const inMain = () => within(screen.getByRole('main'));
const signInButton = () =>
  screen.getByRole('button', { name: /Sign in with a passkey|Signing in|Waiting/ });

function setOnline(value: boolean) {
  vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(value);
  act(() => {
    window.dispatchEvent(new Event(value ? 'online' : 'offline'));
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetExplicitSignOut();
  installMatchMedia();
  api = installFakeApi();
  api.set('GET /api/auth/session', { body: SIGNED_OUT });
  vi.stubGlobal('PublicKeyCredential', class {});
  vi.stubGlobal('isSecureContext', true);
  startAuthentication.mockReset();
  startAuthentication.mockResolvedValue(ASSERTION);
  api.set('POST /api/auth/login/options', { body: OPTIONS });
  api.set('POST /api/auth/login/verify', { body: { user: USER } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('loading and redirects', () => {
  it('shows a skeleton with aria-busy while the session is checked', () => {
    api.set('GET /api/auth/session', () => new Promise(() => {}) as never);
    renderAt('/login');
    expect(screen.getByTestId('login-skeleton')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('shows the couldn’t-reach banner with Try again when the session check fails', async () => {
    api.set('GET /api/auth/session', { status: 500, body: {} });
    renderAt('/login');
    expect(await screen.findByText(/Couldn't reach Tidings/)).toBeInTheDocument();
    api.set('GET /api/auth/session', { body: SIGNED_OUT });
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('button', { name: 'Sign in with a passkey' });
  });

  it('redirects a signed-in visitor to the default view', async () => {
    api.set('GET /api/auth/session', { body: { ...SIGNED_OUT, user: USER } });
    localStorage.setItem('tidings.lastList', '/folders/f9');
    renderAt('/login');
    await waitFor(() => expect(path()).toBe('/folders/f9'));
  });

  it('redirects to /setup while no owner exists', async () => {
    api.set('GET /api/auth/session', { body: { ...SIGNED_OUT, setupRequired: true } });
    renderAt('/login');
    await screen.findByRole('heading', { level: 1, name: 'Set up Tidings' });
    expect(path()).toBe('/setup');
  });
});

describe('the default screen', () => {
  it('has the h1, intro, primary button and recovery link, and does not start the prompt', async () => {
    renderAt('/login');
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(document.title).toBe('Sign in - Tidings');
    expect(
      screen.getByText('Use the passkey on this device or in your password manager.'),
    ).toBeInTheDocument();
    expect(signInButton()).toHaveTextContent('Sign in with a passkey');
    expect(screen.getByRole('link', { name: 'Lost your passkey?' })).toHaveAttribute(
      'href',
      '/recover',
    );
    // No username field, no auto prompt, nothing focused on load.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(startAuthentication).not.toHaveBeenCalled();
    expect(api.calls.filter((c) => c.path.includes('/login/'))).toEqual([]);
    expect(signInButton()).not.toHaveFocus();
  });

  it('the live regions exist from first render', async () => {
    renderAt('/login');
    await screen.findByRole('heading', { level: 1 });
    expect(inMain().getAllByRole('alert').length).toBeGreaterThan(0);
    expect(inMain().getAllByRole('status').length).toBeGreaterThan(0);
  });

  it('shows a plain card (no banner) on a first visit', async () => {
    renderAt('/login');
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText(/session ended/)).not.toBeInTheDocument();
    expect(screen.queryByText(/already set up/)).not.toBeInTheDocument();
  });
});

describe('AC1: signing in', () => {
  it('asks for options, prompts, verifies, and lands on the default view with the user published', async () => {
    renderAt('/login');
    const user = userEvent.setup();
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });
    await user.click(signInButton());

    await waitFor(() => expect(path()).toBe('/all'));
    expect(api.calls.filter((c) => c.method === 'POST')).toEqual([
      { method: 'POST', path: '/api/auth/login/options', body: {} },
      { method: 'POST', path: '/api/auth/login/verify', body: { response: ASSERTION } },
    ]);
    expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: OPTIONS });
    expect(client.getQueryData(SESSION_KEY)).toEqual({
      user: USER,
      setupRequired: false,
      mustAddPasskey: false,
    });
    // Focus goes to the destination h1.
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'All articles' })).toHaveFocus(),
    );
    expect(hasSignedInHint()).toBe(true);
  });

  it('lands on the last list viewed on this device', async () => {
    localStorage.setItem('tidings.lastList', '/feeds/s3');
    renderAt('/login');
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });
    await userEvent.click(signInButton());
    await waitFor(() => expect(path()).toBe('/feeds/s3'));
  });

  it('restores the route the person was on (path and search)', async () => {
    renderAt('/login', { from: '/folders/f1?state=all', reason: 'expired' });
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });
    await userEvent.click(signInButton());
    await waitFor(() => expect(path()).toBe('/folders/f1?state=all'));
  });

  it.each([
    { from: 'https://evil.example/', why: 'an absolute URL' },
    { from: '//evil.example/x', why: 'a protocol-relative URL' },
    { from: '/\\evil.example', why: 'a backslash path' },
    { from: '/login', why: 'the login screen' },
    { from: '/setup', why: 'the setup screen' },
    { from: '/recover?x=1', why: 'the recover screen' },
    { from: 'javascript:alert(1)', why: 'a script URL' },
    { from: 42, why: 'a number' },
  ])('ignores a remembered route that is $why', async ({ from }) => {
    renderAt('/login', { from });
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });
    await userEvent.click(signInButton());
    await waitFor(() => expect(path()).toBe('/all'));
  });

  it('shows the in-progress labels and helper, and ignores a second press', async () => {
    let resolveOptions: (v: { body: unknown }) => void = () => {};
    api.set(
      'POST /api/auth/login/options',
      () => new Promise((r) => (resolveOptions = r as typeof resolveOptions)) as never,
    );
    renderAt('/login');
    const user = userEvent.setup();
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });
    await user.click(signInButton());
    expect(signInButton()).toHaveTextContent('Signing in...');
    expect(signInButton()).toHaveAttribute('aria-busy', 'true');
    expect(signInButton()).toHaveAttribute('aria-disabled', 'true');
    await user.click(signInButton());
    expect(api.calls.filter((c) => c.path === '/api/auth/login/options')).toHaveLength(1);
    // The recovery link keeps working while the prompt is open.
    expect(screen.getByRole('link', { name: 'Lost your passkey?' })).toBeInTheDocument();
    startAuthentication.mockReturnValue(new Promise(() => {}));
    await act(async () => resolveOptions({ body: OPTIONS }));
    await waitFor(() => expect(signInButton()).toHaveTextContent('Waiting for your passkey...'));
    expect(screen.getByText('Follow the prompt on your device.')).toBeInTheDocument();
  });
});

describe('failures', () => {
  async function tapSignIn() {
    renderAt('/login');
    const user = userEvent.setup();
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });
    await user.click(signInButton());
    return user;
  }

  it('a cancelled prompt is an info banner with the recovery-code link, and focus returns to the button', async () => {
    startAuthentication.mockRejectedValue(
      Object.assign(new Error('x'), { name: 'NotAllowedError' }),
    );
    await tapSignIn();
    const banner = await screen.findByText(/Sign-in was cancelled\./);
    expect(banner.closest('[role="status"]')).not.toBeNull();
    expect(banner.textContent).toBe(
      'Sign-in was cancelled. Try again. No passkey on this device? Use a recovery code.',
    );
    expect(within(banner).getByRole('link', { name: 'Use a recovery code' })).toHaveAttribute(
      'href',
      '/recover',
    );
    await waitFor(() => expect(signInButton()).toHaveFocus());
    // Only the options call was made: nothing was verified, nothing counted.
    expect(api.calls.map((c) => c.path)).not.toContain('/api/auth/login/verify');
    expect(path()).toBe('/login');
  });

  it('AbortError (timed out) is treated as a cancel', async () => {
    startAuthentication.mockRejectedValue(Object.assign(new Error('x'), { name: 'AbortError' }));
    await tapSignIn();
    await screen.findByText(/Sign-in was cancelled\./);
  });

  it('401 webauthn_failed is an error banner with the recovery-code link', async () => {
    api.set('POST /api/auth/login/verify', {
      status: 401,
      body: { error: { code: 'webauthn_failed', message: 'x' } },
    });
    await tapSignIn();
    const banner = await screen.findByText(/That passkey didn't work\./);
    expect(banner.closest('[role="alert"]')).not.toBeNull();
    expect(banner.textContent).toBe("That passkey didn't work. Try again, or use a recovery code.");
    expect(within(banner).getByRole('link', { name: 'use a recovery code' })).toHaveAttribute(
      'href',
      '/recover',
    );
    await waitFor(() => expect(signInButton()).toHaveFocus());
    expect(path()).toBe('/login');
  });

  it('a retry clears the banner and can succeed', async () => {
    startAuthentication.mockRejectedValueOnce(
      Object.assign(new Error('x'), { name: 'NotAllowedError' }),
    );
    const user = await tapSignIn();
    await screen.findByText(/Sign-in was cancelled\./);
    await user.click(signInButton());
    await waitFor(() => expect(path()).toBe('/all'));
  });

  it('NotSupportedError shows the runtime variant and keeps the button', async () => {
    startAuthentication.mockRejectedValue(
      Object.assign(new Error('x'), { name: 'NotSupportedError' }),
    );
    await tapSignIn();
    expect(await screen.findByText("This device can't use passkeys.")).toBeInTheDocument();
    expect(
      screen.getByText('Turn on a screen lock, or connect a security key, then try again.'),
    ).toBeInTheDocument();
    expect(signInButton()).toBeInTheDocument();
  });

  it('a 500 from login/options is the server-error banner', async () => {
    api.set('POST /api/auth/login/options', { status: 500, body: { error: { code: 'internal' } } });
    await tapSignIn();
    expect(
      await screen.findByText('Something went wrong on our side. Try again.'),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/internal|500/);
  });

  it('429 shows the wait, blocks the button, and re-enables it when the wait is over', async () => {
    api.set('POST /api/auth/login/options', {
      status: 429,
      body: { error: { code: 'rate_limited', message: 'x' } },
      headers: { 'Retry-After': '120' },
    });
    renderAt('/login');
    const user = userEvent.setup();
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await user.click(signInButton());
    const banner = await screen.findByText('Too many attempts. Try again in 2 minutes.');
    expect(banner.closest('[role="alert"]')).not.toBeNull();
    expect(signInButton()).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Try again in 2 minutes.')).toBeInTheDocument();
    // A press while blocked sends nothing.
    const calls = api.calls.length;
    await user.click(signInButton());
    expect(api.calls.length).toBe(calls);

    await act(async () => void vi.advanceTimersByTime(120_000));
    expect(await screen.findByText('You can try again now.')).toBeInTheDocument();
    expect(signInButton()).not.toHaveAttribute('aria-disabled');
  });

  it('offline: shows the banner, blocks the button, sends nothing', async () => {
    renderAt('/login');
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });
    setOnline(false);
    expect(
      screen.getByText("You're offline. Connect to the internet to continue."),
    ).toBeInTheDocument();
    expect(signInButton()).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(signInButton());
    expect(api.calls.map((c) => c.path)).not.toContain('/api/auth/login/options');
    setOnline(true);
    expect(screen.queryByText(/You're offline/)).not.toBeInTheDocument();
  });
});

describe('unsupported browsers', () => {
  it('replaces the button with the unsupported block and offers the recovery code as the way forward', async () => {
    vi.unstubAllGlobals();
    api = installFakeApi();
    api.set('GET /api/auth/session', { body: SIGNED_OUT });
    // jsdom has no PublicKeyCredential.
    renderAt('/login');
    expect(await screen.findByText("This browser can't use passkeys.")).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Sign in with a passkey/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Use a recovery code' })).toHaveAttribute(
      'href',
      '/recover',
    );
  });

  it('an insecure context gets its own message', async () => {
    vi.stubGlobal('isSecureContext', false);
    renderAt('/login');
    expect(await screen.findByText('Passkeys need a secure connection.')).toBeInTheDocument();
  });
});

describe('arriving at /login', () => {
  it('shows "Your session ended" for state.reason = expired, until the next attempt starts', async () => {
    renderAt('/login', { from: '/all', reason: 'expired' });
    const banner = await screen.findByText('Your session ended. Sign in again.');
    expect(banner.closest('[role="status"]')).not.toBeNull();
    startAuthentication.mockReturnValue(new Promise(() => {}));
    await userEvent.click(signInButton());
    expect(screen.queryByText('Your session ended. Sign in again.')).not.toBeInTheDocument();
  });

  it('keeps the "already set up" notice from route state', async () => {
    renderAt('/login', { notice: 'already-set-up' });
    expect(
      await screen.findByText('This Tidings is already set up. Sign in instead.'),
    ).toBeInTheDocument();
    // …and it does not break the form.
    expect(signInButton()).toBeInTheDocument();
  });
});

describe('the route guard', () => {
  it.each([
    '/all',
    '/folders/f1',
    '/feeds/s1',
    '/all/a/e1',
    '/manage',
    '/manage/add',
    '/manage/import',
    '/settings',
    '/nope/at/all',
  ])('signed out, %s redirects to /login and remembers where you were', async (route) => {
    renderAt(route);
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });
    expect(path()).toBe('/login');
    expect(routeState()).toEqual({ from: route });
    expect(screen.queryByRole('banner')).not.toBeInTheDocument();
    expect(screen.queryByText(/session ended/)).not.toBeInTheDocument();
  });

  it('remembers the search string too', async () => {
    renderAt('/all?state=all');
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });
    expect(routeState()).toEqual({ from: '/all?state=all' });
  });

  it('on a device that had a session, the redirect says the session ended', async () => {
    markSignedIn();
    renderAt('/feeds/s1');
    expect(await screen.findByText('Your session ended. Sign in again.')).toBeInTheDocument();
    expect(routeState()).toEqual({ from: '/feeds/s1', reason: 'expired' });
  });

  it('shows no shell content while the session is being checked', () => {
    api.set('GET /api/auth/session', () => new Promise(() => {}) as never);
    renderAt('/all');
    expect(screen.getByTestId('auth-pending')).toBeInTheDocument();
    expect(screen.queryByRole('banner')).not.toBeInTheDocument();
    expect(screen.queryByRole('main')).not.toBeInTheDocument();
  });

  it('signed in, a shell route renders', async () => {
    api.set('GET /api/auth/session', { body: { ...SIGNED_OUT, user: USER } });
    renderAt('/manage');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Manage feeds' }),
    ).toBeInTheDocument();
    expect(hasSignedInHint()).toBe(true);
  });

  it('a session check that fails sends you to /login, which offers Try again', async () => {
    api.set('GET /api/auth/session', { status: 500, body: {} });
    renderAt('/all');
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(path()).toBe('/login');
  });

  it('while setup is required, the first-run redirect wins over the login redirect', async () => {
    api.set('GET /api/auth/session', { body: { ...SIGNED_OUT, setupRequired: true } });
    renderAt('/all');
    await screen.findByRole('heading', { level: 1, name: 'Set up Tidings' });
    expect(path()).toBe('/setup');
  });
});

describe('AC4 and AC13: a 401 mid-session', () => {
  async function renderSignedInAt(route: string) {
    api.set('GET /api/auth/session', { body: { ...SIGNED_OUT, user: USER } });
    renderAt(route);
    await screen.findByRole('heading', { level: 1, name: 'Manage feeds' });
  }

  it('routes to /login with the session-ended banner and the route to come back to', async () => {
    await renderSignedInAt('/manage');
    api.set('GET /api/folders', {
      status: 401,
      body: { error: { code: 'unauthenticated', message: 'x' } },
    });
    await act(async () => {
      await apiGet('/api/folders').catch(() => undefined);
    });
    expect(await screen.findByText('Your session ended. Sign in again.')).toBeInTheDocument();
    expect(path()).toBe('/login');
    expect(routeState()).toEqual({ from: '/manage', reason: 'expired' });
    // Nothing from the app is painted behind the login card.
    expect(screen.queryByRole('banner')).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('keeps the cached data and the persisted database', async () => {
    const deleteDatabase = vi.fn();
    vi.stubGlobal('indexedDB', { deleteDatabase });
    await renderSignedInAt('/manage');
    client.setQueryData(['entries', 'all'], { items: ['kept'] });
    api.set('GET /api/folders', {
      status: 401,
      body: { error: { code: 'unauthenticated', message: 'x' } },
    });
    await act(async () => {
      await apiGet('/api/folders').catch(() => undefined);
    });
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });
    expect(client.getQueryData(['entries', 'all'])).toEqual({ items: ['kept'] });
    expect(deleteDatabase).not.toHaveBeenCalled();
    expect(hasSignedInHint()).toBe(true);
  });

  it('only code unauthenticated counts: a 401 webauthn_failed does not end a session', async () => {
    await renderSignedInAt('/manage');
    api.set('GET /api/x', {
      status: 401,
      body: { error: { code: 'webauthn_failed', message: 'x' } },
    });
    await act(async () => {
      await apiGet('/api/x').catch(() => undefined);
    });
    expect(path()).toBe('/manage');
  });

  it('signing in again returns to the route that was open', async () => {
    await renderSignedInAt('/manage');
    api.set('GET /api/folders', {
      status: 401,
      body: { error: { code: 'unauthenticated', message: 'x' } },
    });
    await act(async () => {
      await apiGet('/api/folders').catch(() => undefined);
    });
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });
    await userEvent.click(signInButton());
    await waitFor(() => expect(path()).toBe('/manage'));
  });
});

describe('AC5 and AC13: sign out', () => {
  async function openSettings() {
    api.set('GET /api/auth/session', { body: { ...SIGNED_OUT, user: USER } });
    api.set('POST /api/auth/logout', { status: 204 });
    renderAt('/settings');
    await screen.findByRole('heading', { level: 1, name: 'Settings' });
    return userEvent.setup();
  }

  it('POSTs /api/auth/logout, shows a plain /login with no banner, and the guard stays out of the way', async () => {
    const user = await openSettings();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });
    expect(api.calls.filter((c) => c.method === 'POST')).toEqual([
      { method: 'POST', path: '/api/auth/logout', body: {} },
    ]);
    expect(path()).toBe('/login');
    expect(routeState()).toBeNull();
    expect(screen.queryByText(/session ended/)).not.toBeInTheDocument();
    expect(client.getQueryData(SESSION_KEY)).toEqual(SIGNED_OUT);
  });

  it('clears the hint, the cached queries and the persisted database', async () => {
    const deleteDatabase = vi.fn(() => {
      const req: { onsuccess?: () => void } = {};
      queueMicrotask(() => req.onsuccess?.());
      return req;
    });
    vi.stubGlobal('indexedDB', { deleteDatabase });
    const user = await openSettings();
    client.setQueryData(['entries', 'all'], { items: ['private'] });
    expect(hasSignedInHint()).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });
    expect(client.getQueryData(['entries', 'all'])).toBeUndefined();
    expect(deleteDatabase).toHaveBeenCalledWith(CACHE_DB_NAME);
    expect(hasSignedInHint()).toBe(false);
  });

  it('a later visit to a shell route then redirects without the session-ended banner', async () => {
    const user = await openSettings();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });
    expect(screen.queryByText(/session ended/)).not.toBeInTheDocument();
    // The hint is gone, so another guarded visit is a plain redirect too.
    expect(hasSignedInHint()).toBe(false);
  });

  it('treats an already-ended session (401) as signed out', async () => {
    const user = await openSettings();
    api.set('POST /api/auth/logout', {
      status: 401,
      body: { error: { code: 'unauthenticated', message: 'x' } },
    });
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });
    expect(routeState()).toBeNull();
  });

  it('if the server cannot be reached, it says so and the person stays signed in with their cache', async () => {
    const user = await openSettings();
    client.setQueryData(['entries', 'all'], { items: ['kept'] });
    api.set('POST /api/auth/logout', () => Promise.reject(new TypeError('offline')) as never);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText(/Couldn't sign out/)).toBeInTheDocument();
    expect(path()).toBe('/settings');
    expect(client.getQueryData(['entries', 'all'])).toEqual({ items: ['kept'] });
    expect(hasSignedInHint()).toBe(true);
    // Try again works.
    api.set('POST /api/auth/logout', { status: 204 });
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });
  });

  it('the Sign out button is a 44px tap target', async () => {
    await openSettings();
    expect(screen.getByRole('button', { name: 'Sign out' }).className).toMatch(/min-h-11/);
  });
});
