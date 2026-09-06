import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { screen } from '@testing-library/react';
import { DashboardPage } from '../../apps/web/src/pages/dashboard';
import { PanelsPage } from '../../apps/web/src/pages/panels';
import { panel, renderPage, stubApi } from './harness';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

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

  it('has no source that sets a style attribute', () => {
    // A source-level check as well as the rendered one below, because a
    // component nothing renders in this suite would slip past the DOM check
    // and then break in the browser.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) {
          // Comments stripped FIRST. The comments that explain this rule
          // quote `style={{` themselves, so a line-prefix filter is not
          // enough — a JSX block comment's continuation lines start with
          // ordinary prose.
          const code = readFileSync(full, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');
          for (const line of code.split('\n')) {
            if (line.includes('style={{')) offenders.push(`${full}: ${line.trim()}`);
          }
        }
      }
    };
    walk(join(REPO_ROOT, 'apps/web/src'));
    expect(offenders).toEqual([]);
  });

  it('renders a dashboard with no style attribute the policy would drop', async () => {
    stubApi([
      { url: '/system/readiness', body: { status: 'ok', dependencies: [] } },
      { url: '/panels', body: { panels: [panel()], nextCursor: null } },
      { url: '/ops-log', body: { events: [] } },
    ]);
    const { container } = renderPage(
      <DashboardPage permissions={['panels.view', 'opslog.view']} />,
    );
    // Waited on the DATA, not on the card header: the header renders while
    // the query is still in flight, and asserting on it photographed a
    // skeleton — which is how the first version of this test found no SVG and
    // no style attribute, and passed the second half for the wrong reason.
    await screen.findByText('سالم');

    expect(container.querySelectorAll('[style]')).toHaveLength(0);
    // And the bar still carries its magnitude — as an SVG geometry attribute,
    // which `style-src` does not govern.
    const bar = container.querySelector('svg.bar rect');
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute('width')).toBeTruthy();
  });

  it('renders a table with no style attribute, and keeps its alignment', async () => {
    stubApi([{ url: '/panels', body: { panels: [panel()], nextCursor: null } }]);
    const { container } = renderPage(<PanelsPage mayEdit denied={false} />);
    await screen.findByText('Frankfurt A');

    expect(container.querySelectorAll('[style]')).toHaveLength(0);
    // Alignment survives as a class, so the numeric columns are still
    // end-aligned under the deployed policy.
    expect(container.querySelectorAll('.tbl .al-start').length).toBeGreaterThan(0);
  });
});
