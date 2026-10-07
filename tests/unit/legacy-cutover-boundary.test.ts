import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Mirza migration PR6 — the cutover approval is the owner's CONSENT, reachable from the Web
 * Admin, and must never become a way to import from a click:
 *
 * 1. The module imports nothing that writes a business row or calls a provider: no importer,
 *    no adoption, no opening balance, no provider client, no network API.
 * 2. Its surfaces name neither the importer nor the terminal review queue.
 * 3. Its repository never UPDATEs or DELETEs: approvals and revocations are append-only, and
 *    the database refuses both anyway (0233).
 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

const MODULE = 'apps/api/src/modules/platform/legacy-cutover';
const SURFACES = [
  'apps/api/src/surfaces/web/legacy-cutover.controller.ts',
  'apps/web/src/pages/legacy-cutover.tsx',
];

describe('the legacy cutover boundary', () => {
  it('the module imports no importer, adoption, wallet writer, provider client or network API', () => {
    const files = sources(MODULE);
    expect(files.length).toBeGreaterThanOrEqual(4);
    const forbidden = [
      /legacy-importer\.service|LegacyImporterService/,
      /legacy-adoption|adoptCandidate/,
      /migration-opening-balance|MigrationOpeningBalance/,
      /modules\/platform\/providers\//,
      /ProviderHttpClient|ProviderAdapter|AdapterRegistry|Rickpanel/,
      /from 'node:(http|https|net|tls|dgram|child_process)'/,
      /\bfetch\s*\(/,
    ];
    const offenders = files.flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      return forbidden.filter((rule) => rule.test(text)).map((rule) => `${file}: ${String(rule)}`);
    });
    expect(offenders).toEqual([]);
  });

  it('the surfaces reach neither the importer nor the terminal review queue', () => {
    const offenders = SURFACES.filter((file) =>
      /legacyImporter|LegacyImporterService|\.apply\(|legacy-review-queue|legacyReviewQueue/.test(
        readFileSync(file, 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('the repository is append-only: no UPDATE, no DELETE', () => {
    // The code, without its comments (which say, in words, that there is no UPDATE).
    const repository = readFileSync(
      `${MODULE}/infrastructure/drizzle-legacy-cutover.repository.ts`,
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .replace(/^\s*\/\/.*$/gmu, '');
    expect(repository).not.toMatch(/\.update\(|\.delete\(|\bUPDATE\b|\bDELETE\b/u);
  });

  it('approving charges the CRITICAL key and audits a refusal before anything is read', () => {
    const service = readFileSync(`${MODULE}/application/legacy-cutover.service.ts`, 'utf8');
    expect(service).toMatch(/'legacy\.cutover\.approve' satisfies PermissionKey/u);
    expect(service).toMatch(/recordMutationDenial\(/u);
    expect(service).toMatch(/scopeIsActive\(scope, tx\)/u);
  });
});
