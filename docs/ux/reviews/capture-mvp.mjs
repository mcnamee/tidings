// End-of-MVP UX review capture. Usage (app already running on 8788 with the E2E database):
//   CHROME_PATH=/usr/bin/google-chrome node docs/ux/reviews/capture-mvp.mjs
// Seeds the E2E D1 through wrangler, signs in with the seeded session cookie, then captures every
// MVP screen and state at 375x812 and 1280x800 (light, dark) plus 200% text at 375. Network
// states that the app can't reach on its own (errors, partial success, choice list) are produced
// with page.route(). Output: docs/ux/reviews/mvp/ (screens) and mvp-measurements.json.
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const BASE = process.env.BASE ?? 'http://localhost:8788';
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT ?? join(HERE, 'mvp');
const WORKER = join(HERE, '../../../apps/worker');
const STATE = join(HERE, '../../../e2e/.wrangler-state');
const TOKEN = 'e2e-seed-session-token-0123456789abcdefghij';
const OPML = join(HERE, '../../../e2e/fixtures/opml/inoreader-export.opml');
mkdirSync(OUT, { recursive: true });
void createHash;

const sql = (statement) =>
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'tidings', '--local', '--persist-to', STATE, '--command', statement], {
    cwd: WORKER, stdio: 'pipe', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' },
  });
const q = (s) => `'${String(s).replaceAll("'", "''")}'`;
const U = 'e2e-seed-owner';
const NOW = Math.floor(Date.now() / 1000);

