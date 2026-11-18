import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  ApiError,
  Passkey,
  PasskeysResponse,
  RecoveryCodesResponse,
  User,
} from '@tidings/shared';
import { createApp } from '../src/api/app';
import { REAUTH_WINDOW_SECONDS } from '../src/auth/account';
import { hashRecoveryCode } from '../src/auth/recovery-codes';
import { SESSION_COOKIE } from '../src/auth/session';
import { countRows, seedSession, seedUser } from './support/seed';

// TID-022: Settings > Account API (spec 6.2, 8.3). Real worker, real D1.
const NOW = 1_760_000_000;
const app = createApp({ clock: () => NOW * 1000 });
let tokens: Record<string, string>;

async function call(user: string, method: string, path: string, body?: unknown) {
  const headers = new Headers({
    Origin: env.APP_ORIGIN,
    Cookie: `${SESSION_COOKIE}=${tokens[user]}`,
  });
  if (method !== 'GET') headers.set('Content-Type', 'application/json');
  const res = await app.fetch(
    new Request(`${env.APP_ORIGIN}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );
  const text = await res.text();
  return { res, json: text ? (JSON.parse(text) as unknown) : null };
}

const code = (json: unknown) => (json as ApiError).error.code;

async function addPasskeyRow(userId: string, id: string, name: string, createdAt: number) {
  await env.DB.prepare(
    `INSERT INTO passkeys (id, user_id, public_key, counter, name, created_at, last_used_at)
     VALUES (?, ?, x'00', 0, ?, ?, ?)`,
  )
    .bind(id, userId, name, createdAt, createdAt + 5)
    .run();
}

const passkeyNames = async (user: string) =>
  ((await call(user, 'GET', '/api/auth/passkeys')).json as PasskeysResponse).items.map(
    (p) => p.name,
  );

async function addUser(id: string, sessionAge = 0) {
  await seedUser(id);
  tokens[id] = await seedSession(id, { now: NOW, createdAt: NOW - sessionAge });
}

beforeEach(async () => {
  for (const t of ['sessions', 'recovery_codes', 'passkeys', 'users']) {
    await env.DB.exec(`DELETE FROM ${t}`);
  }
  tokens = {};
  await addUser('u1');
  await addUser('u2');
});

describe('AC1, AC2: PATCH /api/me stores settings', () => {
  it('GET /api/me returns the user with empty settings by default', async () => {
    const { res, json } = await call('u1', 'GET', '/api/me');
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ id: 'u1', settings: {} });
  });

  it('stores the theme, and later changes to other keys keep it (merge, not replace)', async () => {
    const a = await call('u1', 'PATCH', '/api/me', { settings: { theme: 'dark' } });
    expect(a.res.status).toBe(200);
    expect((a.json as User).settings).toEqual({ theme: 'dark' });
    const b = await call('u1', 'PATCH', '/api/me', {
      settings: {
        textSize: 'l',
        unreadOnly: false,
        markReadOnOpen: false,
        markReadOnScroll: false,
      },
    });
    expect((b.json as User).settings).toEqual({
      theme: 'dark',
      textSize: 'l',
      unreadOnly: false,
      markReadOnOpen: false,
      markReadOnScroll: false,
    });
    // A new session (another device) reads it from the session endpoint's user.
    const again = await call('u1', 'GET', '/api/me');
    expect((again.json as User).settings).toMatchObject({ theme: 'dark', textSize: 'l' });
    const session = await app.fetch(
      new Request(`${env.APP_ORIGIN}/api/auth/session`, {
        headers: { Cookie: `${SESSION_COOKIE}=${tokens['u1']}` },
      }),
      env,
    );
    expect(((await session.json()) as { user: User }).user.settings.theme).toBe('dark');
  });

  it('renames the display name (trimmed) and keeps settings', async () => {
    await call('u1', 'PATCH', '/api/me', { settings: { theme: 'light' } });
    const { res, json } = await call('u1', 'PATCH', '/api/me', { displayName: '  Matt  ' });
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ displayName: 'Matt', settings: { theme: 'light' } });
  });

  it('refuses bad values, unknown keys, an empty body and a blank name with 400 validation_failed', async () => {
    const bad: unknown[] = [
      {},
      { settings: {}, extra: 1 },
      { settings: { theme: 'blue' } },
      { settings: { textSize: 'xl' } },
      { settings: { unreadOnly: 'yes' } },
      { settings: { isAdmin: true } },
      { settings: 'dark' },
      { displayName: '   ' },
      { displayName: 'x'.repeat(65) },
    ];
    for (const body of bad) {
      const { res, json } = await call('u1', 'PATCH', '/api/me', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(code(json)).toBe('validation_failed');
    }
    expect(((await call('u1', 'GET', '/api/me')).json as User).settings).toEqual({});
  });

  it('changes only the caller: the other user’s settings and name are untouched', async () => {
    await call('u1', 'PATCH', '/api/me', { displayName: 'One', settings: { theme: 'dark' } });
    expect((await call('u2', 'GET', '/api/me')).json).toMatchObject({
      displayName: 'u2',
      settings: {},
    });
  });
});

describe('AC3: passkeys list, rename and remove', () => {
  beforeEach(async () => {
    await addPasskeyRow('u1', 'pk-a', 'iPhone', NOW - 100);
    await addPasskeyRow('u1', 'pk-b', 'Work laptop', NOW - 50);
    await addPasskeyRow('u2', 'pk-z', 'Theirs', NOW - 10);
  });

  it('lists my passkeys oldest first with name, created and last used, and no one else’s', async () => {
    const { res, json } = await call('u1', 'GET', '/api/auth/passkeys');
    expect(res.status).toBe(200);
    expect((json as PasskeysResponse).items).toEqual<Passkey[]>([
      { id: 'pk-a', name: 'iPhone', createdAt: NOW - 100, lastUsedAt: NOW - 95 },
      { id: 'pk-b', name: 'Work laptop', createdAt: NOW - 50, lastUsedAt: NOW - 45 },
    ]);
    const body = JSON.stringify(json);
    expect(body).not.toContain('public_key');
    expect(body).not.toContain('pk-z');
  });

  it('renames a passkey (trimmed) and rejects blank or over-long names', async () => {
    const ok = await call('u1', 'PATCH', '/api/auth/passkeys/pk-a', { name: '  Pixel  ' });
    expect(ok.res.status).toBe(200);
    expect(ok.json).toMatchObject({ id: 'pk-a', name: 'Pixel' });
    expect(await passkeyNames('u1')).toEqual(['Pixel', 'Work laptop']);
    for (const name of ['', '   ', 'x'.repeat(65), 5]) {
      const { res, json } = await call('u1', 'PATCH', '/api/auth/passkeys/pk-a', { name });
      expect(res.status).toBe(400);
      expect(code(json)).toBe('validation_failed');
    }
    expect(await passkeyNames('u1')).toEqual(['Pixel', 'Work laptop']);
  });

  it('removes one passkey with 204, then refuses to remove the last with 409 last_passkey', async () => {
    const first = await call('u1', 'DELETE', '/api/auth/passkeys/pk-a');
    expect(first.res.status).toBe(204);
    expect(await passkeyNames('u1')).toEqual(['Work laptop']);
    const last = await call('u1', 'DELETE', '/api/auth/passkeys/pk-b');
    expect(last.res.status).toBe(409);
    expect(code(last.json)).toBe('last_passkey');
    expect(await passkeyNames('u1')).toEqual(['Work laptop']);
  });

  it('B renaming A’s passkey gets 404 not_found, and A’s passkey is unchanged', async () => {
    const before = await passkeyNames('u1');
    const { res, json } = await call('u2', 'PATCH', '/api/auth/passkeys/pk-a', {
      name: 'Hijacked',
    });
    expect(res.status).toBe(404);
    expect(code(json)).toBe('not_found');
    expect(await passkeyNames('u1')).toEqual(before);
    expect(await passkeyNames('u2')).toEqual(['Theirs']);
    const nope = await call('u2', 'PATCH', '/api/auth/passkeys/nope', { name: 'Hijacked' });
    expect(nope.json).toEqual(json);
  });

  it('B removing A’s passkey gets 404 not_found, and A’s passkeys are unchanged', async () => {
    const before = await passkeyNames('u1');
    const { res, json } = await call('u2', 'DELETE', '/api/auth/passkeys/pk-a');
    expect(res.status).toBe(404);
    expect(code(json)).toBe('not_found');
    expect(await passkeyNames('u1')).toEqual(before);
    // B has only one passkey, so B's own last-passkey answer must not be what a stranger's ID gets.
    expect(await passkeyNames('u2')).toEqual(['Theirs']);
    const nope = await call('u2', 'DELETE', '/api/auth/passkeys/nope');
    expect(nope.json).toEqual(json);
  });
});

describe('AC4: regenerate recovery codes', () => {
  const OLD = 'ABCD-0123-4567-89AB';

  async function seedOldCode(userId: string, used: boolean) {
    await env.DB.prepare(
      'INSERT INTO recovery_codes (id, user_id, code_hash, used_at, created_at) VALUES (?, ?, ?, ?, 1)',
    )
      .bind(
        crypto.randomUUID(),
        userId,
        await hashRecoveryCode('USED-0000-1111-2222'),
        used ? 5 : null,
      )
      .run();
  }
  const recover = (c: string) =>
    app.fetch(
      new Request(`${env.APP_ORIGIN}/api/auth/recover`, {
        method: 'POST',
        headers: { Origin: env.APP_ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: c }),
      }),
      env,
    );

  it('returns 10 new codes, replaces all old ones (used or not), and stores only hashes', async () => {
    await env.DB.prepare(
      'INSERT INTO recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, 1)',
    )
      .bind('old1', 'u1', await hashRecoveryCode(OLD))
      .run();
    await seedOldCode('u1', true);
    await env.DB.prepare(
      'INSERT INTO recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, 1)',
    )
      .bind('other', 'u2', await hashRecoveryCode('ZZZZ-ZZZZ-ZZZZ-ZZZZ'))
      .run();

    const { res, json } = await call('u1', 'POST', '/api/auth/recovery-codes', {});
    expect(res.status).toBe(200);
    const codes = (json as RecoveryCodesResponse).recoveryCodes;
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);

    const rows = await env.DB.prepare(
      'SELECT user_id, code_hash, used_at FROM recovery_codes ORDER BY user_id',
    ).all<{ user_id: string; code_hash: string; used_at: number | null }>();
    const mine = rows.results.filter((r) => r.user_id === 'u1');
    expect(mine).toHaveLength(10);
    expect(mine.every((r) => r.used_at === null)).toBe(true);
    expect(mine.map((r) => r.code_hash)).not.toContain(await hashRecoveryCode(OLD));
    expect(JSON.stringify(rows.results)).not.toContain(codes[0]);
    expect(rows.results.filter((r) => r.user_id === 'u2')).toHaveLength(1); // not touched

    // Old code no longer works; a new one does.
    expect((await recover(OLD)).status).toBe(401);
    expect((await recover(codes[0] ?? '')).status).toBe(200);
  });

  it('a session whose authenticated_at is older than 15 minutes gets 403 reauth_required, and nothing changes', async () => {
    await addUser('u3', REAUTH_WINDOW_SECONDS + 1);
    await env.DB.prepare(
      'INSERT INTO recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, 1)',
    )
      .bind('old3', 'u3', await hashRecoveryCode(OLD))
      .run();
    const { res, json } = await call('u3', 'POST', '/api/auth/recovery-codes', {});
    expect(res.status).toBe(403);
    expect(code(json)).toBe('reauth_required');
    expect(await countRows('recovery_codes')).toBe(1);
    expect((await recover(OLD)).status).toBe(200);
  });

  it('exactly 15 minutes old is still allowed', async () => {
    await addUser('u4', REAUTH_WINDOW_SECONDS);
    const { res } = await call('u4', 'POST', '/api/auth/recovery-codes', {});
    expect(res.status).toBe(200);
  });

  it('an email session gets 403 reauth_required (ADR 0016) even when its time is fresh', async () => {
    await env.DB.prepare("UPDATE sessions SET auth_method = 'email' WHERE user_id = 'u1'").run();
    const { res, json } = await call('u1', 'POST', '/api/auth/recovery-codes', {});
    expect(res.status).toBe(403);
    expect(code(json)).toBe('reauth_required');
    expect(await countRows('recovery_codes')).toBe(0);
  });
});

describe('AC5: sign out everywhere', () => {
  it('deletes all of my sessions, clears the cookie, and leaves other users’ sessions alone', async () => {
    const second = await seedSession('u1', { now: NOW });
    const { res } = await call('u1', 'POST', '/api/auth/logout-all', {});
    expect(res.status).toBe(204);
    expect(res.headers.get('Set-Cookie') ?? '').toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
    const rows = await env.DB.prepare('SELECT user_id FROM sessions').all<{ user_id: string }>();
    expect(rows.results.map((r) => r.user_id)).toEqual(['u2']);
    for (const token of [tokens['u1'], second]) {
      const after = await app.fetch(
        new Request(`${env.APP_ORIGIN}/api/me`, {
          headers: { Cookie: `${SESSION_COOKIE}=${token}` },
        }),
        env,
      );
      expect(after.status).toBe(401);
    }
    expect((await call('u2', 'GET', '/api/me')).res.status).toBe(200);
  });
});
