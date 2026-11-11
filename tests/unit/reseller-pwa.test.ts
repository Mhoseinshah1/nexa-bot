import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * The reseller panel's PWA (PR-4): the manifest, the icons, and above all the service worker's
 * one rule — it caches only the static shell and NEVER touches `/api`. The worker file is
 * evaluated here against a fake `self`, so the test runs the shipped code, not a copy.
 */
const ROOT = join(__dirname, '../..');
const PUBLIC = join(ROOT, 'apps/web/public/r');
const ORIGIN = 'https://shop.example.com';

interface FetchEvent {
  request: { method: string; url: string };
  respondWith: (answer: Promise<unknown>) => void;
}

function loadWorker(cacheControl = '') {
  const listeners: Record<string, (event: never) => void> = {};
  const puts: string[] = [];
  const cache = {
    match: () => Promise.resolve(undefined),
    put: (request: { url: string }) => {
      puts.push(request.url);
      return Promise.resolve();
    },
  };
  const fetched: string[] = [];
  const sandbox = {
    self: {
      location: { origin: ORIGIN },
      addEventListener: (name: string, handler: (event: never) => void) => {
        listeners[name] = handler;
      },
      skipWaiting: () => undefined,
      clients: { claim: () => Promise.resolve() },
    },
    caches: {
      open: () => Promise.resolve(cache),
      keys: () => Promise.resolve([]),
      delete: () => Promise.resolve(true),
    },
    fetch: (request: { url: string }) => {
      fetched.push(request.url);
      return Promise.resolve({
        ok: true,
        type: 'basic',
        headers: { get: () => cacheControl },
        clone() {
          return this;
        },
      });
    },
    URL,
    Promise,
  };
  vm.runInNewContext(readFileSync(join(PUBLIC, 'sw.js'), 'utf8'), sandbox);
  /** Runs the fetch handler; `handled` is whether the worker took the request over. */
  const run = async (url: string, method = 'GET') => {
    let handled = false;
    let answer: Promise<unknown> | undefined;
    const event: FetchEvent = {
      request: { method, url },
      respondWith: (value) => {
        handled = true;
        answer = value;
      },
    };
    (listeners['fetch'] as (event: FetchEvent) => void)(event);
    await answer;
    return handled;
  };
  return { run, puts, fetched };
}

describe('the service worker', () => {
  it('never takes over an /api request, in any spelling', async () => {
    const worker = loadWorker();
    for (const path of [
      '/api/reseller/v1/me',
      '/api/reseller/v1/services/abc/files/0',
      '/api/reseller/v1/services/abc/files-zip',
      '/api/admin/v1/auth/session',
      '/assets/../api/reseller/v1/wallet',
      '/fonts/%2e%2e/api/reseller/v1/me',
      '/r/icons/../../api/reseller/v1/me',
    ]) {
      expect(await worker.run(`${ORIGIN}${path}`), path).toBe(false);
    }
    expect(worker.puts).toEqual([]);
    expect(worker.fetched).toEqual([]);
  });

  it('does not handle the document, the other routes, another origin, or any non-GET', async () => {
    const worker = loadWorker();
    for (const url of [
      `${ORIGIN}/r/login`,
      `${ORIGIN}/r/dashboard`,
      `${ORIGIN}/`,
      `${ORIGIN}/health/live`,
      `${ORIGIN}/miniapp/x/`,
      'https://evil.example.com/assets/app.js',
    ]) {
      expect(await worker.run(url), url).toBe(false);
    }
    expect(await worker.run(`${ORIGIN}/assets/app.js`, 'POST')).toBe(false);
  });

  it('keeps only the static shell: hashed assets and the webfont', async () => {
    const worker = loadWorker();
    expect(await worker.run(`${ORIGIN}/assets/index-abc123.js`)).toBe(true);
    expect(await worker.run(`${ORIGIN}/fonts/Vazirmatn-Variable.woff2`)).toBe(true);
    expect(worker.puts).toEqual([
      `${ORIGIN}/assets/index-abc123.js`,
      `${ORIGIN}/fonts/Vazirmatn-Variable.woff2`,
    ]);
  });

  it('does not store an answer the server marked no-store', async () => {
    const worker = loadWorker('no-store');
    expect(await worker.run(`${ORIGIN}/assets/index-abc123.js`)).toBe(true);
    expect(worker.puts).toEqual([]);
  });
});

describe('the manifest', () => {
  const manifest = JSON.parse(readFileSync(join(PUBLIC, 'manifest.webmanifest'), 'utf8')) as {
    name: string;
    short_name: string;
    dir: string;
    lang: string;
    start_url: string;
    scope: string;
    display: string;
    background_color: string;
    theme_color: string;
    icons: { src: string; sizes: string; type: string; purpose: string }[];
  };

  it('is «پنل نماینده», right to left, standalone, inside /r/', () => {
    expect(manifest.name).toBe('پنل نماینده');
    expect(manifest.short_name).toBe('پنل نماینده');
    expect(manifest.dir).toBe('rtl');
    expect(manifest.lang).toBe('fa');
    expect(manifest.display).toBe('standalone');
    expect(manifest.scope).toBe('/r/');
    expect(manifest.start_url.startsWith(manifest.scope)).toBe(true);
  });

  it('takes its colours from the dark tokens', () => {
    const tokens = readFileSync(join(ROOT, 'apps/web/src/styles/tokens.css'), 'utf8');
    const bg0 = /:root,\s*:root\[data-theme='dark'\]\s*\{[^}]*--bg-0:\s*(#[0-9a-f]{6})/iu.exec(
      tokens,
    )?.[1];
    expect(bg0).toBeDefined();
    expect(manifest.background_color.toLowerCase()).toBe(bg0?.toLowerCase());
    expect(manifest.theme_color.toLowerCase()).toBe(bg0?.toLowerCase());
  });

  it('ships 192 and 512 icons as committed PNGs of exactly that size', () => {
    const sizes = manifest.icons.map((icon) => icon.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    for (const icon of manifest.icons) {
      expect(icon.src.startsWith('/r/icons/')).toBe(true);
      const file = join(PUBLIC, icon.src.replace('/r/', ''));
      expect(existsSync(file), icon.src).toBe(true);
      const png = readFileSync(file);
      expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      const [w, h] = icon.sizes.split('x').map(Number);
      expect(png.readUInt32BE(16)).toBe(w);
      expect(png.readUInt32BE(20)).toBe(h);
    }
  });
});

describe('the edge', () => {
  const caddy = readFileSync(join(ROOT, 'deploy/caddy/routes.caddy'), 'utf8');

  it('keeps the document CSP that already covers the manifest and the worker', () => {
    const csp = /Content-Security-Policy "([^"]+)"/u.exec(caddy)?.[1] ?? '';
    expect(csp).toContain("default-src 'self'");
    // No `manifest-src` / `worker-src` of their own: `default-src 'self'` (and script-src) apply.
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).toContain("script-src 'self'");
  });

  it('sends the bare panel address to the document and types the manifest', () => {
    expect(caddy).toMatch(/@reseller_root path \/r \/r\//u);
    expect(caddy).toMatch(/rewrite @reseller_root \/index\.html/u);
    expect(caddy).toMatch(/header @reseller_manifest Content-Type "application\/manifest\+json"/u);
  });
});
