import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Locator, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations } from '../support/axe.ts';
import { E2E_SETUP_TOKEN, resetToSetupRequired, seedOwner } from '../support/auth-state.ts';
import { expect, test as base } from '../support/test.ts';
import {
  addVirtualAuthenticator,
  type VirtualAuthenticator,
  type VirtualAuthenticatorOptions,
} from '../support/virtual-authenticator.ts';

// TID-007: first-run setup with a passkey and recovery codes, through the real screens and the
// real Worker, using Chromium's virtual authenticator. Runs in all four projects
// (mobile-light, mobile-dark, desktop-light, desktop-dark). Setup can succeed once per database,
// so each test starts from an empty one and the owner is put back afterwards (auth-state.ts).

const CODE = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/;
const here = path.dirname(fileURLToPath(import.meta.url));

const test = base.extend<{
  authenticator: VirtualAuthenticator;
  newAuthenticator: (options?: VirtualAuthenticatorOptions) => Promise<VirtualAuthenticator>;
}>({
  newAuthenticator: async ({ page }, use) => {
    const made: VirtualAuthenticator[] = [];
    await use(async (options) => {
      const a = await addVirtualAuthenticator(page, options);
      made.push(a);
      return a;
    });
    for (const a of made) await a.remove().catch(() => undefined);
  },
  authenticator: async ({ newAuthenticator }, use) => {
    await use(await newAuthenticator());
  },
});

test.beforeEach(() => resetToSetupRequired());
test.afterAll(() => seedOwner());

// ---- helpers --------------------------------------------------------------------------------

const nameField = (page: Page) => page.getByLabel('Your name');
const tokenField = (page: Page) => page.getByLabel('Setup token', { exact: true });
const createButton = (page: Page) => page.getByRole('button', { name: /passkey|Waiting/i });
const heading = (page: Page, name: string) => page.getByRole('heading', { level: 1, name });
const main = (page: Page) => page.getByRole('main');

async function openSetup(page: Page) {
  await page.goto('/setup');
  await expect(heading(page, 'Set up Tidings')).toBeVisible();
  await expect(nameField(page)).toBeVisible();
}

async function fillForm(page: Page, name = 'Matt E2E', token = E2E_SETUP_TOKEN) {
  await nameField(page).fill(name);
  await tokenField(page).fill(token);
}

async function reachCodes(page: Page): Promise<string[]> {
  await openSetup(page);
  await fillForm(page);
  await createButton(page).click();
  await expect(heading(page, 'Save your recovery codes')).toBeVisible();
  return readCodes(page);
}

async function readCodes(page: Page): Promise<string[]> {
  return page.getByRole('list', { name: 'Recovery codes' }).locator('code').allTextContents();
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function expectTapTarget(locator: Locator, minHeight = 44) {
  const box = await locator.boundingBox();
  expect(box, 'element has a box').not.toBeNull();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(minHeight - 0.5);
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(minHeight - 0.5);
}

/** Everything the page can persist, flattened to one string for "the codes are nowhere" checks. */
async function dumpClientState(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const idb: unknown[] = [];
    const dbs = (await indexedDB.databases?.()) ?? [];
    for (const info of dbs) {
      if (!info.name) continue;
      await new Promise<void>((resolve) => {
        const open = indexedDB.open(info.name as string);
        open.onerror = () => resolve();
        open.onsuccess = () => {
          const db = open.result;
          const stores = Array.from(db.objectStoreNames);
          if (stores.length === 0) {
            db.close();
            resolve();
            return;
          }
          const tx = db.transaction(stores, 'readonly');
          let pending = stores.length;
          for (const s of stores) {
            const req = tx.objectStore(s).getAll();
            req.onsuccess = () => {
              idb.push({ db: info.name, store: s, rows: req.result });
              if (--pending === 0) {
                db.close();
                resolve();
              }
            };
            req.onerror = () => {
              if (--pending === 0) {
                db.close();
                resolve();
              }
            };
          }
        };
      });
    }
    return JSON.stringify({
      local: { ...localStorage },
      session: { ...sessionStorage },
      idb,
      historyState: history.state,
      href: location.href,
      title: document.title,
      cookie: document.cookie,
    });
  });
}

// ---- AC1 ------------------------------------------------------------------------------------

