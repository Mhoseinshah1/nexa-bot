#!/usr/bin/env node
/**
 * `node scripts/web-shots/side-by-side.mjs` — the app beside the approved demo, one image
 * per route, theme and width: the APP on the LEFT, the DEMO on the RIGHT (PROMPT.md §D-4).
 *
 *   node scripts/web-shots/side-by-side.mjs --page dashboard:/:#/
 *   node scripts/web-shots/side-by-side.mjs --page users:/users:#/users --page orders:/orders:#/orders \
 *        --themes dark,light --widths 1440,390 --fixtures demo-parity --out docs/web-redesign/demo-parity/sidebyside
 *   node scripts/web-shots/side-by-side.mjs --page dashboard-empty:/:#/ --fixtures demo-parity-empty \
 *        --demo-image docs/web-redesign/demo-parity/reference/demo-dashboard-empty--1440-dark.png --themes dark
 *
 *   --page name:appRoute:demoHash   repeatable; the output is `<name>--<theme>--<width>.jpg`
 *   --themes dark,light             default dark,light
 *   --widths 1440,390               default 1440,390
 *   --fixtures <set>                a fixture set from tests/web/shots/index.ts (`demo-parity`)
 *   --demo-image <png>              use this reference image as the right side instead of
 *                                   rendering the demo (e.g. a state the demo reaches by hand)
 *   --demo-eval <js>                run this in the demo before its capture (a state switch)
 *   --app-click <selector>          click this in the app before its capture (repeatable)
 *   --out <dir>                     default .web-shots/side-by-side
 *   --no-build                      reuse apps/web/dist
 *   --quality <0-100>               JPEG quality, default 82
 *
 * Both sides are FULL-PAGE captures at the same viewport width and theme. The app is the
 * real production build under the production CSP, answered from the fixture registry; the
 * demo is `docs/web-redesign/demo-parity/reference/approved-demo.html` opened from disk,
 * with its demo-only state bar («نمایش حالت‌ها», excluded from the spec) hidden. The two
 * are composed by Chromium itself (an HTML page holding the two PNGs), so the script needs
 * no image library. The app's capture also reports what `pnpm web:shots` reports
 * (unfixtured requests, console errors, skeletons, error cards, horizontal overflow).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROOT, buildWeb, delay, launchChrome, openPage, startServer } from './harness.mjs';
import { needsTypeStripping, shotProblems } from './policy.mjs';

const DEMO = join(ROOT, 'docs/web-redesign/demo-parity/reference/approved-demo.html');
const MAX_HEIGHT = 16000;

function parseArgs(argv) {
  const options = {
    pages: [],
    themes: ['dark', 'light'],
    widths: [1440, 390],
    fixtures: undefined,
    demoImage: undefined,
    demoEval: undefined,
    appClicks: [],
    out: join(ROOT, '.web-shots/side-by-side'),
    build: true,
    quality: 82,
    height: 900,
    timeoutMs: 15_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      i += 1;
      if (argv[i] === undefined) throw new Error(`${arg} needs a value`);
      return argv[i];
    };
    if (arg === '--page') {
      const [name, route, demo] = value().split(':');
      if (!name || !route || demo === undefined) {
        throw new Error('--page is name:appRoute:demoHash, e.g. dashboard:/:#/');
      }
      options.pages.push({ name, route, demo });
    } else if (arg === '--themes') options.themes = value().split(',');
    else if (arg === '--widths') options.widths = value().split(',').map(Number);
    else if (arg === '--fixtures') options.fixtures = value();
    else if (arg === '--demo-image') options.demoImage = resolve(value());
    else if (arg === '--demo-eval') options.demoEval = value();
    else if (arg === '--app-click') options.appClicks.push(value());
    else if (arg === '--out') options.out = resolve(value());
    else if (arg === '--no-build') options.build = false;
    else if (arg === '--quality') options.quality = Number(value());
    else if (arg === '--help' || arg === '-h') {
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.pages.length === 0) throw new Error('Name at least one --page');
  for (const theme of options.themes) {
    if (theme !== 'dark' && theme !== 'light') throw new Error('--themes takes dark and light');
  }
  return options;
}

/** A full-page PNG (base64) of whatever `page` shows, grown to the height of its scroller. */
async function fullCapture(page, width, height) {
  const tall = await page.evaluate(`(() => {
    const content = document.querySelector('.content');
    const inner = content ? content.scrollHeight - content.clientHeight : 0;
    const doc = document.documentElement.scrollHeight - window.innerHeight;
    return Math.max(0, inner, doc);
  })()`);
  if (tall > 0) {
    await page.metrics(Math.min(height + tall, MAX_HEIGHT));
    await delay(400);
  }
  const { data } = await page.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  });
  return { data, width };
}

