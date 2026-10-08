import { describe, expect, it } from 'vitest';
import {
  productMapAgainstReview,
  productMapRefusalMessage,
  type ProductReviewRowFacts,
} from '../../apps/api/src/modules/platform/legacy-importer/application/product-map-review';

/**
 * aud5 F5 = aud6 F1 (PR2 Departure 9): the import's `mapping.products` against the approved
 * legacy product review, through PR2's own `isExportable`. Synthetic values only.
 */

const F = 'f'.repeat(64);
const G = 'a'.repeat(64);
const X = 'c'.repeat(64);
const P1 = '01900000-0000-7000-8000-0000000000p1';
const P2 = '01900000-0000-7000-8000-0000000000p2';

const row = (over: Partial<ProductReviewRowFacts> = {}): ProductReviewRowFacts => ({
  codeProduct: 'p1',
  state: 'APPROVED_EXISTING',
  factsChecksum: X,
  approvedFactsChecksum: X,
  approvedProductId: P1,
  readFingerprint: F,
  missingSinceReadFingerprint: null,
  sourceConflict: null,
  ...over,
});

describe('the panel map against the product review', () => {
  it('holds when every entry is exportable under the current read and names its approved product', () => {
    const v = productMapAgainstReview(new Map([['p1', P1]]), [row()], F);
    expect(v).toEqual({ productsReadFingerprint: F, entries: 1, refused: [], holds: true });
    expect(productMapRefusalMessage(v)).toBeNull();
    // An empty products section binds nothing.
    expect(productMapAgainstReview(new Map(), [], null).holds).toBe(true);
  });

  it('refuses another target, an unexportable row, a missing row and a missing read', () => {
    const map = new Map([['p1', P1]]);
    const reason = (rows: readonly ProductReviewRowFacts[], read: string | null, m = map) =>
      productMapAgainstReview(m, rows, read).refused.map((r) => r.reason);
    expect(reason([row({ approvedProductId: P2 })], F)).toEqual(['TARGET_DIFFERS']);
    expect(reason([row({ state: 'PENDING_REVIEW' })], F)).toEqual(['NOT_EXPORTABLE']);
    expect(reason([row({ approvedFactsChecksum: G })], F)).toEqual(['NOT_EXPORTABLE']);
    expect(reason([row({ sourceConflict: 'CODE_DUPLICATED' })], F)).toEqual(['NOT_EXPORTABLE']);
    expect(reason([row({ missingSinceReadFingerprint: F })], F)).toEqual(['NOT_EXPORTABLE']);
    // Exportable only under the read that saw it: an older read is not the current one.
    expect(reason([row()], G)).toEqual(['NOT_EXPORTABLE']);
    expect(reason([], F)).toEqual(['NO_REVIEW_ROW']);
    expect(reason([row()], null)).toEqual(['NO_PRODUCTS_READ']);
    const v = productMapAgainstReview(
      new Map([
        ['p2', P2],
        ['p1', P1],
      ]),
      [row()],
      F,
    );
    expect(v.refused).toEqual([{ codeProduct: 'p2', reason: 'NO_REVIEW_ROW' }]);
    expect(productMapRefusalMessage(v)).toContain('"p2": NO_REVIEW_ROW');
  });
});