test.describe('AC1: a fresh instance routes to /setup', () => {
  test('GET /api/auth/session reports {user:null, setupRequired:true}', async ({ request }) => {
    const res = await request.get('/api/auth/session');
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ user: null, setupRequired: true, mustAddPasskey: false });
    expect(res.headers()['cache-control']).toBe('no-store');
  });

  for (const from of ['/', '/all', '/login', '/recover', '/settings']) {
    test(`loading ${from} lands on /setup`, async ({ page }) => {
      await page.goto(from);
      await expect(page).toHaveURL(/\/setup$/);
      await expect(heading(page, 'Set up Tidings')).toBeVisible();
    });
  }

  test('the session check shows a skeleton before the form', async ({ page }) => {
    await page.route('**/api/auth/session', async (route) => {
      await new Promise((r) => setTimeout(r, 600));
      await route.continue();
    });
    await page.goto('/setup');
    await expect(page.getByTestId('setup-skeleton')).toHaveAttribute('aria-busy', 'true');
    await expect(nameField(page)).toBeVisible();
  });

  test('a failed session check shows the banner with Try again', async ({ page }) => {
    let fail = true;
    await page.route('**/api/auth/session', (route) =>
      fail ? route.abort('failed') : route.continue(),
    );
    await page.goto('/setup');
    await expect(main(page).getByRole('alert')).toContainText("Couldn't reach Tidings.");
    fail = false;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(nameField(page)).toBeVisible();
  });
});

// ---- AC2, AC3 -------------------------------------------------------------------------------

test.describe('AC2 and AC3: the setup journey', () => {
  test('creates the owner and a passkey, signs in, and shows 10 distinct codes', async ({
    page,
    context,
    request,
    authenticator,
  }) => {
    const consoleLines: string[] = [];
    page.on('console', (m) => consoleLines.push(m.text()));

    const codes = await reachCodes(page);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(CODE);

    expect(await authenticator.credentials()).toHaveLength(1);
    expect((await authenticator.credentials())[0]?.isResidentCredential).toBe(true);

    const cookies = await context.cookies();
    const session = cookies.find((c) => c.name === '__Host-tid_session');
    expect(session, 'session cookie').toBeDefined();
    expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
    expect(session?.domain).toBe('localhost');
    // The challenge cookie is spent.
    expect(cookies.find((c) => c.name === '__Host-tid_chal')).toBeUndefined();

    // The cookie works: the session endpoint now knows the owner.
    const me = await page.request.get('/api/auth/session');
    expect(await me.json()).toMatchObject({
      user: { displayName: 'Matt E2E', role: 'owner' },
      setupRequired: false,
    });
    // ... and nobody else's request does.
    const anonymous = await request.get('/api/auth/session');
    expect(await anonymous.json()).toMatchObject({ user: null, setupRequired: false });

    // No console output carries a code.
    for (const line of consoleLines) for (const c of codes) expect(line).not.toContain(c);
  });

  test('Continue is inert until "I\'ve saved these" is ticked, then lands on /all', async ({
    page,
    authenticator,
  }) => {
    void authenticator;
    await reachCodes(page);
    const cont = page.getByRole('button', { name: 'Continue' });
    await expect(cont).toHaveAttribute('aria-disabled', 'true');
    await cont.click({ force: true }); // aria-disabled: Playwright would wait forever
    await expect(page).toHaveURL(/\/setup$/);
    await expect(page.getByText('Tick the box to continue.').first()).toBeVisible();

    const box = page.getByRole('checkbox', { name: "I've saved these" });
    await expect(box).not.toBeChecked();
    await box.check();
    await expect(cont).not.toHaveAttribute('aria-disabled', 'true');
    await box.uncheck();
    await expect(cont).toHaveAttribute('aria-disabled', 'true');
    await box.check();
    await cont.click();

    await expect(page).toHaveURL(/\/all$/);
    await expect(heading(page, 'All articles')).toBeVisible();
    // After setup the codes are gone and /setup no longer shows them.
    await expect(page.getByText(CODE)).toHaveCount(0);
    await page.goto('/setup');
    await expect(page).toHaveURL(/\/all$/); // signed in: default view
  });

  test('step 2 has the specified structure, focus and focus order', async ({
    page,
    authenticator,
  }) => {
    void authenticator;
    await reachCodes(page);
    await expect(heading(page, 'Save your recovery codes')).toBeFocused();
    await expect(page).toHaveTitle('Save your recovery codes - Tidings');
    await expect(page.getByRole('heading')).toHaveCount(1);
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(
      page.getByText("Save these now. This is the only time they're shown."),
    ).toBeVisible();
    await expect(page.getByLabel('Setup token')).toHaveCount(0);

    await page.keyboard.press('Tab');
    await expect(
      page.getByRole('button', { name: 'Copy codes, all 10 recovery codes' }),
    ).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(
      page.getByRole('button', { name: 'Download .txt file of recovery codes' }),
    ).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('checkbox', { name: "I've saved these" })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Continue' })).toBeFocused();
  });

  test('step 2 keeps tap targets, width and axe clean, before and after ticking', async ({
    page,
    authenticator,
  }) => {
    void authenticator;
    await reachCodes(page);
    await noHorizontalScroll(page);
    await expectNoSeriousA11yViolations(page);
    await expectTapTarget(page.getByRole('button', { name: 'Copy codes, all 10 recovery codes' }));
    await expectTapTarget(
      page.getByRole('button', { name: 'Download .txt file of recovery codes' }),
    );
    await expectTapTarget(page.getByRole('button', { name: 'Continue' }), 48);
    const checkboxRow = page.locator('label', { hasText: "I've saved these" });
    expect((await checkboxRow.boundingBox())?.height).toBeGreaterThanOrEqual(43.5);
    const checkbox = await page.getByRole('checkbox', { name: "I've saved these" }).boundingBox();
    expect(checkbox?.width).toBeGreaterThanOrEqual(23.5);
    await page.getByRole('checkbox', { name: "I've saved these" }).check();
    await expectNoSeriousA11yViolations(page);
    // Every code sits on one line inside the list container.
    const rows = page.getByRole('list', { name: 'Recovery codes' }).locator('li');
    for (let i = 0; i < 10; i++) {
      expect((await rows.nth(i).boundingBox())?.height).toBeLessThan(60);
    }
  });

  test('Copy puts all 10 codes on the clipboard, one per line', async ({
    page,
    context,
    authenticator,
  }) => {
    void authenticator;
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const codes = await reachCodes(page);
    await page.getByRole('button', { name: 'Copy codes, all 10 recovery codes' }).click();
    await expect(page.getByText('Copied 10 codes.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copied 10 recovery codes' })).toContainText(
      'Copied',
    );
    await expect(
      page.getByText("You can get new codes later in Settings, but these won't be shown again."),
    ).toBeVisible();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip.split('\n')).toEqual(codes);
    await expectNoSeriousA11yViolations(page);
  });
});

