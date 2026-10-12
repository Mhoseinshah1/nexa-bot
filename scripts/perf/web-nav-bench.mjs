#!/usr/bin/env node
/**
 * `node scripts/perf/web-nav-bench.mjs --api http://127.0.0.1:3917 --username perfowner [options]`
 *
 * Measures Web Admin navigation against a REAL API and the REAL production build:
 * Dashboard → Customers → Audit Log → Settings → Dashboard, once cold and then
 * repeated, by clicking the sidebar links the way an operator does.
 *
 * The password is read from `NEXA_BENCH_PASSWORD`, never from argv.
 *
 *   --api URL          the running API (`node apps/api/dist/main.js`)          required
 *   --username NAME    an administrator of that API's primary tenant           required
 *   --rounds N         navigation cycles after the cold one (default 3)
 *   --rtt MS           network round-trip latency Chromium adds to EVERY request
 *                      (default 0). A real operator is not on the API's loopback;
 *                      this is what makes a request waterfall visible.
 *   --cpu N            CPU slowdown factor (default 1)
 *   --hover MS         move the pointer onto the link MS milliseconds before clicking it
 *                      (default 0: a bare click, which no sidebar prefetch can precede)
 *   --out FILE         JSON results (default .perf/web-nav-<cycle>-<rtt>ms.json)
 *   --cycle NAME       admin (default: Dashboard → Customers → Audit Log → Settings) or
 *                      commerce (→ Customers → Orders → Payments → Services → Products →
 *                      Panels → Dashboard, the FIX-11 audit's cycle)
 *   --no-build         serve apps/web/dist as it is
 *
 * Per navigation it records:
 *   shellMs     click → the first frame after the click in which the URL, the
 *               sidebar's current link and the breadcrumb all name the destination;
 *   contentMs   click → the first frame with the destination drawn and no skeleton
 *               (a page served from the query cache draws before its refetch answers);
 *   readyMs     click → destination content settled: no skeleton and no
 *               `aria-busy` in <main>, none of the requests THIS navigation started still
 *               in flight, held for 400 ms
 *               (the reported time is when it BECAME settled, not the end of the hold);
 *   requests    every request the navigation caused, with its duration, status and
 *               transferred bytes (API and JS chunks separately);
 *   longTasks   main-thread tasks over 50 ms, total and longest;
 *   shellKept   whether the sidebar and top bar DOM nodes survived (a remount
 *               replaces them).
 *
 * After the cycles it measures `dashboard(loading)→customers`: open the dashboard and
 * leave it for Customers before its aggregates answer — what the dashboard's abandoned
 * work costs the next page.
 *
 * Static files are served the way `deploy/caddy/routes.caddy` serves them: gzip,
 * `/assets/*` immutable, the SPA fallback for everything else, the production CSP.
 * API requests are proxied to `--api` unchanged. One difference stated rather than
 * hidden: this server speaks HTTP/1.1 (six connections per origin) where the edge
 * speaks HTTP/2, so a page that fires more than six requests at once queues here and
 * would not in production.
 *
 * Not part of `pnpm verify` or CI: it needs Chromium (/opt/pw-browsers or
 * NEXA_CHROMIUM), a migrated database and a running API. Its numbers are evidence
 * for docs/perf/web-admin-navigation.md, not a pass/fail gate.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
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
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { Cdp } from '../web-shots/cdp.mjs';
import { failureLine } from './redact.mjs';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');

/**
 * The navigation cycles. `admin` is the original one. `commerce` is the one the FIX-11 audit
 * measured (the pages an operator selling services lives on: orders, payments, services,
 * products, panels), where the payment attention counts and the panel capacity count are.
 */
const CYCLES = {
  admin: [
    { from: 'dashboard', to: 'customers', href: '/users' },
    { from: 'customers', to: 'audit-log', href: '/audit-log' },
    { from: 'audit-log', to: 'settings', href: '/settings' },
    { from: 'settings', to: 'dashboard', href: '/' },
  ],
  commerce: [
    { from: 'dashboard', to: 'customers', href: '/users' },
    { from: 'customers', to: 'orders', href: '/orders' },
    { from: 'orders', to: 'payments', href: '/payments' },
    { from: 'payments', to: 'services', href: '/services' },
    { from: 'services', to: 'products', href: '/products' },
    { from: 'products', to: 'panels', href: '/panels' },
    { from: 'panels', to: 'dashboard', href: '/' },
  ],
};

