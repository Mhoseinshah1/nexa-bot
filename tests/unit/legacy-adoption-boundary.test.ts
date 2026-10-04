import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Migration P6: the adoption write path (`docs/migration-p6-service-adoption.md`).
 *
 * 1. MIGRATION-ONLY. It writes a PAID order at birth and a live service with no operation,
 *    so no surface may reach it — no controller, no Telegram handler, no web page. The
 *    composition root constructs it and the P7 importer is its one caller.
 * 2. ADOPTION IS NOT PROVISIONING. The module holds no provider client, adapter, transport
 *    or the providers module at all, so a provider mutation is impossible by construction,
 *    not by discipline. This fails the day one is imported.
 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

const MODULE = 'apps/api/src/modules/commerce/legacy-adoption';

describe('the legacy adoption boundary', () => {
  it('is reachable from no surface and no web page', () => {
    const files = [...sources('apps/api/src/surfaces'), ...sources('apps/web/src')];
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.filter((file) =>
      /legacy-adoption|legacyAdoption|LegacyAdoption/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('imports no provider client, adapter, transport or network API', () => {
    const files = sources(MODULE);
    expect(files.length).toBeGreaterThanOrEqual(3);
    const forbidden = [
      /modules\/platform\/providers\//,
      /ProviderHttpClient|ProviderAdapter|AdapterRegistry|adapterFor|RickpanelAdapter/,
      /RickpanelReadOnlyHttp|RickpanelInventoryReader/,
      /from 'node:(http|https|net|tls|dgram)'/,
      /\bfetch\s*\(/,
      /provisioning\.service|provisioner\.service|provision-executor/,
    ];
    const offenders = files.flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      return forbidden.filter((rule) => rule.test(text)).map((rule) => `${file}: ${String(rule)}`);
    });
    expect(offenders).toEqual([]);
  });

  it('is wired in the container with no provider dependency', () => {
    const container = readFileSync('apps/api/src/container.ts', 'utf8');
    const start = container.indexOf('const legacyAdoption = new LegacyAdoptionService({');
    expect(start).toBeGreaterThan(0);
    const block = container.slice(start, container.indexOf('});', start));
    expect(block).not.toMatch(/provider|adapter|http|probe|operations|provisioning/i);
  });
});