// ---- AC10 -----------------------------------------------------------------------------------

test.describe('AC10: Download .txt works with the CSP unchanged', () => {
  test('saves tidings-recovery-codes.txt with all 10 codes and logs no CSP violation', async ({
    page,
    authenticator,
  }) => {
    void authenticator;
    const problems: string[] = [];
    page.on('console', (m) => {
      if (/content security policy|refused to/i.test(m.text())) problems.push(m.text());
    });
    await page.addInitScript(() => {
      (window as unknown as { __csp: string[] }).__csp = [];
      document.addEventListener('securitypolicyviolation', (e) =>
        (window as unknown as { __csp: string[] }).__csp.push(
          `${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber} ${e.sample}`,
        ),
      );
    });

    // The policy is the one in apps/web/public/_headers, untouched.
    const headersFile = await readFile(
      path.resolve(here, '../../apps/web/public/_headers'),
      'utf8',
    );
    const expectedCsp = /Content-Security-Policy: (.+)/.exec(headersFile)?.[1]?.trim();
    expect(expectedCsp).toContain("default-src 'self'");
    expect(expectedCsp).not.toContain('blob:');
    const response = await page.goto('/setup');
    expect(response?.headers()['content-security-policy']).toBe(expectedCsp);

    await fillForm(page);
    await createButton(page).click();
    await expect(heading(page, 'Save your recovery codes')).toBeVisible();
    const codes = await readCodes(page);

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download .txt file of recovery codes' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('tidings-recovery-codes.txt');
    const file = await readFile((await download.path()) as string, 'utf8');
    expect(file).toMatch(
      /^Tidings recovery codes\nCreated \d{4}-\d{2}-\d{2} for localhost:\d+\n\n/,
    );
    expect(file).toContain('Each code works once. Keep this file somewhere safe and private.');
    codes.forEach((c, i) => expect(file).toContain(`${i + 1}. ${c}\n`));
    expect(file.match(new RegExp(CODE.source.slice(1, -1), 'g'))).toHaveLength(10);
    expect(file).not.toContain('\r');
    await expect(page.getByText('Saved tidings-recovery-codes.txt.')).toBeVisible();

    expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
    expect(problems).toEqual([]);
  });
});

// ---- AC12 -----------------------------------------------------------------------------------

