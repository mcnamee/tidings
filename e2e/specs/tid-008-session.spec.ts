import type { APIRequestContext, Page } from '@playwright/test';

type Attempt = {
  client: APIRequestContext;
  headers?: Record<string, string>;
  data: unknown;
};
import { createSession, deleteSessionRow, runSql, SESSION_COOKIE } from '../support/auth-state.ts';
import { expect, signInAs, test } from '../support/test.ts';

// TID-008: sessions, sign out, the signed-out redirect and the API guard, against the real Worker.
// Runs from the resting state (an owner exists, nobody signed in). Tests that end a session use a
// session of their own (createSession) so the shared seeded one survives.

const h1 = (page: Page, name: string) => page.getByRole('heading', { level: 1, name });

const SHELL_ROUTES = [
  '/all',
  '/folders/f1',
  '/feeds/s1',
  '/all/a/e1',
  '/folders/f1/a/e1',
  '/feeds/s1/a/e1',
  '/manage',
  '/manage/add',
  '/manage/import',
  '/settings',
  '/no/such/page',
];

/** Creates the persisted-cache database the app will own (TID-023), holding one record. */
async function plantCache(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('tidings-cache', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('kv');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction('kv', 'readwrite');
          tx.objectStore('kv').put({ private: 'entries' }, 'cache');
          tx.oncomplete = () => {
            open.result.close();
            resolve();
          };
        };
      }),
  );
}

const cacheExists = (page: Page) =>
  page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    return dbs.some((d) => d.name === 'tidings-cache');
  });

test.describe('signed-out redirect', () => {
  for (const route of SHELL_ROUTES) {
    test(`${route} goes to /login and shows no app chrome`, async ({ page }) => {
      await page.goto(route);
      await expect(page).toHaveURL(/\/login$/);
      await expect(h1(page, 'Sign in')).toBeVisible();
      await expect(page.getByRole('banner')).toHaveCount(0);
      await expect(page.getByRole('navigation')).toHaveCount(0);
      await expect(page.getByText('Your session ended.')).toHaveCount(0);
    });
  }

  test('"/" goes to /login too', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe('AC5: sign out', () => {
  test('ends the session, lands on a plain /login, clears the persisted cache, and the cookie is dead', async ({
    page,
    context,
    request,
    baseURL,
  }) => {
    const token = createSession();
    await signInAs(context, token, baseURL);
    await page.goto('/settings');
    await expect(h1(page, 'Settings')).toBeVisible();
    await plantCache(page);
    expect(await cacheExists(page)).toBe(true);
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('tidings.hasSession')))
      .toBe('1');

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(h1(page, 'Sign in')).toBeVisible();
    // Plain card: no banner, no remembered route.
    await expect(page.getByText('Your session ended.')).toHaveCount(0);
    await expect(page.getByText('already set up')).toHaveCount(0);
    expect((await context.cookies()).some((c) => c.name === SESSION_COOKIE)).toBe(false);
    expect(await cacheExists(page)).toBe(false);
    expect(await page.evaluate(() => localStorage.getItem('tidings.hasSession'))).toBeNull();

    // The old cookie value gets 401: logout would be 204 if the row were still there.
    const again = await request.post('/api/auth/logout', {
      data: {},
      headers: { Cookie: `${SESSION_COOKIE}=${token}`, Origin: baseURL ?? '' },
    });
    expect(again.status()).toBe(401);
    expect((await again.json()).error.code).toBe('unauthenticated');

    // Back does not return into the app.
    await page.goBack();
    expect(page.url()).not.toMatch(/\/(settings|all)$/);
  });

  test('a shell route visited after sign out redirects without the session-ended banner', async ({
    page,
    context,
    baseURL,
  }) => {
    await signInAs(context, createSession(), baseURL);
    await page.goto('/settings');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(h1(page, 'Sign in')).toBeVisible();
    await page.goto('/manage');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText('Your session ended.')).toHaveCount(0);
  });
});

test.describe('AC4 and AC13: the session ends', () => {
  test('a session removed server-side: reload shows "Your session ended", keeps the cache, paints no shell', async ({
    page,
    context,
    baseURL,
  }) => {
    const token = createSession();
    await signInAs(context, token, baseURL);
    await page.goto('/manage');
    await expect(h1(page, 'Manage feeds')).toBeVisible();
    await plantCache(page);

    deleteSessionRow(token);
    await page.reload();
    await expect(page).toHaveURL(/\/login$/);
    await expect(
      page.getByRole('main').getByText('Your session ended. Sign in again.'),
    ).toBeVisible();
    await expect(page.getByRole('banner')).toHaveCount(0);
    // Expiry keeps the persisted cache; only an explicit sign out clears it.
    expect(await cacheExists(page)).toBe(true);
  });

  test('a session past expires_at is refused by the Worker and the SPA goes to /login', async ({
    page,
    context,
    request,
    baseURL,
  }) => {
    const token = createSession(2);
    await new Promise((r) => setTimeout(r, 3500));
    await signInAs(context, token, baseURL);
    await page.goto('/manage');
    await expect(page).toHaveURL(/\/login$/);
    const res = await request.post('/api/auth/logout', {
      data: {},
      headers: { Cookie: `${SESSION_COOKIE}=${token}`, Origin: baseURL ?? '' },
    });
    expect(res.status()).toBe(401);
  });
});

