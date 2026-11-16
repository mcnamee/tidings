/** Fixed port for the local fixture feed server during E2E (wrangler needs it up front for ALLOW_FETCH_HOSTS). */
export const FIXTURE_PORT = Number(process.env.E2E_FIXTURE_PORT ?? 8790);