function clear() {
  sql('DELETE FROM user_entries; DELETE FROM entries; DELETE FROM subscriptions; DELETE FROM folders; DELETE FROM feeds;');
}
function seed() {
  const s = [];
  const folders = [
    ['f1', 'Tech'],
    ['f2', 'News'],
    ['f3', 'A very long folder name that keeps going past the edge of a screen'],
    ['f4', 'Empty folder'],
  ];
  for (const [id, n] of folders) s.push(`INSERT INTO folders (id,user_id,name,created_at) VALUES (${q(id)},${q(U)},${q(n)},0);`);
  const feeds = [
    [1, 'Ars Technica', 'f1', 'ok', null, 1],
    [2, 'The Verge', 'f1', 'ok', null, 1],
    [3, 'Daily Brief', 'f2', 'ok', null, 1],
    [4, 'An Extremely Long Feed Title That Should Truncate Somewhere Around Here On A Phone Screen', null, 'ok', null, 1],
    [5, 'Broken Blog', 'f2', 'failing', 'timeout', 1],
    [6, 'Dead Feed', null, 'dead', 'http_410', 1],
    [7, 'Brand New Feed', null, 'pending', null, null],
  ];
  for (const [id, t, f, st, err, ok] of feeds) {
    s.push(
      `INSERT INTO feeds (id,url,title,next_fetch_at,state,last_error_code,last_success_at,error_count,created_at) VALUES (${id},${q(`https://e2e-${id}.example.com/rss`)},${q(t)},9999999999,${q(st)},${err ? q(err) : 'NULL'},${ok ?? 'NULL'},${err ? 3 : 0},0);`,
      `INSERT INTO subscriptions (id,user_id,feed_id,folder_id,created_at) VALUES (${q('s' + id)},${q(U)},${id},${f ? q(f) : 'NULL'},0);`,
    );
  }
  let eid = 1000;
  const add = (feedId, title, o = {}) => {
    eid += 1;
    const at = NOW - (o.age ?? eid - 1000) * 1800;
    s.push(
      `INSERT INTO entries (id,feed_id,guid_hash,url,title,author,summary,content_html,image_url,published_at,fetched_at) VALUES (${eid},${feedId},${q('g' + eid)},${q(o.url ?? 'https://example.com/a/' + eid)},${title === null ? 'NULL' : q(title)},${o.author ? q(o.author) : 'NULL'},${o.summary ? q(o.summary) : 'NULL'},${o.html ? q(o.html) : 'NULL'},${o.img ? q(o.img) : 'NULL'},${at},${at});`,
      `INSERT INTO user_entries (user_id,entry_id,feed_id,published_at,is_read) VALUES (${q(U)},${eid},${feedId},${at},${o.read ? 1 : 0});`,
    );
    return eid;
  };
  const IMG = 'https://img.test/thumb.svg';
  const ARTICLE = `<p>The first paragraph sets the scene. It runs long enough to wrap across several lines on a phone so line length and leading can be judged properly.</p><img src="https://img.test/wide.svg" alt="A wide white chart" width="2000" height="1000"><p>Second paragraph with a <a href="https://example.com">link in the text</a> and <code>inline code</code>.</p><h2>A subheading</h2><blockquote><p>A quoted passage that is set apart from the body text.</p></blockquote><pre><code>const veryLongLine = 'this line is intentionally far wider than a phone screen so horizontal scrolling inside the block can be checked';</code></pre><table><tr><th>Col A</th><th>Col B</th><th>Col C</th><th>Col D</th><th>Col E</th><th>Col F</th></tr><tr><td>one one one</td><td>two two two</td><td>three three</td><td>four four</td><td>five five</td><td>six six six</td></tr></table><figure><img src="https://img.test/tall.svg" alt="" ><figcaption>A caption under the image.</figcaption></figure><p>https://example.com/a-very-long-url-that-has-no-break-opportunities-at-all-and-must-not-push-the-page-sideways-0123456789</p>`;
  // Feed 1: 25 unread (confirm sheet over 20). First is the rich article.
  add(1, 'A rich article with images, code, a table and a very long title that wraps across several lines on a phone', { author: 'Ada Writer', summary: 'Summary text that runs on for a while so the two-line clamp in the list is exercised properly.', html: ARTICLE, img: IMG, age: 1 });
  for (let i = 2; i <= 25; i += 1) add(1, `Ars story number ${i}`, { summary: i % 3 ? 'Short summary.' : undefined, img: i % 4 === 0 ? IMG : undefined });
  // Feed 2: 5 unread (immediate mark all + Undo toast).
  for (let i = 1; i <= 5; i += 1) add(2, `The Verge item ${i}`, { summary: 'A summary.', html: '<p>Body of the article.</p>' });
  add(2, 'Already read item', { read: true });
  // Feed 3: all read (caught up).
  add(3, 'Read already one', { read: true });
  add(3, 'Read already two', { read: true });
  // Feed 4: untitled, no content, long title.
  add(4, null, { html: null });
  add(4, 'Supercalifragilisticexpialidocious_unbreakable_title_with_no_spaces_at_all_to_test_wrapping_in_a_row', { summary: 'x' });
  add(4, 'Plain title, no content', { html: null, url: 'https://example.com/plain' });
  sql(s.join(' '));
}

const sizes = {
  m: { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true },
  d: { viewport: { width: 1280, height: 800 } },
};
const svg = (w, h, fill, label) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="${fill}"/><text x="50%" y="50%" text-anchor="middle" font-size="${Math.round(h / 8)}" fill="#333" font-family="sans-serif">${label}</text></svg>`;

const report = {};
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ['--no-sandbox'] });

async function open(size, scheme, extra = {}) {
  const c = await browser.newContext({ ...sizes[size], colorScheme: scheme, deviceScaleFactor: 1, ...extra });
  await c.addCookies([{ name: '__Host-tid_session', value: TOKEN, domain: new URL(BASE).hostname, path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
  await c.route('https://img.test/**', (r) => {
    const u = r.request().url();
    const body = u.includes('thumb') ? svg(160, 160, '#ffffff', 'THUMB') : u.includes('tall') ? svg(600, 900, '#f5f5f5', 'TALL') : svg(2000, 1000, '#ffffff', 'WIDE WHITE CHART');
    return r.fulfill({ status: 200, contentType: 'image/svg+xml', body });
  });
  return c;
}
const shot = (page, name, full = false) => page.screenshot({ path: join(OUT, `${name}.png`), fullPage: full });

async function audit(page) {
  return page.evaluate(() => {
    const small = [];
    document.querySelectorAll('a[href], button, [role=button], select, input:not([type=hidden]), label:has(input[type=file])').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      if (el.closest('.sr-only')) return;
      if (r.width < 43.5 || r.height < 43.5)
        small.push(`${(el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 30)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    });
    const unnamed = [];
    document.querySelectorAll('button, a[href], select, input:not([type=hidden])').forEach((el) => {
      const name = el.getAttribute('aria-label') || el.textContent?.trim() || (el.id && document.querySelector(`label[for="${el.id}"]`)?.textContent?.trim());
      if (!name && !el.closest('.sr-only')) unnamed.push(el.outerHTML.slice(0, 80));
    });
    return {
      h1: [...document.querySelectorAll('h1')].map((h) => h.textContent),
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      small, unnamed, docTitle: document.title,
    };
  });
}
const focusOrder = async (page, n = 10) => {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    await page.keyboard.press('Tab');
    out.push(await page.evaluate(() => { const a = document.activeElement; return (a.getAttribute('aria-label') || a.textContent || a.tagName).trim().slice(0, 28); }));
  }
  return out;
};
async function go(page, path, wait = 'h1') {
  await page.goto(BASE + path);
  await page.waitForSelector(wait);
  await page.waitForTimeout(350);
}

