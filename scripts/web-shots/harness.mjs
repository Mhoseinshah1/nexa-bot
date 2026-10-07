/**
 * The parts of `pnpm web:shots` that more than one driver needs: the production build served
 * with the production CSP and the fixture API, a headless Chromium over the DevTools
 * protocol, and one page opened, frozen and settled.
 *
 * `shots.mjs` (screenshots) and `responsive.mjs` (the phone and tablet checks) both drive
 * the browser through here, so a page is opened the same way for a picture and for a
 * measurement. Importing this module starts nothing.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cdp } from './cdp.mjs';

export const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
export const API_PREFIX = '/api/admin/v1';

export function findChromium() {
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

export function productionCsp() {
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

/** Builds `apps/web` and its workspace dependencies; exits on a failed build. */
export function buildWeb() {
  console.log('building @nexa/web and its workspace dependencies…');
  const build = spawnSync('pnpm', ['--filter', '@nexa/web...', 'build'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

/**
 * Serves `apps/web/dist` with the SPA fallback and the production CSP, and answers the API
 * from the fixture registry. `unfixtured()` returns (and `resetUnfixtured()` clears) the
 * requests no fixture answered, by name.
 */
export async function startServer({ signedOut = false } = {}) {
  const dist = join(ROOT, 'apps/web/dist');
  if (!existsSync(join(dist, 'index.html')))
    throw new Error('apps/web/dist is missing; drop --no-build.');

  const { FIXTURES, SHOT_NOW, findFixture } = await import(join(ROOT, 'tests/web/shots/index.ts'));
  const csp = productionCsp();
  let unfixtured = [];

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const method = request.method ?? 'GET';
    if (signedOut && url.pathname === `${API_PREFIX}/auth/session`) {
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
  return {
    port: server.address().port,
    now: SHOT_NOW,
    unfixtured: () => [...new Set(unfixtured)],
    resetUnfixtured: () => {
      unfixtured = [];
    },
    close: () => server.close(),
  };
}

/** A headless Chromium and a DevTools connection to it. */
export async function launchChrome() {
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
  const exited = new Promise((done) => chrome.once('exit', done));
  return {
    cdp,
    close: async () => {
      cdp.close();
      chrome.kill('SIGKILL');
      await exited;
      rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

export function delay(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Opens `page.url` in a new target with the viewport, theme, sidebar state and frozen clock
 * set, waits for it to settle, and returns what a driver needs to act on it.
 *
 * `page.touch` emulates a touch device (a coarse pointer, no hover), as a phone or tablet is.
 * `settle()` waits for a quiet network and no skeleton; `evaluate(expression)` returns a value;
 * `click(selector)` clicks the first match and settles (false when nothing matched); `close()` closes the target.
 */
export async function openPage(cdp, page) {
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

  const metrics = (height) =>
    send('Emulation.setDeviceMetricsOverride', {
      width: page.width,
      height,
      deviceScaleFactor: 1,
      mobile: page.touch === true,
    });

  await send('Page.enable');
  await send('Network.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await metrics(page.height);
  if (page.touch === true) {
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  }
  await send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-color-scheme', value: page.theme },
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ],
  });
  // Runs before the page's own scripts, and — being the debugger's — outside the CSP.
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      try {
        localStorage.setItem('nexa.theme', ${JSON.stringify(page.theme)});
        localStorage.setItem('nexa.sidebar', ${JSON.stringify(page.collapsed ? 'collapsed' : 'expanded')});
      } catch {}
      const fixed = Date.parse(${JSON.stringify(page.now)});
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
  await send('Page.navigate', { url: page.url });
  await loaded;

  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
    });
    if (exceptionDetails !== undefined)
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };

  // Quiet network for 600ms and no skeleton left, or the timeout.
  const settle = async () => {
    const deadline = Date.now() + page.timeoutMs;
    while (Date.now() < deadline) {
      await delay(150);
      if (inflight > 0 || Date.now() - lastActivity < 600) continue;
      if ((await evaluate(`document.querySelectorAll('.skel').length`)) === 0) return true;
    }
    return false;
  };

  const click = async (selector) => {
    const found = await evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`,
    );
    lastActivity = Date.now();
    if (found !== true) return false;
    await settle();
    return true;
  };

  return {
    send,
    errors,
    settle,
    evaluate,
    click,
    metrics,
    close: async () => {
      off();
      await cdp.send('Target.closeTarget', { targetId });
    },
  };
}
