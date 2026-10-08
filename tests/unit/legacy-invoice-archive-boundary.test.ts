import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Mirza migration PR3 — the legacy invoice archive is HISTORY, never business.
 *
 * An archived legacy invoice must never become an order, a payment, a wallet (ledger)
 * entry, a service, a provisioning operation or revenue, and no report may read it: the
 * day the archive's code reaches one of those modules, or a report learns the archive's
 * table, a historical price can become a figure somebody is charged or paid. Each rule
 * below fails at the first file that breaks it, the way `legacy-products-boundary` pins
 * the pricing boundary.
 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

const ARCHIVE_FILES = [
  ...sources('apps/api/src/modules/platform/legacy-invoice-archive'),
  'apps/api/src/modules/platform/legacy-importer/application/invoice-archive-read-set.ts',
  'apps/api/src/modules/platform/legacy-importer/application/invoice-archive-ingest.ts',
  'apps/api/src/legacy-import-invoices.ts',
  'apps/api/src/surfaces/web/legacy-invoices.controller.ts',
];

/** Modules whose code turns a fact into money, a service or a figure on a report. */
const BUSINESS_MODULES =
  /\/commerce\/(orders|payments|wallet|ledger|refunds|provisioning|services|pricing|commercial|reporting|settlement|cashback|referrals|resellers|legacy-adoption)\//u;

/** Business tables an archive statement must never name. */
const BUSINESS_TABLES =
  /\b(orders|payments|wallet_entries|services|provisioning_operations|refunds|gateway_invoices|ledger_entries)\b/u;

describe('the legacy invoice archive is history, not business', () => {
  it('imports no module that creates orders, payments, ledger entries, services or reports', () => {
    expect(ARCHIVE_FILES.length).toBeGreaterThan(6);
    for (const file of ARCHIVE_FILES) {
      const text = readFileSync(file, 'utf8');
      const imports = (text.match(/^import[\s\S]*?from '[^']*';$/gmu) ?? []).join('\n');
      expect(imports, file).not.toMatch(BUSINESS_MODULES);
      expect(imports, file).not.toMatch(/PricingService|RefundService|pricing-engine/u);
    }
  });

  it('its repository names no business table in any statement', () => {
    const repository = readFileSync(
      'apps/api/src/modules/platform/legacy-invoice-archive/infrastructure/drizzle-legacy-invoice-archive.repository.ts',
      'utf8',
    );
    // Only the archive's own tables and the importer's map (read for a code, never written).
    const imported =
      /import \{([^}]*)\} from '..\/..\/..\/..\/infrastructure\/persistence\/schema.js';/u.exec(
        repository,
      )?.[1];
    expect(
      imported
        ?.split(',')
        .map((name) => name.trim())
        .filter(Boolean)
        .sort(),
    ).toEqual([
      'legacyImportMap',
      'legacyInvoiceArchive',
      'legacyInvoiceArchiveRuns',
      'legacyInvoiceArchiveStaging',
    ]);
    const statements = repository.match(/sql`[\s\S]*?`/gu) ?? [];
    expect(statements.length).toBeGreaterThan(3);
    for (const statement of statements) expect(statement).not.toMatch(BUSINESS_TABLES);
    // The map is only ever SELECTed.
    expect(repository).not.toMatch(/\.(insert|update|delete)\(legacyImportMap\)/u);
  });

  it('no report, order, payment or wallet module knows the archive', () => {
    const files = [
      ...sources('apps/api/src/modules/commerce'),
      ...sources('apps/api/src/modules/platform/legacy-importer/application').filter(
        (file) => !/invoice-archive-|legacy-importer\.service\.ts$/u.test(file),
      ),
    ];
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.filter((file) =>
      /legacy_invoice_archive|legacyInvoiceArchive|legacy-invoice-archive|LegacyInvoiceArchive/u.test(
        readFileSync(file, 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('the HTTP surface is read-only: no write route reaches the archive', () => {
    const controller = readFileSync(
      'apps/api/src/surfaces/web/legacy-invoices.controller.ts',
      'utf8',
    );
    expect(controller).toMatch(/@Get\(/u);
    expect(controller).not.toMatch(/@(Post|Put|Patch|Delete)\(/u);
    // ... and it reaches neither the importer nor its review queue nor the adoption.
    expect(controller).not.toMatch(/legacy-importer|legacy-adoption|legacyImporter\(/u);
  });

  it('the historical price stays metadata: nothing in the archive sums or prices it', () => {
    for (const file of ARCHIVE_FILES) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/sum\(\s*price_minor|SUM\(price_minor|priceAmount|setPrice/u);
    }
  });
});
