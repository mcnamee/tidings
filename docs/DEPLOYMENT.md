# Deploying and running Tidings

Production is one Worker named `tidings` (API plus static SPA assets), one D1 database `tidings`, on the
custom domain `tidings.mcn.am`. All commands below run from the repo root unless a `cd` is shown.
Decide the hostname before first-run setup: passkeys are bound to `RP_ID` (spec Q2, risk R6). To use a
different host, change `routes`, `APP_ORIGIN` and `RP_ID` in `apps/worker/wrangler.jsonc` first.

## First-time setup

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

## Automatic deploys (GitHub Actions)

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

## Email sign-in (Resend)

Setup, once: create a Resend account, **Domains > Add Domain** `tidings.mcn.am`, add the DNS records it lists
(all under `tidings.mcn.am`; none on the `mcn.am` apex, whose MX records belong to Google Workspace), wait for
Verified, then create an API key with Sending access restricted to that domain. Add `RESEND_API_KEY` and
`MAGIC_LINK_EMAIL` as GitHub secrets (or run `npx wrangler secret put` for each in `apps/worker`) and deploy.
`MAGIC_LINK_FROM` (`signin@tidings.mcn.am`) is a var in `wrangler.jsonc`. Free tier: 3,000 emails/month and
100/day; Tidings caps itself at 10 sends/day. Turn it off with `npx wrangler secret delete MAGIC_LINK_EMAIL`
(and remove the GitHub secret). If no email arrives, check the Worker logs for `email_send_rejected` (the
HTTP status only) or `email_link_failed` (the error class), then Resend's dashboard for the domain status.
Resend sees your address and the link, so treat the key like a password and rotate it in Resend if it leaks.

## Local development

See [DEVELOPMENT.md](DEVELOPMENT.md).

## Where to see usage

Cloudflare dashboard:

- Workers and Pages, then `tidings`, then Metrics: requests, errors, CPU time, and `exceededCpu` outcomes.
  Logs: the same page, Logs tab, or `npx wrangler tail` from `apps/worker`.
- Storage and Databases, then D1, then `tidings`, then Metrics: rows read, rows written and storage.
- Free-tier limits and the assumed load are in `PRODUCT_SPEC.md` section 9.

## Rolling back a deploy

From `apps/worker`:

```sh
npx wrangler deployments list        # recent versions
npx wrangler rollback                # back to the previous version (or pass a version ID)
```

Rollback restores the previous Worker code and assets only. It does not undo D1 migrations; this is why
migrations must be backward compatible. If a bad deploy came from `main`, also revert the commit so the next
push does not redeploy it.

## Break-glass: lost every passkey and recovery code

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

### MVP fallback: reset the account (until TID-009 ships)

If you have lost every passkey, delete the user. This cascades to passkeys, sessions, recovery codes,
folders, subscriptions and read state, so you will re-import your OPML afterwards. Shared feeds and
entries stay. `SETUP_TOKEN` must still be set (`npx wrangler secret put SETUP_TOKEN` if you removed it).

```sh
npx wrangler d1 execute tidings --remote --command "DELETE FROM users"
```

Then open `https://tidings.mcn.am/setup` again and repeat first-time setup step 8. If setup says it is
rate limited, clear `rate_limits` (next section).

## Clearing setup or sign-in lockouts (`rate_limits`)

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
