import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { ARCHIVED_PANELS_PAGE, INFO, PANELS, ROUTES } from './fixtures.mjs';

/**
 * Visual verification for the production Web Admin.
 *
 * NOT on the `pnpm verify` path: it needs Playwright and a Chromium binary,
 * which the repository deliberately does not depend on. Run it by hand:
 *
 *     pnpm --filter @nexa/web build
 *     npm i --no-save playwright && npx playwright install chromium
 *     node scripts/visual/capture.mjs apps/web/dist <output-dir>
 *
 * It exists because a claim about visual verification that leaves no probe
 * behind is worse than no claim: the reader believes a gate that is not
 * there. The numbers any commit message cites come from the JSON this writes
 * beside the captures.
 *
 * It serves the REAL production build — `apps/web/dist`, the same bundle the
 * deployment publishes — and answers `/api` and `/health` from fixtures shaped
 * by the frozen contracts. Nothing about the page is mocked: the router, the
 * query client, the components and the stylesheet are the shipped ones.
 *
 * Every visit records console errors, page errors and page-level horizontal
 * overflow, so the report is a measurement rather than an impression.
 */

const ROOT = resolve(process.argv[2] ?? 'apps/web/dist');
const OUT = resolve(process.argv[3] ?? 'screens');
const PORT = 5199;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  let file = join(ROOT, url.pathname);
  // The SPA fallback the production edge does with `try_files`.
  if (!existsSync(file) || url.pathname.endsWith('/')) file = join(ROOT, 'index.html');
  try {
    const body = await readFile(file);
    response.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404).end('not found');
  }
});

await new Promise((done) => server.listen(PORT, done));

const PREFIX = '/api/admin/v1';

const VIEWS = [
  { key: 'desktop-dark', theme: 'dark', width: 1440, height: 950 },
  { key: 'desktop-light', theme: 'light', width: 1440, height: 950 },
  { key: 'mobile-dark', theme: 'dark', width: 390, height: 844 },
];

/** The panel the interactive create pass makes, and the name it must be told back. */
const CREATED_ID = '01a05e35-c9ad-7e93-bef3-1ed9b55292fe';
const CREATED_NAME = 'Oslo A';

const PAGES = [
  ['dashboard', '/'],
  ['panels', '/panels'],
  ['panels-archived', '/panels?archived=only'],
  ['panel-detail', `/panels/${PANELS[0].id}`],
  ['panel-new', '/panels/new'],
  ['providers', '/providers'],
  ['settings', '/settings'],
  ['features', '/features'],
  ['content', '/content'],
  ['alerts', '/alerts'],
  ['notifications', '/notifications'],
  ['system', '/system'],
  ['system-monitor', '/system?section=monitor'],
  ['system-admins', '/system?section=admins'],
  ['users-planned', '/users'],
  ['services-planned', '/services'],
  ['orders-planned', '/orders'],
  ['payments-planned', '/payments'],
  ['products-planned', '/products'],
  ['bots-planned', '/bots'],
  ['reports-planned', '/reports'],
  ['resellers-planned', '/resellers'],
  ['discounts-planned', '/discounts'],
  ['not-found', '/nowhere'],
];

const browser = await chromium.launch();
const findings = [];

