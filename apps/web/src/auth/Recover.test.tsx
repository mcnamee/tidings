import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { resetExplicitSignOut } from '../lib/signOut';
import { installFakeApi, type FakeApi } from '../test-api';
import { installMatchMedia } from '../test-utils';

// TID-009 UI (docs/ux/screens/recover.md): the /recover screen, and the "Add a new passkey"
// banner in the shell (section 4).
const startRegistration = vi.fn();
vi.mock('@simplewebauthn/browser', () => ({
  startRegistration: (...args: unknown[]) => startRegistration(...args) as unknown,
}));

const USER = { id: 'u1', displayName: 'Matt', role: 'owner', settings: {} };
const SIGNED_OUT = { user: null, setupRequired: false, mustAddPasskey: false, emailSignIn: false };
const RECOVERED = {
  user: USER,
  setupRequired: false,
  mustAddPasskey: true,
  recoveryCodesRemaining: 9,
  emailSignIn: false,
};
const OPTIONS = { challenge: 'abc', rp: { name: 'Tidings' }, user: { id: 'u1' } };
const CREDENTIAL = { id: 'new-cred', rawId: 'new-cred', type: 'public-key', response: {} };

let api: FakeApi;

function Probe() {
  const location = useLocation();
  return <output data-testid="path">{location.pathname}</output>;
}

