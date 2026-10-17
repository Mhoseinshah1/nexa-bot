#!/usr/bin/env node
/**
 * `pnpm web:pr-shots` — the Web Admin screenshots committed with the demo implementation
 * (`docs/web-redesign/demo-implementation/*.jpg`, listed in its README).
 *
 * Each shot opens the production build against the fixture API (the same harness, CSP and
 * frozen clock as `pnpm web:sweep`), performs the clicks it names (a filter panel opened, a
 * date field unfolded), and writes a JPEG. A shot is REFUSED — the script exits non-zero and
 * names it — when the sweep's checks find anything on it: an error card, a danger banner, a
 * skeleton, an unfixtured request, a console error, an English sentence, a sideways overflow
 * at 390, or a click whose target was not there. A committed picture of an error card,
 * reported as the page, is what this replaces.
 *
 *   pnpm web:pr-shots               build, then every shot
 *   pnpm web:pr-shots --no-build incident users
 *
 * Needs a Chromium binary, like the other drivers here; not part of `pnpm verify` or CI.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, buildWeb, delay, launchChrome, openPage, startServer } from './harness.mjs';
import { needsTypeStripping } from './policy.mjs';
import { ENGLISH, OVERFLOW, STATES, sweepProblems } from './sweep.mjs';

const ID = '01a05e35-c9ad-7e93-bef3-1ed9b55292c8';

export const OUT_DIR = 'docs/web-redesign/demo-implementation';

const DARK = { width: 1440, height: 900, theme: 'dark', touch: false };
const LIGHT = { width: 1440, height: 900, theme: 'light', touch: false };
const PHONE = { width: 390, height: 844, theme: 'dark', touch: true };

/** Clicks the first page button whose text starts with `text`; false when there is none. */
const clickButton = (text) =>
  `(() => { const b = [...document.querySelectorAll('#main button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(text)})); if (!b) return false; b.scrollIntoView({ block: 'center' }); b.click(); return true; })()`;

/** Clicks the first element matching `selector`; false when there is none. */
const clickSelector = (selector) =>
  `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`;

/**
 * Every committed shot: its file stem, route, views and clicks. The README's table names
 * these stems; a unit test holds the two together.
 */
export const PR_SHOTS = [
  { name: 'users', route: '/users', views: [DARK, LIGHT, PHONE] },
  {
    name: 'users-filters',
    route: '/users',
    views: [DARK, PHONE],
    clicks: [clickButton('فیلترها')],
  },
  { name: 'customer-360', route: `/users/${ID}`, views: [DARK, PHONE] },
  { name: 'service', route: `/services/${ID}`, views: [DARK, LIGHT, PHONE] },
  { name: 'order', route: `/orders/${ID}`, views: [DARK] },
  { name: 'payments', route: '/payments', views: [DARK, PHONE] },
  { name: 'payment', route: `/payments/${ID}`, views: [DARK] },
  { name: 'bulk-new-audience', route: '/bulk-operations/new', views: [DARK, PHONE] },
  { name: 'campaign-new-tabs', route: '/campaigns/new', views: [DARK] },
  { name: 'bot-buttons', route: '/bot-buttons', views: [DARK] },
  { name: 'settings-tabs', route: '/settings', views: [DARK, LIGHT] },
  { name: 'tickets', route: '/tickets', views: [DARK] },
  { name: 'incident', route: `/incidents/${ID}`, views: [DARK] },
  { name: 'product', route: `/products/${ID}`, views: [DARK] },
  {
    name: 'audit-log-datefield',
    route: '/audit-log',
    views: [DARK],
    clicks: [clickButton('فیلترها'), clickSelector('[data-date-field]')],
  },
  { name: 'system', route: '/system', views: [DARK, LIGHT] },
  { name: 'discounts', route: '/discounts', views: [DARK, PHONE] },
];

/** `incident.1440-dark.jpg`, `users.390-dark.jpg`. Unit-tested. */
export function shotFile(name, view) {
  return `${name}.${view.width < 900 ? '390' : '1440'}-${view.theme}.jpg`;
}

async function main() {
  const argv = process.argv.slice(2);
  const build = !argv.includes('--no-build');
  const only = argv.filter((arg) => !arg.startsWith('--'));
  const unknown = only.filter((name) => !PR_SHOTS.some((shot) => shot.name === name));
  if (unknown.length > 0) throw new Error(`unknown shot: ${unknown.join(', ')}`);
  if (build) buildWeb();
  const shots = only.length > 0 ? PR_SHOTS.filter((shot) => only.includes(shot.name)) : PR_SHOTS;
  const out = join(ROOT, OUT_DIR);
  mkdirSync(out, { recursive: true });
  const server = await startServer();
  const chrome = await launchChrome();
  const refused = [];
  try {
    const { SHOT_NOW } = await import(join(ROOT, 'tests/web/shots/index.ts'));
    for (const shot of shots) {
      for (const view of shot.views) {
        server.resetUnfixtured();
        const page = await openPage(chrome.cdp, {
          url: `http://127.0.0.1:${server.port}${shot.route}`,
          ...view,
          collapsed: view.width < 900,
          now: SHOT_NOW,
          timeoutMs: 15_000,
        });
        let settled = await page.settle();
        const missed = [];
        for (const [index, click] of (shot.clicks ?? []).entries()) {
          if ((await page.evaluate(click)) !== true)
            missed.push(`click ${index + 1} found nothing`);
          await delay(500);
          settled = (await page.settle()) && settled;
        }
        const problems = [
          ...missed,
          ...sweepProblems({
            route: shot.route,
            settled,
            errors: [...page.errors],
            english: await page.evaluate(ENGLISH),
            overflow: view.width < 900 ? Math.max(0, await page.evaluate(OVERFLOW)) : 0,
            ...(await page.evaluate(STATES)),
            unfixtured: server.unfixtured(),
          }),
        ];
        const file = shotFile(shot.name, view);
        if (problems.length === 0) {
          const { data } = await page.send('Page.captureScreenshot', {
            format: 'jpeg',
            quality: 72,
          });
          writeFileSync(join(out, file), Buffer.from(data, 'base64'));
        } else {
          refused.push(file);
        }
        console.log(`${problems.length === 0 ? 'ok  ' : 'FAIL'}  ${file}  ${problems.join('; ')}`);
        await page.close();
      }
    }
  } finally {
    await chrome.close();
    await server.close();
  }
  if (refused.length > 0) {
    console.log(`\n${refused.length} shots refused (not written): ${refused.join(', ')}`);
    process.exit(1);
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  if (needsTypeStripping(process.features)) {
    const again = spawnSync(
      process.execPath,
      [
        ...process.execArgv,
        '--experimental-strip-types',
        fileURLToPath(import.meta.url),
        ...process.argv.slice(2),
      ],
      { stdio: 'inherit' },
    );
    process.exit(again.status ?? 1);
  } else {
    main().catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
  }
}
