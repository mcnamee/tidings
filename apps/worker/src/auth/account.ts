import { Hono } from 'hono';
import {
  RECOVERY_CODE_COUNT,
  type Passkey,
  type PasskeysResponse,
  type RecoveryCodesResponse,
} from '@tidings/shared';
import { renamePasskeyRequestSchema } from '@tidings/shared/schemas';
import { fail } from '../api/respond';
import type { AppEnv } from '../api/security';
import { Db, newId, nowSeconds, sql, systemClock, type Clock } from '../db';
import { clearSessionCookie } from './cookies';
import { generateRecoveryCodes, hashRecoveryCode } from './recovery-codes';
import { parseBody } from './routes';
import { deleteAllSessions } from './session';

/** Spec 8.3: regenerating recovery codes needs a passkey or recovery sign-in this recent. */
export const REAUTH_WINDOW_SECONDS = 15 * 60;

interface PasskeyRow {
  id: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
}

const toPasskey = (r: PasskeyRow): Passkey => ({
  id: r.id,
  name: r.name,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
});

/**
 * Settings > Account routes (TID-022, spec 8.3): list, rename and remove passkeys, regenerate
 * recovery codes, sign out everywhere. Mounted under `/api/auth`; the guard has already required a
 * session, and `email` sessions never reach remove or regenerate (ADR 0016). Every query is
 * scoped by `user_id`, so another user's passkey ID is simply not found.
 */
export function createAccountRoutes(deps?: { clock?: Clock | undefined }): Hono<AppEnv> {
  const clock = deps?.clock ?? systemClock;
  const routes = new Hono<AppEnv>();

  routes.get('/passkeys', async (c) => {
    const { rows } = await new Db(c.env.DB).all<PasskeyRow>(
      sql(
        'SELECT id, name, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY created_at, id',
        c.get('session').user.id,
      ),
    );
    const body: PasskeysResponse = { items: rows.map(toPasskey) };
    return c.json(body);
  });

  routes.patch('/passkeys/:id', async (c) => {
    const body = await parseBody(c, renamePasskeyRequestSchema);
    if (body instanceof Response) return body;
    const row = await new Db(c.env.DB).first<PasskeyRow>(
      sql(
        'UPDATE passkeys SET name = ? WHERE id = ? AND user_id = ? RETURNING id, name, created_at, last_used_at',
        body.name,
        c.req.param('id'),
        c.get('session').user.id,
      ),
    );
    return row ? c.json(toPasskey(row)) : fail(c, 404, 'not_found', 'Not found');
  });

  routes.delete('/passkeys/:id', async (c) => {
    const db = new Db(c.env.DB);
    const userId = c.get('session').user.id;
    const id = c.req.param('id');
    // One statement, so two removals racing cannot both pass the "not the last one" check.
    const meta = await db.run(
      sql(
        `DELETE FROM passkeys WHERE id = ?1 AND user_id = ?2
           AND (SELECT COUNT(*) FROM passkeys WHERE user_id = ?2) > 1`,
        id,
        userId,
      ),
    );
    if (meta.changes === 1) return c.body(null, 204);
    const exists = await db.first<{ one: number }>(
      sql('SELECT 1 AS one FROM passkeys WHERE id = ? AND user_id = ?', id, userId),
    );
    return exists
      ? fail(c, 409, 'last_passkey', 'You need at least one passkey')
      : fail(c, 404, 'not_found', 'Not found');
  });

  routes.post('/recovery-codes', async (c) => {
    const session = c.get('session');
    const now = nowSeconds(clock);
    if (now - session.authenticatedAt > REAUTH_WINDOW_SECONDS) {
      return fail(c, 403, 'reauth_required', 'Sign in with a passkey to do this');
    }
    const codes = generateRecoveryCodes(RECOVERY_CODE_COUNT);
    const hashes = await Promise.all(codes.map((code) => hashRecoveryCode(code)));
    // One batch: the old codes (used or not) go and the new ones arrive together.
    await new Db(c.env.DB).batch([
      sql('DELETE FROM recovery_codes WHERE user_id = ?', session.user.id),
      ...hashes.map((hash) =>
        sql(
          'INSERT INTO recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, ?)',
          newId(),
          session.user.id,
          hash,
          now,
        ),
      ),
    ]);
    const body: RecoveryCodesResponse = { recoveryCodes: codes };
    return c.json(body);
  });

  routes.post('/logout-all', async (c) => {
    await deleteAllSessions(new Db(c.env.DB), c.get('session').user.id);
    clearSessionCookie(c);
    return c.body(null, 204);
  });

  return routes;
}