// ---------- Pass A: empty database ----------
clear();
const entryIds = {};
for (const size of ['m', 'd']) {
  for (const scheme of ['light', 'dark']) {
    const tag = `${size}-${scheme}`;
    clear();
    const c = await open(size, scheme);
    const page = await c.newPage();
    const R = (report[`A-${tag}`] = {});
    for (const [name, path] of [['all-empty', '/all'], ['manage-empty', '/manage'], ['add', '/manage/add'], ['import-choose', '/manage/import']]) {
      await go(page, path);
      await shot(page, `${name}-${tag}`);
      R[name] = await audit(page);
    }
    // Import: not an OPML file
    await page.setInputFiles('input[type=file]', { name: 'bad.opml', mimeType: 'text/xml', buffer: Buffer.from('<html>nope</html>') });
    await page.waitForSelector('[role=alert]');
    await shot(page, `import-bad-file-${tag}`);
    // Import: preview
    await page.setInputFiles('input[type=file]', OPML);
    await page.waitForSelector('text=Found');
    await shot(page, `import-preview-${tag}`);
    R['import-preview'] = await audit(page);
    R.importPreviewFocus = await focusOrder(page, 5);
    // Sending (slow first request)
    let n = 0;
    await page.route('**/api/import/opml', async (r) => { n += 1; if (n === 1) { await new Promise((x) => setTimeout(x, 2500)); } return r.continue(); });
    await page.getByRole('button', { name: /^Import \d/ }).click();
    await page.waitForTimeout(500);
    await shot(page, `import-sending-${tag}`);
    await page.waitForSelector('text=Fetching your feeds', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(800);
    await shot(page, `import-progress-${tag}`);
    R['import-progress'] = await audit(page);
    R.importProgressText = await page.locator('main, #main').first().innerText().catch(() => '');
    await c.close();
  }
}
// Import failure mid-send (once, mobile light)
{
  clear();
  const c = await open('m', 'light');
  const page = await c.newPage();
  await go(page, '/manage/import');
  await page.route('**/api/import/opml', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"code":"internal","message":"x"}}' }));
  await page.setInputFiles('input[type=file]', OPML);
  await page.waitForSelector('text=Found');
  await page.getByRole('button', { name: /^Import \d/ }).click();
  await page.waitForSelector('text=Import paused');
  await shot(page, 'import-paused-m-light');
  report.importPaused = await audit(page);
  await c.close();
}

// ---------- Pass B: seeded data ----------
clear();
seed();

