# Tidings

A personal, mobile-first RSS reader on Cloudflare's free tier. See `docs/PRODUCT_SPEC.md`.

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
| `npm run db:migrate:local` | Applies D1 migrations locally (none yet; schema is TID-004)                             |

Never run `wrangler deploy` by hand; production deploys are covered by TID-024. The D1 `database_id` in
`apps/worker/wrangler.jsonc` is a placeholder until then.

## Layout

`apps/web` (React SPA), `apps/worker` (Hono Worker), `packages/shared` (API types), `packages/feed-parser`, `e2e`.

## Testing

`npm test` runs Worker integration tests inside workerd against a migrated local D1. `npm run test:e2e`
needs a one-off `npm run install:browsers -w @tidings/e2e` (Chromium). Layers, helpers, fixtures and the
traceability convention are in `docs/testing/TEST_STRATEGY.md`.
