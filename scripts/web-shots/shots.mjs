#!/usr/bin/env node
/**
 * `pnpm web:shots` — screenshots of the REAL production build of the Web Admin
 * against controlled fixtures.
 *
 *   pnpm web:shots                              the default set, dark and light
 *   pnpm web:shots /users /panels/x --theme dark
 *   pnpm web:shots /settings --width 900 --collapsed
 *   pnpm web:shots / --full --no-build --out /tmp/shots
 *   pnpm web:shots /panels/<id> --click '[role=tab]:nth-child(3)'   a state reached by clicking
 *   pnpm web:shots / --signed-out                  the sign-in screen (the session answers 401)
 *
 * What it does, and why each part is there:
 *
 * - builds `apps/web` (and its workspace dependencies) unless `--no-build`, and
 *   serves `apps/web/dist` — the bytes a release publishes — with the SPA
 *   fallback and the PRODUCTION Content-Security-Policy read from
 *   `deploy/caddy/routes.caddy`, so a `style` attribute that the deployment
 *   would drop is dropped here too;
 * - answers `/api/admin/v1/*` and `/health/info` from the fixture registry in
 *   `tests/web/shots/` (every body schema-validated by the web suite), and
 *   answers anything unfixtured with a 404 that the report NAMES — a page agent
 *   adds the missing fixture rather than photographing an error card;
 * - drives Chromium from `/opt/pw-browsers` over the DevTools protocol, with the
 *   clock frozen at `SHOT_NOW`, animations reduced, and the theme and sidebar
 *   state set through the same storage keys the app reads;
 * - waits for the network to go quiet and every skeleton to go, then captures;
 * - reports per shot: unfixtured requests, console errors, a skeleton or an
 *   error state still on screen, and horizontal overflow of the page.
 *
 * PNGs and `report.json` go to `.web-shots/` (git-ignored) unless `--out`.
 * Not part of `pnpm verify` or CI: it needs a Chromium binary.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, buildWeb, delay, launchChrome, openPage, startServer } from './harness.mjs';
import { needsTypeStripping, shotProblems } from './policy.mjs';

/** The default set: one of each page type, the shell states the brief names. */
const DEFAULT_ROUTES = ['/', '/users', '/panels/01a05e35-c9ad-7e93-bef3-1ed9b55292c8', '/settings'];

function parseArgs(argv) {
  const options = {
    routes: [],
    themes: ['dark', 'light'],
    width: 1440,
    height: 900,
    collapsed: false,
    full: false,
    build: true,
    out: join(ROOT, '.web-shots'),
    timeoutMs: 15_000,
    clicks: [],
    signedOut: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      i += 1;
      if (argv[i] === undefined) throw new Error(`${arg} needs a value`);
      return argv[i];
    };
    if (arg === '--theme') {
      const theme = value();
      options.themes = theme === 'both' ? ['dark', 'light'] : [theme];
    } else if (arg === '--width') options.width = Number(value());
    else if (arg === '--height') options.height = Number(value());
    else if (arg === '--collapsed') options.collapsed = true;
    else if (arg === '--full') options.full = true;
    else if (arg === '--no-build') options.build = false;
    else if (arg === '--out') options.out = resolve(value());
    else if (arg === '--timeout') options.timeoutMs = Number(value());
    else if (arg === '--click') options.clicks.push(value());
    else if (arg === '--signed-out') options.signedOut = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
      process.exit(0);
    } else if (arg.startsWith('/')) options.routes.push(arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.routes.length === 0) options.routes = DEFAULT_ROUTES;
  for (const theme of options.themes) {
    if (theme !== 'dark' && theme !== 'light') throw new Error(`--theme is dark, light or both`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.build) buildWeb();
  const server = await startServer({ signedOut: options.signedOut });
  const chrome = await launchChrome();
  const { cdp } = chrome;

  mkdirSync(options.out, { recursive: true });
  const report = [];

  try {
    for (const route of options.routes) {
      for (const theme of options.themes) {
        server.resetUnfixtured();
        const name = shotName(route, theme, options);
        const result = await shoot(cdp, {
          url: `http://127.0.0.1:${server.port}${route}`,
          theme,
          width: options.width,
          height: options.height,
          collapsed: options.collapsed,
          full: options.full,
          now: server.now,
          timeoutMs: options.timeoutMs,
          clicks: options.clicks,
          file: join(options.out, `${name}.png`),
        });
        const entry = {
          route,
          theme,
          file: join(options.out, `${name}.png`),
          unfixtured: server.unfixtured(),
          ...result,
        };
        report.push(entry);
        const problems = shotProblems({ ...entry, timeoutMs: options.timeoutMs });
        console.log(
          `${problems.length === 0 ? 'ok  ' : 'WARN'} ${entry.file}${problems.length ? `\n     ${problems.join('\n     ')}` : ''}`,
        );
      }
    }
  } finally {
    writeFileSync(join(options.out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    server.close();
    await chrome.close();
  }
}

function shotName(route, theme, options) {
  const slug =
    route === '/'
      ? 'dashboard'
      : route
          .replace(/^\//, '')
          .replace(/[^a-zA-Z0-9]+/g, '-')
          .slice(0, 60);
  return [
    slug,
    theme,
    String(options.width),
    options.collapsed ? 'collapsed' : null,
    options.full ? 'full' : null,
    options.clicks.length > 0 ? `click${options.clicks.length}` : null,
    options.signedOut ? 'signed-out' : null,
  ]
    .filter(Boolean)
    .join('--');
}

async function shoot(cdp, shot) {
  const page = await openPage(cdp, shot);
  try {
    let settled = await page.settle();
    // A state no URL addresses: click through to it, settling after each click.
    for (const selector of shot.clicks) {
      if (!(await page.click(selector))) page.errors.push(`--click found nothing for ${selector}`);
      settled = (await page.settle()) && settled;
    }
    await delay(250);

    const facts = await page.evaluate(`(() => {
      const content = document.querySelector('.content');
      return {
        stillLoading: document.querySelectorAll('.skel').length > 0,
        errorStates: document.querySelectorAll('.empty.error').length,
        horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
        contentHeight: content ? content.scrollHeight - content.clientHeight : 0,
      };
    })()`);

    if (shot.full && facts.contentHeight > 0) {
      await page.metrics(Math.min(shot.height + facts.contentHeight, 16000));
      await delay(300);
    }
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(shot.file, Buffer.from(data, 'base64'));
    return {
      settled,
      stillLoading: facts.stillLoading,
      errorStates: facts.errorStates,
      horizontalOverflow: facts.horizontalOverflow,
      errors: page.errors,
    };
  } finally {
    await page.close();
  }
}

if (needsTypeStripping(process.features)) {
  // Node 22.11–22.17: the fixtures are TypeScript, and stripping is opt-in
  // there. Run this same script again with it on, rather than fail on the
  // first `.ts` import.
  const again = spawnSync(
    process.execPath,
    [
      // After the inherited flags, so it wins over a `--no-experimental-strip-types`
      // among them rather than re-running into the same refusal for ever.
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