async function captureApp(cdp, server, options, page, theme, width) {
  server.resetUnfixtured();
  const tab = await openPage(cdp, {
    url: `http://127.0.0.1:${server.port}${page.route}`,
    theme,
    width,
    height: options.height,
    now: server.now,
    timeoutMs: options.timeoutMs,
  });
  try {
    let settled = await tab.settle();
    for (const selector of options.appClicks) {
      if (!(await tab.click(selector)))
        tab.errors.push(`--app-click found nothing for ${selector}`);
      settled = (await tab.settle()) && settled;
    }
    await delay(250);
    const facts = await tab.evaluate(`(() => ({
      stillLoading: document.querySelectorAll('.skel').length > 0,
      errorStates: document.querySelectorAll('.empty.error').length,
      horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
    }))()`);
    const shot = await fullCapture(tab, width, options.height);
    const problems = shotProblems({
      settled,
      ...facts,
      errors: tab.errors,
      unfixtured: server.unfixtured(),
      timeoutMs: options.timeoutMs,
    });
    return { ...shot, problems };
  } finally {
    await tab.close();
  }
}

async function captureDemo(cdp, options, page, theme, width) {
  const tab = await openPage(cdp, {
    url: `${pathToFileURL(DEMO).href}${page.demo}`,
    theme,
    width,
    height: options.height,
    now: new Date().toISOString(),
    timeoutMs: 8_000,
  });
  try {
    await delay(1200);
    await tab.evaluate(`(() => {
      document.documentElement.dataset.theme = ${JSON.stringify(theme)};
      const style = document.createElement('style');
      style.textContent = '.demo{display:none!important}';
      document.head.append(style);
    })()`);
    if (options.demoEval !== undefined) await tab.evaluate(options.demoEval);
    await delay(500);
    return await fullCapture(tab, width, options.height);
  } finally {
    await tab.close();
  }
}

/** Composes the two PNGs side by side (app left, demo right) in Chromium and saves a JPEG. */
async function compose(cdp, left, right, file, quality) {
  const gap = 24;
  const label = 28;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;background:#3a3a40;font:600 15px system-ui,sans-serif;color:#fff}
    .row{display:flex;gap:${gap}px;padding:0 ${gap}px ${gap}px;align-items:flex-start}
    .col{display:flex;flex-direction:column}
    .col b{height:${label}px;line-height:${label}px}
    img{display:block}
  </style></head><body><div class="row">
    <div class="col"><b>APP</b><img id="a" src="data:image/png;base64,${left.data}"></div>
    <div class="col"><b>DEMO</b><img id="d" src="data:image/png;base64,${right.data}"></div>
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.build) buildWeb();
  const server = await startServer(
    options.fixtures === undefined ? {} : { fixtureSet: options.fixtures },
  );
  const chrome = await launchChrome();
  mkdirSync(options.out, { recursive: true });
  let failures = 0;
  try {
    for (const page of options.pages) {
      for (const theme of options.themes) {
        for (const width of options.widths) {
          const app = await captureApp(chrome.cdp, server, options, page, theme, width);
          const demo =
            options.demoImage === undefined
              ? await captureDemo(chrome.cdp, options, page, theme, width)
              : { data: readFileSync(options.demoImage).toString('base64'), width };
          const file = join(options.out, `${page.name}--${theme}--${width}.jpg`);
          await compose(chrome.cdp, app, demo, file, options.quality);
          if (app.problems.length > 0) failures += 1;
          console.log(
            `${app.problems.length === 0 ? 'ok  ' : 'WARN'} ${file}${app.problems.length ? `\n     ${app.problems.join('\n     ')}` : ''}`,
          );
        }
      }
    }
  } finally {
    server.close();
    await chrome.close();
  }
  if (failures > 0) process.exitCode = 1;
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
