#!/usr/bin/env node
/**
 * `pnpm web:no-scroll` — no button may scroll the page to another section (W2).
 *
 * The approved Web Admin moved every "jump to section" button to a tab or a drawer. This
 * check holds the rule in a real browser: for EVERY route the app serves (`ROUTE_PATTERNS`,
 * with the fixture ids the other drivers use), it opens the production build against the
 * fixture API, and for every enabled button inside the page content it scrolls the content
 * to the button (centred, as an operator scrolls to it), clicks it, and measures the content's and the window's scroll offset.
 * A click that moves either by more than a few pixels while the route stays the same is a
 * jump, and is reported by route and button text. A click that navigates (a link styled as a
 * button) is not a jump: the next route starts at its own top.
 *
 * After each click the page is put back: Escape closes a dialog, drawer, menu or filter
 * panel; if anything modal is still open, or the route changed, the route is opened again.
 * Buttons inside dialogs are not clicked — a confirm button commits; this check is about
 * the page.
 *
 *   pnpm web:no-scroll                    every route, 1440×900, dark
 *   pnpm web:no-scroll /users /services/x  some routes
 *   pnpm web:no-scroll --no-build --width 390
 *
 * Exit status 1 when a jump was found. Not part of `pnpm verify` or CI: it needs a Chromium
 * binary, like `pnpm web:shots` and `pnpm web:responsive`.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, buildWeb, delay, launchChrome, openPage, startServer } from './harness.mjs';
import { needsTypeStripping } from './policy.mjs';

const ID = '01a05e35-c9ad-7e93-bef3-1ed9b55292c8';

/** Pixels a click may move the page by without counting as a jump (sub-pixel layout, focus rings). */
export const JUMP_TOLERANCE_PX = 4;

/** Every route the app serves (`ROUTE_PATTERNS` in `app.tsx`), with the fixture ids. */
export function allRoutes() {
  const app = readFileSync(join(ROOT, 'apps/web/src/app.tsx'), 'utf8');
  const block = /export const ROUTE_PATTERNS[^=]*=\s*\[([\s\S]*?)\];/.exec(app);
  if (block === null) throw new Error('ROUTE_PATTERNS not found in apps/web/src/app.tsx');
  return [...block[1].matchAll(/'(\/[^']*)'/g)].map((m) =>
    m[1].replace(':id', ID).replace(':provider', 'tonpays'),
  );
}

/**
 * Whether a click moved the page: the same route, and either scroll offset moved by more than
 * the tolerance. Exported so the decision is unit-tested without a browser.
 */
export function isJump(before, after, tolerance = JUMP_TOLERANCE_PX) {
  if (before.route !== after.route) return false;
  /*
   * A click that made the page SHORTER (a shorter tab, a removed row, a last page with fewer
   * rows) leaves the browser no choice but to clamp the offset to the new end: an upward move
   * that lands exactly on the new maximum is that clamp, not a jump to another section.
   */
  const clamped = (was, now, max) => max !== undefined && now < was && now >= max - tolerance;
  const content =
    Math.abs(after.content - before.content) > tolerance &&
    !clamped(before.content, after.content, after.contentMax);
  const windowMoved =
    Math.abs(after.window - before.window) > tolerance &&
    !clamped(before.window, after.window, after.windowMax);
  return content || windowMoved;
}

/*
 * The page's own buttons: inside the content, visible, enabled, not inside a dialog. The kit
 * pager's «قبلی / بعدی» are left out: they REPLACE the list they sit under, and while the next
 * page loads the list is briefly shorter, so the view lands at that list's start — the same
 * list, not another section of the page.
 */
const BUTTONS = `[...document.querySelectorAll('#main button')].filter((b) =>
  !b.disabled && !b.closest('[role=dialog], .modal-layer, .drawer-layer, [aria-modal=true], .menu, .pager') &&
  b.getClientRects().length > 0)`;

const POSITION = `(() => ({
  route: location.pathname + location.search + location.hash,
  content: document.querySelector('#main')?.scrollTop ?? 0,
  contentMax: (() => { const m = document.querySelector('#main'); return m ? m.scrollHeight - m.clientHeight : 0; })(),
  window: window.scrollY,
  windowMax: document.documentElement.scrollHeight - window.innerHeight,
}))()`;

// The items of a menu a button opened (the kit's `Menu`), inside the page content.
const MENU_ITEMS = `[...document.querySelectorAll('#main .menu button, #main .menu a')].filter((b) =>
  !b.disabled && b.getClientRects().length > 0)`;

