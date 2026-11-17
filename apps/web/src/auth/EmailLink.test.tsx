import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { SESSION_KEY } from '../lib/session';
import { resetExplicitSignOut } from '../lib/signOut';
import { installFakeApi, type FakeApi } from '../test-api';
import { installMatchMedia } from '../test-utils';

// TID-053 UI (docs/ux/FLOWS.md 2.1a): the /login email option and the /login/email landing page.
const USER = { id: 'u1', displayName: 'Matt', role: 'owner', settings: {} };
const SIGNED_OUT = { user: null, setupRequired: false, mustAddPasskey: false, emailSignIn: true };

let api: FakeApi;
let client: QueryClient;

function Probe() {
  const location = useLocation();
  return <output data-testid="path">{location.pathname}</output>;
}

function renderAt(path: string) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
const emailButton = () => screen.findByRole('button', { name: 'Email me a sign-in link' });
const emailCalls = (p: string) => api.calls.filter((c) => c.path === p);

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetExplicitSignOut();
  installMatchMedia();
  api = installFakeApi();
  api.set('GET /api/auth/session', { body: SIGNED_OUT });
  vi.stubGlobal('PublicKeyCredential', class {});
  vi.stubGlobal('isSecureContext', true);
  api.set('POST /api/auth/email/request', { status: 202, body: {} });
  api.set('POST /api/auth/email/verify', { body: { user: USER } });
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('/login: Email me a sign-in link', () => {
  it('is hidden when the server says emailSignIn is false', async () => {
    api.set('GET /api/auth/session', { body: { ...SIGNED_OUT, emailSignIn: false } });
    renderAt('/login');
    await screen.findByRole('button', { name: 'Sign in with a passkey' });
    expect(screen.queryByRole('button', { name: 'Email me a sign-in link' })).toBeNull();
  });

  it('reveals the form in the same card with the field focused, and Use a passkey instead hides it', async () => {
    renderAt('/login');
    await userEvent.click(await emailButton());
    const field = screen.getByLabelText('Email address');
    expect(field).toHaveFocus();
    expect(field).toHaveAttribute('type', 'email');
    expect(field).toHaveAttribute('autocomplete', 'email');
    expect(field).toHaveAttribute('inputmode', 'email');
    expect(path()).toBe('/login');
    await userEvent.click(screen.getByRole('button', { name: 'Use a passkey instead' }));
    expect(await screen.findByRole('button', { name: 'Sign in with a passkey' })).toBeVisible();
  });

  it('sends the trimmed address, shows Sending..., then the same Check your email state', async () => {
    let finish: () => void = () => undefined;
    api.set(
      'POST /api/auth/email/request',
      () => new Promise((resolve) => (finish = () => resolve({ status: 202, body: {} }))),
    );
    renderAt('/login');
    await userEvent.click(await emailButton());
    await userEvent.type(screen.getByLabelText('Email address'), '  Me@Example.test ');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a link' }));
    expect(await screen.findByRole('button', { name: 'Sending...' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await act(async () => finish());
    const heading = await screen.findByRole('heading', { name: 'Check your email' });
    const status = heading.closest('[role="status"]') as HTMLElement;
    expect(status).toBeVisible();
    expect(status).toHaveTextContent(
      'If that address is set up for Tidings, a sign-in link is on its way. It works once and expires in 15 minutes.',
    );
    expect(emailCalls('/api/auth/email/request')).toEqual([
      { method: 'POST', path: '/api/auth/email/request', body: { email: 'Me@Example.test' } },
    ]);
    // Send another link returns to the form with the address kept.
    await userEvent.click(screen.getByRole('button', { name: 'Send another link' }));
    expect((screen.getByLabelText('Email address') as HTMLInputElement).value.trim()).toBe(
      'Me@Example.test',
    );
  });

  it('shows the inline error for an empty field (no request) and for a 400', async () => {
    renderAt('/login');
    await userEvent.click(await emailButton());
    await userEvent.click(screen.getByRole('button', { name: 'Email me a link' }));
    expect(await screen.findByText('Enter an email address.')).toBeVisible();
    expect(emailCalls('/api/auth/email/request')).toHaveLength(0);
    api.set('POST /api/auth/email/request', {
      status: 400,
      body: { error: { code: 'validation_failed', message: 'x' } },
    });
    await userEvent.type(screen.getByLabelText('Email address'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a link' }));
    await waitFor(() => expect(emailCalls('/api/auth/email/request')).toHaveLength(1));
    expect(screen.getByText('Enter an email address.')).toBeVisible();
  });

  it('shows the shared rate-limit message on 429', async () => {
    api.set('POST /api/auth/email/request', {
      status: 429,
      headers: { 'Retry-After': '300' },
      body: { error: { code: 'rate_limited', message: 'x' } },
    });
    renderAt('/login');
    await userEvent.click(await emailButton());
    await userEvent.type(screen.getByLabelText('Email address'), 'a@b.test');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a link' }));
    expect(await screen.findByText('Too many attempts. Try again in 5 minutes.')).toBeVisible();
  });

  it('is blocked and says so when offline', async () => {
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    renderAt('/login');
    await userEvent.click(await emailButton());
    act(() => void window.dispatchEvent(new Event('offline')));
    expect(await screen.findByText(/You're offline/)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Email me a link' }));
    expect(emailCalls('/api/auth/email/request')).toHaveLength(0);
  });
});

describe('/login/email', () => {
  it('strips the fragment, makes no API call until Sign in is tapped, then signs in and goes to /all', async () => {
    window.history.replaceState(null, '', '/login/email#token=abc_DEF-123');
    renderAt('/login/email');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Sign in to Tidings' }),
    ).toBeVisible();
    expect(window.location.hash).toBe('');
    expect(screen.getByText('Tap the button to finish signing in on this device.')).toBeVisible();
    const button = screen.getByRole('button', { name: 'Sign in' });
    expect(button).not.toHaveFocus();
    expect(api.calls.some((c) => c.path.startsWith('/api/auth/email'))).toBe(false);

    await userEvent.click(button);
    await waitFor(() => expect(path()).toBe('/all'));
    expect(emailCalls('/api/auth/email/verify')).toEqual([
      { method: 'POST', path: '/api/auth/email/verify', body: { token: 'abc_DEF-123' } },
    ]);
    expect(client.getQueryData(SESSION_KEY)).toMatchObject({ user: USER });
  });

  it('401 invalid_link shows the expired state with Back to sign in', async () => {
    api.set('POST /api/auth/email/verify', {
      status: 401,
      body: { error: { code: 'invalid_link', message: 'x' } },
    });
    window.history.replaceState(null, '', '/login/email#token=used-token');
    renderAt('/login/email');
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'This link has expired' }),
    ).toBeVisible();
    expect(
      screen.getByText('Sign-in links work once and expire after 15 minutes. Ask for a new one.'),
    ).toBeVisible();
    await userEvent.click(screen.getByRole('link', { name: 'Back to sign in' }));
    await waitFor(() => expect(path()).toBe('/login'));
  });

  it('404 (feature off) says email sign-in is not available', async () => {
    api.set('POST /api/auth/email/verify', {
      status: 404,
      body: { error: { code: 'not_found', message: 'x' } },
    });
    window.history.replaceState(null, '', '/login/email#token=t');
    renderAt('/login/email');
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(
      await screen.findByText("Email sign-in isn't available. Use a passkey or a recovery code."),
    ).toBeVisible();
  });

  it('no token in the address shows the expired state without calling the API', async () => {
    window.history.replaceState(null, '', '/login/email');
    renderAt('/login/email');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'This link has expired' }),
    ).toBeVisible();
    expect(api.calls.some((c) => c.path.startsWith('/api/auth/email'))).toBe(false);
  });

  it('blocks Sign in and says so when offline', async () => {
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    window.history.replaceState(null, '', '/login/email#token=t');
    renderAt('/login/email');
    await screen.findByRole('button', { name: 'Sign in' });
    act(() => void window.dispatchEvent(new Event('offline')));
    expect(await screen.findAllByText(/You're offline/)).not.toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(emailCalls('/api/auth/email/verify')).toHaveLength(0);
  });
});
