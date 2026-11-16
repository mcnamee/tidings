# Tidings

A personal, mobile-first RSS reader on Cloudflare's free tier. See `docs/PRODUCT_SPEC.md`.

## Local development

Prereqs: Node 22+, npm 10+.

```sh
npm install
npm run dev        # wrangler dev on :8787 (Worker + local D1) and Vite on :5173, /api proxied
```

Open http://localhost:5173. The placeholder page calls `/api/health`.

Create `apps/worker/.dev.vars` (gitignored) for local secrets such as `SETUP_TOKEN` (used from TID-007).

## Scripts

| Script                     | What it does                                                         |
| -------------------------- | -------------------------------------------------------------------- |
| `npm run typecheck`        | `tsc` in every workspace                                             |
| `npm run lint`             | ESLint + Prettier check                                              |
| `npm test`                 | Vitest unit tests in every workspace, plus lint-rule tests           |
| `npm run build`            | Builds `apps/web/dist`, then `wrangler deploy --dry-run` (no upload) |
| `npm run test:e2e`         | Placeholder until TID-005                                            |
| `npm run db:migrate:local` | Applies D1 migrations locally (none yet; schema is TID-004)          |

Never run `wrangler deploy` by hand; production deploys are covered by TID-024. The D1 `database_id` in
`apps/worker/wrangler.jsonc` is a placeholder until then.

## Layout

`apps/web` (React SPA), `apps/worker` (Hono Worker), `packages/shared` (API types), `packages/feed-parser`, `e2e`.
