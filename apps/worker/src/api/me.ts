import { Hono } from 'hono';
import type { User } from '@tidings/shared';
import { updateMeRequestSchema } from '@tidings/shared/schemas';
import { parseBody } from '../auth/routes';
import { parseSettings } from '../auth/session';
import { Db, sql } from '../db';
import type { AppEnv } from './security';

/** `GET` and `PATCH /api/me` (spec 8.3, TID-022). The user is always the session's own. */
export function createMeRoutes(): Hono<AppEnv> {
  const me = new Hono<AppEnv>();

  me.get('/', (c) => c.json(c.get('session').user));

  me.patch('/', async (c) => {
    const body = await parseBody(c, updateMeRequestSchema);
    if (body instanceof Response) return body;
    const { user } = c.get('session');
    // Merged in the database (json_patch), so two devices changing different settings at once
    // cannot overwrite each other with a stale copy. The patch only holds known keys.
    const row = await new Db(c.env.DB).first<{ display_name: string; settings_json: string }>(
      sql(
        `UPDATE users SET display_name = COALESCE(?1, display_name),
                          settings_json = json_patch(settings_json, ?2)
         WHERE id = ?3 RETURNING display_name, settings_json`,
        body.displayName ?? null,
        JSON.stringify(body.settings ?? {}),
        user.id,
      ),
    );
    if (!row) return c.json(user);
    const updated: User = {
      ...user,
      displayName: row.display_name,
      settings: parseSettings(row.settings_json),
    };
    return c.json(updated);
  });

  return me;
}
