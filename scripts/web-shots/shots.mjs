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
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cdp } from './cdp.mjs';
import { needsTypeStripping, shotProblems } from './policy.mjs';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const API_PREFIX = '/api/admin/v1';

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

function findChromium() {
  if (process.env.NEXA_CHROMIUM) return process.env.NEXA_CHROMIUM;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  if (!existsSync(base))
    throw new Error(`No Chromium: ${base} does not exist (set NEXA_CHROMIUM).`);
  const dirs = readdirSync(base)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const dir of dirs) {
    const candidate = join(base, dir, 'chrome-linux', 'chrome');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`No chromium-*/chrome-linux/chrome under ${base} (set NEXA_CHROMIUM).`);
}

function productionCsp() {
  const caddy = readFileSync(join(ROOT, 'deploy/caddy/routes.caddy'), 'utf8');
  const found = /Content-Security-Policy "([^"]+)"/.exec(caddy);
  if (found === null) throw new Error('No Content-Security-Policy in deploy/caddy/routes.caddy.');
  return found[1];
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.build) {
    console.log('building @nexa/web and its workspace dependencies…');
    const build = spawnSync('pnpm', ['--filter', '@nexa/web...', 'build'], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    if (build.status !== 0) process.exit(build.status ?? 1);
  }
  const dist = join(ROOT, 'apps/web/dist');
  if (!existsSync(join(dist, 'index.html')))
    throw new Error('apps/web/dist is missing; drop --no-build.');

  const { FIXTURES, SHOT_NOW, findFixture } = await import(join(ROOT, 'tests/web/shots/index.ts'));
  const csp = productionCsp();
  let unfixtured = [];

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const method = request.method ?? 'GET';
    if (options.signedOut && url.pathname === `${API_PREFIX}/auth/session`) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          error: {
            kind: 'UNAUTHENTICATED',
            code: 'auth.no_session',
            message: 'no',
            correlationId: 'shots',
          },
        }),
      );
      return;
    }
    if (url.pathname.startsWith(API_PREFIX) || url.pathname.startsWith('/health/')) {
      const found = findFixture(FIXTURES, method, url.pathname, url.searchParams, API_PREFIX);
      if (found === undefined) {
        unfixtured.push(`${method} ${url.pathname}${url.search}`);
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            error: {
              kind: 'not_found',
              code: 'shots.unfixtured',
              message: url.pathname,
              correlationId: 'shots',
            },
          }),
        );
        return;
      }
      response.writeHead(found.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(found.body));
      return;
    }
    let file = join(dist, url.pathname);
    // The SPA fallback the production edge does with `try_files`.
    if (!file.startsWith(dist) || !existsSync(file) || url.pathname.endsWith('/'))
      file = join(dist, 'index.html');
    try {
      const body = await readFile(file);
      const headers = { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' };
      if (extname(file) === '.html') headers['content-security-policy'] = csp;
      response.writeHead(200, headers);
      response.end(body);
    } catch {
      response.writeHead(404).end('not found');
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;

  const profile = mkdtempSync(join(tmpdir(), 'nexa-shots-'));
  const chrome = spawn(
    findChromium(),
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--force-color-profile=srgb',
      '--font-render-hinting=none',
      '--lang=fa-IR',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      '--remote-debugging-port=0',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const wsUrl = await new Promise((resolveUrl, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('Chromium did not start')), 20_000);
    chrome.stderr.on('data', (chunk) => {
      buffer += chunk;
      const found = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
      if (found) {
        clearTimeout(timer);
        resolveUrl(found[1]);
      }
    });
    chrome.on('exit', (code) =>
      reject(new Error(`Chromium exited (${code}): ${buffer.slice(-400)}`)),
    );
  });
  const cdp = await Cdp.connect(wsUrl);

  mkdirSync(options.out, { recursive: true });
  const report = [];

  try {
    for (const route of options.routes) {
      for (const theme of options.themes) {
        unfixtured = [];
        const name = shotName(route, theme, options);
        const result = await shoot(cdp, {
          url: `http://127.0.0.1:${port}${route}`,
          theme,
          width: options.width,
          height: options.height,
          collapsed: options.collapsed,
          full: options.full,
          now: SHOT_NOW,
          timeoutMs: options.timeoutMs,
          clicks: options.clicks,
          file: join(options.out, `${name}.png`),
        });
        const entry = {
          route,
          theme,
          file: join(options.out, `${name}.png`),
          unfixtured: [...new Set(unfixtured)],
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
    cdp.close();
    chrome.kill('SIGKILL');
    server.close();
    rmSync(profile, { recursive: true, force: true });
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
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId);
  const errors = [];
  let inflight = 0;
  let lastActivity = Date.now();
  const off = cdp.on((message) => {
    if (message.sessionId !== sessionId) return;
    if (message.method === 'Network.requestWillBeSent') {
      inflight += 1;
      lastActivity = Date.now();
    } else if (
      message.method === 'Network.loadingFinished' ||
      message.method === 'Network.loadingFailed'
    ) {
      inflight = Math.max(0, inflight - 1);
      lastActivity = Date.now();
    } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      errors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '));
    } else if (message.method === 'Runtime.exceptionThrown') {
      errors.push(
        message.params.exceptionDetails.exception?.description ??
          message.params.exceptionDetails.text,
      );
    } else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      // A 404 for an unfixtured request is reported separately, by name; a 401 is
      // the signed-out session a --signed-out shot asks for.
      if (!/status of (404|401)/.test(message.params.entry.text))
        errors.push(message.params.entry.text);
    }
  });

  try {
    await send('Page.enable');
    await send('Network.enable');
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: shot.width,
      height: shot.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send('Emulation.setEmulatedMedia', {
      features: [
        { name: 'prefers-color-scheme', value: shot.theme },
        { name: 'prefers-reduced-motion', value: 'reduce' },
      ],
    });
    // Runs before the page's own scripts, and — being the debugger's — outside the CSP.
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        try {
          localStorage.setItem('nexa.theme', ${JSON.stringify(shot.theme)});
          localStorage.setItem('nexa.sidebar', ${JSON.stringify(shot.collapsed ? 'collapsed' : 'expanded')});
        } catch {}
        const fixed = Date.parse(${JSON.stringify(shot.now)});
        const Real = Date;
        class Frozen extends Real {
          constructor(...args) { if (args.length === 0) super(fixed); else super(...args); }
          static now() { return fixed; }
        }
        globalThis.Date = Frozen;
      })();`,
    });
    const loaded = new Promise((done) => {
      const stop = cdp.on((message) => {
        if (message.sessionId === sessionId && message.method === 'Page.loadEventFired') {
          stop();
          done();
        }
      });
    });
    await send('Page.navigate', { url: shot.url });
    await loaded;

    // Quiet network for 600ms and no skeleton left, or the timeout.
    const settle = async () => {
      const deadline = Date.now() + shot.timeoutMs;
      while (Date.now() < deadline) {
        await delay(150);
        if (inflight > 0 || Date.now() - lastActivity < 600) continue;
        const { result } = await send('Runtime.evaluate', {
          expression: `document.querySelectorAll('.skel').length`,
          returnByValue: true,
        });
        if (result.value === 0) return true;
      }
      return false;
    };
    let settled = await settle();
    // A state no URL addresses: click through to it, settling after each click.
    for (const selector of shot.clicks) {
      const { result } = await send('Runtime.evaluate', {
        expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`,
        returnByValue: true,
      });
      if (result.value !== true) errors.push(`--click found nothing for ${selector}`);
      lastActivity = Date.now();
      settled = (await settle()) && settled;
    }
    await delay(250);

    const { result: measured } = await send('Runtime.evaluate', {
      expression: `(() => {
        const content = document.querySelector('.content');
        return {
          stillLoading: document.querySelectorAll('.skel').length > 0,
          errorStates: document.querySelectorAll('.empty.error').length,
          horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
          contentHeight: content ? content.scrollHeight - content.clientHeight : 0,
        };
      })()`,
      returnByValue: true,
    });
    const facts = measured.value;

    if (shot.full && facts.contentHeight > 0) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: shot.width,
        height: Math.min(shot.height + facts.contentHeight, 16000),
        deviceScaleFactor: 1,
        mobile: false,
      });
      await delay(300);
    }
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(shot.file, Buffer.from(data, 'base64'));
    return {
      settled,
      stillLoading: facts.stillLoading,
      errorStates: facts.errorStates,
      horizontalOverflow: facts.horizontalOverflow,
      errors,
    };
  } finally {
    off();
    await cdp.send('Target.closeTarget', { targetId });
  }
}

function delay(ms) {
  return new Promise((done) => setTimeout(done, ms));
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
