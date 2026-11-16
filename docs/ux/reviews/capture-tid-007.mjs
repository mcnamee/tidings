// UX review capture for TID-007.
// Usage: BASE=http://localhost:8798 STATE=/tmp/ux007-state node docs/ux/reviews/capture-tid-007.mjs
// Needs `wrangler dev` with SETUP_TOKEN=ux-review-token-0123456789abcdefghij on a fresh --persist-to dir.
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE ?? 'http://localhost:8798';
const STATE = process.env.STATE ?? '/tmp/ux007-state';
const TOKEN = 'ux-review-token-0123456789abcdefghij';
const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, 'tid-007');
const WORKER = resolve(here, '../../../apps/worker');
mkdirSync(OUT, { recursive: true });

function reset() {
  execFileSync(
    'npx',
    [
      'wrangler', 'd1', 'execute', 'tidings', '--local', '--persist-to', STATE, '--command',
      ['sessions', 'recovery_codes', 'passkeys', 'webauthn_challenges', 'rate_limits', 'users']
        .map((t) => `DELETE FROM ${t};`)
        .join(' '),
    ],
    { cwd: WORKER, stdio: 'pipe', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' } },
  );
}

const sizes = {
  m: { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true },
  d: { viewport: { width: 1280, height: 800 } },
};
const report = {};
const browser = await chromium.launch();

async function authn(page, opts = {}) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
      isUserVerified: opts.verified ?? true, automaticPresenceSimulation: opts.presence ?? true,
    },
  });
}

async function audit(page) {
  return page.evaluate(() => {
    const small = [];
    document.querySelectorAll('a[href], button, [role=button], input').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const t = (el.getAttribute('aria-label') || el.textContent || el.id || el.tagName).trim().slice(0, 30);
      if (r.width < 43.5 || r.height < 43.5) small.push(`${el.tagName} "${t}" ${Math.round(r.width)}x${Math.round(r.height)}`);
    });
    return {
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      small, h1: document.querySelectorAll('h1').length, docTitle: document.title,
    };
  });
}
const active = (page) =>
  page.evaluate(() => {
    const e = document.activeElement;
    return (e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 40) + ` <${e.tagName.toLowerCase()}>`;
  });
async function tabOrder(page, n) {
  const out = [];
  for (let i = 0; i < n; i++) { await page.keyboard.press('Tab'); out.push(await active(page)); }
  return out;
}
async function fillAndSubmit(page, token = TOKEN) {
  await page.getByLabel('Your name').fill('Matt');
  await page.getByLabel('Setup token', { exact: true }).fill(token);
  await page.getByRole('button', { name: /Create passkey/ }).click();
}