test.describe('AC12: the codes are never stored', () => {
  test('codes are not in any storage, history state or the URL, during or after step 2', async ({
    page,
    authenticator,
  }) => {
    void authenticator;
    const codes = await reachCodes(page);
    // Let any persister or effect settle, then look.
    await page.waitForTimeout(500);

    const during = await dumpClientState(page);
    for (const c of codes) {
      expect(during).not.toContain(c);
      expect(during).not.toContain(c.replaceAll('-', ''));
    }
    expect(during).not.toContain(E2E_SETUP_TOKEN);
    // The only history state is the Back guard's flag.
    expect(await page.evaluate(() => history.state?.usr)).toEqual({ setupCodes: true });

    await page.getByRole('checkbox', { name: "I've saved these" }).check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page).toHaveURL(/\/all$/);
    await page.waitForTimeout(500);

    const after = await dumpClientState(page);
    for (const c of codes) {
      expect(after).not.toContain(c);
      expect(after).not.toContain(c.replaceAll('-', ''));
    }
    expect(after).not.toContain(E2E_SETUP_TOKEN);
    await expect(page.getByText(CODE)).toHaveCount(0);
  });

  test('the API response for setup/verify is not cacheable', async ({ page, authenticator }) => {
    void authenticator;
    await openSetup(page);
    await fillForm(page);
    const verify = page.waitForResponse('**/api/auth/setup/verify');
    await createButton(page).click();
    const res = await verify;
    expect(res.status()).toBe(201);
    expect(res.headers()['cache-control']).toBe('no-store');
    expect(((await res.json()) as { recoveryCodes: string[] }).recoveryCodes).toHaveLength(10);
  });
});

// ---- guards ---------------------------------------------------------------------------------

test.describe('losing the codes by accident (setup.md 5.5)', () => {
  test('closing the tab asks first while unticked, and does not once ticked', async ({
    page,
    authenticator,
  }) => {
    void authenticator;
    await reachCodes(page);
    // A user gesture is needed before Chromium shows a beforeunload prompt; the clicks did that.
    const dialog = page.waitForEvent('dialog', { timeout: 5000 });
    await page.close({ runBeforeUnload: true });
    const d = await dialog;
    expect(d.type()).toBe('beforeunload');
    await d.dismiss();
    expect(page.isClosed()).toBe(false);

    await page.getByRole('checkbox', { name: "I've saved these" }).check();
    let prompted = false;
    page.on('dialog', (x) => {
      prompted = true;
      void x.dismiss();
    });
    await page.reload();
    expect(prompted).toBe(false);
    await expect(page).toHaveURL(/\/all$/); // signed in, so /setup goes to the default view
  });

  test('Back opens "Leave without saving?"; Stay keeps the codes; Leave anyway goes to /all', async ({
    page,
    authenticator,
  }) => {
    void authenticator;
    const codes = await reachCodes(page);
    await page.goBack();
    const dialog = page.getByRole('alertdialog', { name: 'Leave without saving?' });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText(
        "Your recovery codes won't be shown again. You can make new ones later in Settings.",
      ),
    ).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Stay and save codes' })).toBeFocused();
    await expect(page).toHaveURL(/\/setup$/);
    await expectNoSeriousA11yViolations(page);
    await noHorizontalScroll(page);

    // Escape and Stay both keep the codes, and focus returns to the checkbox.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('checkbox', { name: "I've saved these" })).toBeFocused();
    expect(await readCodes(page)).toEqual(codes);

    // The guard re-armed itself: Back asks again.
    await page.goBack();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Stay and save codes' }).click();
    await expect(dialog).toBeHidden();
    expect(await readCodes(page)).toEqual(codes);

    await page.goBack();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Leave anyway' }).click();
    await expect(page).toHaveURL(/\/all$/);
    await expect(page.getByText(CODE)).toHaveCount(0);
  });

  test('with the box ticked, Back just leaves to /all with no dialog', async ({
    page,
    authenticator,
  }) => {
    void authenticator;
    await reachCodes(page);
    await page.getByRole('checkbox', { name: "I've saved these" }).check();
    await page.goBack();
    await expect(page).toHaveURL(/\/all$/);
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
  });
});

// ---- AC4, AC5, AC6, AC8 (API) ---------------------------------------------------------------

