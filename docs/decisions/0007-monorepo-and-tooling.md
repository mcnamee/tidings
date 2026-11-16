# 0007. Monorepo, backend libraries and tooling

- Status: Accepted
- Date: 2026-11-16
- Deciders: product-manager

## Decision

- **npm workspaces**: `apps/web`, `apps/worker`, `packages/shared`, `packages/feed-parser`, `e2e/`. Root scripts `dev`, `build`, `typecheck`, `lint`, `test`, `test:e2e`, `db:migrate:local`, `db:seed:local`. (pnpm/turborepo add tooling without a real need at this size.)
- **Hono 4** for routing and middleware on Workers; **zod 4** schemas in `packages/shared`, shared by SPA and Worker.
- **TypeScript strict**, ESLint flat config (typescript-eslint, react-hooks, jsx-a11y, a `no-restricted-syntax` rule for `dangerouslySetInnerHTML` outside `ArticleContent` and template literals in `prepare()`), Prettier.
- **Tests:** Vitest for unit and component tests; `@cloudflare/vitest-pool-workers` for Worker integration tests against local D1; Playwright (+ `@axe-core/playwright`) for E2E at 375 × 812 and 1280 × 800 in light and dark. The engineer checks Vitest / pool-workers version compatibility at scaffolding and pins what works.
- **CI/CD:** GitHub Actions (spec Q8). Deploy on `main`: apply D1 migrations, then `wrangler deploy`.

## Consequences

- One `npm install`, one lockfile, shared types without publishing packages.
- Any new runtime dependency needs PM approval (stated in the spec).