for (const size of ['m', 'd']) {
  for (const scheme of ['light', 'dark']) {
    const tag = `${size}-${scheme}`;
    const R = (report[tag] = {});
    const shot = (page, name, full = false) => page.screenshot({ path: join(OUT, `${tag}-${name}.png`), fullPage: full });
    const ctx = (extra = {}) =>
      browser.newContext({
        ...sizes[size], colorScheme: scheme, deviceScaleFactor: 1, acceptDownloads: true,
        permissions: ['clipboard-read', 'clipboard-write'], baseURL: BASE, ...extra,
      });
    reset();

    // 1. token entry, validation, wrong token, rate limited
    {
      const c = await ctx();
      const page = await c.newPage();
      await authn(page);
      await page.goto('/setup');
      await page.getByRole('heading', { level: 1, name: 'Set up Tidings' }).waitFor();
      R.step1 = await audit(page);
      await shot(page, '01-token-entry');
      R.step1Tab = await tabOrder(page, 6);
      await page.getByRole('button', { name: /Create passkey/ }).click();
      await shot(page, '02-validation');
      R.validationFocus = await active(page);
      await fillAndSubmit(page, 'nope-wrong-token');
      await page.getByText("That setup token isn't right").waitFor();
      await shot(page, '03-wrong-token');
      R.wrongTokenFocus = await active(page);
      R.wrongTokenSel = await page.evaluate(() => { const e = document.activeElement; return [e.selectionStart, e.selectionEnd, e.value.length]; });
      for (let i = 0; i < 12; i++) {
        await page.evaluate(() => fetch('/api/auth/setup/options', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ setupToken: 'bad', displayName: 'x' }) }));
      }
      await page.getByRole('button', { name: /Create passkey/ }).click();
      await page.getByText(/Too many attempts/).waitFor({ timeout: 5000 }).catch(() => {});
      await shot(page, '04-rate-limited');
      R.rate = await page.evaluate(() => ({ text: document.querySelector('main')?.innerText.slice(0, 400), btn: document.querySelector('button[type=submit]')?.outerHTML.slice(0, 400) }));
      await c.close();
      reset();
    }

    // 2. unsupported before and at runtime
    {
      const c = await ctx();
      const page = await c.newPage();
      await page.addInitScript(() => { delete window.PublicKeyCredential; });
      await page.goto('/setup');
      await page.waitForTimeout(800);
      await shot(page, '05-unsupported-before');
      R.unsupportedBefore = await page.evaluate(() => document.querySelector('main')?.innerText);
      await c.close();
      const c2 = await ctx();
      const p2 = await c2.newPage();
      await p2.addInitScript(() => { navigator.credentials.create = () => Promise.reject(new DOMException('x', 'NotSupportedError')); });
      await p2.goto('/setup');
      await fillAndSubmit(p2);
      await p2.waitForTimeout(800);
      await shot(p2, '06-unsupported-runtime');
      R.unsupportedRuntime = await p2.evaluate(() => document.querySelector('main')?.innerText);
      await c2.close();
      reset();
    }

    // 3. in progress and cancelled
    {
      const c = await ctx();
      const page = await c.newPage();
      await authn(page, { presence: false });
      await page.goto('/setup');
      await fillAndSubmit(page);
      await page.getByText('Follow the prompt on your device.').waitFor({ timeout: 8000 }).catch(() => {});
      await shot(page, '07-in-progress');
      R.progress = await page.evaluate(() => ({ text: document.querySelector('main')?.innerText, btn: document.querySelector('button[type=submit]')?.outerHTML.slice(0, 500), ro: [...document.querySelectorAll('input')].map((i) => i.readOnly) }));
      await c.close();
      reset();
      const c2 = await ctx();
      const p2 = await c2.newPage();
      await p2.addInitScript(() => { navigator.credentials.create = () => Promise.reject(new DOMException('x', 'NotAllowedError')); });
      await p2.goto('/setup');
      await fillAndSubmit(p2);
      await p2.getByText('Passkey setup was cancelled').waitFor();
      await shot(p2, '08-cancelled');
      R.cancelledFocus = await active(p2);
      R.cancelledValues = await p2.evaluate(() => [...document.querySelectorAll('input')].map((i) => i.value.length));
      await c2.close();
      reset();
    }

    // 4. success, codes step
    {
      const c = await ctx();
      const page = await c.newPage();
      await authn(page);
      page.on('dialog', async (d) => { (R.dialogs ??= []).push(d.type()); await d.dismiss(); });
      await page.goto('/setup');
      await fillAndSubmit(page);
      await page.getByRole('heading', { level: 1, name: 'Save your recovery codes' }).waitFor();
      await page.waitForTimeout(300);
      R.codesFocus = await active(page);
      await shot(page, '09-codes-before');
      if (size === 'm') await shot(page, '09-codes-before-full', true);
      R.codes = await audit(page);
      R.codesTab = await tabOrder(page, 5);
      const codes = await page.getByRole('list', { name: 'Recovery codes' }).locator('code').allTextContents();
      R.codeCount = codes.length; R.codeDistinct = new Set(codes).size; R.codesSample = codes[0];
      R.codeFont = await page.evaluate(() => { const e = document.querySelector('ol code'); const s = getComputedStyle(e); return { size: s.fontSize, family: s.fontFamily.slice(0, 40), w: e.getBoundingClientRect().width, ol: document.querySelector('ol').getBoundingClientRect().width }; });
      R.names = await page.evaluate(() => [...document.querySelectorAll('button')].map((b) => [b.textContent.trim(), b.getAttribute('aria-label'), b.getAttribute('aria-disabled')]));
      await page.getByRole('button', { name: /Copy codes/ }).click();
      await page.waitForTimeout(300);
      await shot(page, '10-copied');
      R.clip = await page.evaluate(() => navigator.clipboard.readText());
      R.copyStatus = await page.locator('[role=status]').allInnerTexts();
      R.copyBtn = await page.evaluate(() => [...document.querySelectorAll('button')].map((b) => b.textContent.trim() + '|' + b.getAttribute('aria-label')));
      const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Download/ }).click()]);
      const f = join(OUT, `${tag}-download.txt`);
      await dl.saveAs(f);
      R.download = { name: dl.suggestedFilename(), content: readFileSync(f, 'utf8').split('\n').slice(0, 6) };
      R.downloadStatus = await page.locator('[role=status]').allInnerTexts();
      await page.getByRole('button', { name: 'Continue' }).click({ force: true });
      R.continueInertUrl = page.url();
      R.continueInertStatus = await page.locator('[role=status]').allInnerTexts();
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.goBack().catch(() => {});
      await page.getByRole('alertdialog').waitFor({ timeout: 4000 }).catch(() => { R.noLeaveDialog = true; });
      await page.waitForTimeout(200);
      await shot(page, '11-leave-dialog');
      R.leaveFocus = await active(page);
      R.leaveText = await page.getByRole('alertdialog').innerText().catch(() => null);
      R.leaveTab = await tabOrder(page, 3);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      R.afterEscape = { dialog: await page.getByRole('alertdialog').count(), focus: await active(page), url: page.url() };
      await page.getByLabel("I've saved these").check();
      await page.waitForTimeout(200);
      await shot(page, '12-ticked');
      R.ticked = await page.evaluate(() => [...document.querySelectorAll('[role=status]')].map((e) => e.textContent));
      R.tickedContinueDisabled = await page.getByRole('button', { name: 'Continue' }).getAttribute('aria-disabled');
      await page.evaluate(() => (document.documentElement.style.fontSize = '32px'));
      await page.waitForTimeout(200);
      await page.evaluate(() => window.scrollTo(0, 0));
      await shot(page, '13-text200-codes');
      R.text200 = await page.evaluate(() => { const o = document.querySelector('ol'); return { docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, ol: [o.scrollWidth, o.clientWidth, getComputedStyle(o).overflowX] }; });
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await shot(page, '13-text200-codes-bottom');
      await page.evaluate(() => (document.documentElement.style.fontSize = ''));
      await page.goBack().catch(() => {});
      await page.waitForTimeout(500);
      R.backTicked = { dialog: await page.getByRole('alertdialog').count(), url: page.url() };
      await c.close();
      reset();
    }

    // 5. mobile only: short viewport sticky footer, reduced motion, reload prompt
    if (size === 'm') {
      const c = await ctx({ viewport: { width: 375, height: 667 }, reducedMotion: 'reduce' });
      const page = await c.newPage();
      await authn(page);
      await page.goto('/setup');
      await fillAndSubmit(page);
      await page.getByRole('heading', { level: 1, name: 'Save your recovery codes' }).waitFor();
      await page.waitForTimeout(300);
      await shot(page, '14-short-top');
      await page.evaluate(() => window.scrollTo(0, 250));
      await page.waitForTimeout(200);
      await shot(page, '14-short-mid');
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(200);
      await shot(page, '14-short-bottom');
      R.sticky = await page.evaluate(() => {
        let e = document.querySelector('input[type=checkbox]');
        while (e && getComputedStyle(e).position !== 'sticky') e = e.parentElement;
        const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Continue').getBoundingClientRect();
        return { stickyEl: e ? e.tagName + ' bottom=' + getComputedStyle(e).bottom : null, continueBottom: btn.bottom, vh: innerHeight, docH: document.documentElement.scrollHeight };
      });
      await page.evaluate(() => window.scrollTo(0, 0));
      R.stickyAtTop = await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Continue').getBoundingClientRect(); return { top: b.top, bottom: b.bottom, vh: innerHeight }; });
      let prompted = false;
      page.on('dialog', async (d) => { prompted = d.type() === 'beforeunload'; await d.dismiss(); });
      await page.close({ runBeforeUnload: true });
      R.beforeunloadPrompted = prompted;
      await c.close();
      reset();
    }
    if (tag === 'm-light') {
      const c = await ctx({ reducedMotion: 'reduce' });
      const page = await c.newPage();
      await authn(page, { presence: false });
      await page.goto('/setup');
      await fillAndSubmit(page);
      await page.getByText('Follow the prompt on your device.').waitFor({ timeout: 8000 }).catch(() => {});
      R.spinnerReduced = await page.evaluate(() => [...document.querySelectorAll('button svg, button span')].map((e) => getComputedStyle(e).animationName + '/' + getComputedStyle(e).animationDuration));
      await c.close();
      reset();
    }
    console.error('done', tag);
  }
}
writeFileSync(join(OUT, 'measurements.json'), JSON.stringify(report, null, 2));
await browser.close();