for (const view of VIEWS) {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: 2,
    locale: 'fa-IR',
    colorScheme: view.theme,
  });

  await context.addInitScript((theme) => {
    try {
      window.localStorage.setItem('nexa.theme', theme);
    } catch {
      /* a browser that refuses storage still gets the system theme */
    }
  }, view.theme);

  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path.startsWith('/health/info')) {
      return route.fulfill({ json: INFO });
    }
    if (path.startsWith(PREFIX)) {
      const rest = path.slice(PREFIX.length);
      // Longest match first, so `/panels/:id` is not answered by `/panels`.
      const key = Object.keys(ROUTES)
        .filter((candidate) => rest === candidate || rest.startsWith(`${candidate}/`))
        .sort((a, b) => b.length - a.length)[0];

      // The archive is a QUERY on the same path, so the pathname alone would
      // answer it with the live fleet — the live rows under the archived
      // heading, which is precisely the screen this view exists to check.
      if (rest === '/panels' && url.searchParams.get('archived') === 'only') {
        return route.fulfill({ json: ARCHIVED_PANELS_PAGE });
      }

      const detail = /^\/panels\/([^/]+)$/.exec(rest);
      if (detail && detail[1] !== 'new') {
        const found = PANELS.find((panel) => panel.id === detail[1]);
        if (found) return route.fulfill({ json: { panel: found } });
      }
      if (key) return route.fulfill({ json: ROUTES[key] });
      return route.fulfill({
        status: 404,
        json: {
          error: { kind: 'not_found', code: 'fixture.missing', message: rest, correlationId: 'x' },
        },
      });
    }
    return route.continue();
  });

  const page = await context.newPage();
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`));

  for (const [name, path] of PAGES) {
    errors.length = 0;
    await page.goto(`http://localhost:${PORT}${path}`, { waitUntil: 'networkidle' });
    // Long enough for react-query's retry backoff to settle. A query whose
    // response fails schema validation stays PENDING through its retry, so a
    // short wait photographs a loading skeleton and calls it a verified page.
    await page.waitForTimeout(2500);

    // The shell must own its scrolling. If the DOCUMENT scrolls, the sidebar
    // and the topbar leave the screen — the one thing a fixed shell exists to
    // prevent — so this is measured on every route rather than eyeballed.
    await page.evaluate(() => window.scrollTo(0, 5000));
    const pageScrolledBy = await page.evaluate(() => window.scrollY);
    await page.evaluate(() => window.scrollTo(0, 0));

    // Did the page actually RENDER, or only draw its shell?
    //
    // This is the measurement that was missing. Four routes were photographed
    // showing a loading skeleton because the fixtures had drifted from the
    // frozen schemas, the client's `schema.parse` threw, and react-query held
    // the query pending through its retry. Every screenshot looked plausible
    // and verified nothing but the chrome.
    const unsettled = await page.evaluate(() => ({
      skeleton: document.querySelector('.skel') !== null,
      errorState: (document.body.textContent ?? '').includes('خطا در ارتباط با سرور'),
    }));

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      theme: document.documentElement.getAttribute('data-theme'),
      dir: document.documentElement.getAttribute('dir'),
    }));

    await page.screenshot({
      path: join(OUT, `${view.key}--${name}.png`),
      fullPage: true,
    });

    findings.push({
      view: view.key,
      kind: 'route',
      page: name,
      path,
      theme: overflow.theme,
      dir: overflow.dir,
      horizontalOverflow: overflow.scrollWidth > overflow.clientWidth,
      overflowBy: overflow.scrollWidth - overflow.clientWidth,
      pageScrolledBy,
      stillLoading: unsettled.skeleton,
      showingError: unsettled.errorState,
      errors: [...errors],
    });
  }

  await context.close();
}

