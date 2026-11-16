import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { installFakeApi, type FakeApi } from '../test-api';
import { installMatchMedia } from '../test-utils';

// TID-007 UI (docs/ux/screens/setup.md): both steps, every state, the focus order and the rules
// for keeping the recovery codes out of every store.
const startRegistration = vi.fn();
vi.mock('@simplewebauthn/browser', () => ({
  startRegistration: (...args: unknown[]) => startRegistration(...args) as unknown,
}));

const CODES = Array.from({ length: 10 }, (_, i) => `K7Q${i}-M9XD-4TRP-8WZB`);
const OPTIONS = { challenge: 'abc', rp: { name: 'Tidings' }, user: {}, pubKeyCredParams: [] };
const CREDENTIAL = { id: 'cred', rawId: 'cred', type: 'public-key', response: {} };
const USER = { id: 'u1', displayName: 'Matt', role: 'owner', settings: {} };

let api: FakeApi;
let client: QueryClient;

function Probe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <div>
      <output data-testid="path">{location.pathname}</output>
      <output data-testid="state">{JSON.stringify(location.state)}</output>
      <button type="button" onClick={() => void navigate(-1)}>
        system back
      </button>
    </div>
  );
}

function renderSetup(path = '/setup') {
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
// The toast region also has an alert role, so banners are looked up inside <main>.
const inMain = () => within(screen.getByRole('main'));
const button = () => screen.getByRole('button', { name: /passkey|Waiting/ });

function setOnline(value: boolean) {
  vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(value);
  act(() => {
    window.dispatchEvent(new Event(value ? 'online' : 'offline'));
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  installMatchMedia();
  api = installFakeApi();
  api.set('GET /api/auth/session', {
    body: { user: null, setupRequired: true, mustAddPasskey: false },
  });
  vi.stubGlobal('PublicKeyCredential', class {});
  vi.stubGlobal('isSecureContext', true);
  startRegistration.mockReset();
  startRegistration.mockResolvedValue(CREDENTIAL);
  api.set('POST /api/auth/setup/options', { body: OPTIONS });
  api.set('POST /api/auth/setup/verify', {
    status: 201,
    body: { user: USER, recoveryCodes: CODES },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function fill(name = 'Matt', token = 'a-valid-looking-token') {
  const user = userEvent.setup();
  if (name) await user.type(await screen.findByLabelText('Your name'), name);
  if (token) await user.type(screen.getByLabelText('Setup token'), token);
  return user;
}

async function reachStepTwo() {
  renderSetup();
  const user = await fill();
  await user.click(button());
  await screen.findByRole('heading', { level: 1, name: 'Save your recovery codes' });
  return user;
}

describe('step 1: loading and redirects (AC1, AC5)', () => {
  it('shows a skeleton with aria-busy while the session is checked', () => {
    api.set('GET /api/auth/session', () => new Promise(() => {}) as never);
    renderSetup();
    expect(screen.getByTestId('setup-skeleton')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('AC1: lands on /setup from any route when setup is required', async () => {
    renderSetup('/all');
    await screen.findByRole('heading', { level: 1, name: 'Set up Tidings' });
    expect(path()).toBe('/setup');
  });

  it('AC1: /login and /recover redirect to /setup', async () => {
    renderSetup('/login');
    await screen.findByRole('heading', { level: 1, name: 'Set up Tidings' });
    expect(path()).toBe('/setup');
  });

  it('AC5: /setup redirects to /login when a user exists', async () => {
    api.set('GET /api/auth/session', {
      body: { user: null, setupRequired: false, mustAddPasskey: false },
    });
    renderSetup();
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });
    expect(path()).toBe('/login');
  });

  it('redirects a signed-in visitor on /setup to the default view', async () => {
    api.set('GET /api/auth/session', {
      body: { user: USER, setupRequired: false, mustAddPasskey: false },
    });
    renderSetup();
    await waitFor(() => expect(path()).toBe('/all'));
  });

  it('shows the couldn’t-reach banner with Try again when the session check fails', async () => {
    api.set('GET /api/auth/session', { status: 500, body: {} });
    renderSetup();
    expect(await waitFor(() => inMain().getByRole('alert'))).toHaveTextContent(
      "Couldn't reach Tidings. Check your connection and try again.",
    );
    api.set('GET /api/auth/session', {
      body: { user: null, setupRequired: true, mustAddPasskey: false },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByLabelText('Your name')).toBeInTheDocument();
  });
});

describe('step 1: the form', () => {
  it('has the specified copy, fields, attributes and focus order', async () => {
    renderSetup();
    const name = await screen.findByLabelText('Your name');
    const token = screen.getByLabelText('Setup token');
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('Set up Tidings');
    expect(heading).toHaveAttribute('tabindex', '-1');
    expect(document.activeElement).not.toBe(heading); // not forced on load
    expect(document.title).toBe('Set up Tidings - Tidings');
    expect(screen.getByText(/Create your account with a passkey/)).toBeInTheDocument();
    expect(screen.getByText('Shown in Settings.')).toBeInTheDocument();
    expect(
      screen.getByText('The SETUP_TOKEN secret you set when you deployed Tidings.'),
    ).toBeInTheDocument();
    expect(name).toHaveAttribute('autocomplete', 'name');
    expect(name).toHaveAttribute('autocapitalize', 'words');
    expect(token).toHaveAttribute('type', 'password');
    expect(token).toHaveAttribute('autocomplete', 'off');
    expect(token).toHaveAttribute('data-1p-ignore');
    expect(token).toHaveAttribute('data-lpignore', 'true');
    expect(name).not.toHaveAttribute('maxlength');
    expect(screen.getAllByRole('heading')).toHaveLength(1);
    expect(screen.getByRole('main')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.tab();
    expect(name).toHaveFocus();
    await user.tab();
    expect(token).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Show setup token' })).toHaveFocus();
    await user.tab();
    expect(button()).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('link', { name: 'Already set up? Sign in' })).toHaveFocus();
  });

  it('Show / Hide toggles the token field and reports aria-pressed', async () => {
    renderSetup();
    const user = await fill();
    const toggle = screen.getByRole('button', { name: 'Show setup token' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);
    expect(screen.getByLabelText('Setup token')).toHaveAttribute('type', 'text');
    expect(screen.getByRole('button', { name: 'Hide setup token' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('validates on submit, sends nothing and focuses the first invalid field', async () => {
    renderSetup();
    const user = userEvent.setup();
    await screen.findByLabelText('Your name');
    await user.click(button());
    expect(screen.getByText('Enter your name.')).toBeInTheDocument();
    expect(screen.getByText('Enter your setup token.')).toBeInTheDocument();
    expect(screen.getByLabelText('Your name')).toHaveFocus();
    expect(screen.getByLabelText('Your name')).toHaveAttribute('aria-invalid', 'true');
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('rejects 65 characters but allows 64, with no silent truncation', async () => {
    renderSetup();
    const user = await fill('x'.repeat(65));
    await user.click(button());
    expect(screen.getByText('Use 64 characters or fewer.')).toBeInTheDocument();
    expect(screen.getByLabelText('Your name')).toHaveValue('x'.repeat(65));
    await user.clear(screen.getByLabelText('Your name'));
    await user.type(screen.getByLabelText('Your name'), 'y'.repeat(64));
    await user.click(button());
    await screen.findByRole('heading', { name: 'Save your recovery codes' });
  });

  it('Enter in a field submits', async () => {
    renderSetup();
    const user = await fill('Matt', 'tok');
    await user.type(screen.getByLabelText('Setup token'), '{Enter}');
    await screen.findByRole('heading', { name: 'Save your recovery codes' });
  });

  it('does not offer the passkey form when the browser has no passkeys', async () => {
    vi.stubGlobal('PublicKeyCredential', undefined);
    delete (window as { PublicKeyCredential?: unknown }).PublicKeyCredential;
    renderSetup();
    expect(await screen.findByText("This browser can't use passkeys.")).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Set up Tidings');
    expect(screen.queryByLabelText('Setup token')).not.toBeInTheDocument();
    expect(within(screen.getByRole('main')).queryByRole('button')).not.toBeInTheDocument();
  });

  it('explains an insecure context', async () => {
    vi.stubGlobal('isSecureContext', false);
    renderSetup();
    expect(await screen.findByText('Passkeys need a secure connection.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Setup token')).not.toBeInTheDocument();
  });
});

describe('step 1: running the ceremony', () => {
  it('calls options, the browser prompt, then verify, in order, with the specified bodies', async () => {
    renderSetup();
    const user = await fill('  Matt  ', '  tok  ');
    await user.click(button());
    await screen.findByRole('heading', { name: 'Save your recovery codes' });

    const posts = api.calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => c.path)).toEqual(['/api/auth/setup/options', '/api/auth/setup/verify']);
    expect(posts[0]?.body).toEqual({ setupToken: 'tok', displayName: 'Matt' });
    expect(posts[1]?.body).toMatchObject({
      setupToken: 'tok',
      displayName: 'Matt',
      response: CREDENTIAL,
      passkeyName: expect.stringMatching(/^Passkey/) as string,
    });
    expect(startRegistration).toHaveBeenCalledWith({ optionsJSON: OPTIONS });
  });

  it('shows the two in-flight phases with readonly fields and a status helper', async () => {
    let release!: (v: unknown) => void;
    startRegistration.mockReturnValue(new Promise((resolve) => (release = resolve)));
    renderSetup();
    const user = await fill();
    await user.click(button());
    const btn = await screen.findByRole('button', { name: 'Waiting for your passkey...' });
    expect(btn).toHaveAttribute('aria-busy', 'true');
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Follow the prompt on your device.')).toBeInTheDocument();
    expect(screen.getByLabelText('Your name')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('Setup token')).toHaveAttribute('readonly');
    // Escape cancels nothing, and a second press does nothing.
    await user.keyboard('{Escape}');
    await user.click(btn);
    expect(api.calls.filter((c) => c.path === '/api/auth/setup/options')).toHaveLength(1);
    await act(async () => release(CREDENTIAL));
    await screen.findByRole('heading', { name: 'Save your recovery codes' });
  });

  it('a cancelled prompt is an info banner; values are kept and the button is focused', async () => {
    startRegistration.mockRejectedValueOnce(
      Object.assign(new Error('x'), { name: 'NotAllowedError' }),
    );
    renderSetup();
    const user = await fill();
    await user.click(button());
    expect(await screen.findByText('Passkey setup was cancelled. Try again.')).toBeInTheDocument();
    expect(
      screen.getByText('Passkey setup was cancelled. Try again.').closest('[role]'),
    ).toHaveAttribute('role', 'status');
    expect(screen.getByLabelText('Your name')).toHaveValue('Matt');
    expect(screen.getByLabelText('Setup token')).toHaveValue('a-valid-looking-token');
    await waitFor(() => expect(button()).toHaveFocus());
    // Retrying fetches fresh options and succeeds.
    await user.click(button());
    await screen.findByRole('heading', { name: 'Save your recovery codes' });
    expect(api.calls.filter((c) => c.path === '/api/auth/setup/options')).toHaveLength(2);
  });

  it('NotSupportedError shows the device warning above the form with values kept', async () => {
    startRegistration.mockRejectedValueOnce(
      Object.assign(new Error('x'), { name: 'NotSupportedError' }),
    );
    renderSetup();
    const user = await fill();
    await user.click(button());
    const alert = await waitFor(() => inMain().getByRole('alert'));
    expect(alert).toHaveTextContent("This device can't use passkeys.");
    expect(alert).toHaveTextContent(
      'Turn on a screen lock, or connect a security key, then try again.',
    );
    expect(screen.getByLabelText('Your name')).toHaveValue('Matt');
    expect(button()).toBeEnabled();
  });

  it('a wrong setup token marks the token field, focuses and selects it, and keeps the name', async () => {
    api.set('POST /api/auth/setup/options', {
      status: 403,
      body: { error: { code: 'invalid_setup_token', message: 'x' } },
    });
    renderSetup();
    const user = await fill('Matt', 'wrong-token');
    await user.click(button());
    const token = screen.getByLabelText('Setup token') as HTMLInputElement;
    expect(
      await screen.findByText("That setup token isn't right. Check it and try again."),
    ).toBeInTheDocument();
    expect(token).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(token).toHaveFocus());
    expect(token.selectionStart).toBe(0);
    expect(token.selectionEnd).toBe('wrong-token'.length);
    expect(screen.getByLabelText('Your name')).toHaveValue('Matt');
    expect(startRegistration).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: 'Save your recovery codes' })).toBeNull();
  });

  it('an unverifiable passkey shows the verify banner and refocuses the button', async () => {
    api.set('POST /api/auth/setup/verify', {
      status: 401,
      body: { error: { code: 'webauthn_failed', message: 'x' } },
    });
    renderSetup();
    const user = await fill();
    await user.click(button());
    expect(await waitFor(() => inMain().getByRole('alert'))).toHaveTextContent(
      "We couldn't verify that passkey. Try again.",
    );
    await waitFor(() => expect(button()).toHaveFocus());
    expect(screen.getByLabelText('Your name')).toHaveValue('Matt');
  });

  it('AC6 UX: a 429 shows the wait text, blocks the button, then allows a retry', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      api.set('POST /api/auth/setup/options', {
        status: 429,
        body: { error: { code: 'rate_limited', message: 'x' } },
        headers: { 'Retry-After': '420' },
      });
      renderSetup();
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await user.type(await screen.findByLabelText('Your name'), 'Matt');
      await user.type(screen.getByLabelText('Setup token'), 'tok');
      await user.click(button());
      expect(await waitFor(() => inMain().getByRole('alert'))).toHaveTextContent(
        'Too many attempts. Try again in 7 minutes.',
      );
      expect(button()).toHaveAttribute('aria-disabled', 'true');
      expect(
        screen.getByText('Try again in 7 minutes.', { selector: '#setup-helper' }),
      ).toBeInTheDocument();
      await user.click(button());
      expect(api.calls.filter((c) => c.path === '/api/auth/setup/options')).toHaveLength(1);
      await act(async () => {
        vi.advanceTimersByTime(421_000);
      });
      expect(await screen.findByText('You can try again now.')).toBeInTheDocument();
      expect(button()).not.toHaveAttribute('aria-disabled');
    } finally {
      vi.useRealTimers();
    }
  });

  it('without a Retry-After header the wait is "a few minutes"', async () => {
    api.set('POST /api/auth/setup/options', {
      status: 429,
      body: { error: { code: 'rate_limited', message: 'x' } },
    });
    renderSetup();
    const user = await fill();
    await user.click(button());
    expect(await waitFor(() => inMain().getByRole('alert'))).toHaveTextContent(
      'Too many attempts. Try again in a few minutes.',
    );
  });

  it('409 setup_unavailable redirects to /login with the notice', async () => {
    // The server now says setup is closed, to the options call and to any later session check.
    api.set('POST /api/auth/setup/options', () => {
      api.set('GET /api/auth/session', {
        body: { user: null, setupRequired: false, mustAddPasskey: false },
      });
      return { status: 409, body: { error: { code: 'setup_unavailable', message: 'x' } } };
    });
    renderSetup();
    const user = await fill();
    await user.click(button());
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });
    expect(path()).toBe('/login');
    expect(
      screen.getByText('This Tidings is already set up. Sign in instead.'),
    ).toBeInTheDocument();
  });

  it('a network failure shows the couldn’t-reach banner with values kept', async () => {
    api.set('POST /api/auth/setup/options', () => {
      throw new TypeError('Failed to fetch');
    });
    renderSetup();
    const user = await fill();
    await user.click(button());
    expect(await waitFor(() => inMain().getByRole('alert'))).toHaveTextContent(
      "Couldn't reach Tidings. Check your connection and try again.",
    );
    expect(screen.getByLabelText('Your name')).toHaveValue('Matt');
  });

  it('a 500 shows the server error banner', async () => {
    api.set('POST /api/auth/setup/verify', {
      status: 500,
      body: { error: { code: 'internal_error' } },
    });
    renderSetup();
    const user = await fill();
    await user.click(button());
    expect(await waitFor(() => inMain().getByRole('alert'))).toHaveTextContent(
      'Something went wrong on our side. Try again.',
    );
  });

  it('offline: shows the offline banner, blocks the button and sends nothing', async () => {
    renderSetup();
    const user = await fill();
    setOnline(false);
    expect(
      await screen.findByText("You're offline. Connect to the internet to continue."),
    ).toBeInTheDocument();
    expect(button()).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText("You're offline.", { selector: '#setup-helper' })).toBeInTheDocument();
    await user.click(button());
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    setOnline(true);
    await waitFor(() => expect(screen.queryByText(/You're offline/)).toBeNull());
  });
});

describe('step 2: recovery codes (AC2, AC3)', () => {
  it('replaces the card in place with no navigation, focuses the h1 and sets the title', async () => {
    await reachStepTwo();
    expect(path()).toBe('/setup');
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1).toHaveTextContent('Save your recovery codes');
    expect(h1).toHaveFocus();
    expect(document.title).toBe('Save your recovery codes - Tidings');
    expect(screen.queryByLabelText('Setup token')).not.toBeInTheDocument();
    expect(
      screen.getByText("Save these now. This is the only time they're shown."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'If you lose your passkey, one of these codes signs you in. Each code works once.',
      ),
    ).toBeInTheDocument();
  });

  it('lists all 10 codes exactly as returned, in an ordered list', async () => {
    await reachStepTwo();
    const list = screen.getByRole('list', { name: 'Recovery codes' });
    expect(list.tagName).toBe('OL');
    const shown = Array.from(list.querySelectorAll('li code')).map((c) => c.textContent);
    expect(shown).toEqual(CODES);
  });

  it('keeps the focus order Copy, Download, checkbox, Continue', async () => {
    const user = await reachStepTwo();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Copy codes, all 10 recovery codes' })).toHaveFocus();
    await user.tab();
    expect(
      screen.getByRole('button', { name: 'Download .txt file of recovery codes' }),
    ).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('checkbox', { name: "I've saved these" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Continue' })).toHaveFocus();
  });

  it('Continue is inert until the box is ticked, and a press says why', async () => {
    const user = await reachStepTwo();
    const cont = screen.getByRole('button', { name: 'Continue' });
    expect(cont).toHaveAttribute('aria-disabled', 'true');
    expect(cont).toHaveAccessibleDescription('Tick the box to continue.');
    await user.click(cont);
    expect(path()).toBe('/setup');
    expect(
      screen.getAllByRole('status').some((r) => r.textContent === 'Tick the box to continue.'),
    ).toBe(true);
    await user.click(screen.getByRole('checkbox', { name: "I've saved these" }));
    expect(cont).not.toHaveAttribute('aria-disabled');
    await user.click(screen.getByRole('checkbox', { name: "I've saved these" }));
    expect(cont).toHaveAttribute('aria-disabled', 'true');
  });

  it('AC3: ticking and pressing Continue lands on /all', async () => {
    const user = await reachStepTwo();
    await user.click(screen.getByRole('checkbox', { name: "I've saved these" }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(path()).toBe('/all'));
    expect(screen.queryByText(CODES[0] as string)).not.toBeInTheDocument();
    // The session cache now says signed in, so /setup would redirect rather than re-show.
    expect(client.getQueryData(['session'])).toEqual({
      user: USER,
      setupRequired: false,
      mustAddPasskey: false,
    });
  });

  it('AC3: Copy writes all 10 codes, one per line, and confirms', async () => {
    const user = await reachStepTwo();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    expect(
      screen.getByText("Somewhere safe, like a password manager. They won't be shown again."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy codes, all 10 recovery codes' }));
    expect(writeText).toHaveBeenCalledWith(CODES.join('\n'));
    expect(await screen.findByText('Copied 10 codes.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copied 10 recovery codes' })).toHaveTextContent(
      'Copied',
    );
    expect(
      screen.getByText("You can get new codes later in Settings, but these won't be shown again."),
    ).toBeInTheDocument();
  });

  it('shows the copy failure as an alert and leaves the codes selectable', async () => {
    const user = await reachStepTwo();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    await user.click(screen.getByRole('button', { name: 'Copy codes, all 10 recovery codes' }));
    const alert = await waitFor(() => inMain().getByRole('alert'));
    expect(alert).toHaveTextContent("Couldn't copy. Select the codes and copy them by hand.");
    expect(screen.getByRole('list', { name: 'Recovery codes' }).className).toContain('select-text');
  });

  it('AC3/AC10: Download builds a text blob with all 10 codes and clicks a download anchor', async () => {
    const blobs: Blob[] = [];
    const createObjectURL = vi.fn((b: Blob) => {
      blobs.push(b);
      return 'blob:http://localhost/xyz';
    });
    const revoke = vi.fn();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revoke;
    const clicked: Array<{ download: string; href: string }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({ download: this.download, href: this.href });
    });
    const user = await reachStepTwo();
    await user.click(screen.getByRole('button', { name: 'Download .txt file of recovery codes' }));
    expect(clicked).toEqual([
      { download: 'tidings-recovery-codes.txt', href: 'blob:http://localhost/xyz' },
    ]);
    const text = await blobs[0]?.text();
    expect(text).toMatch(/^Tidings recovery codes\nCreated \d{4}-\d{2}-\d{2} for .+\n\n/);
    CODES.forEach((code, i) => expect(text).toContain(`${i + 1}. ${code}\n`));
    expect(text).not.toContain('\r');
    expect(await screen.findByText('Saved tidings-recovery-codes.txt.')).toBeInTheDocument();
  });

  it('shows the download failure message', async () => {
    URL.createObjectURL = vi.fn(() => {
      throw new Error('blocked');
    });
    const user = await reachStepTwo();
    await user.click(screen.getByRole('button', { name: 'Download .txt file of recovery codes' }));
    expect(await waitFor(() => inMain().getByRole('alert'))).toHaveTextContent(
      "Couldn't download the file. Copy the codes instead.",
    );
  });
});

describe('step 2: keeping the codes (setup.md section 6, AC12)', () => {
  it('never puts codes or the setup token in the query cache, web storage, history state, the URL or the title', async () => {
    const user = await reachStepTwo();
    const hay = () =>
      JSON.stringify({
        cache: client
          .getQueryCache()
          .getAll()
          .map((q) => ({ key: q.queryKey, data: q.state.data })),
        mutations: client.getMutationCache().getAll().length,
        local: { ...localStorage },
        session: { ...sessionStorage },
        state: screen.getByTestId('state').textContent,
        path: path(),
        title: document.title,
      });
    for (const probe of [...CODES, 'a-valid-looking-token']) {
      expect(hay()).not.toContain(probe);
      expect(hay()).not.toContain(probe.replace(/-/g, ''));
    }
    expect(client.getMutationCache().getAll()).toHaveLength(0);
    await user.click(screen.getByRole('checkbox', { name: "I've saved these" }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(path()).toBe('/all'));
    for (const probe of CODES) expect(hay()).not.toContain(probe);
    expect(document.body.textContent).not.toContain(CODES[0]);
  });

  it('puts the codes in no aria-label other than the list label', async () => {
    await reachStepTwo();
    const labelled = Array.from(document.querySelectorAll('[aria-label]')).map((e) =>
      e.getAttribute('aria-label'),
    );
    for (const label of labelled) for (const c of CODES) expect(label).not.toContain(c);
  });

  it('registers beforeunload while unticked and removes it once ticked', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const user = await reachStepTwo();
    expect(add.mock.calls.filter(([t]) => t === 'beforeunload')).toHaveLength(1);
    const handler = add.mock.calls.find(([t]) => t === 'beforeunload')?.[1] as (
      e: BeforeUnloadEvent,
    ) => void;
    const ev = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    handler(ev);
    expect(ev.defaultPrevented).toBe(true);
    await user.click(screen.getByRole('checkbox', { name: "I've saved these" }));
    expect(remove.mock.calls.some(([t]) => t === 'beforeunload')).toBe(true);
  });

  it('pushes one extra history entry that carries only a flag', async () => {
    await reachStepTwo();
    await waitFor(() =>
      expect(screen.getByTestId('state').textContent).toBe('{"setupCodes":true}'),
    );
  });
});

describe('step 2: the leave dialog (setup.md 5.5)', () => {
  async function pressBack(user: ReturnType<typeof userEvent.setup>) {
    await waitFor(() => expect(screen.getByTestId('state').textContent).toContain('setupCodes'));
    await user.click(screen.getByRole('button', { name: 'system back' }));
  }

  it('Back with the box unticked opens the dialog, focused on "Stay and save codes"', async () => {
    const user = await reachStepTwo();
    await pressBack(user);
    const dialog = await screen.findByRole('alertdialog', { name: 'Leave without saving?' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription(
      "Your recovery codes won't be shown again. You can make new ones later in Settings.",
    );
    expect(screen.getByRole('button', { name: 'Stay and save codes' })).toHaveFocus();
    // The guard entry is back in place, so a second Back is caught too.
    await waitFor(() => expect(screen.getByTestId('state').textContent).toContain('setupCodes'));
    expect(path()).toBe('/setup');
  });

  it('traps Tab between the two buttons', async () => {
    const user = await reachStepTwo();
    await pressBack(user);
    await screen.findByRole('alertdialog');
    await user.tab();
    expect(screen.getByRole('button', { name: 'Leave anyway' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Stay and save codes' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Leave anyway' })).toHaveFocus();
  });

  it('Escape and "Stay and save codes" close it and return focus to the checkbox', async () => {
    const user = await reachStepTwo();
    await pressBack(user);
    await screen.findByRole('alertdialog');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: "I've saved these" })).toHaveFocus();
    expect(screen.getByRole('list', { name: 'Recovery codes' })).toBeInTheDocument();

    await pressBack(user);
    await user.click(await screen.findByRole('button', { name: 'Stay and save codes' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('a tap on the scrim chooses Stay', async () => {
    const user = await reachStepTwo();
    await pressBack(user);
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toBeInTheDocument();
    await user.click(document.querySelector('[data-scrim]') as HTMLElement);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('Leave anyway goes to /all and drops the codes', async () => {
    const user = await reachStepTwo();
    await pressBack(user);
    await user.click(await screen.findByRole('button', { name: 'Leave anyway' }));
    await waitFor(() => expect(path()).toBe('/all'));
    expect(document.body.textContent).not.toContain(CODES[0]);
  });

  it('with the box ticked, Back just leaves to /all with no dialog', async () => {
    const user = await reachStepTwo();
    await user.click(screen.getByRole('checkbox', { name: "I've saved these" }));
    await pressBack(user);
    await waitFor(() => expect(path()).toBe('/all'));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
