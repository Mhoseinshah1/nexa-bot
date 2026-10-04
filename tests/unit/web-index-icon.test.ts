import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The Web Admin declares its own icon, so the browser never asks for `/favicon.ico`
 * (Issue 16, `docs/perf/web-admin-navigation.md`).
 *
 * Without a declared icon Chromium requested `/favicon.ico` on EVERY in-app navigation:
 * the edge's SPA fallback (`try_files {path} /index.html`) answers that path with the
 * document itself under `Cache-Control: no-store`, so nothing was ever cached and each
 * click cost one more uncacheable round trip. The benchmark counted it on all of them.
 */
const ROOT = join(__dirname, '../..');

describe('the web entry document', () => {
  const html = readFileSync(join(ROOT, 'apps/web/index.html'), 'utf8');

  it('declares an icon that needs no request', () => {
    expect(html).toMatch(/<link rel="icon" href="data:,"\s*\/?>/);
  });

  it('declares it in a form the production CSP allows', () => {
    // A `data:` icon the CSP refused would put the request back by another route.
    const caddy = readFileSync(join(ROOT, 'deploy/caddy/routes.caddy'), 'utf8');
    const csp = /Content-Security-Policy "([^"]+)"/.exec(caddy)?.[1] ?? '';
    const img = /img-src ([^;]+)/.exec(csp)?.[1] ?? '';
    expect(img.split(/\s+/)).toContain('data:');
  });
});
