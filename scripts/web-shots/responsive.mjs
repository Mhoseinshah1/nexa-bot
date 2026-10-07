#!/usr/bin/env node
/**
 * `pnpm web:responsive` — the Web Admin measured on a phone and a tablet, not looked at.
 *
 *   pnpm web:responsive                         every route, phone and tablet
 *   pnpm web:responsive /users /orders --device phone
 *   pnpm web:responsive --no-build --out /tmp/r
 *   pnpm web:responsive --scenarios-only        only the interactive checks
 *
 * It serves the production build exactly as `pnpm web:shots` does (production CSP, the
 * fixture API, the frozen clock; `harness.mjs`) and opens each route with TOUCH emulated, so
 * the page sees a coarse pointer as a real phone or tablet does. On each it measures:
 *
 * - horizontal overflow of the page (the page itself must never scroll sideways);
 * - every visible control — buttons, links drawn as controls, fields, tabs, switches,
 *   summaries — against the 44px touch target (`responsive-policy.mjs`; inline links in
 *   running text are exempt);
 * - controls cut off at the viewport edge with no scrolling container to reach them.
 *
 * Then the SCENARIOS (below): the phone navigation drawer and its accordion, a modal, a
 * drawer, tabs and a filter row, each reached by clicking as an operator would, with the
 * opened dialog checked to fit the viewport and to keep its actions on screen.
 *
 * Each measurement prints `ok` or `FAIL` with the reasons; a PNG of each and `report.json`
 * go to `.web-shots/responsive/` (git-ignored) or `--out`. Exit status is non-zero when any
 * measurement fails. Not part of `pnpm verify` or CI: it needs a Chromium binary.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, buildWeb, delay, launchChrome, openPage, startServer } from './harness.mjs';
import { needsTypeStripping } from './policy.mjs';
import { DEVICES, responsiveProblems } from './responsive-policy.mjs';

const ID = '01a05e35-c9ad-7e93-bef3-1ed9b55292c8';

/** Every route the app serves (`ROUTE_PATTERNS` in `app.tsx`), with the fixture ids. */
function allRoutes() {
  const app = readFileSync(join(ROOT, 'apps/web/src/app.tsx'), 'utf8');
  const block = /export const ROUTE_PATTERNS[^=]*=\s*\[([\s\S]*?)\];/.exec(app);
  if (block === null) throw new Error('ROUTE_PATTERNS not found in apps/web/src/app.tsx');
  return [...block[1].matchAll(/'(\/[^']*)'/g)].map((m) =>
    m[1].replace(':id', ID).replace(':provider', 'TONPAYS'),
  );
}

/**
 * The interactive checks. Each opens `route` on `device`, clicks `clicks` in order (settling
 * after each), and measures; `dialog` asks for the topmost `[role=dialog]` to be checked too.
 * `expect` is an expression that must be true afterwards (the state the clicks should reach).
 */