for (const size of ['m', 'd']) {
  for (const scheme of ['light', 'dark']) {
    const tag = `${size}-${scheme}`;
    const c = await open(size, scheme);
    const page = await c.newPage();
    const R = (report[`B-${tag}`] = {});

    // Capture subscription ids
    await page.goto(BASE + '/all');
    const subs = await page.evaluate(async () => (await fetch('/api/subscriptions')).json());
    const sub = (t) => subs.items.find((s) => s.title === t || s.title.startsWith(t));
    const ars = sub('Ars'), verge = sub('The Verge'), brief = sub('Daily'), long = sub('An Extremely'), broken = sub('Broken'), fresh = sub('Brand'), dead = sub('Dead');

    const pages = [
      ['all', '/all'],
      ['all-readstate', '/all?state=all'],
      ['feed-long', `/feeds/${long.id}?state=all`],
      ['feed-failing', `/feeds/${broken.id}`],
      ['feed-dead', `/feeds/${dead.id}`],
      ['feed-pending', `/feeds/${fresh.id}`],
      ['feed-caught-up', `/feeds/${brief.id}`],
      ['manage', '/manage'],
    ];
    for (const [name, path] of pages) {
      await go(page, path);
      await shot(page, `${name}-${tag}`);
      R[name] = await audit(page);
    }
    R.manageFocus = await (async () => { await go(page, '/manage'); return focusOrder(page, 14); })();
    await shot(page, `manage-full-${tag}`, true);

    // Drawer (mobile) or sidebar with counts
    if (size === 'm') {
      await go(page, '/all');
      await page.getByRole('button', { name: 'Open navigation' }).click();
      await page.waitForTimeout(500);
      await shot(page, `drawer-${tag}`);
      R.drawer = await page.evaluate(() => [...document.querySelectorAll('#nav-drawer a, #nav-drawer button')].map((el) => { const r = el.getBoundingClientRect(); return `${(el.getAttribute('aria-label') || el.textContent).trim().slice(0, 30)} ${Math.round(r.width)}x${Math.round(r.height)}`; }));
      await page.keyboard.press('Escape');
    }

    // Articles
    await go(page, `/feeds/${ars.id}?state=all`);
    await page.getByRole('link', { name: /A rich article/ }).first().click();
    await page.waitForSelector('article img');
    await page.waitForTimeout(600);
    await shot(page, `article-rich-${tag}`);
    await shot(page, `article-rich-full-${tag}`, true);
    R.article = await audit(page);
    R.articleImgs = await page.evaluate(() => [...document.querySelectorAll('article img')].map((i) => ({ w: Math.round(i.getBoundingClientRect().width), vw: innerWidth, filter: getComputedStyle(i).filter })));
    R.articleScroll = await page.evaluate(() => ({ docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, pre: (() => { const p = document.querySelector('article pre'); return p ? getComputedStyle(p).overflowX : null; })(), table: (() => { const t = document.querySelector('article table'); return t ? { w: Math.round(t.getBoundingClientRect().width), vw: innerWidth, parentOverflow: getComputedStyle(t.parentElement).overflowX } : null; })() }));
    R.articleFocus = await focusOrder(page, 8);
    await page.keyboard.press('Shift+Tab');
    await go(page, `/feeds/${long.id}?state=all`);
    const links = page.locator('main a[href*="/a/"], #main a[href*="/a/"]');
    const count = await links.count();
    // Untitled article (first in feed 4 by age is newest: the untitled one)
    await links.nth(0).click();
    await page.waitForSelector('article');
    await page.waitForTimeout(400);
    await shot(page, `article-untitled-nocontent-${tag}`);
    await page.goBack();
    await page.waitForTimeout(300);
    await links.nth(1).click();
    await page.waitForSelector('article');
    await page.waitForTimeout(300);
    await shot(page, `article-longtitle-${tag}`);
    R.articleLong = await audit(page);
    R.longLinks = count;

    // Loading skeleton + error + offline for the list
    const p2 = await c.newPage();
    await p2.route('**/api/entries?**', async (r) => { await new Promise((x) => setTimeout(x, 4000)); return r.continue(); });
    await p2.goto(BASE + `/feeds/${ars.id}`);
    await p2.waitForSelector('[data-testid=list-skeleton]');
    await p2.waitForTimeout(300);
    await shot(p2, `list-loading-${tag}`);
    await p2.close();
    const p3 = await c.newPage();
    await p3.route('**/api/entries?**', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"code":"internal","message":"x"}}' }));
    await p3.goto(BASE + `/feeds/${ars.id}`);
    await p3.waitForSelector('text=Try again');
    await shot(p3, `list-error-${tag}`);
    await p3.close();
    const p4 = await c.newPage();
    await p4.route('**/api/subscriptions', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"code":"internal","message":"x"}}' }));
    await p4.goto(BASE + '/manage');
    await p4.waitForSelector('[role=alert]');
    await shot(p4, `manage-error-${tag}`);
    await p4.close();
    // Offline on manage and on a list
    await go(page, '/all');
    await c.setOffline(true);
    await page.waitForTimeout(500);
    await shot(page, `all-offline-${tag}`);
    await go(page, '/manage').catch(() => {});
    await c.setOffline(false);
    await c.close();
  }
}

