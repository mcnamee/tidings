# Tidings

A personal, mobile-first RSS reader that replaces Inoreader. Runs on the Cloudflare free tier.

- **Product spec (source of truth):** `docs/PRODUCT_SPEC.md`
- **Backlog / stories:** `docs/BACKLOG.md`
- **Architecture decisions:** `docs/decisions/NNNN-title.md` (ADRs)
- **UX:** `docs/ux/`
- **Test strategy and reports:** `docs/testing/`
- **Where we're up to, and how the orchestrator runs the team:** `docs/HANDOFF.md`

## Hard constraints

These are non-negotiable. Any change to them needs an ADR approved by the user.

1. **Free-tier first.** Everything must run within Cloudflare's free plan (Workers, D1, KV, Cron Triggers, static assets). The spec's "Free-tier budget" section lists the limits. If a design would exceed them, say so before building it.
2. **Mobile first.** Design and test at 375px wide first, then scale up.
3. **Dark mode.** Every screen supports light and dark themes and follows the system preference by default.
4. **SPA + API.** The frontend is a React single-page app styled with Tailwind CSS. It talks to the backend only through the JSON API documented in the spec. No server-rendered pages.
5. **Secure by default.** Every API route except auth needs an authenticated session, and every query is scoped to the current user.

## The team (subagents in `.claude/agents/`)

| Agent | Model | Owns |
|---|---|---|
| `product-manager` | Opus | Spec, backlog, acceptance criteria, ADRs, sign-off |
| `software-engineer` | Sonnet | Application code (`apps/`, `packages/`), migrations, unit tests for their own code |
| `tester` | Sonnet | Test strategy, integration and E2E suites, test runs, defect reports |
| `ux-engineer` | Sonnet | Design system, screen flows, UI copy, accessibility, UX review of built screens |

### How work flows

1. **PM** writes or updates a story in `docs/BACKLOG.md`: ID (`TID-###`), user story, acceptance criteria, and anything out of scope.
2. **UX** adds the flow, layout, states (empty, loading, error, offline) and copy for any story with UI, in `docs/ux/`.
3. **Software engineer** builds the story on a branch named `tid-###-short-name`, with unit tests.
4. **Tester** checks the build against the acceptance criteria, adds or extends integration and E2E tests, runs the full suite, and files defects in `docs/testing/DEFECTS.md`.
5. **UX** reviews the built screens at mobile width in both themes.
6. **PM** accepts the story or sends it back, and marks it done in the backlog.

When you orchestrate from the main session, give each agent the story ID and the files to read. Don't paste the spec into the prompt. Agents report back with: what changed (file paths), what they verified, and any open questions for the PM.

## Definition of done

- Every acceptance criterion is met and has a test that proves it.
- `npm run typecheck`, `npm run lint` and `npm test` pass.
- It works at 375px wide and in both light and dark themes.
- No new free-tier risk, or the risk is recorded in an ADR.
- API changes are reflected in the spec's API section.

## Conventions

- TypeScript everywhere, `strict` on.
- Keep secrets out of the repo. Use `wrangler secret` for production and `.dev.vars` (gitignored) for local development.
- Database changes go through numbered D1 migrations only.
- Commit messages: `TID-###: imperative summary`.
