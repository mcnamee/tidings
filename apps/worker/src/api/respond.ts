import type { Context, Env as HonoEnv } from 'hono';
import type { ApiError, ErrorCode } from '@tidings/shared';

export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500;

/** The one way a handler or middleware answers with an error (spec 8.1). */
export function fail<E extends HonoEnv>(
  c: Context<E>,
  status: ErrorStatus,
  code: ErrorCode,
  message: string,
): Response {
  const body: ApiError = { error: { code, message } };
  return c.json(body, status);
}