const SCENARIOS = [
  {
    name: 'phone navigation drawer opens over the page',
    device: 'phone',
    route: '/users',
    clicks: ['.menu-toggle'],
    expect: `(() => { const s = document.querySelector('#app-sidebar'); if (!s) return false;
      const r = s.getBoundingClientRect(); return r.width > 0 && r.right <= innerWidth + 1 && r.left >= -1; })()`,
  },
  {
    name: 'phone navigation accordion opens another group',
    device: 'phone',
    route: '/users',
    clicks: ['.menu-toggle', '#app-sidebar .nav-group-head[aria-expanded="false"]'],
    expect: `document.querySelectorAll('#app-sidebar .nav-group-head[aria-expanded="true"]').length === 1`,
  },
  {
    name: 'tablet navigation rail opens as a drawer',
    device: 'tablet',
    route: '/orders',
    clicks: ['.menu-toggle'],
    expect: `(() => { const s = document.querySelector('#app-sidebar'); return !!s && s.getBoundingClientRect().width > 100; })()`,
  },
  {
    name: 'phone command search dialog',
    device: 'phone',
    route: '/payments',
    clicks: ['.search-trigger'],
    dialog: true,
  },
  {
    name: 'phone modal (customer tags)',
    device: 'phone',
    route: '/users',
    clicks: ['.page-head .btn'],
    dialog: true,
  },
  {
    name: 'phone account menu',
    device: 'phone',
    route: '/orders',
    clicks: ['.topbar [aria-haspopup="menu"]'],
    expect: `!!document.querySelector('[role=menu]')`,
  },
  {
    name: 'phone tabs on a detail page',
    device: 'phone',
    route: `/panels/${ID}`,
    clicks: ['[role=tab]:nth-of-type(2)'],
    expect: `document.querySelector('[role=tab][aria-selected="true"]') !== document.querySelector('[role=tab]')`,
  },
  {
    name: 'phone filter chip applies a filter',
    device: 'phone',
    route: '/orders',
    clicks: ['.filter-row [aria-pressed="false"]'],
    expect: `location.search.includes('state=')`,
  },
  {
    name: 'tablet ticket filters',
    device: 'tablet',
    route: '/tickets',
    clicks: ['.filter-row [aria-pressed="false"]'],
    expect: `location.search.includes('status=')`,
  },
];