const MODAL_OPEN = `!!document.querySelector('[role=dialog], .modal-layer, .drawer-layer, [aria-modal=true]')`;

function parseArgs(argv) {
  const options = { routes: [], width: 1440, height: 900, theme: 'dark', build: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--no-build') options.build = false;
    else if (arg === '--width') options.width = Number(argv[(i += 1)]);
    else if (arg === '--height') options.height = Number(argv[(i += 1)]);
    else if (arg === '--theme') options.theme = argv[(i += 1)];
    else if (arg.startsWith('/')) options.routes.push(arg);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  if (needsTypeStripping(process.features)) {
    // Node 22.11–22.17: the fixtures are TypeScript; run again with stripping on (as shots.mjs).
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
  }
  const options = parseArgs(process.argv.slice(2));
  if (options.build) buildWeb();
  const routes = options.routes.length > 0 ? options.routes : allRoutes();
  const server = await startServer();
  const chrome = await launchChrome();
  const jumps = [];
  let clicked = 0;
  try {
    const { SHOT_NOW } = await import(join(ROOT, 'tests/web/shots/index.ts'));
    for (const route of routes) {
      const open = async () => {
        const page = await openPage(chrome.cdp, {
          url: `http://127.0.0.1:${server.port}${route}`,
          width: options.width,
          height: options.height,
          theme: options.theme,
          collapsed: false,
          now: SHOT_NOW,
          timeoutMs: 15_000,
        });
        await page.settle();
        return page;
      };
      let page = await open();
      const escape = async () => {
        for (const type of ['keyDown', 'keyUp'])
          await page.send('Input.dispatchKeyEvent', {
            type,
            key: 'Escape',
            code: 'Escape',
            windowsVirtualKeyCode: 27,
          });
        await delay(100);
      };
      /*
       * One attempt: with button `index` brought into view the way an operator reaches it
       * (centred, from the top of the route), click it and, when `item` is
       * given, then item `item` of the menu that click opened (a «jump to section» menu is
       * the classic offender, so menu items are clicked too). Returns the label, or null
       * when the button or item is not there.
       */
      const attempt = async (index, item) => {
        await page.evaluate(
          `(() => { const m = document.querySelector('#main'); if (m) m.scrollTop = 0; window.scrollTo(0, 0);
            const b = ${BUTTONS}[${index}]; if (b) b.scrollIntoView({ block: 'center' }); })()`,
        );
        await delay(50);
        const before = await page.evaluate(POSITION);
        let label = await page.evaluate(
          `(() => { const b = ${BUTTONS}[${index}]; if (!b) return null; b.click(); return (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 60); })()`,
        );
        if (label !== null && item !== undefined) {
          await delay(150);
          const inner = await page.evaluate(
            `(() => { const b = ${MENU_ITEMS}[${item}]; if (!b) return null; b.click(); return (b.textContent || '').trim().slice(0, 60); })()`,
          );
          label = inner === null ? null : `${label} › ${inner}`;
        }
        if (label === null) return { label: null, items: 0 };
        clicked += 1;
        await delay(350);
        const after = await page.evaluate(POSITION);
        if (isJump(before, after)) jumps.push({ route, button: label, before, after });
        const items = item === undefined ? await page.evaluate(`${MENU_ITEMS}.length`) : 0;
        await escape();
        const now = await page.evaluate(POSITION);
        if (now.route !== before.route || (await page.evaluate(MODAL_OPEN))) {
          await page.close();
          page = await open();
        }
        return { label, items };
      };
      const count = await page.evaluate(`${BUTTONS}.length`);
      for (let index = 0; index < count; index += 1) {
        const { items } = await attempt(index);
        for (let item = 0; item < items; item += 1) await attempt(index, item);
      }
      await page.close();
      console.log(`${route}: ${count} buttons`);
    }
  } finally {
    await chrome.close();
    await server.close();
  }
  const out = join(ROOT, '.web-shots');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'no-scroll.json'), JSON.stringify({ clicked, jumps }, null, 2));
  console.log(`\n${clicked} buttons clicked on ${routes.length} routes; ${jumps.length} jumps.`);
  for (const jump of jumps)
    console.log(
      `JUMP  ${jump.route}  «${jump.button}»  ${JSON.stringify(jump.before)} → ${JSON.stringify(jump.after)}`,
    );
  process.exit(jumps.length > 0 ? 1 : 0);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
