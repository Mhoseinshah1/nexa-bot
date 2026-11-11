/**
 * `pnpm web:token-fragment` — a one-time link's `#token=…` in the BUILT app, in a real browser.
 *
 * The unit tests hand the token to the page directly, which is how an early router rewrite of
 * the address (dropping the fragment at module load) went unseen. This opens `/activate#token=…`
 * and `/enter#token=…` on the production bundle with the production CSP and checks: the form (or
 * the redeem request) is reached, the fragment is gone from the address bar, and a reload says
 * the link was already opened rather than «ناقص». Exits 1 on any failure.
 *
 * Flags: --no-build (reuse apps/web/dist).
 */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { buildWeb, startServer } from './harness.mjs';

const require = createRequire(import.meta.url);
function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    return require(`${execSync('npm root -g').toString().trim()}/playwright`);
  }
}

const NO_TOKEN = [
  'این لینک ناقص است. لینک کامل فعال‌سازی را از مدیر سرور بگیرید.',
  'این پیوند ناقص است. از «میزبانی‌ها» دوباره «ورود به پنل» را بزنید.',
];
const USED = 'این لینک قبلاً باز شده است';
const TOKEN = 'nxact_browser_check_0123456789';

if (!process.argv.includes('--no-build')) buildWeb();
const { chromium } = loadPlaywright();
const server = await startServer({ signedOut: true });
const browser = await chromium.launch(
  process.env.NEXA_CHROMIUM ? { executablePath: process.env.NEXA_CHROMIUM } : {},
);
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

try {
  for (const path of ['/activate', '/enter']) {
    const page = await browser.newPage();
    server.resetUnfixtured();
    await page.goto(`http://127.0.0.1:${server.port}${path}#token=${TOKEN}`);
    await page.waitForSelector('main.screen');
    await page.waitForTimeout(400);
    let text = await page.locator('main').innerText();
    check(!NO_TOKEN.some((m) => text.includes(m)), `${path}#token: no «ناقص» banner`);
    if (path === '/activate') {
      check((await page.locator('form').count()) === 1, `${path}#token: the activation form shows`);
    } else {
      check(
        server.unfixtured().some((r) => r.startsWith('POST') && r.includes('enter')),
        `${path}#token: the token was redeemed (POST sent)`,
      );
    }
    const url = new URL(page.url());
    check(
      url.hash === '' && url.pathname === path,
      `${path}#token: no fragment in the address bar`,
    );
    const stored = await page.evaluate(
      () =>
        JSON.stringify(window.history.state) +
        JSON.stringify({ ...localStorage }) +
        JSON.stringify({ ...sessionStorage }),
    );
    check(!stored.includes(TOKEN), `${path}#token: the token is in no storage or history.state`);

    await page.reload();
    await page.waitForSelector('main.screen');
    await page.waitForTimeout(400);
    text = await page.locator('main').innerText();
    check(text.includes(USED), `${path} reload: says the link was already opened`);
    check(!NO_TOKEN.some((m) => text.includes(m)), `${path} reload: not «ناقص»`);
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log('token fragment: all checks passed.');
