#!/usr/bin/env node
/**
 * `pnpm web:demo-diff` — the live app against the owner's approved demo, route by route.
 *
 *   pnpm web:demo-diff                                   # all routes, light+dark × 1440+390
 *   pnpm web:demo-diff --themes light --widths 1440 --routes /users,/orders
 *   pnpm web:demo-diff --filter-kit <report.txt>         # apply KEEP to an existing report
 *
 *   --demo <html>      default docs/web-redesign/demo-parity/reference/redesign-demo.html,
 *                      else approved-demo.html (loudly)
 *   --themes light,dark   --widths 1440,390   --routes a,b   (filters, comma-separated)
 *   --no-build   reuse apps/web/dist       --no-tabs   skip the per-tab pass
 *   --no-shots   signatures only           --out <dir>   default .web-shots/demo-diff
 *   --keep <json>      default scripts/web-shots/demo-diff.keep.json
 *   --quality <0-100>  side-by-side JPEG quality, default 80
 *
 * Live side: the production build under the production CSP. When the demo carries
 * `<script type="application/json" id="nx-data">`, that JSON and the inline shim after it are
 * injected before the app's first script (the owner's kit does the same in inject.py), the
 * shim's sha256 is allowed in script-src IN THIS TOOL ONLY, and the shim answers the API.
 * Otherwise the app is served with the repo's `demo-parity` fixture set (stated in the header).
 * Demo side: the HTML opened from disk, navigated with `__NXH.push` + popstate when it has
 * that history object, else by `location.hash`. Output per theme-width: `<name>--demo.png`,
 * `<name>--app.png`, `<name>.jpg` (demo LEFT, app RIGHT), `sig.json`, `report.txt`.
 * KEEP (demo-diff.keep.json) suppresses the owner-approved differences, each with a reason.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROOT, buildWeb, delay, launchChrome, openPage, startServer } from './harness.mjs';
import { needsTypeStripping } from './policy.mjs';
import {
  SIG_JS,
  applyKeep,
  diffSigs,
  formatReport,
  normaliseSig,
  parseKitReport,
  validateKeep,
} from './demo-diff-lib.mjs';

const REF = join(ROOT, 'docs/web-redesign/demo-parity/reference');
const HERE = fileURLToPath(new URL('.', import.meta.url));
const MAX_HEIGHT = 16000;

function parseArgs(argv) {
  const o = {
    demo: undefined,
    themes: ['light', 'dark'],
    widths: [1440, 390],
    routes: undefined,
    build: true,
    tabs: true,
    shots: true,
    out: join(ROOT, '.web-shots/demo-diff'),
    keep: join(HERE, 'demo-diff.keep.json'),
    quality: 80,
    filterKit: undefined,
    height: 900,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      i += 1;
      if (argv[i] === undefined) throw new Error(`${arg} needs a value`);
      return argv[i];
    };
    if (arg === '--demo') o.demo = resolve(value());
    else if (arg === '--themes') o.themes = value().split(',');
    else if (arg === '--widths') o.widths = value().split(',').map(Number);
    else if (arg === '--routes') o.routes = value().split(',');
    else if (arg === '--no-build') o.build = false;
    else if (arg === '--no-tabs') o.tabs = false;
    else if (arg === '--no-shots') o.shots = false;
    else if (arg === '--out') o.out = resolve(value());
    else if (arg === '--keep') o.keep = resolve(value());
    else if (arg === '--quality') o.quality = Number(value());
    else if (arg === '--filter-kit') o.filterKit = resolve(value());
    else if (arg === '--help' || arg === '-h') {
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  for (const t of o.themes)
    if (t !== 'light' && t !== 'dark') throw new Error('themes: light,dark');
  return o;
}

function pickDemo(options) {
  if (options.demo !== undefined) return { file: options.demo, fallback: false };
  const wanted = join(REF, 'redesign-demo.html');
  if (existsSync(wanted)) return { file: wanted, fallback: false };
  console.warn(
    '\n!!! WARNING: reference/redesign-demo.html is missing. Falling back to the OLDER\n' +
      '!!! reference/approved-demo.html. This is NOT the demo the owner approved for this round;\n' +
      '!!! the numbers below are not the fix list. Pass --demo <the owner demo> to compare properly.\n',
  );
  return { file: join(REF, 'approved-demo.html'), fallback: true };
}

/** The demo's `#nx-data` block and the inline shim script that follows it, or undefined. */
export function extractInjection(demoHtml) {
  const a = demoHtml.indexOf('<script type="application/json" id="nx-data">');
  if (a < 0) return undefined;
  const b = demoHtml.indexOf('</script>', a) + '</script>'.length;
  const c = demoHtml.indexOf('<script>', b);
  const d = demoHtml.indexOf('</script>', c) + '</script>'.length;
  if (c < 0 || d < c) return undefined;
  const shim = demoHtml.slice(c + '<script>'.length, d - '</script>'.length);
  return {
    html: demoHtml.slice(a, b) + demoHtml.slice(c, d),
    hash: `'sha256-${createHash('sha256').update(shim, 'utf8').digest('base64')}'`,
  };
}