test.describe('AC4: a wrong setup token is refused', () => {
  test('setup/options and setup/verify return 403 invalid_setup_token and create nothing', async ({
    request,
  }) => {
    const options = await request.post('/api/auth/setup/options', {
      data: { setupToken: 'not-the-token', displayName: 'Mallory' },
    });
    expect(options.status()).toBe(403);
    expect((await options.json()).error.code).toBe('invalid_setup_token');
    const verify = await request.post('/api/auth/setup/verify', {
      data: {
        setupToken: 'not-the-token',
        displayName: 'Mallory',
        response: { id: 'a', rawId: 'a', type: 'public-key', response: {} },
      },
    });
    expect([400, 403]).toContain(verify.status());
    const session = await request.get('/api/auth/session');
    expect(await session.json()).toMatchObject({ setupRequired: true, user: null });
  });

  test('the form shows the field error, focuses and selects the token, and keeps the name', async ({
    page,
    authenticator,
  }) => {
    await openSetup(page);
    await fillForm(page, 'Matt E2E', 'definitely-wrong-token');
    await createButton(page).click();
    const error = page.getByText("That setup token isn't right. Check it and try again.");
    await expect(error).toBeVisible();
    await expect(tokenField(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(tokenField(page)).toBeFocused();
    const selected = await tokenField(page).evaluate((el: HTMLInputElement) =>
      el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0),
    );
    expect(selected).toBe('definitely-wrong-token');
    await expect(nameField(page)).toHaveValue('Matt E2E');
    expect(await authenticator.credentials()).toHaveLength(0); // no prompt was shown
    await expectNoSeriousA11yViolations(page);
    await noHorizontalScroll(page);
  });
});

test.describe('AC5: setup is closed once a user exists', () => {
  test('both endpoints return 409 setup_unavailable, even with the right token', async ({
    request,
  }) => {
    seedOwner();
    const options = await request.post('/api/auth/setup/options', {
      data: { setupToken: E2E_SETUP_TOKEN, displayName: 'Second' },
    });
    expect(options.status()).toBe(409);
    expect((await options.json()).error.code).toBe('setup_unavailable');
    const verify = await request.post('/api/auth/setup/verify', {
      data: {
        setupToken: E2E_SETUP_TOKEN,
        displayName: 'Second',
        response: { id: 'a', rawId: 'a', type: 'public-key', response: {} },
      },
    });
    expect(verify.status()).toBe(409);
    expect((await verify.json()).error.code).toBe('setup_unavailable');
  });

  test('/setup redirects to /login when a user exists', async ({ page }) => {
    seedOwner();
    await page.goto('/setup');
    await expect(page).toHaveURL(/\/login$/);
    await expect(heading(page, 'Sign in')).toBeVisible();
    await expect(page.getByText('This Tidings is already set up.')).toHaveCount(0);
  });

  test('a 409 in the middle of setup goes to /login with the notice', async ({
    page,
    authenticator,
  }) => {
    void authenticator;
    await openSetup(page);
    await fillForm(page);
    seedOwner(); // someone else finished setup first
    await createButton(page).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText('This Tidings is already set up. Sign in instead.')).toBeVisible();
  });
});

