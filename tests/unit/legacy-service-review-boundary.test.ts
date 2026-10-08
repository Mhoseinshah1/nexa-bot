import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Mirza migration PR5 — the operator's review of legacy service candidates is its OWN
 * service, reachable from the Web Admin, and it must never become a back door to the two
 * migration-only paths it sits beside:
 *
 * 1. It adopts NOTHING. The module imports neither the P6 adoption nor any provider client,
 *    adapter, transport or network API: an ADOPT approval is a label the next import run
 *    executes through P6, so a provider write from a click is impossible by construction.
 * 2. It is not the terminal Manual Review Queue (charged to the CRITICAL maintenance.run,
 *    kept off every surface by `legacy-review-queue-boundary`). The module and its surfaces
 *    name neither the queue's service nor its resolutions.
 * 3. Only the importer writes outcomes: the review service holds no `insert`/`updateOutcome`
 *    call, so no web request can invent or rewrite an outcome.
 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

const MODULE = 'apps/api/src/modules/platform/legacy-service-review';
const SURFACES = [
  'apps/api/src/surfaces/web/legacy-services.controller.ts',
  'apps/web/src/pages/legacy-services.tsx',
];

describe('the legacy service review boundary', () => {
  it('the module imports no adoption, provider client, adapter, transport or network API', () => {
    const files = sources(MODULE);
    expect(files.length).toBeGreaterThanOrEqual(4);
    const forbidden = [
      /legacy-adoption|LegacyAdoptionService|adoptCandidate/,
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

  it('neither the module nor its surfaces reach the terminal review queue', () => {
    const files = [...sources(MODULE), ...SURFACES];
    const offenders = files.filter((file) =>
      /legacy-review-queue|legacyReviewQueue|LegacyReviewQueue|resolveReview|reopenReview/.test(
        readFileSync(file, 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('the review service never writes an outcome: only the importer does', () => {
    const service = readFileSync(`${MODULE}/application/legacy-service-review.service.ts`, 'utf8');
    expect(service).not.toMatch(/\.insert\(|\.updateOutcome\(/u);
    // Every decision is the one conditional transition, bound to the version.
    expect(service).toMatch(/repository\.transition\(/u);
    expect(service).toMatch(/expectedVersion/u);
  });

  it('the importer is the one writer of outcomes and executes approvals through P6 only', () => {
    const importer = readFileSync(
      'apps/api/src/modules/platform/legacy-importer/application/legacy-importer.service.ts',
      'utf8',
    );
    expect(importer).toMatch(/serviceCandidates\.insert\(/u);
    expect(importer).toMatch(/serviceCandidates\.updateOutcome\(/u);
    // The only adoption call is the P6 seam.
    expect(importer.match(/\.adopt\(/gu)?.length).toBe(1);
    expect(importer).toMatch(/this\.deps\.adoption\.adopt\(/u);
  });
});
