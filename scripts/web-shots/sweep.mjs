#!/usr/bin/env node
/**
 * `pnpm web:sweep` — the release sweep of the Web Admin over EVERY route.
 *
 * For every route the app serves (`ROUTE_PATTERNS`, fixture ids as the other drivers use)
 * and three views — 1440×900 dark, 1440×900 light, 390×844 dark on a touch device — it opens
 * the production build against the fixture API and reports:
 *
 * - console errors and uncaught exceptions;
 * - horizontal overflow at 390px (the page, or the content scroller, wider than the screen);
 * - English SENTENCES visible to the operator: three or more Latin words in a row in a text
 *   node that is not a technical value (`dir="ltr"`, `.ltr`, `code`, `.mono`, `kbd`, inputs);
 * - an error card (`Empty variant="error"`, drawn as `.empty.error`) or a danger banner
 *   (`Banner tone="danger"`, drawn as `.banner.danger`) visible on screen — unless the route
 *   is meant to show that banner (`ALLOWED_DANGER_BANNERS`, each with its reason);
 * - a skeleton still on screen, or a network that never went quiet;
 * - every API request no fixture answered, by route — the page then draws an error card or
 *   an empty state instead of the screen, and a picture of that is not a picture of the page.
 *
 * With `--shots`, a PNG of each view goes to `.web-shots/sweep/` (git-ignored).
 *
 *   pnpm web:sweep                 every route, three views
 *   pnpm web:sweep /users --shots  one route, with pictures
 *   pnpm web:sweep --no-build --view 390-dark
 *
 * Exit status 1 when ANY view has a problem (`sweepProblems`). Not part of `pnpm verify` or
 * CI: it needs a Chromium binary (`pnpm verify:web-browser` runs it with the no-scroll check).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, buildWeb, launchChrome, openPage, startServer } from './harness.mjs';
import { needsTypeStripping } from './policy.mjs';
import { allRoutes } from './no-scroll.mjs';

export const VIEWS = [
  { name: '1440-dark', width: 1440, height: 900, theme: 'dark', touch: false },
  { name: '1440-light', width: 1440, height: 900, theme: 'light', touch: false },
  { name: '390-dark', width: 390, height: 844, theme: 'dark', touch: true },
];

/** Three or more Latin words in a row: a sentence, not an identifier. */
export const ENGLISH_SENTENCE = /[A-Za-z]{2,}[,.:']?(?:\s+[A-Za-z]{2,}[,.:']?){2,}/;

/** Whether a visible text run reads as an English sentence. Unit-tested. */
export function isEnglishSentence(text) {
  return ENGLISH_SENTENCE.test(text);
}

const ENGLISH = `(() => {
  const found = [];
  const skip = (el) => el.closest('[dir=ltr], .ltr, code, .mono, kbd, pre, script, style, svg, input, textarea, select, [aria-hidden=true]');
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent.trim();
    if (!text || !node.parentElement || skip(node.parentElement)) continue;
    if (node.parentElement.getClientRects().length === 0) continue;
    if (${ENGLISH_SENTENCE}.test(text)) found.push(text.slice(0, 120));
  }
  return [...new Set(found)];
})()`;

const OVERFLOW = `(() => {
  const doc = document.documentElement.scrollWidth - innerWidth;
  const main = document.querySelector('#main');
  const inner = main ? main.scrollWidth - main.clientWidth : 0;
  return Math.max(doc, inner);
})()`;

/*
 * What is drawn on screen that says the page is not showing its content. Only VISIBLE
 * elements count: a card inside a closed tab or a collapsed disclosure is not on screen.
 * The kit draws the error card as `.empty.error` and a danger banner as `.banner.danger`.
 */
export const STATES = `(() => {
  const visible = (el) => el.getClientRects().length > 0;
  const text = (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
  const all = (selector) => [...document.querySelectorAll(selector)].filter(visible);
  return {
    skeletons: all('.skel').length,
    errorCards: all('.empty.error').map(text),
    dangerBanners: all('.banner.danger').map(text),
  };
})()`;

/**
 * Danger banners a route is MEANT to show in its fixture state, by route and a text the
 * banner contains, each with the reason. A banner here is page content (a recorded failure
 * the screen exists to show), not the page failing to load. Anything not listed fails.
 *
 * @type {readonly { route: string; contains: string; reason: string }[]}
 */
export const ALLOWED_DANGER_BANNERS = [];