test.describe('AC6: setup attempts are rate limited', () => {
  test('the 11th failed attempt gets 429 rate_limited with Retry-After', async ({ request }) => {
    for (let i = 0; i < 10; i++) {
      const res = await request.post('/api/auth/setup/options', {
        data: { setupToken: `wrong-${i}`, displayName: 'Mallory' },
      });
      expect(res.status()).toBe(403);
    }
    const limited = await request.post('/api/auth/setup/options', {
      data: { setupToken: E2E_SETUP_TOKEN, displayName: 'Matt' },
    });
    expect(limited.status()).toBe(429);
    expect((await limited.json()).error.code).toBe('rate_limited');
    const retry = Number(limited.headers()['retry-after']);
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(600);
  });

  test('the form shows the wait text and blocks the button, with fields editable', async ({
    page,
    request,
  }) => {
    for (let i = 0; i < 10; i++) {
      await request.post('/api/auth/setup/options', {
        data: { setupToken: `wrong-${i}`, displayName: 'Mallory' },
      });
    }
    await openSetup(page);
    await fillForm(page);
    await createButton(page).click();
    const banner = main(page).getByRole('alert');
    await expect(banner).toContainText(/Too many attempts\. Try again in (9|10) minutes\./);
    await expect(createButton(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('#setup-helper')).toContainText(/Try again in (9|10) minutes/);
    await expect(nameField(page)).not.toHaveAttribute('readonly', '');
    await expectNoSeriousA11yViolations(page);
    await noHorizontalScroll(page);
  });

  test('a successful setup does not count against the limit', async ({ page, authenticator }) => {
    void authenticator;
    await reachCodes(page);
    const next = await page.request.post('/api/auth/setup/options', {
      data: { setupToken: 'x', displayName: 'y' },
    });
    expect(next.status()).toBe(409); // closed, not limited
  });
});

test.describe('AC8: challenges are single use', () => {
  test('a verify with no challenge cookie, or one already spent, is 401 webauthn_failed', async ({
    request,
  }) => {
    const options = await request.post('/api/auth/setup/options', {
      data: { setupToken: E2E_SETUP_TOKEN, displayName: 'Matt' },
    });
    expect(options.status()).toBe(200);
    const body = {
      setupToken: E2E_SETUP_TOKEN,
      displayName: 'Matt',
      response: {
        id: 'AAAA',
        rawId: 'AAAA',
        type: 'public-key',
        response: { clientDataJSON: 'AAAA', attestationObject: 'AAAA' },
      },
    };
    // First attempt uses (and burns) the challenge held in the request context's cookie jar.
    const first = await request.post('/api/auth/setup/verify', { data: body });
    expect(first.status()).toBe(401);
    expect((await first.json()).error.code).toBe('webauthn_failed');
    // Second attempt: the challenge is gone.
    const second = await request.post('/api/auth/setup/verify', { data: body });
    expect(second.status()).toBe(401);
    expect((await second.json()).error.code).toBe('webauthn_failed');
    const session = await request.get('/api/auth/session');
    expect(await session.json()).toMatchObject({ setupRequired: true });
  });

  test('the form shows "We couldn\'t verify that passkey" and refocuses the button', async ({
    page,
    authenticator,
  }) => {
    void authenticator;
    await page.route('**/api/auth/setup/verify', (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'webauthn_failed', message: 'x' } }),
      }),
    );
    await openSetup(page);
    await fillForm(page);
    await createButton(page).click();
    await expect(main(page).getByRole('alert')).toContainText(
      "We couldn't verify that passkey. Try again.",
    );
    await expect(createButton(page)).toBeFocused();
    await expect(nameField(page)).toHaveValue('Matt E2E');
    await expectNoSeriousA11yViolations(page);
  });
});

// ---- the states in setup.md -----------------------------------------------------------------