// ---------- Pass C: sheets, toasts, add-feed states (mobile + desktop light/dark) ----------
for (const size of ['m', 'd']) {
  for (const scheme of ['light', 'dark']) {
    const tag = `${size}-${scheme}`;
    const c = await open(size, scheme);
    const page = await c.newPage();
    const R = (report[`C-${tag}`] = {});
    const sheetAudit = () => page.evaluate(() => { const d = document.querySelector('[role=dialog]'); if (!d) return null; const r = d.getBoundingClientRect(); const items = [...d.querySelectorAll('button,input,select')].map((el) => { const b = el.getBoundingClientRect(); return `${(el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 24)} ${Math.round(b.width)}x${Math.round(b.height)}`; }); return { top: Math.round(r.top), h: Math.round(r.height), vh: innerHeight, name: d.getAttribute('aria-labelledby') && document.getElementById(d.getAttribute('aria-labelledby'))?.textContent, items, focus: (document.activeElement.getAttribute('aria-label') || document.activeElement.textContent || document.activeElement.tagName).trim().slice(0, 30) }; });

    // Manage sheets
    await go(page, '/manage');
    await page.getByRole('button', { name: 'New folder' }).click();
    await page.waitForSelector('[role=dialog]');
    await shot(page, `sheet-new-folder-${tag}`);
    R.newFolder = await sheetAudit();
    await page.getByRole('button', { name: 'Create folder' }).click();
    await page.waitForTimeout(300);
    await shot(page, `sheet-new-folder-error-${tag}`);
    await page.getByRole('textbox', { name: 'Folder name' }).fill('Tech');
    await page.getByRole('button', { name: 'Create folder' }).click();
    await page.waitForTimeout(800);
    await shot(page, `sheet-new-folder-duplicate-${tag}`);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Rename Tech' }).click();
    await page.waitForTimeout(300);
    await shot(page, `sheet-rename-folder-${tag}`);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Delete Tech' }).click();
    await page.waitForTimeout(300);
    await shot(page, `sheet-delete-folder-${tag}`);
    R.deleteFolder = await sheetAudit();
    await page.keyboard.press('Escape');
    R.focusReturn = await page.evaluate(() => document.activeElement.getAttribute('aria-label'));
    await page.getByRole('button', { name: 'Ars Technica, options' }).click();
    await page.waitForTimeout(300);
    await shot(page, `sheet-feed-options-${tag}`);
    R.feedOptions = await sheetAudit();
    await page.getByRole('button', { name: 'Move to folder' }).click();
    await page.waitForTimeout(300);
    await shot(page, `sheet-move-${tag}`);
    R.move = await sheetAudit();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Ars Technica, options' }).click();
    await page.getByRole('button', { name: 'Unsubscribe' }).click();
    await page.waitForTimeout(300);
    await shot(page, `sheet-unsubscribe-${tag}`);
    R.unsub = await sheetAudit();
    await page.keyboard.press('Escape');

    // Add-feed states
    await go(page, '/manage/add');
    await page.getByLabel('Feed or website address').fill('https://example.com/nothing');
    await page.route('**/api/subscriptions', async (r) => {
      if (r.request().method() !== 'POST') return r.continue();
      const body = JSON.parse(r.request().postData() ?? '{}');
      const u = body.url;
      const err = (status, code, details) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: { code, message: 'x', details } }) });
      if (u.endsWith('nothing')) return err(422, 'no_feed_found');
      if (u.endsWith('choice')) return err(409, 'feed_choice_required', { candidates: [ { url: 'https://example.com/feed.xml', title: 'Example Blog', type: 'rss', supported: true }, { url: 'https://example.com/atom.xml', title: null, type: 'atom', supported: true }, { url: 'https://example.com/feed.json', title: 'Example Blog (JSON Feed)', type: 'json', supported: false } ] });
      if (u.endsWith('dupe')) return err(409, 'already_subscribed', { subscriptionId: 's1' });
      if (u.endsWith('limit')) return err(409, 'limit_reached');
      if (u.endsWith('rate')) return err(429, 'rate_limited');
      if (u.endsWith('partial')) {
        const list = await (await r.fetch({ url: BASE + '/api/subscriptions', method: 'GET' })).json();
        const s = (list.items)[0];
        return r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ subscription: { ...s, title: 'Example Blog' }, fetch: { ok: false, newEntries: 0, errorCode: 'http_500' } }) });
      }
      if (u.endsWith('slow')) { await new Promise((x) => setTimeout(x, 3000)); return err(422, 'no_feed_found'); }
      return r.continue();
    });
    await page.getByRole('button', { name: 'Add feed' }).click();
    await page.waitForSelector('text=We couldn');
    await shot(page, `add-no-feed-${tag}`);
    R.addNoFeedInvalid = await page.evaluate(() => { const i = document.querySelector('input[inputmode=url]'); return { invalid: i.getAttribute('aria-invalid'), described: i.getAttribute('aria-describedby') }; });
    R.add = await audit(page);
    R.addFocus = await (async () => { await go(page, '/manage/add'); return focusOrder(page, 8); })();
    const fill = async (v) => { await go(page, '/manage/add'); await page.getByLabel('Feed or website address').fill(v); await page.getByRole('button', { name: 'Add feed' }).click(); };
    await fill('https://example.com/slow');
    await page.waitForTimeout(600);
    await shot(page, `add-busy-${tag}`);
    await page.waitForTimeout(3000);
    await fill('https://example.com/dupe');
    await page.waitForSelector('text=already follow');
    await shot(page, `add-already-${tag}`);
    await fill('https://example.com/limit');
    await page.waitForSelector('text=limit of 1,000');
    await shot(page, `add-limit-${tag}`);
    await fill('https://example.com/rate');
    await page.waitForSelector('text=Too many');
    await shot(page, `add-rate-${tag}`);
    await fill('https://example.com/partial');
    await page.waitForSelector('text=Tidings will keep trying');
    await page.waitForTimeout(300);
    await shot(page, `add-partial-${tag}`);
    R.addPartial = await audit(page);
    await fill('https://example.com/choice');
    await page.waitForSelector('text=We found 3');
    await page.waitForTimeout(300);
    await shot(page, `add-choice-${tag}`);
    R.addChoice = await audit(page);
    await go(page, '/manage/add');
    await page.getByLabel('Folder (optional)').focus();
    await shot(page, `add-folder-focus-${tag}`);
    await c.setOffline(true);
    await page.waitForTimeout(500);
    await shot(page, `add-offline-${tag}`);
    await c.setOffline(false);

    // Success toast after real add is not reachable offline of the fixture server: use the toast from mark-all instead.
    // Mark all read: confirm sheet (feed 25 unread) then toast+Undo (Verge 5 unread)
    await page.goto(BASE + '/all');
    const subs = await page.evaluate(async () => (await fetch('/api/subscriptions')).json());
    const list = subs.items;
    const ars = list.find((s) => s.title === 'Ars Technica');
    const verge = list.find((s) => s.title === 'The Verge');
    await go(page, `/feeds/${ars.id}`);
    await page.getByRole('button', { name: 'Mark all as read' }).click();
    await page.waitForSelector('[role=dialog]');
    await shot(page, `markall-confirm-${tag}`);
    R.markConfirm = await sheetAudit();
    await page.keyboard.press('Escape');
    await go(page, `/feeds/${verge.id}`);
    await page.getByRole('button', { name: 'Mark all as read' }).click();
    await page.waitForSelector('.toast-item');
    await page.waitForTimeout(500);
    await shot(page, `toast-undo-${tag}`);
    R.toast = await page.evaluate(() => { const t = document.querySelector('.toast-item').getBoundingClientRect(); const b = document.querySelector('#bottom-bar')?.getBoundingClientRect(); const act = document.querySelector('.toast-item button')?.getBoundingClientRect(); return { text: document.querySelector('.toast-item').textContent, gapAboveBar: b ? Math.round(b.top - t.bottom) : null, actionSize: act ? `${Math.round(act.width)}x${Math.round(act.height)}` : null }; });
    await page.getByRole('button', { name: 'Undo' }).click();
    await page.waitForTimeout(600);
    R.afterUndo = await page.locator('.toast-item').allInnerTexts();
    await shot(page, `toast-after-undo-${tag}`);
    // Caught-up state in unread-only list
    await page.getByRole('button', { name: 'Mark all as read' }).click();
    await page.waitForTimeout(1200);
    await go(page, `/feeds/${verge.id}`);
    await shot(page, `caught-up-${tag}`);
    // Restore unread for later passes
    sql('UPDATE user_entries SET is_read = 0 WHERE feed_id IN (1,2);');
    await c.close();
  }
}

