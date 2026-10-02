#!/usr/bin/env node
/**
 * `node --experimental-strip-types scripts/web-shots/bot-buttons-drag.mjs [--out dir]`
 *
 * A REAL-browser check of the button builder's drag (owner order 2026-10-02, round-T QA-2),
 * which the web suite cannot make: jsdom fires synthetic pointer events and lays nothing
 * out, so it cannot see Chromium's touch adjustment move a finger off a small grip, nor a
 * placeholder that moves the layout under the pointer.
 *
 * Serves the BUILT `apps/web/dist` (run `pnpm web:shots` or `pnpm --filter @nexa/web build`
 * first) with the shots fixtures and the production CSP, drives Chromium from
 * `/opt/pw-browsers` over CDP, and:
 *
 * 1. at 390 px with touch emulation, presses a finger (radius 0.5 px, as QA-2 did) on the
 *    centre of the `help` key's grip and drags it onto the START half of `catalog`: the
 *    pointerdown must reach the grip, the ghost, the caret and the target row must be drawn
 *    mid-drag, and `help` must end up first on row 1;
 * 2. at 1440 px with a mouse, drags `wallet` onto the gap below row 1: a new row.
 *
 * Mid-drag screenshots go to `--out` (default `.web-shots/drag`). Exits non-zero when a
 * check fails. Not part of `pnpm verify` or CI: it needs a Chromium binary.
 *
 * What it does NOT prove: QA-2's retargeting (a finger on the old 18 px `span` grip
 * delivered to `.bb-chip-main`) was seen through Playwright's `hasTouch` context; through
 * CDP touch emulation here the old grip received its pointerdown too, so this probe does not
 * reproduce that defect. The grip is now a real `<button>` with a 34 × 44 px hit area — the
 * fix direction QA-2 named — and R-ACC-9 (a real phone) remains the answer.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cdp } from './cdp.mjs';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const API_PREFIX = '/api/admin/v1';
const outAt = process.argv.indexOf('--out');
const OUT = resolve(outAt > 0 ? (process.argv[outAt + 1] ?? '') : join(ROOT, '.web-shots/drag'));
const dist = join(ROOT, 'apps/web/dist');
if (!existsSync(join(dist, 'index.html'))) throw new Error('Build apps/web first.');
const { FIXTURES, findFixture } = await import(join(ROOT, 'tests/web/shots/index.ts'));
const caddy = readFileSync(join(ROOT, 'deploy/caddy/routes.caddy'), 'utf8');
const csp = /Content-Security-Policy "([^"]+)"/.exec(caddy)?.[1] ?? '';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
};
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
mkdirSync(OUT, { recursive: true });

function chromium() {
  if (process.env.NEXA_CHROMIUM) return process.env.NEXA_CHROMIUM;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  const dir = readdirSync(base)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))[0];
  if (dir === undefined) throw new Error(`No chromium-* under ${base} (set NEXA_CHROMIUM).`);
  return join(base, dir, 'chrome-linux', 'chrome');
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname.startsWith(API_PREFIX) || url.pathname.startsWith('/health/')) {
    const found = findFixture(
      FIXTURES,
      request.method ?? 'GET',
      url.pathname,
      url.searchParams,
      API_PREFIX,
    );
    response.writeHead(found?.status ?? 404, { 'content-type': 'application/json' });
    response.end(JSON.stringify(found?.body ?? {}));
    return;
  }
  let file = join(dist, url.pathname);
  if (!file.startsWith(dist) || !existsSync(file) || url.pathname.endsWith('/')) {
    file = join(dist, 'index.html');
  }
  const headers = { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' };
  if (extname(file) === '.html') headers['content-security-policy'] = csp;
  response.writeHead(200, headers);
  response.end(await readFile(file));
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const port = server.address().port;

const chrome = spawn(
  chromium(),
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--lang=fa-IR',
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'nexa-drag-'))}`,
    '--remote-debugging-port=0',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);
const wsUrl = await new Promise((done, fail) => {
  let buffer = '';
  const timer = setTimeout(() => fail(new Error('Chromium did not start')), 20_000);
  chrome.stderr.on('data', (chunk) => {
    buffer += chunk;
    const found = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
    if (found) {
      clearTimeout(timer);
      done(found[1]);
    }
  });
});
const cdp = await Cdp.connect(wsUrl);
const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `: ${JSON.stringify(detail)}`}`);
  if (!ok) failures.push(name);
};

async function open(width, height, touch) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: touch,
  });
  if (touch) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  // The debugger's script, outside the CSP: records which control each pointerdown reached.
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__downs = [];
      document.addEventListener('pointerdown', (e) => window.__downs.push(
        e.target.closest('.bb-grip, .bb-row-grip, .bb-chip-main')?.classList[0] ?? null), true);`,
  });
  await send('Page.navigate', { url: `http://127.0.0.1:${String(port)}/bot-buttons` });
  await delay(3500);
  const evaluate = async (expression) =>
    (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
  const shot = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
  };
  return { send, evaluate, shot, close: () => cdp.send('Target.closeTarget', { targetId }) };
}

const rectOf = (selector) =>
  `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
     return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, width: r.width }; })()`;
const ROWS = `[...document.querySelectorAll('.bb-row')].map((row) =>
  [...row.querySelectorAll('[data-chip]')].map((chip) => chip.dataset.chip))`;

try {
  // 1. A finger, 390 px.
  const phone = await open(390, 844, true);
  await phone.evaluate(
    `document.querySelector('[data-chip="help"]').scrollIntoView({ block: 'center' })`,
  );
  await delay(300);
  const grip = await phone.evaluate(rectOf('[data-chip="help"] .bb-grip'));
  const onto = await phone.evaluate(rectOf('[data-chip="catalog"]'));
  const touch = (type, x, y) =>
    phone.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y, radiusX: 0.5, radiusY: 0.5, id: 1 }],
    });
  await touch('touchStart', grip.x, grip.y);
  const endX = onto.left + onto.width * 0.8; // the RIGHT half: the start of a Persian line
  for (let step = 1; step <= 12; step += 1) {
    await touch(
      'touchMove',
      grip.x + ((endX - grip.x) * step) / 12,
      grip.y + ((onto.y - grip.y) * step) / 12,
    );
    await delay(30);
  }
  await delay(150);
  await phone.shot('touch-midway-390');
  const midway = await phone.evaluate(`({
    ghost: document.querySelector('[data-testid="bb-drag-ghost"]') !== null,
    caret: document.querySelector('.is-insert-before')?.dataset.chip ?? null,
    targetRow: document.querySelector('.bb-row.is-target')?.dataset.row ?? null })`);
  await touch('touchEnd', endX, onto.y);
  await delay(250);
  const downs = await phone.evaluate('window.__downs');
  const rows = await phone.evaluate(ROWS);
  check('a finger on a key grip reaches the grip', downs[0] === 'bb-grip', downs);
  check(
    'mid-drag: ghost, caret before catalog, row 1 targeted',
    midway.ghost && midway.caret === 'catalog' && midway.targetRow === '0',
    midway,
  );
  check('the finger drag moved help before catalog', rows[0]?.[0] === 'help', rows);
  check(
    'no horizontal overflow at 390',
    (await phone.evaluate(
      'document.documentElement.scrollWidth - document.documentElement.clientWidth',
    )) === 0,
    null,
  );
  await phone.close();

  // 2. A mouse, 1440 px.
  const desk = await open(1440, 1000, false);
  await desk.evaluate(
    `document.querySelector('[data-chip="wallet"]').scrollIntoView({ block: 'center' })`,
  );
  await delay(300);
  const from = await desk.evaluate(rectOf('[data-chip="wallet"] .bb-grip'));
  const gap = await desk.evaluate(rectOf('[data-drop="gap"][data-at="1"]'));
  const mouse = (type, x, y) =>
    desk.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      buttons: type === 'mouseReleased' ? 0 : 1,
      clickCount: 1,
    });
  await mouse('mousePressed', from.x, from.y);
  for (let step = 1; step <= 10; step += 1) {
    await mouse(
      'mouseMoved',
      from.x + ((gap.x - from.x) * step) / 10,
      from.y + ((gap.y - from.y) * step) / 10,
    );
    await delay(30);
  }
  await delay(150);
  await desk.shot('mouse-midway-1440');
  const line = await desk.evaluate(`document.querySelector('.bb-gap.is-over')?.dataset.at ?? null`);
  await mouse('mouseReleased', gap.x, gap.y);
  await delay(250);
  const after = await desk.evaluate(ROWS);
  check('mid-drag: the new-row line under row 1', line === '1', line);
  check('the mouse drag made wallet a row of its own', after[1]?.join() === 'wallet', after);
  await desk.close();
} finally {
  chrome.kill();
  server.close();
}
console.log(`screenshots: ${OUT}`);
process.exit(failures.length === 0 ? 0 : 1);