function renderAt(path: string, state?: unknown) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
const codeField = () => screen.getByLabelText('Recovery code') as HTMLInputElement;
const signIn = () => screen.getByRole('button', { name: /Sign in|Signing in/ });

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
  startRegistration.mockReset();
  startRegistration.mockResolvedValue(CREDENTIAL);
  api.set('POST /api/auth/recover', {
    body: { user: USER, mustAddPasskey: true, recoveryCodesRemaining: 9 },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('/recover screen', () => {
  it('shows the form with its exact copy and field attributes', async () => {
    renderAt('/recover');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Use a recovery code' }),
    ).toBeVisible();
    expect(document.title).toContain('Use a recovery code');
    expect(
      screen.getByText(
        'Enter one of the 10 codes you saved when you set up Tidings. Each code works once.',
      ),
    ).toBeVisible();
    expect(screen.getByText('Letters and numbers. Dashes are optional.')).toBeVisible();
    const field = codeField();
    expect(field).toHaveAttribute('placeholder', 'XXXX-XXXX-XXXX-XXXX');
    expect(field).toHaveAttribute('autocomplete', 'off');
    expect(field).toHaveAttribute('autocapitalize', 'characters');
    expect(field).toHaveAttribute('spellcheck', 'false');
    expect(field).toHaveAttribute('enterkeyhint', 'go');
    expect(screen.getByRole('link', { name: 'Use a passkey instead' })).toHaveAttribute(
      'href',
      '/login',
    );
  });

  it('an empty submit shows the field error and sends nothing', async () => {
    const user = userEvent.setup();
    renderAt('/recover');
    await screen.findByLabelText('Recovery code');
    await user.type(codeField(), ' - ');
    await user.click(signIn());
    expect(screen.getByText('Enter a recovery code.')).toBeVisible();
    expect(codeField()).toHaveFocus();
    expect(api.calls.some((c) => c.path === '/api/auth/recover')).toBe(false);
  });

  it('sends the code as typed (trimmed), clears it, and lands on /all with the banner flag set', async () => {
    const user = userEvent.setup();
    renderAt('/recover');
    await screen.findByLabelText('Recovery code');
    await user.type(codeField(), '  abcd 0123-4567-89ab ');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(path()).toBe('/all'));
    const call = api.calls.find((c) => c.path === '/api/auth/recover');
    expect(call?.body).toEqual({ code: 'abcd 0123-4567-89ab' });
    expect(document.body.textContent).not.toContain('abcd 0123');
  });

  it('a wrong code: one fixed message, value kept and selected, no counts', async () => {
    api.set('POST /api/auth/recover', {
      status: 401,
      body: { error: { code: 'invalid_recovery_code', message: 'x' } },
    });
    const user = userEvent.setup();
    renderAt('/recover');
    await screen.findByLabelText('Recovery code');
    await user.type(codeField(), 'K7Q2-M9XD-4TRP-8WZ');
    await user.click(signIn());
    const msg = await screen.findByText(
      "That code didn't work. Check it and try again. Each code works only once.",
    );
    expect(msg).toBeVisible();
    expect(codeField()).toHaveAttribute('aria-invalid', 'true');
    expect(codeField()).toHaveValue('K7Q2-M9XD-4TRP-8WZ');
    expect(codeField()).toHaveFocus();
    expect(codeField().selectionStart).toBe(0);
    expect(codeField().selectionEnd).toBe('K7Q2-M9XD-4TRP-8WZ'.length);
    expect(path()).toBe('/recover');
  });

  it('rate limited: warning banner with the wait, button blocked, editable field', async () => {
    api.set('POST /api/auth/recover', {
      status: 429,
      headers: { 'Retry-After': '540' },
      body: { error: { code: 'rate_limited', message: 'x' } },
    });
    const user = userEvent.setup();
    renderAt('/recover');
    await screen.findByLabelText('Recovery code');
    await user.type(codeField(), 'AAAA');
    await user.click(signIn());
    expect(await screen.findByText('Too many attempts. Try again in 9 minutes.')).toBeVisible();
    expect(signIn()).toHaveAttribute('aria-disabled', 'true');
    expect(codeField()).not.toHaveAttribute('readonly');
    const before = api.calls.length;
    await user.click(signIn());
    expect(api.calls.length).toBe(before);
  });

  it('network and server errors keep the value', async () => {
    api.set('POST /api/auth/recover', {
      status: 500,
      body: { error: { code: 'internal', message: 'x' } },
    });
    const user = userEvent.setup();
    renderAt('/recover');
    await screen.findByLabelText('Recovery code');
    await user.type(codeField(), 'AAAA-BBBB');
    await user.click(signIn());
    expect(await screen.findByText('Something went wrong on our side. Try again.')).toBeVisible();
    expect(codeField()).toHaveValue('AAAA-BBBB');
  });

  it('offline: banner, blocked button, nothing sent', async () => {
    const user = userEvent.setup();
    renderAt('/recover');
    await screen.findByLabelText('Recovery code');
    setOnline(false);
    expect(
      await screen.findByText("You're offline. Connect to the internet to continue."),
    ).toBeVisible();
    await user.type(codeField(), 'AAAA');
    await user.click(signIn());
    expect(api.calls.some((c) => c.path === '/api/auth/recover')).toBe(false);
    setOnline(true);
  });

  it('redirects: setup required goes to /setup, signed in goes to /all', async () => {
    api.set('GET /api/auth/session', { body: { ...SIGNED_OUT, setupRequired: true } });
    const first = renderAt('/recover');
    await waitFor(() => expect(path()).toBe('/setup'));
    first.unmount();
    api.set('GET /api/auth/session', { body: { ...RECOVERED, mustAddPasskey: false } });
    renderAt('/recover');
    await waitFor(() => expect(path()).toBe('/all'));
  });

  it('returns to where the person was going after a session ended', async () => {
    const user = userEvent.setup();
    renderAt('/recover', { from: '/manage' });
    await screen.findByLabelText('Recovery code');
    await user.type(codeField(), 'AAAA-BBBB-CCCC-DDDD');
    await user.click(signIn());
    await waitFor(() => expect(path()).toBe('/manage'));
  });
});