// ---------- Pass D: 200% text on the phone ----------
for (const scheme of ['light', 'dark']) {
  const c = await open('m', scheme);
  const page = await c.newPage();
  const R = (report[`D-${scheme}`] = {});
  sql('UPDATE user_entries SET is_read = 0 WHERE feed_id IN (1,2);'); // earlier contexts opened articles
  await page.goto(BASE + '/all');
    const subs = await page.evaluate(async () => (await fetch('/api/subscriptions')).json());
  const list = subs.items;
  const ars = list.find((s) => s.title === 'Ars Technica');
  const zoom = () => page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
  for (const [name, path] of [['manage', '/manage'], ['add', '/manage/add'], ['import', '/manage/import'], ['list', `/feeds/${ars.id}`], ['all', '/all']]) {
    await go(page, path);
    await zoom();
    await page.waitForTimeout(300);
    await shot(page, `zoom200-${name}-${scheme}`);
    R[name] = await audit(page);
    R[name].bottomBar = await page.evaluate(() => { const b = document.querySelector('#bottom-bar')?.getBoundingClientRect(); return b ? { h: Math.round(b.height), vh: innerHeight } : null; });
  }
  await go(page, '/manage');
  await zoom();
  await page.getByRole('button', { name: 'Ars Technica, options' }).click();
  await page.waitForTimeout(300);
  await shot(page, `zoom200-sheet-${scheme}`);
  R.sheet = await page.evaluate(() => { const d = document.querySelector('[role=dialog]'); return { scroll: d.scrollHeight > d.clientHeight, h: Math.round(d.getBoundingClientRect().height), vh: innerHeight }; });
  await page.keyboard.press('Escape');
  await go(page, `/feeds/${ars.id}`);
  await zoom();
  await page.waitForSelector('a[href*="/a/"]');
  await page.getByRole('link', { name: /A rich article/ }).first().click({ timeout: 60000 });
  await page.waitForSelector('article img');
  await zoom();
  await page.waitForTimeout(400);
  await shot(page, `zoom200-article-${scheme}`);
  R.article = await audit(page);
  R.articleBar = await page.evaluate(() => { const b = document.querySelector('#bottom-bar'); return b ? { h: Math.round(b.getBoundingClientRect().height), btn: [...b.querySelectorAll('button')].map((x) => `${x.textContent.trim()} ${Math.round(x.getBoundingClientRect().width)}x${Math.round(x.getBoundingClientRect().height)}`) } : null; });
  await c.close();
}

writeFileSync(join(HERE, 'mvp-measurements.json'), JSON.stringify(report, null, 2));
await browser.close();
console.log('done');
void readFileSync;
