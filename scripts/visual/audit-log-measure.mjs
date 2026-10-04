// Issue 15 visual probe: serve a built Web Admin, stub the API from the repo's visual
// fixtures plus an audit-log page, and measure /audit-log at 1280/390 in light and dark.
// Usage (after `pnpm --filter @nexa/web build`, with playwright resolvable as for capture.mjs):
//   node scripts/visual/audit-log-measure.mjs apps/web/dist <out-dir> <long|short>
// Writes <out-dir>/audit-*.png and measure-<set>.json (table vs wrap width, column widths,
// row heights, cell offsets). Not part of CI.
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const { ROUTES, INFO } = await import('./fixtures.mjs');

const ROOT = resolve(process.argv[2]);
const OUT = resolve(process.argv[3]);
const SET = process.argv[4] ?? 'long';
await mkdir(OUT, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
};
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let file = join(ROOT, url.pathname);
  if (!existsSync(file) || url.pathname.endsWith('/')) file = join(ROOT, 'index.html');
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
const PORT = 5300 + Math.floor(Math.random() * 500);
await new Promise((done) => server.listen(PORT, done));

const none = { customerId: null, orderId: null, paymentId: null, serviceId: null };
let n = 0;
const entry = (o) => ({
  id: `019360ab-cdef-7012-8345-6789abcdef${String(++n).padStart(2, '0')}`,
  occurredAt: '2026-10-04T10:00:00.000Z',
  actorType: 'WEB_ADMIN',
  actorId: '01a05e35-c9ad-7e93-bef3-1ed9b55292c8',
  actorLabel: 'owner',
  surface: 'WEB',
  action: 'settings.update',
  entityType: 'Setting',
  entityId: null,
  result: 'SUCCESS',
  reason: null,
  correlationId: 'corr-1',
  before: null,
  after: null,
  security: [],
  links: none,
  ...o,
});
const job = (u) => ({
  actorType: 'SYSTEM_JOB',
  actorId: `telegram-update:019370ab-cdef-7012-8345-6789abcdef09:${u}`,
  actorLabel: `job:telegram-update:019370ab-cdef-7012-8345-6789abcdef09:${u}`,
  surface: 'WORKER',
  action: 'customer.register',
  entityType: 'Customer',
  entityId: '019320ab-cdef-7012-8345-6789abcdef01',
  links: { ...none, customerId: '019320ab-cdef-7012-8345-6789abcdef01' },
});
const SHORT = [
  entry({}),
  entry({ actorLabel: 'مدیر اصلی' }),
  entry({
    action: 'order.confirm',
    entityType: 'Order',
    entityId: '019350ab-cdef-7012-8345-6789abcdef01',
    links: { ...none, orderId: '019350ab-cdef-7012-8345-6789abcdef01' },
  }),
  entry({ result: 'DENIED', security: ['DENIED'], action: 'panels.edit' }),
  entry({ actorLabel: 'support', action: 'ticket.reply' }),
];
const LONG = [
  entry({}),
  entry({ ...job('918273645501928374') }),
  entry({
    ...job('918273645501928375'),
    action: 'customer.register_from_telegram_update_with_referral',
  }),
  entry({ actorLabel: 'مدیر اصلی', action: 'settings.update' }),
  entry({
    actorType: 'SYSTEM_JOB',
    actorId: 'sweep',
    actorLabel: 'job:sweep',
    surface: 'WORKER',
    action: 'cashback.earn',
  }),
];
const AUDIT = { entries: SET === 'long' ? LONG : SHORT, nextCursor: null };
const SESSION = {
  ...ROUTES['/auth/session'],
  permissions: [...ROUTES['/auth/session'].permissions, 'audit.view', 'audit.export'],
};

