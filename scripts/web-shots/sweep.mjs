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
 * - an error card or skeleton still on screen.
 *
 * With `--shots`, a PNG of each view goes to `.web-shots/sweep/` (git-ignored).
 *
 *   pnpm web:sweep                 every route, three views
 *   pnpm web:sweep /users --shots  one route, with pictures
 *
 * Exit status 1 when a console error, an overflow at 390 or an English sentence was found.
 * Not part of `pnpm verify` or CI: it needs a Chromium binary.
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

const STUCK = `document.querySelectorAll('.skel, .error-state').length`;

function parseArgs(argv) {
  const options = { routes: [], build: true, shots: false };
  for (const arg of argv) {
    if (arg === '--no-build') options.build = false;
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
  const server = await startServer();
  const chrome = await launchChrome();
  const report = [];
  const out = join(ROOT, '.web-shots', 'sweep');
  mkdirSync(out, { recursive: true });
  try {
    const { SHOT_NOW } = await import(join(ROOT, 'tests/web/shots/index.ts'));
    for (const route of routes) {
      for (const view of VIEWS) {
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
        const stuck = await page.evaluate(STUCK);
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
          stuck,
        };
        report.push(entry);
        await page.close();
        const problems = [
          entry.errors.length > 0 && `${entry.errors.length} console errors`,
          entry.english.length > 0 && `English: ${entry.english.slice(0, 3).join(' | ')}`,
          entry.overflow > 0 && `overflow ${entry.overflow}px`,
          entry.stuck > 0 && `${entry.stuck} skeleton/error cards`,
          !settled && 'not settled',
        ].filter(Boolean);
        console.log(
          `${problems.length === 0 ? 'ok  ' : 'FAIL'}  ${view.name}  ${route}  ${problems.join('; ')}`,
        );
      }
    }
  } finally {
    await chrome.close();
    await server.close();
  }
  writeFileSync(
    join(out, 'report.json'),
    JSON.stringify({ unfixtured: server.unfixtured(), report }, null, 2),
  );
  const failed = report.filter(
    (e) => e.errors.length > 0 || e.english.length > 0 || e.overflow > 0,
  );
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