function parseArgs(argv) {
  const options = {
    routes: [],
    devices: Object.keys(DEVICES),
    build: true,
    out: join(ROOT, '.web-shots/responsive'),
    timeoutMs: 15_000,
    scenariosOnly: false,
    theme: 'dark',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      i += 1;
      if (argv[i] === undefined) throw new Error(`${arg} needs a value`);
      return argv[i];
    };
    if (arg === '--device') options.devices = value().split(',');
    else if (arg === '--no-build') options.build = false;
    else if (arg === '--out') options.out = resolve(value());
    else if (arg === '--timeout') options.timeoutMs = Number(value());
    else if (arg === '--scenarios-only') options.scenariosOnly = true;
    else if (arg === '--theme') options.theme = value();
    else if (arg === '--help' || arg === '-h') {
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
      process.exit(0);
    } else if (arg.startsWith('/')) options.routes.push(arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  for (const device of options.devices) {
    if (DEVICES[device] === undefined) throw new Error(`--device is ${Object.keys(DEVICES)}`);
  }
  if (options.routes.length === 0) options.routes = allRoutes();
  return options;
}

/** Runs in the page: the facts `responsiveProblems` judges. */
const MEASURE = `(() => {
  const SELECTOR = 'button, a[href], input:not([type=hidden]), select, textarea, summary, ' +
    '[role=tab], [role=switch], [role=menuitem], [role=menuitemradio], [role=checkbox], [role=radio]';
  const describe = (el) => {
    const name = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '')
      .replace(/\\s+/g, ' ').trim().slice(0, 24);
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\\s+/).slice(0, 3).join('.') : '';
    return el.tagName.toLowerCase() + (cls ? '.' + cls : '') + (name ? '«' + name + '»' : '');
  };
  const inScroller = (el) => {
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      if ((style.overflowX === 'auto' || style.overflowX === 'scroll') && node.scrollWidth > node.clientWidth + 1)
        return true;
    }
    return false;
  };
  const targets = [];
  const seen = new Set();
  for (const el of document.querySelectorAll(SELECTOR)) {
    if (el.closest('[hidden], [inert], [aria-hidden="true"]')) continue;
    let box = el.getBoundingClientRect();
    let kind = el.tagName.toLowerCase();
    let node = el;
    // A native checkbox or radio is hit through its label.
    if (el.matches('input[type=checkbox], input[type=radio]')) {
      const label = el.closest('label');
      if (label) { node = label; box = label.getBoundingClientRect(); kind = 'label'; }
      else if (el.labels && el.labels.length > 0) kind = 'labelled-box';
    }
    if (seen.has(node)) continue;
    seen.add(node);
    const style = getComputedStyle(node);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    // Parked off screen on purpose until focused (the skip link).
    if ((style.position === 'absolute' || style.position === 'fixed') &&
        (box.right <= 0 || box.left >= innerWidth || box.bottom <= 0)) continue;
    // Zero-sized, or visually hidden (a 1px input behind its styled control).
    if (box.width <= 2 || box.height <= 2) continue;
    if (kind === 'a' && style.display === 'inline') kind = 'inline-link';
    targets.push({
      kind,
      desc: describe(node),
      w: Math.round(box.width),
      h: Math.round(box.height),
      left: Math.round(box.left),
      right: Math.round(box.right),
      inScroller: inScroller(node),
    });
  }
  const dialogs = [...document.querySelectorAll('[role=dialog], [role=alertdialog]')];
  const top = dialogs[dialogs.length - 1];
  let dialog = { found: false, inside: false, footVisible: false };
  if (top) {
    const r = top.getBoundingClientRect();
    const foot = top.querySelector('.modal-foot, .drawer-foot, .dialog-actions');
    const f = foot ? foot.getBoundingClientRect() : r;
    dialog = {
      found: true,
      inside: r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1,
      footVisible: f.bottom <= innerHeight + 1 && f.top >= -1,
    };
  }
  return {
    coarse: matchMedia('(pointer: coarse) and (hover: none)').matches,
    width: innerWidth,
    horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
    targets,
    dialog,
  };
})()`;

async function measure(cdp, server, options, job) {
  const device = DEVICES[job.device];
  server.resetUnfixtured();
  const page = await openPage(cdp, {
    url: `http://127.0.0.1:${server.port}${job.route}`,
    theme: options.theme,
    width: device.width,
    height: device.height,
    touch: true,
    collapsed: false,
    now: server.now,
    timeoutMs: options.timeoutMs,
  });
  try {
    await page.settle();
    const missed = [];
    for (const selector of job.clicks ?? []) {
      if (!(await page.click(selector))) missed.push(`click found nothing for ${selector}`);
    }
    await delay(250);
    const facts = await page.evaluate(MEASURE);
    const reached = job.expect === undefined ? true : await page.evaluate(job.expect);
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(job.file, Buffer.from(data, 'base64'));
    const problems = [
      ...missed,
      ...(reached === true ? [] : ['the scenario did not reach its expected state']),
      ...responsiveProblems({
        ...facts,
        dialog: job.dialog === true ? facts.dialog : null,
        errors: page.errors,
        unfixtured: server.unfixtured(),
      }),
    ];
    return { ...job, problems, targets: facts.targets.length };
  } finally {
    await page.close();
  }
}

function slug(text) {
  return text
    .replace(/^\//, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .slice(0, 60);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.build) buildWeb();
  const server = await startServer();
  const chrome = await launchChrome();
  mkdirSync(options.out, { recursive: true });
  const jobs = [];
  if (!options.scenariosOnly) {
    for (const route of options.routes) {
      for (const device of options.devices) {
        jobs.push({
          name: route,
          route,
          device,
          file: join(options.out, `${slug(route) || 'dashboard'}--${device}.png`),
        });
      }
    }
  }
  for (const scenario of SCENARIOS) {
    if (!options.devices.includes(scenario.device)) continue;
    jobs.push({ ...scenario, file: join(options.out, `scenario--${slug(scenario.name)}.png`) });
  }
  const report = [];
  try {
    for (const job of jobs) {
      const result = await measure(chrome.cdp, server, options, job);
      report.push(result);
      console.log(
        `${result.problems.length === 0 ? 'ok  ' : 'FAIL'} ${job.device.padEnd(6)} ${job.name}` +
          (result.problems.length ? `\n     ${result.problems.join('\n     ')}` : ''),
      );
    }
  } finally {
    writeFileSync(join(options.out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    server.close();
    await chrome.close();
  }
  const failed = report.filter((entry) => entry.problems.length > 0).length;
  console.log(`${report.length - failed} of ${report.length} measurements passed`);
  if (failed > 0) process.exitCode = 1;
}

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