const PREFIX = '/api/admin/v1';
const browser = await chromium.launch();
const results = [];
for (const width of [1280, 390]) {
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({
      viewport: { width, height: width === 390 ? 844 : 900 },
      deviceScaleFactor: 1,
      locale: 'fa-IR',
      colorScheme: theme,
    });
    await context.addInitScript((t) => {
      try {
        localStorage.setItem('nexa.theme', t);
      } catch {
        // Storage refused: the colorScheme above still selects the theme.
      }
    }, theme);
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      const p = url.pathname;
      if (p.startsWith('/health/info')) return route.fulfill({ json: INFO });
      if (p.startsWith(PREFIX)) {
        const rest = p.slice(PREFIX.length);
        if (rest === '/auth/session') return route.fulfill({ json: SESSION });
        if (rest === '/audit-log') return route.fulfill({ json: AUDIT });
        const key = Object.keys(ROUTES)
          .filter((c) => rest === c || rest.startsWith(`${c}/`))
          .sort((a, b) => b.length - a.length)[0];
        if (key) return route.fulfill({ json: ROUTES[key] });
        return route.fulfill({
          status: 404,
          json: { error: { kind: 'not_found', code: 'x', message: rest, correlationId: 'x' } },
        });
      }
      return route.continue();
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://localhost:${PORT}/audit-log`, { waitUntil: 'networkidle' });
    await page.waitForSelector('table.tbl tbody tr', { timeout: 15000 });
    if (process.env.EXTRA_CSS) await page.addStyleTag({ content: process.env.EXTRA_CSS });
    await page.waitForTimeout(400);
    const m = await page.evaluate(() => {
      const wrap = document.querySelector('.tbl-wrap');
      const table = wrap.querySelector('table.tbl');
      const ths = [...table.querySelectorAll('thead th')].map((th) =>
        Math.round(th.getBoundingClientRect().width),
      );
      const rows = [...table.querySelectorAll('tbody tr')].map((tr) => {
        const td = tr.children[1];
        const val = td.querySelector('bdi, .ltr.mono');
        const cell = td.getBoundingClientRect();
        const v = val?.getBoundingClientRect();
        const cs = val ? getComputedStyle(val) : null;
        return {
          rowH: Math.round(tr.getBoundingClientRect().height),
          tdH: [...tr.children]
            .map((c) =>
              Math.round(
                [...c.children].reduce((h, k) => Math.max(h, k.getBoundingClientRect().height), 0),
              ),
            )
            .join('/'),
          text: val?.textContent ?? null,
          cls: val?.className ?? null,
          font: cs?.fontFamily.split(',')[0] ?? null,
          lines: v && cs ? Math.round(v.height / parseFloat(cs.lineHeight || '0')) : null,
          gapFromCellStart: v ? Math.round(cell.right - v.right) : null,
          copy: td.querySelector('button[data-copy-value]') !== null,
          actionGap: (() => {
            const a = tr.children[2].querySelector('.clamp-2');
            return a
              ? Math.round(
                  tr.children[2].getBoundingClientRect().right - a.getBoundingClientRect().right,
                )
              : null;
          })(),
        };
      });
      return {
        wrapClient: wrap.clientWidth,
        tableScroll: table.scrollWidth,
        scrollsSideways: wrap.scrollWidth > wrap.clientWidth + 1,
        bodyOverflow:
          document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        columnWidths: ths,
        rows,
      };
    });
    const name = `audit-${SET}-${width}-${theme}`;
    await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
    await page.locator('.tbl-wrap').screenshot({ path: join(OUT, `${name}-table.png`) });
    results.push({ name, errors, ...m });
    await context.close();
  }
}
await browser.close();
server.close();
await writeFile(join(OUT, `measure-${SET}.json`), JSON.stringify(results, null, 2));
for (const r of results) {
  console.log(
    `${r.name}: table ${r.tableScroll}px / wrap ${r.wrapClient}px sideways=${r.scrollsSideways} bodyOverflow=${r.bodyOverflow} cols=${r.columnWidths.join(',')} errors=${r.errors.length}`,
  );
  for (const row of r.rows)
    console.log(
      `   h=${row.rowH} td=${row.tdH} lines=${row.lines} font=${row.font} startGap=${row.gapFromCellStart} actionGap=${row.actionGap} copy=${row.copy} cls="${row.cls}" ${row.text?.slice(0, 40)}`,
    );
}
