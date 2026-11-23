<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <img src="docs/assets/logo-light.svg" alt="Tidings logo" width="96" height="96">
  </picture>
</p>

<h1 align="center">Tidings</h1>

<p align="center">
  <strong>A fast, beautiful RSS reader you own - built for your phone and free to run.</strong>
</p>

<p align="center">
  Mobile first · Installable app · Light and dark · Runs on Cloudflare's free plan
</p>

---

## Why Tidings

Paid feed readers charge every month to show you articles from the open web. Tidings gives you the same daily reading flow on your own Cloudflare account, for nothing.

- **Free to run.** Everything fits inside Cloudflare's free plan, with the budget worked out feed by feed and checked in production.
- **Yours.** Your subscriptions, reading history and settings live in your own database. Export them as OPML whenever you like.
- **Made for the phone.** Designed at 375px first, for one-handed reading in short bursts, often in the dark.
- **Always fresh.** Feeds refresh in the background every 30 minutes, whether or not the app is open, so there's no waiting when you open it.
- **Private and secure.** Passkey sign-in, no public sign-up, and article content can never run script in the app.

## Features

### Reading

- **Opens instantly.** Your lists and recent articles are cached on the device, so the app shows them straight away, even offline, and updates in the background.
- **Folders and unread counts** for everything, every folder and every feed.
- **Recommended order.** An optional sort that learns from what you actually open and read, using Cloudflare Workers AI on your own reading only.
- **Preview images for every feed.** When a feed doesn't include an image, Tidings finds a good one from the article page, and drops tiny or junk ones.
- **No duplicates.** The same story from several feeds shows once.
- **Mark as read as you scroll**, or mark a whole list as read with one tap (with undo).
- **A clean article view** with a sans-serif body, adjustable text size and a one-tap jump to the original.

### Feels like a native app

- **Install it to your home screen.** It runs full screen, with its own icon and launch screen.
- **Natural gestures.** Swipe from the edge to open the menu, which slides the page aside to reveal it underneath, and swipe back from an article to the list.
- **Light and dark themes** that follow your system by default, with a blurred, translucent header.
- **A small reward** when you're all caught up: one of a dozen hand-drawn illustrations.

### Managing feeds

- **Switch in one sitting.** Import your OPML from Inoreader (or any reader), with folders kept intact.
- **Add a feed by its address or the website's address.** Tidings finds the feed for you.
- **Feed health at a glance.** See which feeds are failing and why, in plain language, and refresh any feed on demand.
- **Rename, move and re-point feeds** without losing your history.

### Under the hood

- One Cloudflare Worker serves both the React app and the JSON API, with a D1 database and Cron Triggers for refreshing.
- Polite fetching: conditional requests, backoff for failing feeds, and an SSRF-safe fetcher.
- Strict security headers and a content security policy, with every API query scoped to the signed-in user.
- Typed end to end in TypeScript, with unit, integration and end-to-end tests at phone and desktop sizes in both themes.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/web/public/caught-up/trophy-dark.png">
    <img src="apps/web/public/caught-up/trophy-light.png" alt="" width="120">
  </picture>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/web/public/caught-up/cat-dark.png">
    <img src="apps/web/public/caught-up/cat-light.png" alt="" width="120">
  </picture>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/web/public/caught-up/coffee-dark.png">
    <img src="apps/web/public/caught-up/coffee-light.png" alt="" width="120">
  </picture>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/web/public/caught-up/popper-dark.png">
    <img src="apps/web/public/caught-up/popper-light.png" alt="" width="120">
  </picture>
</p>

## Installation

You'll need:

- A free Cloudflare account, with the domain you want to use added to it
- Node.js 22 or later
- About 15 minutes

**1. Get the code and install it**

```bash
git clone https://github.com/mcnamee/tidings.git
```

```bash
cd tidings && npm ci
```

**2. Sign in to Cloudflare**

```bash
npx wrangler login
```

**3. Create the database**

```bash
cd apps/worker && npx wrangler d1 create tidings
```

Copy the `database_id` it prints into `apps/worker/wrangler.jsonc`. In the same file, set `routes`, `APP_ORIGIN` and `RP_ID` to your own hostname (passkeys are tied to it, so choose it before you sign up).

**4. Set your setup token**

This is a one-off secret of at least 32 characters that proves you're the owner when you first sign up.

```bash
npx wrangler secret put SETUP_TOKEN
```

**5. Deploy**

```bash
cd ../.. && npm run deploy
```

This builds the app, applies the database migrations and deploys the Worker. The certificate for a new hostname can take about 10 minutes to arrive.

**6. Create your account**

Open `https://<your-hostname>/setup`, enter your setup token, create a passkey and save your recovery codes. Then import your OPML file from Settings and start reading.

**7. Install it on your phone (optional)**

Open your Tidings address in Safari or Chrome and choose **Add to Home Screen**.

For automatic deploys from GitHub, email sign-in links, monitoring, rollbacks and account recovery, see the full [deployment guide](docs/DEPLOYMENT.md).

## Documentation

| Guide                                        | What's in it                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [Deployment and runbook](docs/DEPLOYMENT.md) | First-time setup in detail, GitHub Actions, email sign-in, usage, rollback, break-glass recovery |
| [Development](docs/DEVELOPMENT.md)           | Running locally, scripts, testing the background refresh, project layout and tests               |
| [Product spec](docs/PRODUCT_SPEC.md)         | Requirements, architecture, API, free-tier budget and security model                             |
| [Backlog](docs/BACKLOG.md)                   | Stories and acceptance criteria                                                                  |
| [Architecture decisions](docs/decisions/)    | The ADRs behind the main design choices                                                          |
| [Design system](docs/ux/DESIGN_SYSTEM.md)    | Colours, type, motion and components for both themes                                             |
