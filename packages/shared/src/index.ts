/** API contract shared by the SPA and the Worker. */

export interface HealthResponse {
  ok: true;
  version: string;
}

export type ErrorCode = 'not_found' | 'internal_error' | 'config_error';

export interface ApiError {
  error: { code: ErrorCode; message: string };
}