test.describe('API guard on the running Worker', () => {
  test('AC6: protected routes answer 401 unauthenticated without a cookie', async ({
    request,
    baseURL,
  }) => {
    const origin = baseURL ?? '';
    for (const path of [
      '/api/folders',
      '/api/me',
      '/api/entries',
      '/api/counts',
      '/api/export/opml',
      '/api/subscriptions',
    ]) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(401);
      expect((await res.json()).error.code).toBe('unauthenticated');
    }
    for (const path of ['/api/auth/logout', '/api/folders', '/api/entries/read-state']) {
      const res = await request.post(path, { data: {}, headers: { Origin: origin } });
      expect(res.status(), path).toBe(401);
    }
  });

  test('AC8: security headers on success and on errors, no CORS headers, no preflight approval', async ({
    request,
    baseURL,
  }) => {
    for (const res of [
      await request.get('/api/health'),
      await request.get('/api/folders'),
      await request.fetch('/api/auth/session', {
        method: 'OPTIONS',
        headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
      }),
    ]) {
      const h = res.headers();
      expect(h['cache-control']).toBe('no-store');
      expect(h['x-content-type-options']).toBe('nosniff');
      expect(h['cross-origin-resource-policy']).toBe('same-origin');
      expect(h['access-control-allow-origin']).toBeUndefined();
    }
    expect(baseURL).toBeTruthy();
  });

  test('AC7: a valid session still gets 403 csrf_failed for a foreign Origin, text/plain, or no Origin', async ({
    request,
    bareRequest,
    baseURL,
  }) => {
    const token = createSession();
    const cookie = `${SESSION_COOKIE}=${token}`;
    // `request` carries the app's Origin by default; the first two override it, the third is bare.
    const attempts: Attempt[] = [
      { client: request, headers: { Cookie: cookie, Origin: 'https://evil.example' }, data: {} },
      {
        client: request,
        headers: { Cookie: cookie, Origin: baseURL ?? '', 'Content-Type': 'text/plain' },
        data: '{}',
      },
      { client: bareRequest, headers: { Cookie: cookie }, data: {} },
    ];
    for (const { client, ...attempt } of attempts) {
      const res = await client.post('/api/auth/logout', attempt);
      expect(res.status()).toBe(403);
      expect((await res.json()).error.code).toBe('csrf_failed');
    }
    // None of them signed the session out.
    const me = await request.get('/api/auth/session', { headers: { Cookie: cookie } });
    expect((await me.json()).user).not.toBeNull();
    deleteSessionRow(token);
  });

  test('AC11: with a session the guard and the API_RL binding pass (an unbuilt route is 404, not 401 or 500)', async ({
    request,
  }) => {
    const token = createSession();
    const res = await request.get('/api/me', { headers: { Cookie: `${SESSION_COOKIE}=${token}` } });
    expect(res.status()).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
    deleteSessionRow(token);
  });

  test('AC3: a session with under 23 days left is extended to 30 days and the cookie is re-issued', async ({
    request,
  }) => {
    const token = createSession(10 * 86400);
    const res = await request.get('/api/auth/session', {
      headers: { Cookie: `${SESSION_COOKIE}=${token}` },
    });
    const setCookie = res.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie');
    expect(setCookie).toHaveLength(1);
    expect(setCookie[0]?.value).toContain(`${SESSION_COOKIE}=${token}`);
    expect(setCookie[0]?.value).toContain(`Max-Age=${30 * 86400}`);
    deleteSessionRow(token);
  });

  test('AC14: every Public auth route refuses a foreign Origin, text/plain and a missing Origin', async ({
    request,
    bareRequest,
    baseURL,
  }) => {
    const paths = [
      '/api/auth/setup/options',
      '/api/auth/setup/verify',
      '/api/auth/login/options',
      '/api/auth/login/verify',
      '/api/auth/recover',
    ];
    for (const path of paths) {
      const cases: Attempt[] = [
        { client: request, headers: { Origin: 'https://evil.example' }, data: {} },
        {
          client: request,
          headers: { Origin: baseURL ?? '', 'Content-Type': 'text/plain' },
          data: '{}',
        },
        { client: bareRequest, data: {} },
      ];
      for (const { client, ...c } of cases) {
        const res = await client.post(path, c);
        expect(res.status(), path).toBe(403);
        expect((await res.json()).error.code).toBe('csrf_failed');
      }
    }
  });

  test('AC10: the 11th failed sign-in from one IP is 429 with Retry-After', async ({
    request,
    baseURL,
  }) => {
    runSql('DELETE FROM rate_limits;');
    try {
      const body = {
        response: {
          id: 'nope',
          rawId: 'nope',
          type: 'public-key',
          response: { clientDataJSON: 'x', authenticatorData: 'x', signature: 'x' },
        },
      };
      for (let i = 0; i < 10; i++) {
        const res = await request.post('/api/auth/login/verify', {
          data: body,
          headers: { Origin: baseURL ?? '' },
        });
        expect(res.status(), `attempt ${i + 1}`).toBe(401);
      }
      const blocked = await request.post('/api/auth/login/verify', {
        data: body,
        headers: { Origin: baseURL ?? '' },
      });
      expect(blocked.status()).toBe(429);
      expect((await blocked.json()).error.code).toBe('rate_limited');
      expect(Number(blocked.headers()['retry-after'])).toBeGreaterThan(0);
    } finally {
      runSql('DELETE FROM rate_limits;');
    }
  });
});
