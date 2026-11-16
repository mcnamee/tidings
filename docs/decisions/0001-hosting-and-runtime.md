# 0001. Hosting and runtime: one Cloudflare Worker with static assets, on the Free plan

- Status: Accepted
- Date: 2026-11-16
- Deciders: product-manager

## Context

The user wants a mobile-first SPA with an API backend that runs for almost nothing on Cloudflare's free tier, plus a background job to cache feeds. Workers Free gives 100,000 requests/day, 10 ms CPU per invocation, 50 external subrequests per invocation, and 5 Cron Triggers per account (checked 2026-11-16, spec §9.1). Workers Static Assets can serve an SPA without invoking the Worker.

## Options

1. **One Worker**: static assets (SPA) + `/api/*` (Hono) + `scheduled()` crons + a `FeedRefresher` entrypoint.
2. Cloudflare Pages for the SPA + a separate Worker for the API and crons.
3. Two Workers (API, refresher) + static assets.

## Decision

Option 1. A single Worker named `tidings` with:
- `assets.not_found_handling = "single-page-application"` and `run_worker_first = ["/api/*"]`, so only API calls invoke the Worker and count toward the request quota;
- `_headers` for SPA security headers;
- two Cron Triggers (`* * * * *` dispatcher, `17 * * * *` maintenance);
- a `FeedRefresher` `WorkerEntrypoint` called through `ctx.exports` (see ADR 0004).

Same origin for SPA and API means no CORS, simple cookie auth and one deploy.

## Consequences

- One `wrangler deploy` ships everything; one place for bindings and secrets.
- `_headers` doesn't apply to Worker responses, so API security headers are set in middleware.
- If TID-003 shows a loopback call doesn't get its own CPU budget, we split the refresher into a second Worker (option 3) without changing the code structure.
- Workers Paid ($5/month) remains the escape hatch, but only with the user's approval (spec Q6).
