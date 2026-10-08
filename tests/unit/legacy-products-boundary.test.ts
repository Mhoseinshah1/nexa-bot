import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Program Item 4 (hidden legacy products), "no second productless pricing system":
 * `docs/legacy-migration/hidden-legacy-products.md` §1, §3.
 *
 * A legacy service renews through the ONE renewal path — `CommercialActionService`
 * quoting the service's own product through `PricingService.price` over
 * `pricing-engine.ts` — because its hidden product is an ordinary product row priced
 * with the current tariff. The day the pricing boundary or the renewal path learns about
 * legacy shapes, there are two answers to "what does this legacy service cost"; and the
 * day the legacy code computes a price of its own, there is a second pricing system.
 * Both fail here.
 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

const LEGACY_CATALOG = [
  'apps/api/src/modules/commerce/catalog/application/legacy-shape.ts',
  'apps/api/src/modules/commerce/catalog/application/legacy-product.service.ts',
  'apps/api/src/modules/commerce/catalog/application/legacy-product-ports.ts',
  'apps/api/src/modules/commerce/catalog/infrastructure/drizzle-legacy-product-shape.repository.ts',
];

describe('hidden legacy products: one pricing system', () => {
  it('the pricing boundary and the renewal path know nothing of legacy shapes', () => {
    const files = [
      ...sources('apps/api/src/modules/commerce/pricing'),
      ...sources('apps/api/src/modules/commerce/commercial'),
    ];
    expect(files.length).toBeGreaterThan(3);
    const offenders = files.filter((file) =>
      /legacy[-_]?shape|legacy[-_]?product|LegacyShape|LegacyProduct|legacy_product_shapes/iu.test(
        readFileSync(file, 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('the legacy code computes no price: no pricing import, and never the historical price', () => {
    for (const file of LEGACY_CATALOG) {
      const text = readFileSync(file, 'utf8');
      // Prose may name the pricing boundary (to say renewal goes through it); no import may.
      const imports = text.match(/^import[\s\S]*?from '[^']*';$/gmu) ?? [];
      expect(imports.length, file).toBeGreaterThan(0);
      expect(imports.join('\n'), file).not.toMatch(/\/pricing\/|pricing-engine|PricingService/u);
      // `price_product` may be NAMED in prose (to say it is not an input), never read.
      expect(text, file).not.toMatch(/\.price_product|\.priceProduct|priceProduct\s*:/u);
    }
  });

  it('the shape input has exactly the five tariff facts, and no price among them', () => {
    const text = readFileSync(LEGACY_CATALOG[0] as string, 'utf8');
    const body = /export interface LegacyShapeInput \{([^}]*)\}/u.exec(text)?.[1] ?? '';
    const fields = [...body.matchAll(/readonly (\w+)/gu)].map((match) => match[1]);
    expect(fields).toEqual(['codePanel', 'volume', 'serviceTime', 'timeUnit', 'isCustom']);
  });

  /*
   * Mirza PR2 — the legacy product review. Its historical price is IRT METADATA (owner
   * decision 7): the review module imports nothing from pricing or the commercial actions,
   * and the one product it creates is built with `price: null` in exactly one place.
   */
  it('the legacy product review computes no price and gives its draft none', () => {
    const files = [
      ...sources('apps/api/src/modules/commerce/legacy-product-review'),
      'apps/api/src/modules/platform/legacy-importer/application/products-read-set.ts',
      'apps/api/src/modules/platform/legacy-importer/application/products-ingest.ts',
      'apps/api/src/legacy-import-products.ts',
    ];
    expect(files.length).toBeGreaterThan(6);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const imports = text.match(/^import[\s\S]*?from '[^']*';$/gmu) ?? [];
      expect(imports.join('\n'), file).not.toMatch(
        /\/pricing\/|pricing-engine|PricingService|\/commercial\//u,
      );
      // No write path names a product price column or a price setter.
      expect(text, file).not.toMatch(/price_amount|priceAmount|setPrice|price:\s*money\(/u);
    }
    const service = readFileSync(
      'apps/api/src/modules/commerce/legacy-product-review/application/legacy-product-review.service.ts',
      'utf8',
    );
    const draft = /export function legacyDraftProduct[\s\S]*?\n\}\n/u.exec(service)?.[0] ?? '';
    expect(draft).toMatch(/price: null,/u);
    expect(draft).toMatch(/panelId: null,/u);
    expect(draft).toMatch(/categoryId: null,/u);
    expect(draft).toMatch(/audience: 'HIDDEN',/u);
    // The only `createWithin` call passes the draft that builder made.
    expect(service.match(/createWithin\(/gu)).toHaveLength(1);
    expect(service).toMatch(/const draft = legacyDraftProduct\(/u);
  });
});
