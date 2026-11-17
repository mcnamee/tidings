/**
 * Feed fetch error codes and the fixed plain-language messages for them (FR-FH-1, spec §10.6 rule 8).
 *
 * This table is the only source of text a user sees about a failed fetch. Nothing from the origin
 * (body, headers, `statusText`, redirect `Location`, exception messages) may reach a response. The
 * only origin-controlled value is the numeric HTTP status, and its reason phrase comes from here.
 */

export type FeedErrorCode =
  | 'timeout'
  | 'network_error'
  | 'too_large'
  | 'too_many_redirects'
  | 'invalid_url'
  | 'blocked_address'
  | 'parse_error'
  | 'cpu_limit'
  | 'internal'
  | `http_${number}`;

const FIXED_MESSAGES: Record<Exclude<FeedErrorCode, `http_${number}`>, string> = {
  timeout: 'Timed out after 10 s',
  network_error: "Couldn't connect to the server",
  too_large: 'Too large (over 1 MB)',
  too_many_redirects: 'The address redirects too many times',
  invalid_url: 'The feed address is not valid',
  blocked_address: 'This address is not allowed',
  parse_error: "Couldn't parse the feed",
  cpu_limit: 'This feed is too heavy to process',
  internal: 'Something went wrong on our side',
};

const HTTP_REASONS: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  304: 'Not Modified',
  404: 'Not Found',
  408: 'Request Timeout',
  410: 'Gone',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

const HTTP_CODE = /^http_(\d{3})$/;

/** True for exactly the codes the refresher can store in `feeds.last_error_code`. */
export function isFeedErrorCode(value: unknown): value is FeedErrorCode {
  if (typeof value !== 'string') return false;
  return Object.hasOwn(FIXED_MESSAGES, value) || HTTP_CODE.test(value);
}

/** `http_<status>` for a numeric HTTP status (callers pass only integers from `Response.status`). */
export function httpErrorCode(status: number): FeedErrorCode {
  return `http_${Math.trunc(status)}` as FeedErrorCode;
}

/** The fixed message for a stored code, or null for null or an unknown code. */
export function feedErrorMessage(code: string | null): string | null {
  if (code === null) return null;
  const http = HTTP_CODE.exec(code);
  if (http) {
    const status = Number(http[1]);
    const reason = HTTP_REASONS[status];
    return reason ? `The server returned ${status} ${reason}` : `The server returned ${status}`;
  }
  return Object.hasOwn(FIXED_MESSAGES, code)
    ? FIXED_MESSAGES[code as keyof typeof FIXED_MESSAGES]
    : null;
}
