# Handoff: where the project is up to

Last updated 2026-11-17, when the work moved from a local Claude Code session to cloud sessions. Read this together with `CLAUDE.md`. Status changes belong in `docs/BACKLOG.md`. Update this file only when the way of working changes.

## State of `main`

All merged work is on `main`, and CI is green.

| Status | Stories |
|---|---|
| Done | TID-001 to TID-008, TID-010, TID-011, TID-012 (AC13 split out to TID-039) |
| Ready, in suggested order | **TID-038** (E2E stability, tester), TID-009 (recovery-code sign-in), TID-013 (subscribe; includes the AC9 isolation suite), TID-046 (GUID-churn guard, must come before TID-016), TID-021 (maintenance job), TID-036, TID-037 |
| Blocked | **TID-039** (deployed CPU gate): needs the owner's approval to deploy throwaway Workers (spec §16.1, Q12). It must be Done before TID-024. |

The decision history lives in ADRs 0001–0013. Open questions for the owner are in spec §16.1.

Two local branches were deliberately **not** pushed: `tid-002-parse-spike` and `tid-003-fanout-spike`. They hold throwaway spike code; the results are already in ADRs 0002, 0004 and 0006.

## How a story moves (the orchestrator's job)

1. **Build.** The `software-engineer` agent builds the story on a branch `tid-###-short-name`, in an isolated worktree. It doesn't push or merge.
2. **Verify.** The `tester` agent checks each AC against the code, deliberately breaks the important guards to check a test fails each time, tries to break the feature, and files defects.
3. **UX review.** For stories with UI, the `ux-engineer` agent reviews the built screens at 375 px and 1280 px, light and dark, plus 200% text.
4. **Fix and close.** The engineer fixes the defects, and the tester closes them. A known-defect test is written as `it.fails` / `test.fail`, and only that marker is flipped when the defect is fixed.
5. **Accept.** The `product-manager` agent accepts or rejects in a "decision round" branch (`pm-decisions-rN`) and records rulings in ADRs.
6. **Merge.** The orchestrator merges into `main`, runs typecheck, lint, tests, build and the full E2E suite, pushes, and watches CI.

## Lessons learned

- **One E2E run at a time.** The harness uses fixed ports 8788 and 8790. Run at most about 2 agents at once: parallel runs overload the machine and use up the plan's usage limit quickly.
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