test.describe('step 1 states (setup.md section 2)', () => {
  test('default: copy, attributes, focus order, tap targets, axe, no horizontal scroll', async ({
    page,
    authenticator,
  }) => {
    void authenticator;
    await openSetup(page);
    await expect(page).toHaveTitle('Set up Tidings - Tidings');
    await expect(page.getByText(/Create your account with a passkey/)).toBeVisible();
    await expect(page.getByText('Shown in Settings.')).toBeVisible();
    await expect(
      page.getByText('The SETUP_TOKEN secret you set when you deployed Tidings.'),
    ).toBeVisible();
    await expect(tokenField(page)).toHaveAttribute('type', 'password');
    await expect(page.getByRole('heading')).toHaveCount(1);
    await expect(page.getByRole('link', { name: 'Already set up? Sign in' })).toHaveAttribute(
      'href',
      '/login',
    );

    // Focus is not forced onto the heading, and the order is name, token, show, button, link.
    await expect(page.locator(':focus')).toHaveCount(0);
    for (const target of [
      nameField(page),
      tokenField(page),
      page.getByRole('button', { name: 'Show setup token' }),
      createButton(page),
      page.getByRole('link', { name: 'Already set up? Sign in' }),
    ]) {
      await page.keyboard.press('Tab');
      await expect(target).toBeFocused();
    }

    await expectTapTarget(page.getByRole('button', { name: 'Show setup token' }));
    await expectTapTarget(page.getByRole('link', { name: 'Already set up? Sign in' }), 44);
    expect((await nameField(page).boundingBox())?.height).toBeGreaterThanOrEqual(47.5);
    expect((await createButton(page).boundingBox())?.height).toBeGreaterThanOrEqual(47.5);
    await noHorizontalScroll(page);
    await expectNoSeriousA11yViolations(page);
  });

  test('Show / Hide reveals the token and reports its state', async ({ page, authenticator }) => {
    void authenticator;
    await openSetup(page);
    await tokenField(page).fill('secret-value');
    const toggle = page.getByRole('button', { name: 'Show setup token' });
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(tokenField(page)).toHaveAttribute('type', 'text');
    await expect(page.getByRole('button', { name: 'Hide setup token' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('validation: empty fields and a 65-character name are caught before anything is sent', async ({
    page,
    authenticator,
  }) => {
    void authenticator;
    let posts = 0;
    page.on('request', (r) => r.method() === 'POST' && posts++);
    await openSetup(page);
    await createButton(page).click();
    await expect(page.getByText('Enter your name.')).toBeVisible();
    await expect(page.getByText('Enter your setup token.')).toBeVisible();
    await expect(nameField(page)).toBeFocused();
    await nameField(page).fill('x'.repeat(65));
    await tokenField(page).fill('t');
    await createButton(page).click();
    await expect(page.getByText('Use 64 characters or fewer.')).toBeVisible();
    await expect(nameField(page)).toHaveValue('x'.repeat(65)); // never silently truncated
    expect(posts).toBe(0);
    await expectNoSeriousA11yViolations(page);
  });

  test('in progress: the passkey prompt phase shows its label, helper and read-only fields', async ({
    page,
    newAuthenticator,
  }) => {
    // Without automatic presence the prompt stays open, like a person who has not touched the sensor.
    await newAuthenticator({ automaticPresenceSimulation: false });
    await openSetup(page);
    await fillForm(page);
    await createButton(page).click();
    const waiting = page.getByRole('button', { name: 'Waiting for your passkey...' });
    await expect(waiting).toBeVisible();
    await expect(waiting).toHaveAttribute('aria-busy', 'true');
    await expect(waiting).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByText('Follow the prompt on your device.')).toBeVisible();
    await expect(nameField(page)).toHaveAttribute('readonly', '');
    await expect(tokenField(page)).toHaveAttribute('readonly', '');
    // Escape cancels nothing.
    await page.keyboard.press('Escape');
    await expect(waiting).toBeVisible();
    await noHorizontalScroll(page);
    await expectNoSeriousA11yViolations(page);
  });

  test('a cancelled prompt is an info banner; values are kept and a retry succeeds', async ({
    page,
    authenticator,
  }) => {
    await authenticator.setUserVerified(false); // the biometric fails: the prompt is rejected
    await openSetup(page);
    await fillForm(page);
    await createButton(page).click();
    const info = main(page).getByRole('status').filter({ hasText: 'Passkey setup was cancelled.' });
    await expect(info).toContainText('Passkey setup was cancelled. Try again.');
    await expect(nameField(page)).toHaveValue('Matt E2E');
    await expect(tokenField(page)).toHaveValue(E2E_SETUP_TOKEN);
    await expect(createButton(page)).toBeFocused();
    expect(await authenticator.credentials()).toHaveLength(0);
    await expectNoSeriousA11yViolations(page);
    await noHorizontalScroll(page);

    await authenticator.setUserVerified(true);
    await createButton(page).click();
    await expect(heading(page, 'Save your recovery codes')).toBeVisible();
    expect(await authenticator.credentials()).toHaveLength(1);
  });

  test('a browser without passkeys gets the explanation and no form', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'PublicKeyCredential', { value: undefined });
    });
    await page.goto('/setup');
    await expect(heading(page, 'Set up Tidings')).toBeVisible();
    await expect(page.getByText("This browser can't use passkeys.")).toBeVisible();
    await expect(
      page.getByText(/Open it in a recent version of Safari, Chrome, Edge or Firefox/),
    ).toBeVisible();
    await expect(tokenField(page)).toHaveCount(0);
    await expect(main(page).getByRole('button')).toHaveCount(0);
    await expectNoSeriousA11yViolations(page);
    await noHorizontalScroll(page);
  });

  test('a device that cannot make a passkey gets the warning and can retry', async ({
    page,
    authenticator,
  }) => {
    void authenticator;
    // Make the browser report NotSupportedError the first time, the real thing afterwards.
    await page.addInitScript(() => {
      const real = navigator.credentials.create.bind(navigator.credentials);
      let first = true;
      navigator.credentials.create = (options) => {
        if (first) {
          first = false;
          return Promise.reject(new DOMException('no screen lock', 'NotSupportedError'));
        }
        return real(options);
      };
    });
    await openSetup(page);
    await fillForm(page);
    await createButton(page).click();
    const banner = main(page).getByRole('alert');
    await expect(banner).toContainText("This device can't use passkeys.");
    await expect(banner).toContainText(
      'Turn on a screen lock, or connect a security key, then try again.',
    );
    await expect(nameField(page)).toHaveValue('Matt E2E');
    await expectNoSeriousA11yViolations(page);
    await createButton(page).click();
    await expect(heading(page, 'Save your recovery codes')).toBeVisible();
  });

  test('offline: banner, blocked button, nothing sent; online again clears it', async ({
    page,
    context,
    authenticator,
  }) => {
    void authenticator;
    let posts = 0;
    page.on('request', (r) => r.method() === 'POST' && posts++);
    await openSetup(page);
    await fillForm(page);
    await context.setOffline(true);
    await expect(
      page.getByText("You're offline. Connect to the internet to continue."),
    ).toBeVisible();
    await expect(createButton(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('#setup-helper')).toHaveText("You're offline.");
    await createButton(page).click({ force: true });
    expect(posts).toBe(0);
    await expectNoSeriousA11yViolations(page);
    await context.setOffline(false);
    await expect(page.getByText(/You're offline/)).toHaveCount(0);
    await expect(createButton(page)).not.toHaveAttribute('aria-disabled', 'true');
  });

  test('a network failure and a server error each show their own banner, values kept', async ({
    page,
    authenticator,
  }) => {
    void authenticator;
    await openSetup(page);
    await fillForm(page);
    await page.route('**/api/auth/setup/options', (route) => route.abort('failed'));
    await createButton(page).click();
    await expect(main(page).getByRole('alert')).toContainText(
      "Couldn't reach Tidings. Check your connection and try again.",
    );
    await expect(nameField(page)).toHaveValue('Matt E2E');
    await page.unroute('**/api/auth/setup/options');
    await page.route('**/api/auth/setup/options', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'internal', message: 'x' } }),
      }),
    );
    await createButton(page).click();
    await expect(main(page).getByRole('alert')).toContainText(
      'Something went wrong on our side. Try again.',
    );
    await expectNoSeriousA11yViolations(page);
  });

  test('a very long name and token do not widen the card', async ({ page, authenticator }) => {
    void authenticator;
    await openSetup(page);
    await fillForm(page, 'N'.repeat(300), 'T'.repeat(300));
    await noHorizontalScroll(page);
  });
});

