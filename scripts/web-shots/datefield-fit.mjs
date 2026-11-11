#!/usr/bin/env node
/**
 * `node scripts/web-shots/datefield-fit.mjs` (`pnpm web:datefield-fit`) — the Jalali date-time
 * picker inside the hosting dialogs («ساخت ربات», «تغییر انقضای ربات») in the BUILT app, in real
 * Chromium, at the screens of a laptop and a phone.
 *
 * For each viewport and each dialog it opens the picker and fails unless the whole popover — the
 * time steppers and «تأیید» included — lies inside the viewport; then it taps a day and checks the
 * field already shows it (apply at once), closes the picker with Escape and checks the value is
 * kept. Screenshots (device scale 2) go to `.shots-datefield/` (untracked). Exit 1 on a failure.
 *
 * The hosting API is answered here (a route per request) with a section session already open and
 * one hosted bot, so the page draws its panel. Needs Playwright with the Chromium of
 * `/opt/pw-browsers` (see `harness.mjs`); not part of `pnpm verify`. `--no-build` reuses dist.
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ROOT, buildWeb, startServer } from './harness.mjs';

const require = createRequire(import.meta.url);
function loadPlaywright() {
  for (const base of [ROOT, '/opt/node-tools/node_modules', process.env.NEXA_PLAYWRIGHT ?? ROOT]) {
    try {
      return require(require.resolve('playwright', { paths: [base] }));
    } catch {
      // try the next place
    }
  }
  throw new Error('playwright is not installed (set NEXA_PLAYWRIGHT to its node_modules).');
}

const build = !process.argv.includes('--no-build');
const out = join(ROOT, '.shots-datefield');
const VIEWPORTS = [
  [1920, 940],
  [1536, 730],
  [1366, 650],
  [1280, 600],
  [390, 844],
];

const SOON = new Date(Date.now() + 40 * 86_400_000).toISOString();
const BOT = {
  tenantId: 'tenant-1',
  slug: 'demo-bot',
  displayName: 'ربات نمونه',
  state: 'ACTIVE',
  tenantStatus: 'ACTIVE',
  expiresAt: SOON,
  createdAt: '2026-01-01T00:00:00.000Z',
  stateChangedAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
  purgedAt: null,
  customerCount: 3,
  webAdmin: { username: 'demo' },
  telegramBot: null,
  lastBackupAt: null,
  resources: [],
};
const hostingAnswers = (pathname) => {
  if (pathname.endsWith('/hosting/status'))
    return {
      factor: 'ACTIVE',
      recoveryCodesRemaining: 8,
      session: { expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
      lockedUntil: null,
      create: { enabled: true, refusal: null },
    };
  if (pathname.endsWith('/hosting/bots'))
    return { bots: [BOT], create: { enabled: true, refusal: null } };
  return null;
};

if (build) buildWeb();
mkdirSync(out, { recursive: true });
const server = await startServer({});
const { chromium } = loadPlaywright();
const browser = await chromium.launch();
const failures = [];
const report = (ok, label, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(label);
};

try {
  for (const [width, height] of VIEWPORTS) {
    for (const dialog of ['create', 'expiry']) {
      const label = `${width}x${height} ${dialog}`;
      const context = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: 2,
        locale: 'fa-IR',
        colorScheme: 'dark',
        ...(width < 500 ? { hasTouch: true, isMobile: true } : {}),
      });
      await context.addInitScript(() => {
        try {
          localStorage.setItem('nexa.theme', 'dark');
          localStorage.setItem('nexa.sidebar', 'collapsed');
        } catch {
          // storage unavailable
        }
      });
      const page = await context.newPage();
      await page.route('**/api/admin/v1/hosting/**', async (route) => {
        const body = hostingAnswers(new URL(route.request().url()).pathname);
        if (body === null) return route.fulfill({ status: 404, body: '{}' });
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(body),
        });
      });
      try {
        await page.goto(`http://127.0.0.1:${server.port}/hosting`);
        if (dialog === 'create') {
          await page.locator('.hosting-section-head button').first().click();
        } else {
          await page.locator('.hosting-bot button', { hasText: 'انقضا' }).first().click();
        }
        const modal = page.locator('[role="dialog"]').first();
        await modal.waitFor();
        const trigger = modal.locator('[data-date-field="datetime"]');
        await trigger.scrollIntoViewIfNeeded();
        const before = (await trigger.innerText()).trim();
        await trigger.click();
        const pop = page.locator('.date-pop');
        await pop.waitFor();
        await page.waitForTimeout(250);

        const inside = async (selector) => {
          const box = await page.locator(selector).first().boundingBox();
          if (box === null) return `${selector}: not drawn`;
          const slack = 0.5;
          const ok =
            box.x >= -slack &&
            box.y >= -slack &&
            box.x + box.width <= width + slack &&
            box.y + box.height <= height + slack;
          return ok
            ? null
            : `${selector} at ${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)} leaves ${width}x${height}`;
        };
        const problems = (
          await Promise.all(
            ['.date-pop', '.date-pop-time', '.date-pop-tin', '.date-pop-ok'].map(inside),
          )
        ).filter((problem) => problem !== null);
        report(
          problems.length === 0,
          `${label}: popover and «تأیید» inside the viewport`,
          problems.join('; '),
        );
        await page.screenshot({ path: join(out, `${width}x${height}-${dialog}-open.png`) });

        // The footer button must also be clickable where it is (not covered).
        const okClickable = await page.evaluate(() => {
          const ok = document.querySelector('.date-pop-ok');
          if (!ok) return false;
          const r = ok.getBoundingClientRect();
          const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return hit === ok || ok.contains(hit);
        });
        report(okClickable, `${label}: «تأیید» is the element under its own centre`);

        // A day other than the one already chosen, in this month.
        const target = pop.locator('.date-pop-d:not(.sel):not([aria-disabled="true"])').nth(10);
        await target.click();
        await page.waitForTimeout(100);
        const applied = (await trigger.innerText()).trim();
        report(
          applied !== before && (await trigger.locator('.date-field-val').count()) === 1,
          `${label}: a tapped day is applied to the field at once`,
          `${before} → ${applied}`,
        );
        report((await pop.count()) === 1, `${label}: the popover stays open after the tap`);
        await page.screenshot({ path: join(out, `${width}x${height}-${dialog}-picked.png`) });
        await page.keyboard.press('Escape');
        await page.waitForTimeout(150);
        const kept = (await trigger.innerText()).trim();
        report(
          (await page.locator('.date-pop').count()) === 0 && kept === applied,
          `${label}: Escape closes the picker and the value is kept`,
          kept,
        );
      } catch (error) {
        report(
          false,
          `${label}: the script could not drive the page`,
          String(error).split('\n')[0],
        );
        try {
          await page.screenshot({ path: join(out, `${width}x${height}-${dialog}-error.png`) });
        } catch {
          // no page to shoot
        }
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed. Screenshots: ${out}`);
  process.exit(1);
}
console.log(`\nall date-time picker checks passed. Screenshots: ${out}`);
