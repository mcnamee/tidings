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

| `npm run deploy` | Builds the SPA, applies remote D1 migrations, then `wrangler deploy` (production) |
| `npm run check:headers` | `node scripts/check-prod-headers.mjs <origin>`: checks the spec 10.4 headers |

Production deploys and the runbook are in [Deployment and runbook](#deployment-and-runbook) below.

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
npx wrangler dev --port 8787 --var APP_ORIGIN:http://localhost:8787 \
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
traceability convention are in `docs/testing/TEST_STRATEGY.md`.

## Deployment and runbook

Production is one Worker named `tidings` (API plus static SPA assets), one D1 database `tidings`, on the
custom domain `tidings.mcn.am`. All commands below run from the repo root unless a `cd` is shown.
Decide the hostname before first-run setup: passkeys are bound to `RP_ID` (spec Q2, risk R6). To use a
different host, change `routes`, `APP_ORIGIN` and `RP_ID` in `apps/worker/wrangler.jsonc` first.

### First-time setup

Prereqs: a Cloudflare account on the free plan with the `mcn.am` zone added (the custom domain needs the
zone on the same account), and `npx wrangler login` done once (or `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` exported in your shell).

1. Check the account's Workers list holds no `tidings-spike-*` scripts.
2. Install and build:
   ```sh
   npm ci
   npm run build -w @tidings/web
   cd apps/worker
   ```
3. Create the database and note the `database_id` it prints:
   ```sh
   npx wrangler d1 create tidings
   ```
4. Paste that ID into `apps/worker/wrangler.jsonc`, replacing `00000000-0000-0000-0000-000000000000`
   in the `d1_databases` entry (the only place it lives). Commit it; the ID is not a secret.
5. Set the setup secret (at least 32 random characters). Generate one with
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`, then:
   ```sh
   npx wrangler secret put SETUP_TOKEN
   ```
   Wrangler may ask to create the Worker first; answering yes is fine, the deploy in step 7 fills it in.
6. Apply the migrations to the remote database:
   ```sh
   npx wrangler d1 migrations apply tidings --remote
   ```
7. Deploy (from the repo root this also rebuilds the SPA and re-applies migrations, which is a no-op now):
   ```sh
   cd ../..
   npm run deploy
   ```
   The `routes` entry (`tidings.mcn.am`, `custom_domain: true`) makes Wrangler create the DNS record and
   certificate for the hostname. TLS can take about 10 minutes to provision on first deploy, so early
   certificate errors are not a failed deploy. Wait and retry before debugging.
8. Open `https://tidings.mcn.am/setup`, enter the `SETUP_TOKEN`, create your passkey and save the recovery
   codes. Setup closes itself once a user exists (the secret can then be removed with
   `npx wrangler secret delete SETUP_TOKEN` from `apps/worker`; keep it if you want it for break-glass notes).
9. Check the security headers (spec 10.4, including HSTS):
   ```sh
   npm run check:headers -- https://tidings.mcn.am
   ```

### Automatic deploys (GitHub Actions)

A push to `main` runs CI; when it passes, the `deploy` job in `.github/workflows/ci.yml` builds the SPA,
runs `wrangler d1 migrations apply tidings --remote`, then `wrangler deploy`. A failed migration fails that
step and the Worker is not deployed. Add two repository secrets (Settings, Secrets and variables, Actions):

- `CLOUDFLARE_API_TOKEN`: an API token scoped to your one account with Workers Scripts: Edit and
  D1: Edit (add Workers Routes: Edit and Zone: Read, DNS: Edit on `mcn.am` if the deploy needs to
  manage the custom domain record).
- `CLOUDFLARE_ACCOUNT_ID`: shown on the Workers and Pages overview page.

Two optional secrets switch on email sign-in (TID-053, ADR 0016). If they are set in GitHub, the deploy
job copies them to Workers secrets (`wrangler-action` `secrets:`); if not, it skips them and the deploy still
passes:

- `RESEND_API_KEY`: a Resend sending-only API key restricted to the `tidings.mcn.am` domain.
- `MAGIC_LINK_EMAIL`: your own address, the only recipient.

Migrations must stay backward compatible with the previous Worker version: add columns first, use them in
a later deploy (spec 14.3). Pull requests and other branches never deploy.

### Email sign-in (Resend)

Setup, once: create a Resend account, **Domains > Add Domain** `tidings.mcn.am`, add the DNS records it lists
(all under `tidings.mcn.am`; none on the `mcn.am` apex, whose MX records belong to Google Workspace), wait for
Verified, then create an API key with Sending access restricted to that domain. Add `RESEND_API_KEY` and
`MAGIC_LINK_EMAIL` as GitHub secrets (or run `npx wrangler secret put` for each in `apps/worker`) and deploy.
`MAGIC_LINK_FROM` (`signin@tidings.mcn.am`) is a var in `wrangler.jsonc`. Free tier: 3,000 emails/month and
100/day; Tidings caps itself at 10 sends/day. Turn it off with `npx wrangler secret delete MAGIC_LINK_EMAIL`
(and remove the GitHub secret). If no email arrives, check the Worker logs for `email_send_rejected` (the
HTTP status only) or `email_link_failed` (the error class), then Resend's dashboard for the domain status.
Resend sees your address and the link, so treat the key like a password and rotate it in Resend if it leaks.

### Local development

See [Local development](#local-development). In short: `npm install`, `npm run db:migrate:local`, copy
`apps/worker/.dev.vars.example` to `.dev.vars`, `npm run dev`, open http://localhost:5173.

### Where to see usage

Cloudflare dashboard:

- Workers and Pages, then `tidings`, then Metrics: requests, errors, CPU time, and `exceededCpu` outcomes.
  Logs: the same page, Logs tab, or `npx wrangler tail` from `apps/worker`.
- Storage and Databases, then D1, then `tidings`, then Metrics: rows read, rows written and storage.
- Free-tier limits and the assumed load are in `docs/PRODUCT_SPEC.md` section 9.

### Rolling back a deploy

From `apps/worker`:

```sh
npx wrangler deployments list        # recent versions
npx wrangler rollback                # back to the previous version (or pass a version ID)
```

Rollback restores the previous Worker code and assets only. It does not undo D1 migrations; this is why
migrations must be backward compatible. If a bad deploy came from `main`, also revert the commit so the next
push does not redeploy it.

### Break-glass: lost every passkey and recovery code

Setup does not reopen once a user exists, so you insert a new one-time recovery code instead. Run these
from `apps/worker`. Nothing here leaves your machine except the hash.

**MVP caveat:** the `/recover` sign-in screen and `POST /api/auth/recover` arrive with TID-009 (R2). Until
that ships, a code inserted here cannot be used, so use "MVP fallback: reset the account" below. Steps 1
to 3 are the procedure once TID-009 is deployed.

1. Generate a code and its hash locally (the code is shown once; keep it safe, it is a single-use sign-in):
   ```sh
   node -e "const c=require('node:crypto');const A='0123456789ABCDEFGHJKMNPQRSTVWXYZ';const code=Array.from(c.randomBytes(16),b=>A[b%32]).join('');console.log('CODE',code.match(/.{4}/g).join('-'));console.log('HASH',c.createHash('sha256').update(code).digest('hex'))"
   ```
2. Store the hash (replace `<HASH>`; this attaches it to the single existing user):
   ```sh
   npx wrangler d1 execute tidings --remote --command "INSERT INTO recovery_codes (id, user_id, code_hash, created_at) SELECT lower(hex(randomblob(8))), id, '<HASH>', unixepoch() FROM users LIMIT 1"
   ```
3. Sign in at `https://tidings.mcn.am` with the recovery-code option using the `CODE` value, then add a new
   passkey and regenerate your recovery codes in Settings.
4. Optional, if a lost device may be in someone else's hands: remove the old passkeys and sessions.
   ```sh
   npx wrangler d1 execute tidings --remote --command "DELETE FROM passkeys; DELETE FROM sessions"
   ```
   Run this before step 3 (it also signs out any current session).

#### MVP fallback: reset the account (until TID-009 ships)

If you have lost every passkey, delete the user. This cascades to passkeys, sessions, recovery codes,
folders, subscriptions and read state, so you will re-import your OPML afterwards. Shared feeds and
entries stay. `SETUP_TOKEN` must still be set (`npx wrangler secret put SETUP_TOKEN` if you removed it).

```sh
npx wrangler d1 execute tidings --remote --command "DELETE FROM users"
```

Then open `https://tidings.mcn.am/setup` again and repeat first-time setup step 8. If setup says it is
rate limited, clear `rate_limits` (next section).

### Clearing setup or sign-in lockouts (`rate_limits`)

Auth routes are rate limited with counters in the `rate_limits` table (ADR 0011). If you are locked out
(for example the global setup limit was used up by someone else before you finished setup, or you hit the
sign-in limit), either wait up to an hour or clear the counters:

```sh
cd apps/worker
npx wrangler d1 execute tidings --remote --command "DELETE FROM rate_limits"
```

Warning: this resets all auth rate-limit protection, including the guess limits on recovery codes. Do it
only when you need to, and not while an attack is in progress. To clear one family only, add
`WHERE key LIKE 'setup:%'` (or `'login:%'`, `'recover:%'`).