/*
 * One capture that no URL can reach.
 *
 * The create confirmation only exists for an actor holding `panels.edit` and
 * NOT `panels.view`: everyone else is navigated to the new panel's detail page,
 * which is where the edit-only actor used to land on a permission-denied screen
 * with no way back. So the state has to be REACHED — a different session, a
 * filled form, a real submit — rather than photographed from a route.
 *
 * It is a separate pass rather than a fourth view so it does not multiply
 * every other page by a permission set that changes only this one screen.
 */
{
  const view = VIEWS[0];
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: 2,
    locale: 'fa-IR',
    colorScheme: view.theme,
  });
  await context.addInitScript((theme) => {
    try {
      window.localStorage.setItem('nexa.theme', theme);
    } catch {
      /* a browser that refuses storage still gets the system theme */
    }
  }, view.theme);

  const EDIT_ONLY = {
    ...ROUTES['/auth/session'],
    permissions: ROUTES['/auth/session'].permissions.filter((p) => p !== 'panels.view'),
  };

  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.startsWith('/health/info')) return route.fulfill({ json: INFO });
    if (path.startsWith(PREFIX)) {
      const rest = path.slice(PREFIX.length);
      if (rest === '/auth/session') return route.fulfill({ json: EDIT_ONLY });
      // The create itself. Answering it with the LIST — which is what a
      // path-only match does — would fail the client's schema parse and
      // photograph an error toast instead of the confirmation.
      if (rest === '/panels' && route.request().method() === 'POST') {
        const sent = JSON.parse(route.request().postData() ?? '{}');
        return route.fulfill({
          status: 201,
          json: { panel: { ...PANELS[0], id: CREATED_ID, name: sent.name ?? 'بدون نام' } },
        });
      }
      const key = Object.keys(ROUTES)
        .filter((candidate) => rest === candidate || rest.startsWith(`${candidate}/`))
        .sort((a, b) => b.length - a.length)[0];
      if (key) return route.fulfill({ json: ROUTES[key] });
      return route.fulfill({
        status: 404,
        json: {
          error: { kind: 'not_found', code: 'fixture.missing', message: rest, correlationId: 'x' },
        },
      });
    }
    return route.continue();
  });

  const page = await context.newPage();
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`));

  await page.goto(`http://localhost:${PORT}/panels/new`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  await page.fill('#new-name', CREATED_NAME);
  await page.selectOption('#new-provider', 'marzban');
  await page.fill('#new-url', 'https://new-panel.example/api');
  await page.click('button[type="submit"]');
  await page.waitForTimeout(1500);

  // Measured here exactly as in the loop above. An earlier version asserted
  // `pageScrolledBy: 0` and `stillLoading: false` on this finding instead of
  // measuring them, which quietly exempted the one capture with the most going
  // on from the shell-scroll check the loop calls "measured on every route".
  await page.evaluate(() => window.scrollTo(0, 5000));
  const pageScrolledBy = await page.evaluate(() => window.scrollY);
  await page.evaluate(() => window.scrollTo(0, 0));

  const state = await page.evaluate(() => ({
    text: document.body.textContent ?? '',
    path: window.location.pathname,
    skeleton: document.querySelector('.skel') !== null,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    theme: document.documentElement.getAttribute('data-theme'),
    dir: document.documentElement.getAttribute('dir'),
  }));

  await page.screenshot({
    path: join(OUT, `${view.key}--panel-created.png`),
    fullPage: true,
  });

  // The two things this capture exists to prove, measured rather than eyeballed:
  // the actor was NOT navigated away, and the panel they made is named back.
  if (state.path !== '/panels/new') errors.push(`navigated away to ${state.path}`);
  if (!state.text.includes(CREATED_NAME)) errors.push('the created panel was not named back');

  findings.push({
    view: view.key,
    kind: 'interactive',
    page: 'panel-created',
    path: '/panels/new (submitted, edit-only session)',
    theme: state.theme,
    dir: state.dir,
    horizontalOverflow: state.scrollWidth > state.clientWidth,
    overflowBy: state.scrollWidth - state.clientWidth,
    pageScrolledBy,
    stillLoading: state.skeleton,
    showingError: state.text.includes('خطا در ارتباط با سرور'),
    errors: [...errors],
  });

  await context.close();
}

await browser.close();
server.close();

const bad = findings.filter(
  (f) =>
    f.horizontalOverflow ||
    f.errors.length > 0 ||
    f.pageScrolledBy > 0 ||
    f.stillLoading ||
    f.showingError,
);
const wrongTheme = findings.filter((f) => !f.view.includes(f.theme ?? 'none'));
const wrongDir = findings.filter((f) => f.dir !== 'rtl');

const summary = {
  captured: findings.length,
  // Routes x views, plus the interactive states, which are single-view by
  // construction. Reported separately because `PAGES.length + 1` read as if
  // `captured` should be `pages x views` and left two captures looking lost.
  routes: PAGES.length,
  views: VIEWS.map((v) => v.key),
  // From a field on the finding, not from a parenthesis in a display string:
  // the previous spelling was correct only because no route path happened to
  // contain one, and a second interactive capture written without one would
  // have silently gone uncounted.
  interactiveStates: findings.filter((f) => f.kind === 'interactive').length,
  horizontalOverflow: findings.filter((f) => f.horizontalOverflow).length,
  documentScrolledInsteadOfShell: findings.filter((f) => f.pageScrolledBy > 0).length,
  stillLoadingAfterSettle: findings.filter((f) => f.stillLoading).length,
  showingErrorState: findings.filter((f) => f.showingError).length,
  consoleOrPageErrors: findings.reduce((sum, f) => sum + f.errors.length, 0),
  themeMismatches: wrongTheme.length,
  nonRtl: wrongDir.length,
  problems: bad,
  findings,
};
// WRITTEN beside the CAPTURES, not next to this script, and written rather
// than only printed. An earlier version logged its result and nothing else,
// so a `verification.json` from a previous run sat on disk looking current —
// and a later run's real numbers could be read as clean when they were not.
// Writing it into the output directory ties the summary to the images it
// describes.
writeFileSync(join(OUT, 'verification.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, findings: undefined }, null, 2));
