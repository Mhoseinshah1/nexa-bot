import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReactElement } from 'react';
import { screen, waitFor } from '@testing-library/react';
import { PERMISSION_KEYS } from '@nexa/contracts';
import { NAV, resolve } from '../../apps/web/src/app';
import { t } from '../../apps/web/src/i18n/web.fa';
import { DashboardPage } from '../../apps/web/src/pages/dashboard';
import { PanelsPage } from '../../apps/web/src/pages/panels';
import { panel, renderPage, stubApi } from './harness';

/** The panels list reads its archive filter from the URL, as `/system` does. */
const LIVE_ROUTE = { path: '/panels', query: new URLSearchParams() };

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Enough of the API for every route to render its loaded state.
 *
 * Longest-match wins in the harness, so the specific routes below take
 * precedence over the general ones.
 */
const GENEROUS_ROUTES = [
  { url: '/system/readiness', body: { status: 'ok', dependencies: [] } },
  {
    url: '/health/info',
    body: {
      name: 'nexa',
      version: '1.0.0',
      commit: 'abc123',
      buildTime: '2026-09-06T00:00:00.000Z',
      nodeVersion: 'v22.11.0',
      environment: 'production',
    },
  },
  {
    url: '/system/monitor',
    body: {
      monitor: {
        enabled: true,
        tickMs: 30000,
        healthyIntervalMs: 180000,
        retryableIntervalMs: 120000,
        nonRetryableIntervalMs: 3600000,
        batchSize: 150,
        concurrency: 4,
        tenantsPerTick: 10,
        probeTenantLimit: 100,
        probeTenantWindowMs: 300000,
        probeCooldownMs: 10000,
        budgetReservePercent: 40,
        freshForMs: 900000,
        tenantFreshPanelCeiling: 60,
        installationFreshPanelCeiling: 900,
        tenantTurnCeiling: 60,
        schedulerCapacityExceeded: false,
      },
    },
  },
  { url: '/panels', body: { panels: [panel()], nextCursor: null } },
  // The DETAIL shape, which is not the list shape. `/panels/<id>` matches the
  // list route by substring, so without this the panel detail route rendered
  // its error state throughout the sweep below — which is exactly what the
  // error-state assertion there caught on its first run.
  { url: `/panels/${panel().id as string}`, body: { panel: panel() } },
  { url: '/providers', body: { providers: [] } },
  { url: '/ops-log', body: { events: [], nextCursor: null } },
  { url: '/notifications', body: { notifications: [], nextCursor: null } },
  { url: '/settings', body: { settings: [] } },
  { url: '/features', body: { flags: [] } },
  { url: '/templates', body: { templates: [] } },
  { url: '/admins', body: { admins: [] } },
  { url: '/roles', body: { roles: [] } },
  { url: '/referrals', body: { referrals: [], nextCursor: null } },
  { url: '/referral-commissions', body: { commissions: [], nextCursor: null } },
];

/**
 * The production document policy is `style-src 'self'`.
 *
 * That blocks element `style` ATTRIBUTES outright — not just `<style>` blocks
 * — so anything set through `style={{ … }}` is silently dropped in the
 * deployment and nowhere else. jsdom applies it, the Vite build emits it, and
 * every existing test passed while the dashboard's distribution bars lost
 * their widths and both reorder chevrons pointed the same way on the real
 * server.
 *
 * Failing only in production is exactly why this needs a test rather than
 * care. Two halves: the policy still says what we think it says, and the
 * rendered app contains no attribute that policy would discard.
 */