// ---- AC11 -----------------------------------------------------------------------------------

test.describe('AC11: passkeyName is a best-effort label', () => {
  test('the screen sends a readable label and setup succeeds', async ({ page, authenticator }) => {
    void authenticator;
    await openSetup(page);
    await fillForm(page);
    const verify = page.waitForRequest('**/api/auth/setup/verify');
    await createButton(page).click();
    const body = (await verify).postDataJSON() as { passkeyName: string };
    expect(body.passkeyName).toMatch(/^Passkey( on (iPhone|Android|Windows|Mac))?$/);
    await expect(heading(page, 'Save your recovery codes')).toBeVisible();
  });
});

// ---- UX review M1: the codes footer is sticky only when the viewport is tall in rem ----------

const footerOf = (page: Page) => page.locator('[data-codes-footer]');
const footerPosition = (page: Page) =>
  footerOf(page).evaluate((el) => getComputedStyle(el).position);

test.describe('UX review M1: sticky footer follows the text size', () => {
  test.describe('200% text at 375 x 812', () => {
    // 200% text is the browser's default font size of 32px. `html { font-size: 200% }` would not
    // do: rem in a media query follows the browser setting, not the page's own font-size. That
    // needs a launch flag, which a describe block cannot set, so this test owns its browser.
    test('the footer is not sticky, so the codes are reachable and visible', async ({
      browserName,
    }, testInfo) => {
      void browserName;
      const browser = await chromium.launch({ args: ['--blink-settings=defaultFontSize=32'] });
      try {
        const context = await browser.newContext({
          baseURL: testInfo.project.use.baseURL,
          viewport: { width: 375, height: 812 },
          colorScheme: testInfo.project.use.colorScheme ?? 'light',
        });
        const page = await context.newPage();
        const authenticator = await addVirtualAuthenticator(page);
        void authenticator;
        await reachCodes(page);
        expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe(
          '32px',
        );
        expect(await footerPosition(page)).toBe('static');

        // Every code can be scrolled to and is fully visible: nothing pinned covers it.
        const items = page.getByRole('list', { name: 'Recovery codes' }).locator('li');
        await expect(items).toHaveCount(10);
        for (const i of [0, 9]) {
          const item = items.nth(i);
          await item.scrollIntoViewIfNeeded();
          await expect(item).toBeInViewport({ ratio: 1 });
        }
      } finally {
        await browser.close();
      }
    });
  });

  test.describe('normal text at 375 x 667', () => {
    test.use({ viewport: { width: 375, height: 667 } });

    test('the footer is sticky and pinned to the bottom of the screen', async ({
      page,
      authenticator,
    }) => {
      void authenticator;
      await reachCodes(page);
      expect(await footerPosition(page)).toBe('sticky');
      await page.evaluate(() => window.scrollTo(0, 0));
      const box = await footerOf(page).boundingBox();
      expect(box).not.toBeNull();
      expect((box?.y ?? 0) + (box?.height ?? 0)).toBeCloseTo(667, 0);
    });
  });
});