describe('the "Add a new passkey" banner', () => {
  beforeEach(() => {
    api.set('GET /api/auth/session', { body: RECOVERED });
    api.set('POST /api/auth/passkeys/options', { body: OPTIONS });
    api.set('POST /api/auth/passkeys/verify', {
      status: 201,
      body: { id: 'new-cred', name: 'Passkey' },
    });
  });

  it('shows after a recovery sign-in, with the codes left and a 44px+ button', async () => {
    renderAt('/all');
    const b = await screen.findByTestId('passkey-banner');
    expect(b).toHaveAttribute('role', 'status');
    expect(
      within(b).getByText(
        'You signed in with a recovery code. Add a new passkey so you don’t need another one.',
      ),
    ).toBeVisible();
    expect(within(b).getByText('9 of 10 recovery codes left.')).toBeVisible();
    expect(within(b).getByRole('button', { name: 'Add a new passkey' })).toBeVisible();
    // Not dismissible.
    expect(within(b).queryByRole('button', { name: /close|dismiss/i })).toBeNull();
  });

  it('is on other screens too, and absent when the session has no flag', async () => {
    const view = renderAt('/manage');
    expect(await screen.findByTestId('passkey-banner')).toBeVisible();
    view.unmount();
    api.set('GET /api/auth/session', { body: { ...RECOVERED, mustAddPasskey: false } });
    renderAt('/all');
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByTestId('passkey-banner')).toBeNull();
  });

  it('adds a passkey: options, the device prompt, verify with a label; then the banner goes', async () => {
    const user = userEvent.setup();
    renderAt('/all');
    await screen.findByTestId('passkey-banner');
    // After success the server says the flag is clear.
    api.set('GET /api/auth/session', { body: { ...RECOVERED, mustAddPasskey: false } });
    await user.click(screen.getByRole('button', { name: 'Add a new passkey' }));
    await waitFor(() => expect(screen.queryByTestId('passkey-banner')).toBeNull());
    expect(startRegistration).toHaveBeenCalledWith({ optionsJSON: OPTIONS });
    const verify = api.calls.find((c) => c.path === '/api/auth/passkeys/verify');
    expect(verify?.body).toMatchObject({ response: CREDENTIAL, name: expect.any(String) });
    expect(
      await screen.findByText('Passkey added. You can sign in with it next time.'),
    ).toBeVisible();
  });

  it('a cancelled prompt keeps the banner and says so; the button works again', async () => {
    startRegistration.mockRejectedValueOnce(
      Object.assign(new Error('x'), { name: 'NotAllowedError' }),
    );
    const user = userEvent.setup();
    renderAt('/all');
    await screen.findByTestId('passkey-banner');
    await user.click(screen.getByRole('button', { name: 'Add a new passkey' }));
    expect(await screen.findByText('Passkey setup was cancelled. Try again.')).toBeVisible();
    expect(api.calls.some((c) => c.path === '/api/auth/passkeys/verify')).toBe(false);
    expect(screen.getByTestId('passkey-banner')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Add a new passkey' }));
    await waitFor(() =>
      expect(api.calls.filter((c) => c.path === '/api/auth/passkeys/verify')).toHaveLength(1),
    );
  });

  it('a server refusal keeps the banner with a fixed message', async () => {
    api.set('POST /api/auth/passkeys/verify', {
      status: 401,
      body: { error: { code: 'webauthn_failed', message: 'x' } },
    });
    const user = userEvent.setup();
    renderAt('/all');
    await screen.findByTestId('passkey-banner');
    await user.click(screen.getByRole('button', { name: 'Add a new passkey' }));
    expect(await screen.findByText("We couldn't verify that passkey. Try again.")).toBeVisible();
    expect(screen.getByTestId('passkey-banner')).toBeVisible();
  });

  it('without passkey support: the unsupported text and no button', async () => {
    vi.stubGlobal('PublicKeyCredential', undefined);
    renderAt('/all');
    const b = await screen.findByTestId('passkey-banner');
    expect(
      within(b).getByText(
        'You signed in with a recovery code. Open Tidings on a device that supports passkeys to add a new one.',
      ),
    ).toBeVisible();
    expect(within(b).queryByRole('button')).toBeNull();
  });
});