/** Whether a visible danger banner on `route` is one the route is meant to show. */
export function isAllowedDangerBanner(route, text, allowed = ALLOWED_DANGER_BANNERS) {
  return allowed.some((entry) => entry.route === route && text.includes(entry.contains));
}

/**
 * Everything about one view that stops the sweep certifying it, as lines; empty is `ok`.
 * Unit-tested: each problem alone fails a view.
 *
 * @param {{
 *   route: string;
 *   settled: boolean;
 *   errors: readonly string[];
 *   english: readonly string[];
 *   overflow: number;
 *   skeletons: number;
 *   errorCards: readonly string[];
 *   dangerBanners: readonly string[];
 *   unfixtured: readonly string[];
 * }} entry
 * @returns {string[]}
 */
export function sweepProblems(entry, allowed = ALLOWED_DANGER_BANNERS) {
  const banners = entry.dangerBanners.filter(
    (text) => !isAllowedDangerBanner(entry.route, text, allowed),
  );
  return [
    entry.errors.length > 0 && `${entry.errors.length} console errors`,
    entry.english.length > 0 && `English: ${entry.english.slice(0, 3).join(' | ')}`,
    entry.overflow > 1 && `overflow ${entry.overflow}px`,
    entry.errorCards.length > 0 && `error card: ${entry.errorCards.slice(0, 2).join(' | ')}`,
    banners.length > 0 && `danger banner: ${banners.slice(0, 2).join(' | ')}`,
    entry.skeletons > 0 && `${entry.skeletons} skeletons`,
    entry.unfixtured.length > 0 && `unfixtured: ${entry.unfixtured.join(', ')}`,
    !entry.settled && 'not settled',
  ].filter((line) => typeof line === 'string');
}

function parseArgs(argv) {
  /** @type {{ routes: string[]; build: boolean; shots: boolean; views: string[] }} */
  const options = { routes: [], build: true, shots: false, views: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--no-build') options.build = false;
    else if (arg === '--view') options.views.push(argv[(i += 1)]);
    else if (arg === '--shots') options.shots = true;
    else if (arg.startsWith('/')) options.routes.push(arg);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.build) buildWeb();
  const routes = options.routes.length > 0 ? options.routes : allRoutes();
  const views =
    options.views.length > 0 ? VIEWS.filter((view) => options.views.includes(view.name)) : VIEWS;
  if (options.views.length > 0 && views.length !== new Set(options.views).size)
    throw new Error(`unknown --view; one of ${VIEWS.map((view) => view.name).join(', ')}`);
  const server = await startServer();
  const chrome = await launchChrome();
  const report = [];
  const out = join(ROOT, '.web-shots', 'sweep');
  mkdirSync(out, { recursive: true });
  try {
    const { SHOT_NOW } = await import(join(ROOT, 'tests/web/shots/index.ts'));
    for (const route of routes) {
      for (const view of views) {
        server.resetUnfixtured();
        const page = await openPage(chrome.cdp, {
          url: `http://127.0.0.1:${server.port}${route}`,
          width: view.width,
          height: view.height,
          theme: view.theme,
          touch: view.touch,
          collapsed: view.width < 900,
          now: SHOT_NOW,
          timeoutMs: 15_000,
        });
        const settled = await page.settle();
        const english = await page.evaluate(ENGLISH);
        const overflow = view.width < 900 ? await page.evaluate(OVERFLOW) : 0;
        const states = await page.evaluate(STATES);
        if (options.shots) {
          const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
          const file = `${route.replace(/[^a-z0-9]+/gi, '_') || 'root'}.${view.name}.png`;
          writeFileSync(join(out, file), Buffer.from(data, 'base64'));
        }
        const entry = {
          route,
          view: view.name,
          settled,
          errors: [...page.errors],
          english,
          overflow: overflow > 1 ? overflow : 0,
          ...states,
          unfixtured: server.unfixtured(),
        };
        await page.close();
        const problems = sweepProblems(entry);
        report.push({ ...entry, problems });
        console.log(
          `${problems.length === 0 ? 'ok  ' : 'FAIL'}  ${view.name}  ${route}  ${problems.join('; ')}`,
        );
      }
    }
  } finally {
    await chrome.close();
    await server.close();
  }
  writeFileSync(join(out, 'report.json'), JSON.stringify({ report }, null, 2));
  const failed = report.filter((e) => e.problems.length > 0);
  console.log(
    `\n${report.length} views, ${failed.length} with problems; report in .web-shots/sweep/report.json`,
  );
  process.exit(failed.length > 0 ? 1 : 0);
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
