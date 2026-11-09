#!/usr/bin/env node
/**
 * `pnpm web:print-shots` — SFR A4: the recovery page's Mirza dry-run report as the browser
 * PRINTS it (Save as PDF), in both themes, at A4 width (794 CSS px at 96 dpi).
 *
 * The owner's printout dropped the number column on the left (RTL) and showed only labels.
 * Each capture is refused unless every value of the report (`.kv dd`, table cells) lies inside
 * the printed page, and the sidebar and top bar are gone. The pictures go to OUT_DIR.
 *
 *   pnpm web:print-shots            build the web app, then capture
 *   pnpm web:print-shots --no-build use the existing apps/web/dist
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, buildWeb, launchChrome, openPage, startServer } from './harness.mjs';
import { needsTypeStripping } from './policy.mjs';

export const OUT_DIR = 'docs/web-redesign/print';

/** A4 portrait at 96 dpi: what Chrome lays a printed page out at. */
export const PRINT_VIEWS = [
  { width: 794, height: 1123, theme: 'dark', touch: false, media: 'print' },
  { width: 794, height: 1123, theme: 'light', touch: false, media: 'print' },
];

/**
 * Evaluated in the page: what of the report is outside the printed width, and whether the
 * chrome still shows. Pure DOM geometry; an empty `outside` is the pass.
 */
export const PRINT_GEOMETRY = `(() => {
  const width = document.documentElement.clientWidth;
  const values = [...document.querySelectorAll('.kv dd, td, th')].filter((el) => el.offsetParent !== null);
  const outside = values
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 0 && (r.left < -1 || r.right > width + 1))
    .map((r) => Math.round(r.left) + '..' + Math.round(r.right));
  const chrome = ['.sidebar', '.topbar'].filter((s) => {
    const el = document.querySelector(s);
    return el !== null && getComputedStyle(el).display !== 'none';
  });
  return { values: values.length, outside, chrome, width };
})()`;

/** The reasons a capture is refused; empty when it may be written. Unit-tested. */
export function printProblems({ values, outside, chrome }) {
  const problems = [];
  if (values === 0) problems.push('no report values drawn (is the dry-run report on the page?)');
  if (outside.length > 0)
    problems.push(`${outside.length} value(s) outside the page: ${outside.slice(0, 5).join(', ')}`);
  if (chrome.length > 0) problems.push(`chrome printed: ${chrome.join(', ')}`);
  return problems;
}

async function main() {
  const build = !process.argv.includes('--no-build');
  if (build) buildWeb();
  const out = join(ROOT, OUT_DIR);
  mkdirSync(out, { recursive: true });
  const server = await startServer({ fixtureSet: 'print-dry-run-report' });
  const chrome = await launchChrome();
  let failed = 0;
  try {
    const { SHOT_NOW } = await import(join(ROOT, 'tests/web/shots/index.ts'));
    for (const view of PRINT_VIEWS) {
      const page = await openPage(chrome.cdp, {
        url: `http://127.0.0.1:${server.port}/recovery`,
        ...view,
        collapsed: false,
        now: SHOT_NOW,
        timeoutMs: 15_000,
      });
      await page.settle();
      const geometry = await page.evaluate(PRINT_GEOMETRY);
      const problems = printProblems(geometry);
      const file = `recovery-dry-run-report.print-${view.theme}.jpg`;
      if (problems.length === 0) {
        const { data } = await page.send('Page.captureScreenshot', {
          format: 'jpeg',
          quality: 72,
          captureBeyondViewport: true,
        });
        writeFileSync(join(out, file), Buffer.from(data, 'base64'));
      } else {
        failed += 1;
      }
      console.log(
        `${problems.length === 0 ? 'ok  ' : 'FAIL'}  ${file}  values=${geometry.values} ${problems.join('; ')}`,
      );
      await page.close();
    }
  } finally {
    await chrome.close();
    await server.close();
  }
  if (failed > 0) process.exit(1);
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
