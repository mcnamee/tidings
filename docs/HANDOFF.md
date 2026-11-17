# Handoff: where the project is up to

Last updated 2026-11-17, when the work moved from a local Claude Code session to cloud sessions. Read this together with `CLAUDE.md`. Status changes belong in `docs/BACKLOG.md`. Update this file only when the way of working changes.

## State of `main`

All merged work is on `main`, and CI is green.

Work is now organised into releases: **MVP**, then **R2**, then **R3** (ADR 0014, spec §2). The backlog summary table gives each story's release and build order.

| Release | Stories, in build order |
|---|---|
| MVP | TID-013 and TID-046 (in parallel), TID-014, TID-018, TID-016, TID-019, TID-020, then TID-024 (production deploy; needs the owner's approval each time) |
| R2 | TID-009, TID-017, TID-015, TID-022, TID-021, TID-047 (post-launch budget and CPU check) |
| R3 | TID-023, TID-036, TID-037, TID-038 |

TID-039 (deployed CPU gate) is deferred and runs only if TID-047 shows trouble.

The decision history lives in ADRs 0001–0014. Open questions for the owner are in spec §16.1.

Two local branches were deliberately **not** pushed: `tid-002-parse-spike` and `tid-003-fanout-spike`. They hold throwaway spike code; the results are already in ADRs 0002, 0004 and 0006.

## How a story moves (the orchestrator's job)

For the MVP the workflow is lighter, to save tokens (ADR 0014):

1. **Build.** The `software-engineer` agent builds the story on a branch `tid-###-short-name`, in an isolated worktree, with unit and integration tests. It doesn't push, merge or run the E2E suite.
2. **Verify.** The `tester` agent checks each AC against the code, breaks the important guards to check a test fails each time, and files defects. It runs unit and integration tests, not the full E2E suite.
3. **Fix and close.** The engineer fixes the defects, and the tester closes them. A known-defect test is written as `it.fails` / `test.fail`, and only that marker is flipped when the defect is fixed.
4. **Merge.** The orchestrator merges into `main`, runs typecheck, lint, tests, build and the full E2E suite, pushes, and watches CI.
5. **End of release.** The `ux-engineer` reviews all the release's screens once (375 px and 1280 px, light and dark, 200% text), the engineer fixes what it finds, and the `product-manager` accepts the release in one decision round.

## Lessons learned

- **One E2E run at a time.** The harness uses fixed ports 8788 and 8790. Run at most about 2 agents at once: parallel runs overload the machine and use up the plan's usage limit quickly.
- **Cloud sessions:** the setup script must be `npx -y npm@11.6.2 ci` (the container's npm 10 rejects the lockfile). Playwright's Chromium can't be downloaded, so `playwright.config.ts` uses `CHROME_PATH` (preinstalled Chrome 153) when it is set.
- **Locally, run E2E under `caffeinate -ims npm run test:e2e`.** Every earlier "Playwright stall" was the Mac going to sleep (DEF-019). Cloud VMs don't need this.
- **Defect IDs collide across parallel branches.** Allocate the next ID from `main`; the next free one is **DEF-020**. Renumber at merge time if needed.
- **`package-lock.json`:** `npm install` on macOS reorders the optional `@emnapi` entries. Commit lockfile changes only if `npm ci` fails without them. CI pins npm 11.6.2.
- **Merge conflicts** are usually two branches each appending a section, in `TEST_STRATEGY.md`, `DEFECTS.md`, `packages/shared` exports or `BACKLOG.md`. Keep both sides.
- **Platform fonts differ.** Linux CI fonts are wider than macOS ones, so large-text tests must not depend on exact line counts.
- **Cloudflare:** agents must never read stored credentials. Anything that deploys to the owner's account needs the owner's explicit approval each time.

## Moving to cloud sessions

### Environment (claude.ai/code → environment settings)

- **Network access:** Limited, plus `api.cloudflare.com`. Add the Playwright browser CDN if you download Chromium, or choose Full.
- **Setup script:** `npm ci` (must exit 0).
- **Network secret:** a Cloudflare API token, type Bearer, for `api.cloudflare.com`.
- **Environment variables:** `CLOUDFLARE_ACCOUNT_ID=<your account ID>`. It's on the Workers & Pages overview page in the dashboard. Wrangler may also need a placeholder `CLOUDFLARE_API_TOKEN` before it sends requests that the proxy then authenticates. Verify this.

### Verify in the first cloud session

These are not confirmed by the docs:

1. `npm test` passes, including the workerd tests (`@cloudflare/workerd-linux-64`).
2. Playwright can run. Either install Chromium (needs the CDN host allowed) or point it at the preinstalled Chrome (`CHROME_PATH`) and check the version is compatible.
3. Agent worktree isolation behaves as it did locally.
4. `npx wrangler whoami` works through the network-secret proxy. Only needed when a deploy is approved.