async function fullCapture(tab, baseHeight) {
  await tab.metrics(baseHeight);
  const tall = await tab.evaluate(`(() => {
    const c = document.querySelector('.content');
    const inner = c ? c.scrollHeight - c.clientHeight : 0;
    return Math.max(0, inner, document.documentElement.scrollHeight - window.innerHeight);
  })()`);
  if (tall > 0) {
    await tab.metrics(Math.min(baseHeight + tall, MAX_HEIGHT));
    await delay(350);
  }
  const { data } = await tab.send('Page.captureScreenshot', { format: 'png' });
  await tab.metrics(baseHeight);
  return data;
}

async function compose(cdp, left, right, file, quality) {
  const gap = 24;
  const label = 28;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;background:#3a3a40;font:600 15px system-ui,sans-serif;color:#fff}
    .row{display:flex;gap:${gap}px;padding:0 ${gap}px ${gap}px;align-items:flex-start}
    .col{display:flex;flex-direction:column} .col b{height:${label}px;line-height:${label}px}
    img{display:block}
  </style></head><body><div class="row">
    <div class="col"><b>DEMO</b><img id="a" src="data:image/png;base64,${left}"></div>
    <div class="col"><b>APP</b><img id="d" src="data:image/png;base64,${right}"></div>
  </div></body></html>`;
  const tab = await openPage(cdp, {
    url: 'about:blank',
    theme: 'dark',
    width: 400,
    height: 400,
    now: new Date().toISOString(),
    timeoutMs: 5_000,
  });
  try {
    const { frameTree } = await tab.send('Page.getFrameTree');
    await tab.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html });
    await delay(300);
    const size = await tab.evaluate(`(() => {
      const a = document.getElementById('a'), d = document.getElementById('d');
      return { w: a.naturalWidth + d.naturalWidth + ${gap * 3},
               h: Math.max(a.naturalHeight, d.naturalHeight) + ${label + gap} };
    })()`);
    await tab.metrics(Math.min(size.h, MAX_HEIGHT));
    await tab.send('Emulation.setDeviceMetricsOverride', {
      width: size.w,
      height: Math.min(size.h, MAX_HEIGHT),
      deviceScaleFactor: 1,
      mobile: false,
    });
    await delay(300);
    const { data } = await tab.send('Page.captureScreenshot', { format: 'jpeg', quality });
    writeFileSync(file, Buffer.from(data, 'base64'));
  } finally {
    await tab.close();
  }
}

/** Clicks each `[role=tab]` of the current page in turn and returns `{label: signature}`. */
async function tabSigs(tab, labels, settle) {
  const out = {};
  for (const label of labels) {
    const clicked = await tab.evaluate(`(() => {
      const want = ${JSON.stringify(label)};
      const clean = (s) => s.replace(/[\\u200c\\u200d]/g, '').replace(/[0-9\\u06f0-\\u06f9\\u0660-\\u0669]+/g, '#').replace(/\\s+/g, ' ').trim();
      const el = [...document.querySelectorAll('main [role=tab], [role=tab]')].find(
        (e) => clean(e.textContent) === want && e.getBoundingClientRect().width > 0,
      );
      if (!el) return false;
      el.click();
      return true;
    })()`);
    if (clicked !== true) continue;
    await settle();
    out[label] = normaliseSig(await tab.evaluate(SIG_JS));
  }
  return out;
}

function slug(route) {
  return route.replace(/[/?=&#:]+/g, '_').replace(/^_+|_+$/g, '') || 'root';
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  const keep = validateKeep(JSON.parse(readFileSync(options.keep, 'utf8')));
  if (options.filterKit !== undefined) {
    const { diffs, order } = parseKitReport(readFileSync(options.filterKit, 'utf8'));
    const applied = applyKeep(diffs, keep);
    const header = [`Owner's kit report ${options.filterKit} with KEEP applied (${options.keep})`];
    process.stdout.write(formatReport({ header, order, diffs, applied, keep }).text);
    return;
  }
  const routes = JSON.parse(
    readFileSync(join(HERE, 'demo-diff.routes.json'), 'utf8'),
  ).routes.filter((r) => options.routes === undefined || options.routes.includes(r));
  if (routes.length === 0) throw new Error('No route matches --routes.');
  const demo = pickDemo(options);
  const demoHtml = readFileSync(demo.file, 'utf8');
  const injection = extractInjection(demoHtml);
  const hashNav = !demoHtml.includes('__NXH');
  if (options.build) buildWeb();
  const server = await startServer(
    injection === undefined
      ? { fixtureSet: 'demo-parity' }
      : {
          scriptHashes: [injection.hash],
          transformIndex: (html) => {
            const at = html.indexOf('<script');
            return html.slice(0, at) + injection.html + html.slice(at);
          },
        },
  );
  const source = injection === undefined ? "repo fixture set 'demo-parity'" : "the demo's #nx-data";
  const chrome = await launchChrome();
  const demoUrl = pathToFileURL(demo.file).href;
  const summary = [];
  try {
    for (const theme of options.themes) {
      for (const width of options.widths) {
        const dir = join(options.out, `${theme}-${width}`);
        mkdirSync(dir, { recursive: true });
        const base = { theme, width, height: options.height, now: server.now, timeoutMs: 15_000 };
        const sigs = {};
        const failed = {};
        const shots = {};
        const demoTab = await openPage(chrome.cdp, {
          ...base,
          url: demoUrl,
          now: new Date().toISOString(),
          timeoutMs: 8_000,
        });
        await delay(2500);
        await demoTab.evaluate(`(() => {
          document.documentElement.dataset.theme = ${JSON.stringify(theme)};
          const s = document.createElement('style');
          s.textContent = '.demo{display:none!important}';
          document.head.append(s);
        })()`);
        const demoGo = async (route) => {
          await demoTab.evaluate(
            hashNav
              ? `location.hash = ${JSON.stringify(`#${route}`)}`
              : `(() => { __NXH.push(null, '', ${JSON.stringify(route)}); dispatchEvent(new PopStateEvent('popstate')); })()`,
          );
          await delay(900);
        };
        const demoSettle = () => delay(500);
        try {
          for (const route of routes) {
            console.log(`${theme}-${width} ${route}`);
            sigs[route] = {};
            try {
              await demoGo(route);
              const dSig = normaliseSig(await demoTab.evaluate(SIG_JS));
              if (options.shots)
                shots[route] = { demo: await fullCapture(demoTab, options.height) };
              const dTabs = options.tabs ? await tabSigs(demoTab, dSig.tabs, demoSettle) : {};
              if (options.tabs && dSig.tabs.length > 0) {
                await tabSigs(demoTab, dSig.tabs.slice(0, 1), demoSettle);
              }
              server.resetUnfixtured();
              const app = await openPage(chrome.cdp, {
                ...base,
                url: `http://127.0.0.1:${server.port}${route}`,
              });
              try {
                await app.settle();
                await delay(300);
                const aSig = normaliseSig(await app.evaluate(SIG_JS));
                if (options.shots) shots[route].app = await fullCapture(app, options.height);
                const aTabs = options.tabs ? await tabSigs(app, aSig.tabs, () => app.settle()) : {};
                sigs[route] = { demo: dSig, app: aSig, tabs: { demo: dTabs, app: aTabs } };
              } finally {
                await app.close();
              }
              if (options.shots) {
                writeFileSync(
                  join(dir, `${slug(route)}--demo.png`),
                  Buffer.from(shots[route].demo, 'base64'),
                );
                writeFileSync(
                  join(dir, `${slug(route)}--app.png`),
                  Buffer.from(shots[route].app, 'base64'),
                );
                await compose(
                  chrome.cdp,
                  shots[route].demo,
                  shots[route].app,
                  join(dir, `${slug(route)}.jpg`),
                  options.quality,
                );
                delete shots[route];
              }
            } catch (error) {
              failed[route] = String(error instanceof Error ? error.message : error).slice(0, 160);
            }
          }
        } finally {
          await demoTab.close();
        }
        const diffs = {};
        const order = [];
        for (const route of routes) {
          order.push(route);
          const s = sigs[route];
          diffs[route] = s?.demo && s?.app ? diffSigs(s.demo, s.app) : [];
          for (const label of Object.keys(s?.tabs?.demo ?? {})) {
            if (s.tabs.app[label] === undefined) continue;
            const key = `${route}#tab:${label}`;
            order.push(key);
            diffs[key] = diffSigs(s.tabs.demo[label], s.tabs.app[label]);
          }
        }
        writeFileSync(join(dir, 'sig.json'), JSON.stringify(sigs, null, 1));
        const applied = applyKeep(diffs, keep);
        const header = [
          `demo-diff ${theme} ${width}px`,
          `demo: ${demo.file}${demo.fallback ? '  (FALLBACK: the owner redesign-demo.html is missing; not the approved demo)' : ''}`,
          `live side data: ${source}`,
          `routes: ${routes.length}${options.tabs ? ' + tabs' : ''}   KEEP: ${options.keep}`,
        ];
        const report = formatReport({ header, order, diffs, applied, keep, failed });
        writeFileSync(join(dir, 'report.txt'), report.text);
        summary.push(
          `${theme}-${width}: before KEEP ${report.before}, suppressed ${report.suppressed}, remaining ${report.after}, failed ${Object.keys(failed).length}`,
        );
      }
    }
  } finally {
    server.close();
    await chrome.close();
  }
  console.log(`\n${summary.join('\n')}\nreports under ${options.out}`);
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
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