function parseArgs(argv) {
  const o = {
    api: null,
    username: null,
    rounds: 3,
    rtt: 0,
    cpu: 1,
    hover: 0,
    out: null,
    build: true,
    cycle: 'admin',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const v = () => {
      i += 1;
      if (argv[i] === undefined) throw new Error(`${a} needs a value`);
      return argv[i];
    };
    if (a === '--api') o.api = v();
    else if (a === '--username') o.username = v();
    else if (a === '--rounds') o.rounds = Number(v());
    else if (a === '--rtt') o.rtt = Number(v());
    else if (a === '--cpu') o.cpu = Number(v());
    else if (a === '--out') o.out = resolve(v());
    else if (a === '--hover') o.hover = Number(v());
    else if (a === '--no-build') o.build = false;
    else if (a === '--cycle') o.cycle = v();
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (o.api === null || o.username === null) throw new Error('--api and --username are required');
  if (CYCLES[o.cycle] === undefined) throw new Error(`--cycle is ${Object.keys(CYCLES).join('|')}`);
  if (!process.env.NEXA_BENCH_PASSWORD) throw new Error('Set NEXA_BENCH_PASSWORD.');
  o.out ??= join(ROOT, '.perf', `web-nav-${o.cycle}-${o.rtt}ms.json`);
  return o;
}

function findChromium() {
  if (process.env.NEXA_CHROMIUM) return process.env.NEXA_CHROMIUM;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  const dirs = existsSync(base)
    ? readdirSync(base)
        .filter((name) => /^chromium-\d+$/.test(name))
        .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    : [];
  for (const dir of dirs) {
    const candidate = join(base, dir, 'chrome-linux', 'chrome');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`No Chromium under ${base} (set NEXA_CHROMIUM).`);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function serve(dist, api) {
  const caddy = readFileSync(join(ROOT, 'deploy/caddy/routes.caddy'), 'utf8');
  const csp = /Content-Security-Policy "([^"]+)"/.exec(caddy)?.[1];
  const target = new URL(api);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/health/')) {
      const upstream = httpRequest(
        {
          host: target.hostname,
          port: target.port,
          method: req.method,
          path: req.url,
          headers: { ...req.headers, host: target.host },
        },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on('error', () => res.writeHead(502).end());
      req.pipe(upstream);
      return;
    }
    let file = join(dist, url.pathname);
    if (!file.startsWith(dist) || !existsSync(file) || url.pathname.endsWith('/'))
      file = join(dist, 'index.html');
    try {
      const raw = await readFile(file);
      const headers = { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' };
      if (url.pathname.startsWith('/assets/'))
        headers['cache-control'] = 'public, max-age=31536000, immutable';
      else headers['cache-control'] = 'no-store';
      if (extname(file) === '.html' && csp) headers['content-security-policy'] = csp;
      let body = raw;
      if (
        /gzip/.test(String(req.headers['accept-encoding'] ?? '')) &&
        /\.(js|css|html|svg)$/.test(file)
      ) {
        body = gzipSync(raw);
        headers['content-encoding'] = 'gzip';
      }
      res.writeHead(200, headers);
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return server;
}

/** Installed before the app's scripts: fetch accounting and long tasks, in page time. */
const PAGE_PROBE = `(() => {
  // Each fetch is remembered with the time it STARTED, so a navigation can wait for
  // its own requests without also waiting for ones an earlier page left in flight.
  const state = { inflight: 0, lastFetchAt: 0, pending: new Set(), finished: [], longTasks: [] };
  state.inflightSince = (t) => [...state.pending].filter((s) => s >= t).length;
  state.lastActivitySince = (t) =>
    Math.max(t, ...[...state.pending].filter((s) => s >= t), ...state.finished.filter((f) => f.start >= t).map((f) => f.end));
  window.__perf = state;
  const real = window.fetch.bind(window);
  window.fetch = (...args) => {
    const started = performance.now();
    state.pending.add(started);
    state.inflight += 1;
    state.lastFetchAt = started;
    return real(...args).finally(() => {
      state.pending.delete(started);
      state.inflight -= 1;
      state.lastFetchAt = performance.now();
      state.finished.push({ start: started, end: state.lastFetchAt });
      if (state.finished.length > 500) state.finished.splice(0, 250);
    });
  };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) state.longTasks.push({ start: e.startTime, duration: e.duration });
    }).observe({ type: 'longtask', buffered: true });
  } catch {}
})();`;

/** Runs in the page: clicks a sidebar link and resolves with shell and ready times. */
function clickAndMeasure(href) {
  return `new Promise((done) => {
    const state = window.__perf;
    const sidebar = document.querySelector('aside.sidebar');
    const topbar = document.querySelector('.topbar') ?? document.querySelector('header');
    const link = document.querySelector('aside.sidebar a[href=${JSON.stringify(href)}]');
    if (!link) { done({ error: 'no link ' + ${JSON.stringify(href)} }); return; }
    const crumbBefore = (document.querySelector('header.topbar') ?? {}).textContent ?? '';
    const tasksBefore = state.longTasks.length;
    const start = performance.now();
    link.click();
    let shellAt = null;
    let contentAt = null;
    let settledSince = null;
    const isShellThere = () =>
      location.pathname === ${JSON.stringify(href)} &&
      document.querySelector('aside.sidebar a[aria-current="page"]')?.getAttribute('href') === ${JSON.stringify(href)};
    const isDrawn = () => {
      const main = document.querySelector('main#main');
      return !!main && !main.querySelector('.skel, [aria-busy="true"]');
    };
    const isSettled = () => {
      const main = document.querySelector('main#main');
      if (!main) return false;
      if (main.querySelector('.skel, [aria-busy="true"]')) return false;
      return state.inflightSince(start) === 0;
    };
    const tick = () => {
      const now = performance.now();
      if (shellAt === null && isShellThere()) shellAt = now;
      if (contentAt === null && shellAt !== null && isDrawn()) contentAt = now;
      if (isSettled()) {
        const last = state.lastActivitySince(start);
        if (settledSince === null || last > settledSince) settledSince = Math.max(now, last);
        if (now - settledSince >= 400 && now - start > 50) {
          const tasks = state.longTasks.slice(tasksBefore).filter((t) => t.start >= start - 1);
          done({
            shellMs: shellAt === null ? null : shellAt - start,
            contentMs: contentAt === null ? null : contentAt - start,
            readyMs: settledSince - start,
            shellKept: document.querySelector('aside.sidebar') === sidebar &&
              (topbar === null || document.contains(topbar)),
            longTaskCount: tasks.length,
            longTaskTotalMs: tasks.reduce((s, t) => s + t.duration, 0),
            longTaskMaxMs: tasks.reduce((m, t) => Math.max(m, t.duration), 0),
            crumbChanged: ((document.querySelector('header.topbar') ?? {}).textContent ?? '') !== crumbBefore,
            errorCards: document.querySelectorAll('main#main .empty.error').length,
          });
          return;
        }
      } else settledSince = null;
      if (now - start > 30000) { done({ error: 'timeout', shellMs: shellAt === null ? null : shellAt - start }); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })`;
}

function delay(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function median(values) {
  const sorted = values.filter((v) => typeof v === 'number').sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.build) {
    const build = spawnSync('pnpm', ['--filter', '@nexa/web...', 'build'], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    if (build.status !== 0) process.exit(build.status ?? 1);
  }
  const dist = join(ROOT, 'apps/web/dist');
  const server = serve(dist, o.api);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const profile = mkdtempSync(join(tmpdir(), 'nexa-bench-'));
  const chrome = spawn(
    findChromium(),
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      '--remote-debugging-port=0',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const wsUrl = await new Promise((ok, fail) => {
    let buffer = '';
    const timer = setTimeout(() => fail(new Error('Chromium did not start')), 20_000);
    chrome.stderr.on('data', (chunk) => {
      buffer += chunk;
      const found = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
      if (found) {
        clearTimeout(timer);
        ok(found[1]);
      }
    });
  });
  const cdp = await Cdp.connect(wsUrl);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId);

  // Every request, keyed by id; a navigation takes the ones that started inside it.
  const requests = new Map();
  cdp.on((m) => {
    if (m.sessionId !== sessionId) return;
    const p = m.params;
    if (m.method === 'Network.requestWillBeSent') {
      requests.set(p.requestId, {
        url: p.request.url,
        method: p.request.method,
        start: p.timestamp,
        type: p.type,
      });
    } else if (m.method === 'Network.responseReceived') {
      const r = requests.get(p.requestId);
      if (r) {
        r.status = p.response.status;
        r.fromCache = p.response.fromDiskCache || p.response.fromMemoryCache || false;
      }
    } else if (m.method === 'Network.loadingFinished') {
      const r = requests.get(p.requestId);
      if (r) {
        r.end = p.timestamp;
        r.bytes = p.encodedDataLength;
      }
    } else if (m.method === 'Network.loadingFailed') {
      const r = requests.get(p.requestId);
      if (r) {
        r.end = p.timestamp;
        r.failed = p.errorText;
      }
    }
  });

  const results = {
    options: { rtt: o.rtt, cpu: o.cpu, rounds: o.rounds },
    initial: null,
    navigations: [],
  };
  try {
    await send('Page.enable');
    await send('Network.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    if (o.rtt > 0)
      await send('Network.emulateNetworkConditions', {
        offline: false,
        latency: o.rtt,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
    if (o.cpu > 1) await send('Emulation.setCPUThrottlingRate', { rate: o.cpu });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_PROBE });

    // Sign in through the API from the page's own origin, so the cookie is the browser's.
    const loaded = () =>
      new Promise((done) => {
        const stop = cdp.on((m) => {
          if (m.sessionId === sessionId && m.method === 'Page.loadEventFired') {
            stop();
            done();
          }
        });
      });
    let wait = loaded();
    await send('Page.navigate', { url: `${origin}/robots-not-a-route` });
    await wait;
    /*
     * The sidebar as the icon rail. The labelled sidebar is a single-open ACCORDION whose
     * closed groups render no links at all, so a click on \`/users\` or \`/orders\` had no
     * element to land on ("no link") from the dashboard. The rail draws every link the
     * actor may see; what is measured is the page behind the link, not the accordion.
     */
    // The credentials are ARGUMENTS, never interpolated into page source a CDP error can echo.
    const page = await send('Runtime.evaluate', { expression: 'globalThis' });
    const login = await send('Runtime.callFunctionOn', {
      objectId: page.result.objectId,
      functionDeclaration: `function (username, password) {
        localStorage.setItem('nexa.sidebar', 'collapsed');
        return fetch('/api/admin/v1/auth/login', { method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username, password }) })
          .then((r) => r.status);
      }`,
      arguments: [{ value: o.username }, { value: process.env.NEXA_BENCH_PASSWORD }],
      awaitPromise: true,
      returnByValue: true,
    });
    if (login.result.value !== 201 && login.result.value !== 200)
      throw new Error(`sign-in answered ${login.result.value}`);

    // The initial load of the dashboard, with an empty HTTP cache.
    await send('Network.clearBrowserCache');
    requests.clear();
    const wallStart = Date.now();
    wait = loaded();
    await send('Page.navigate', { url: `${origin}/` });
    await wait;
    const initialReady = await send('Runtime.evaluate', {
      expression: `new Promise((done) => {
        const state = window.__perf; let since = null;
        const tick = () => {
          const main = document.querySelector('main#main');
          const ok = main && !main.querySelector('.skel, [aria-busy="true"]') && state.inflight === 0;
          const now = performance.now();
          if (ok) { if (since === null || state.lastFetchAt > since) since = Math.max(now, state.lastFetchAt);
            if (now - since >= 400) { done(since); return; } } else since = null;
          if (now > 60000) { done(null); return; }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      })`,
      awaitPromise: true,
      returnByValue: true,
    });
    await delay(200);
    results.initial = {
      readyMs: initialReady.result.value,
      wallMs: Date.now() - wallStart,
      requests: summarise([...requests.values()]),
    };
    console.log(
      `initial load: ready ${fmt(results.initial.readyMs)}  requests ${results.initial.requests.count} ` +
        `(js ${results.initial.requests.jsBytes} B transferred)`,
    );

    for (let round = 0; round <= o.rounds; round += 1) {
      for (const step of CYCLES[o.cycle]) {
        await delay(300);
        requests.clear();
        if (o.hover > 0) {
          // The pointer arrives on the link first, as a mouse does, then the click.
          const box = await send('Runtime.evaluate', {
            expression: `(() => { const a = document.querySelector('aside.sidebar a[href=${JSON.stringify(step.href)}]'); a.scrollIntoView({ block: 'center' }); const r = a.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
            returnByValue: true,
          });
          await send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: box.result.value.x,
            y: box.result.value.y,
          });
          await delay(o.hover);
        }
        const { result } = await send('Runtime.evaluate', {
          expression: clickAndMeasure(step.href),
          awaitPromise: true,
          returnByValue: true,
        });
        await delay(100);
        const entry = {
          round,
          kind: round === 0 ? 'cold' : 'repeat',
          step: `${step.from}→${step.to}`,
          ...result.value,
          requests: summarise([...requests.values()]),
        };
        results.navigations.push(entry);
        console.log(
          `${entry.kind.padEnd(6)} ${entry.step.padEnd(22)} shell ${fmt(entry.shellMs)}  content ${fmt(entry.contentMs)}  ready ${fmt(entry.readyMs)}  ` +
            `api ${entry.requests.api.length}  js ${entry.requests.js.length}  long ${fmt(entry.longTaskTotalMs)}  ` +
            `kept ${entry.shellKept}${entry.error ? `  ERROR ${entry.error}` : ''}`,
        );
      }
    }

    // The impatient operator: open the dashboard and leave it for Customers before
    // its aggregates have answered. Measures what the dashboard's in-flight work costs
    // the NEXT page.
    for (let round = 0; round < Math.max(1, o.rounds); round += 1) {
      await delay(300);
      await send('Runtime.evaluate', {
        expression: `document.querySelector('aside.sidebar a[href="/settings"]').click()`,
      });
      await delay(600);
      await send('Runtime.evaluate', {
        expression: `document.querySelector('aside.sidebar a[href="/"]').click()`,
      });
      await delay(150);
      requests.clear();
      const { result } = await send('Runtime.evaluate', {
        expression: clickAndMeasure('/users'),
        awaitPromise: true,
        returnByValue: true,
      });
      await delay(100);
      const entry = {
        round,
        kind: 'leave-early',
        step: 'dashboard(loading)→customers',
        ...result.value,
        requests: summarise([...requests.values()]),
      };
      results.navigations.push(entry);
      console.log(
        `${entry.kind.padEnd(11)} ${entry.step.padEnd(28)} shell ${fmt(entry.shellMs)}  content ${fmt(entry.contentMs)}  ready ${fmt(entry.readyMs)}`,
      );
      // Let the abandoned dashboard requests drain before the next round.
      await delay(4000);
    }

    results.summary = {};
    for (const [label, kinds] of [
      ...CYCLES[o.cycle].map((step) => [`${step.from}→${step.to}`, ['cold', 'repeat']]),
      ['dashboard(loading)→customers', ['leave-early']],
    ]) {
      for (const kind of kinds) {
        const rows = results.navigations.filter((n) => n.step === label && n.kind === kind);
        results.summary[`${label} ${kind}`] = {
          shellMs: median(rows.map((r) => r.shellMs)),
          contentMs: median(rows.map((r) => r.contentMs)),
          readyMs: median(rows.map((r) => r.readyMs)),
          apiRequests: median(rows.map((r) => r.requests.api.length)),
          jsChunks: median(rows.map((r) => r.requests.js.length)),
          longTaskTotalMs: median(rows.map((r) => r.longTaskTotalMs)),
          apiKB: median(rows.map((r) => r.requests.apiBytes / 1024)),
          shellKept: rows.every((r) => r.shellKept),
        };
      }
    }
    console.table(
      Object.fromEntries(
        Object.entries(results.summary).map(([k, v]) => [
          k,
          {
            shell: Math.round(v.shellMs ?? -1),
            content: Math.round(v.contentMs ?? -1),
            ready: Math.round(v.readyMs ?? -1),
            api: v.apiRequests,
            js: v.jsChunks,
            longTask: Math.round(v.longTaskTotalMs ?? 0),
            apiKB: Math.round((v.apiKB ?? 0) * 10) / 10,
            kept: v.shellKept,
          },
        ]),
      ),
    );
  } finally {
    mkdirSync(dirname(o.out), { recursive: true });
    writeFileSync(o.out, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`wrote ${o.out}`);
    cdp.close();
    chrome.kill('SIGKILL');
    server.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

function fmt(ms) {
  return typeof ms === 'number' ? `${Math.round(ms)}ms`.padStart(7) : '    n/a';
}

function summarise(list) {
  const rows = list.map((r) => {
    const url = new URL(r.url);
    return {
      path: `${url.pathname}${url.search}`,
      method: r.method,
      status: r.status ?? null,
      ms: r.end !== undefined ? Math.round((r.end - r.start) * 1000) : null,
      bytes: r.bytes ?? 0,
      fromCache: r.fromCache ?? false,
      failed: r.failed,
    };
  });
  const api = rows.filter((r) => r.path.startsWith('/api/') || r.path.startsWith('/health/'));
  const js = rows.filter((r) => r.path.endsWith('.js'));
  return {
    count: rows.length,
    api,
    js,
    apiBytes: api.reduce((s, r) => s + r.bytes, 0),
    jsBytes: js.reduce((s, r) => s + r.bytes, 0),
    all: rows,
  };
}

main().catch((error) => {
  console.error(failureLine(error, process.env.NEXA_BENCH_PASSWORD));
  process.exit(1);
});
