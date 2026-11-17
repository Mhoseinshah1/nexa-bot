/** Targeted pagination/history visual regression. Build Web first; no external requests.
 * NEXA_CHROMIUM=/usr/bin/chromium node --experimental-strip-types \
 *   scripts/web-shots/reseller-bot-requests.mjs /tmp/reseller-bot-shots
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchChrome, openPage, startServer } from './harness.mjs';
import { me } from '../../tests/web/reseller-fixtures.ts';

const out = resolve(process.argv[2] ?? '.web-shots/reseller-bot-requests');
mkdirSync(out, { recursive: true });
const now = '2026-11-10T10:00:00.000Z';
const firstId = '0190a0b0-0000-7000-8000-0000000000aa';
const olderId = '0190a0b0-0000-7000-8000-0000000000bb';
const request = (older = false) => ({
  id: older ? olderId : firstId,
  number: older ? '11' : '12',
  state: older ? 'APPROVED' : 'PENDING',
  botUsername: older ? 'older_linked_bot' : 'current_request_bot',
  tokenMasked: '••••••••123456',
  domain: 'bots.example.test',
  fee: { amountMinor: '500000', currency: 'IRT' },
  createdAt: now,
  decidedAt: older ? now : null,
  rejectReason: null,
  cancelledAt: null,
  hostedBot: { linked: older, state: older ? 'ACTIVE' : null },
  hostedTenantId: older ? '0190a0b0-0000-7000-8000-0000000000cc' : null,
  billing: {
    state: older ? 'PAID' : 'NONE',
    paidThrough: older ? '2026-12-10T10:00:00.000Z' : null,
    stopsAt: null,
  },
  timeline: [
    { event: 'SUBMITTED', at: now, amount: null, period: null },
    ...(older
      ? [
          { event: 'APPROVED', at: now, amount: null, period: null },
          { event: 'BOT_CREATED', at: now, amount: null, period: null },
        ]
      : []),
  ],
  customer: { id: firstId, displayName: 'نماینده نمونه', telegramUserId: '1001' },
});
const status = {
  factor: 'ACTIVE',
  recoveryCodesRemaining: 8,
  session: { expiresAt: '2026-12-10T10:00:00.000Z' },
  lockedUntil: null,
  create: { enabled: true, refusal: null },
};
const server = await startServer();
const chrome = await launchChrome();
const report = [];
try {
  for (const view of [
    { width: 390, theme: 'dark' },
    { width: 390, theme: 'light' },
    { width: 820, theme: 'dark' },
    { width: 1440, theme: 'dark' },
    { width: 1440, theme: 'light' },
  ]) {
    for (const route of ['/hosting', '/r/bot']) {
      server.resetUnfixtured();
      const page = await openPage(chrome.cdp, {
        url: 'about:blank',
        ...view,
        height: 1000,
        touch: view.width < 900,
        collapsed: view.width < 900,
        now,
        timeoutMs: 15000,
      });
      const off = chrome.cdp.on((message) => {
        if (message.method !== 'Fetch.requestPaused') return;
        const url = new URL(message.params.request.url);
        let body;
        if (url.pathname === '/api/reseller/v1/me') body = me();
        else if (url.pathname === '/api/reseller/v1/own-bot')
          body = {
            offer: { offered: true, fee: request().fee, graceDays: 3, canRequest: false },
            requests: [request(), request(true)],
          };
        else if (url.pathname === '/api/admin/v1/hosting/status') body = status;
        else if (url.pathname === '/api/admin/v1/hosting/bots')
          body = { bots: [], create: status.create };
        else if (url.pathname === '/api/admin/v1/hosting/server') body = { measuredAt: now };
        else if (url.pathname === '/api/admin/v1/hosting/reseller-bot-requests')
          body = {
            requests: [request(url.searchParams.has('cursor'))],
            nextCursor: url.searchParams.has('cursor') ? null : firstId,
            settings: { fee: request().fee, graceDays: 3 },
          };
        const params = { requestId: message.params.requestId };
        void chrome.cdp.send(
          body === undefined ? 'Fetch.continueRequest' : 'Fetch.fulfillRequest',
          body === undefined
            ? params
            : {
                ...params,
                responseCode: 200,
                responseHeaders: [{ name: 'content-type', value: 'application/json' }],
                body: Buffer.from(JSON.stringify(body)).toString('base64'),
              },
          message.sessionId,
        );
      });
      await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*' }] });
      await page.send('Page.navigate', { url: `http://127.0.0.1:${server.port}${route}` });
      if (!(await page.settle())) throw new Error(`unsettled: ${route}`);
      if (route === '/hosting') {
        const selected = await page.evaluate(
          `(() => { const tab = [...document.querySelectorAll('[role=tab]')].find(el => el.textContent.includes('درخواست')); tab?.click(); return !!tab; })()`,
        );
        if (!selected || !(await page.settle())) throw new Error('owner request tab missing');
      } else if (!(await page.click('details.disclosure > summary')))
        throw new Error('historical timeline missing');
      const facts = await page.evaluate(`(() => ({
        rtl: document.documentElement.dir === 'rtl',
        overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
        visible: document.body.innerText.includes(${JSON.stringify(route === '/hosting' ? 'current_request_bot' : 'older_linked_bot')}),
        targets: [...document.querySelectorAll('button, summary')].filter(el =>
          el.matches('.disclosure > summary') || ['بارگذاری بیشتر', 'تازه‌سازی'].some(text => el.textContent.trim() === text)
        ).map(el => ({ text: el.textContent.trim(), height: el.getBoundingClientRect().height })),
      }))()`);
      if (
        !facts.rtl ||
        !facts.visible ||
        facts.overflow > 0 ||
        page.errors.length > 0 ||
        (view.width < 900 && facts.targets.some((target) => target.height < 44))
      ) {
        throw new Error(JSON.stringify({ route, view, facts, errors: page.errors }));
      }
      if (server.unfixtured().length > 0) throw new Error(JSON.stringify(server.unfixtured()));
      const shot = await page.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
      });
      const file = `${route === '/hosting' ? 'owner-pages' : 'own-history'}.${view.width}-${view.theme}.png`;
      writeFileSync(resolve(out, file), Buffer.from(shot.data, 'base64'));
      if (route === '/hosting') {
        await page.evaluate(
          `([...document.querySelectorAll('button')].find(el => el.textContent.trim() === 'بارگذاری بیشتر')).click()`,
        );
        if (
          !(await page.settle()) ||
          !(await page.evaluate(`document.body.innerText.includes('older_linked_bot')`))
        ) {
          throw new Error('load more did not reveal the older request');
        }
      }
      report.push({ route, ...view, ...facts, file });
      off();
      await page.close();
    }
  }
  writeFileSync(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(
    `passed=${report.length} failed=0: RTL, overflow, touched-control size, history expansion and load more`,
  );
} finally {
  await chrome.close();
  server.close();
}
