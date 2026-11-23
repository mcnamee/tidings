# Developing Tidings

How to run, test and work on Tidings locally. For production deploys and the runbook, see [DEPLOYMENT.md](DEPLOYMENT.md).

## Local development

Prereqs: Node 22+, npm 10+.

```sh
npm install
npm run dev        # wrangler dev on :8787 (Worker + local D1) and Vite on :5173, /api proxied
```

Open http://localhost:5173. On a fresh local database it opens the first-run setup screen (TID-007).

Before the first run, apply the migrations and create `apps/worker/.dev.vars` (gitignored) from the
example. `SETUP_TOKEN` must be at least 32 characters; setup asks for it once, and passkeys need
`localhost` (a secure context), not a LAN address:

```sh
npm run db:migrate:local
cp apps/worker/.dev.vars.example apps/worker/.dev.vars   # then edit SETUP_TOKEN
```

For a deployment, set the secret with `wrangler secret put SETUP_TOKEN`. The E2E harness passes its
own throwaway token on the `wrangler dev` command line and never reads `.dev.vars`.

## Scripts

| Script                     | What it does                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------- |
| `npm run typecheck`        | `tsc` in every workspace                                                                |
| `npm run lint`             | ESLint + Prettier check                                                                 |
| `npm test`                 | Vitest unit tests in every workspace, plus lint-rule tests                              |
| `npm run build`            | Builds `apps/web/dist`, then `wrangler deploy --dry-run` (no upload)                    |
| `npm run test:e2e`         | Playwright, 4 projects (mobile/desktop x light/dark); see docs/testing/TEST_STRATEGY.md |
| `npm run db:migrate:local` | Applies D1 migrations to the local database                                             |
| `npm run deploy`           | Builds the SPA, applies remote D1 migrations, then `wrangler deploy` (production)       |
| `npm run check:headers`    | `node scripts/check-prod-headers.mjs <origin>`: checks the spec 10.4 headers            |

Production deploys and the runbook are in [DEPLOYMENT.md](DEPLOYMENT.md).

## Checking the background refresh locally (TID-012)

The dispatcher runs from the `* * * * *` cron. Locally you trigger it by hand against the fixture
feed server. It needs a migrated local D1, `ALLOW_FETCH_HOSTS` (accepted only with a
`http://localhost` `APP_ORIGIN`), and one feed with a subscriber:

```sh
node e2e/support/serve-fixtures.ts &        # fixture feeds on http://127.0.0.1:8790 (Node 22.18+)
npm run db:migrate:local
cd apps/worker
npx wrangler d1 execute tidings --local --command "
  INSERT INTO users (id, display_name, created_at) VALUES ('u1', 'U', 0);
  INSERT INTO feeds (id, url, next_fetch_at, state, created_at)
    VALUES (1, 'http://127.0.0.1:8790/feeds/rss2-basic.xml', 0, 'pending', 0);
  INSERT INTO subscriptions (id, user_id, feed_id, created_at) VALUES ('s1', 'u1', 1, 0);"
npx wrangler dev --local --port 8787 --var APP_ORIGIN:http://localhost:8787 \
  --var ALLOW_FETCH_HOSTS:127.0.0.1:8790 &
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*+*+*+*+*"
```

The Worker log prints one `refresh_dispatch` line (`leased`, `fulfilled`, `rejected`, rows read and
written). `SELECT state, last_status FROM feeds` then shows `ok` and `200`, and `entries` holds the
fixture's three items. Run the `curl` again: nothing is due for 30 minutes, so `leased` is 0. Stop the
two background processes when done.

## Layout

`apps/web` (React SPA), `apps/worker` (Hono Worker), `packages/shared` (API types), `packages/feed-parser`, `e2e`.

## Testing

`npm test` runs Worker integration tests inside workerd against a migrated local D1. `npm run test:e2e`
needs a one-off `npm run install:browsers -w @tidings/e2e` (Chromium). Layers, helpers, fixtures and the
traceability convention are in [`docs/testing/TEST_STRATEGY.md`](testing/TEST_STRATEGY.md).