describe('the production content-security policy', () => {
  const caddy = readFileSync(join(REPO_ROOT, 'deploy/caddy/routes.caddy'), 'utf8');

  it('still forbids inline styles, which is the premise of everything below', () => {
    expect(caddy).toContain("style-src 'self'");
    expect(caddy).not.toContain("style-src 'self' 'unsafe-inline'");
    expect(caddy).not.toContain('style-src-attr');
  });

  /**
   * T27 — the ways a `style` attribute is actually set in code like this,
   * rather than one spelling of one.
   *
   * The scan recognised the literal text `style={{` and nothing else, so an
   * unrendered component could reintroduce the defect through `style={value}`,
   * `<div {...{ style }} />`, `element.style.cssText = …`,
   * `style.setProperty(…)` or `setAttribute('style', …)` and stay invisible to
   * both this scan and the two rendered checks, which covered two routes out
   * of the shell's twenty-odd.
   *
   * NOT exhaustive, and the word matters: this is a pattern list, not an AST
   * rule. The three shapes a review named — `Object.assign(node.style, …)`, an
   * aliased `const s = el.style`, and `el['style'].width = …` — now have their
   * own entries and their own samples, but the self-check below can only feed
   * the table what the table was written for, so it can never establish that
   * nothing is missing. An ESLint rule over the JSX props and the DOM style
   * APIs is the form that would close it, and is not what this ships.
   */
  const STYLE_WRITES: readonly { readonly name: string; readonly pattern: RegExp }[] = [
    // Any JSX `style` prop, whatever the expression: object literal,
    // identifier, call, conditional.
    { name: 'a JSX style prop', pattern: /(^|[\s{(])style\s*=\s*[{"']/ },
    // A `style` key inside an object that is spread onto an element.
    { name: 'a style key in a spread object', pattern: /\{\s*\.\.\.[^}]*\bstyle\s*:/ },
    {
      name: 'a style property in an object literal',
      pattern: /(^|[\s{,(])style\s*:\s*[{"'`a-zA-Z]/,
    },
    // The DOM APIs. `.style.` covers `cssText`, `setProperty` and every direct
    // property assignment in one.
    { name: 'a DOM style write', pattern: /\.style\s*(\.|\[)/ },
    // `node['style']` reaches the same property by another spelling, and
    // `Object.assign(node.style, …)` and an aliased `const s = el.style` set it
    // without any of the punctuation above ever following `.style`.
    { name: 'a computed style property access', pattern: /\[\s*['"`]style['"`]\s*\]/ },
    // `.style` that is READ rather than walked: passed as an argument, or
    // aliased to a local that is written through afterwards.
    { name: 'a style object taken by reference', pattern: /\.style\s*[,;)\]]/ },
    { name: "setAttribute('style')", pattern: /setAttribute\s*\(\s*['"`]style['"`]/ },
    { name: 'a cssText write', pattern: /cssText/ },
  ];

  function webSources(): { readonly path: string; readonly code: string }[] {
    const files: { path: string; code: string }[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) {
          // Comments stripped FIRST. The comments that explain this rule quote
          // the very patterns it looks for, so a line-prefix filter is not
          // enough — a JSX block comment's continuation lines start with
          // ordinary prose. String literals too: `t('web.…')` copy and the
          // class-name strings must not be mistaken for code.
          const code = readFileSync(full, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');
          files.push({ path: full, code });
        }
      }
    };
    walk(join(REPO_ROOT, 'apps/web/src'));
    return files;
  }

  it('has no source that sets a style attribute, by any spelling', () => {
    const offenders: string[] = [];
    for (const file of webSources()) {
      for (const line of file.code.split('\n')) {
        for (const rule of STYLE_WRITES) {
          if (rule.pattern.test(line)) {
            offenders.push(`${file.path}: ${rule.name}: ${line.trim()}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The scan is only worth what it can catch, so this proves each pattern
   * catches its own defect. A scan that matches nothing passes the test above
   * for every codebase, including one full of inline styles.
   */
  it('would catch each of those spellings', () => {
    const samples: readonly [string, string][] = [
      ['a JSX style prop', '<div style={{ width: 10 }} />'],
      ['a JSX style prop', '<div style={computed} />'],
      ['a JSX style prop', '<div style="width: 10px" />'],
      ['a style key in a spread object', '<div {...{ style: value }} />'],
      ['a style property in an object literal', 'const props = { style: { width } };'],
      ['a DOM style write', "node.style.width = '10px';"],
      ['a DOM style write', "node.style.setProperty('--w', '10px');"],
      ["setAttribute('style')", "node.setAttribute('style', 'width:10px');"],
      ['a cssText write', "node.style.cssText = 'width:10px';"],
      ['a computed style property access', "node['style'].width = '10px';"],
      ['a style object taken by reference', 'Object.assign(node.style, { width });'],
      ['a style object taken by reference', 'const s = el.style;'],
      ['a style object taken by reference', 'paint(el.style);'],
    ];
    for (const [name, line] of samples) {
      const caught = STYLE_WRITES.some((rule) => rule.pattern.test(line));
      expect(caught, `${name}: ${line}`).toBe(true);
    }
  });

  it('does not fire on the ordinary code it sits beside', () => {
    const innocent = [
      '<div className="styled" />',
      'const lifestyle = 1;',
      "import styles from './styles.css';",
      "<span className={selected ? 'on' : undefined} />",
    ];
    for (const line of innocent) {
      const caught = STYLE_WRITES.filter((rule) => rule.pattern.test(line)).map((r) => r.name);
      expect(caught, line).toEqual([]);
    }
  });

  it('renders a dashboard with no style attribute the policy would drop', async () => {
    stubApi([
      { url: '/system/readiness', body: { status: 'ok', dependencies: [] } },
      { url: '/panels', body: { panels: [panel()], nextCursor: null } },
      // `nextCursor` is REQUIRED by `operationalEventListResponseSchema`.
      // Without it the client rejects at parse, the needs-attention card
      // renders its error state, and the assertions below photograph a page
      // with a broken card — passing for the wrong reason, which is the exact
      // defect this round set out to remove.
      { url: '/ops-log', body: { events: [], nextCursor: null } },
    ]);
    const { container } = renderPage(
      <DashboardPage permissions={['panels.view', 'opslog.view']} />,
    );
    // Waited on the DATA, not on the card header: the header renders while
    // the query is still in flight, and asserting on it photographed a
    // skeleton — which is how the first version of this test found no SVG and
    // no style attribute, and passed the second half for the wrong reason.
    await screen.findByText('سالم');
    // EVERY card loaded, not just the one this assertion waits on. A fixture
    // that drifts from a frozen schema puts one card into its error state and
    // leaves the rest of the page — and the assertion below — looking fine, so
    // the test would go on passing for the wrong reason. That is the failure
    // this whole round exists to remove, and it was in this very test.
    expect(container.querySelectorAll('.skel')).toHaveLength(0);
    expect(screen.queryByText(t('web.error'))).toBeNull();

    expect(container.querySelectorAll('[style]')).toHaveLength(0);
    // And the bar still carries its magnitude — as an SVG geometry attribute,
    // which `style-src` does not govern.
    const bar = container.querySelector('svg.bar rect');
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute('width')).toBeTruthy();
  });

  it('renders a table with no style attribute, and keeps its alignment', async () => {
    stubApi([{ url: '/panels', body: { panels: [panel()], nextCursor: null } }]);
    const { container } = renderPage(<PanelsPage route={LIVE_ROUTE} mayEdit denied={false} />);
    await screen.findByText('Frankfurt A');

    expect(container.querySelectorAll('[style]')).toHaveLength(0);
    // Alignment survives as a class, so the numeric columns are still
    // end-aligned under the deployed policy.
    expect(container.querySelectorAll('.tbl .al-start').length).toBeGreaterThan(0);
  });

  /**
   * The other half of T27: every route the shell serves, rather than the two
   * above.
   *
   * A `style` attribute introduced on `/content`, `/settings` or `/system`
   * broke only in the deployment and passed everything here, because no
   * rendered check ever reached those routes. Driven through `resolve`, so
   * this walks the same table the sidebar links into, plus the two panel
   * routes `resolve` serves outside it.
   *
   * Honest about its own strength: about half of these are planned surfaces
   * that render statically, where the assertion is nearly free. The cases that
   * carry weight are the loaded data routes.
   */
  it.each([
    ...NAV.map((entry) => entry.path),
    // `resolve` serves these two outside the navigation table, and they are the
    // largest new surface on this branch. Iterating NAV alone missed them.
    '/panels/01a05e35-c9ad-7e93-bef3-1ed9b55292c8',
    '/panels/new',
  ])('renders %s with no style attribute the policy would drop', async (path) => {
    stubApi(GENEROUS_ROUTES);
    const resolved = resolve({ path, query: new URLSearchParams() }, PERMISSION_KEYS);
    const { container } = renderPage(resolved.element as ReactElement);
    // Let the queries settle, so this photographs the LOADED page rather
    // than a skeleton — the failure mode the dashboard case above records,
    // and one that would make every assertion below pass for nothing.
    await waitFor(() => {
      expect(container.querySelectorAll('.skel')).toHaveLength(0);
    });
    // And no card fell back to its error state, which a drifted fixture
    // produces and which would make the assertion below meaningless.
    expect(screen.queryByText(t('web.error'))).toBeNull();

    expect(Array.from(container.querySelectorAll('[style]')).map((node) => node.outerHTML)).toEqual(
      [],
    );
  });
});
