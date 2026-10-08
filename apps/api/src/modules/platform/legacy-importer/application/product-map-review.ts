import {
  isExportable,
  type ExportCandidate,
} from '../../../commerce/legacy-product-review/domain/review-transitions.js';

/**
 * Mirza PR5 fix (aud5 F5 = aud6 F1; PR2 Departure 9) — does the import's `mapping.products`
 * agree with the approved legacy product review?
 *
 * `products-export` writes the map's `products` section from rows the review approved
 * against the facts a products read saw. Nothing re-checked that afterwards: a decision
 * changed after export (APPROVED → REJECTED, SOURCE_CHANGED), or a hand-edited map binding a
 * code to another product, was imported as it stood, and invoices and adopted services were
 * attached to products the review does not approve.
 *
 * One answer, through PR2's own export predicate (`isExportable`, never a copy): every entry
 * of `mapping.products` must name a code whose review row is exportable under the CURRENT
 * products read of this source (the latest `products` read set recorded against the v1
 * source fingerprint), and must name exactly the product that row approved. Two callers: the
 * importer's APPLY `prepare` refuses on any refusal; report v2's products section carries it
 * as check PR5 (so `REPORT_V2_HOLDS` and the cutover gate carry it too).
 */

export const PRODUCT_MAP_REVIEW_REASONS = [
  'NO_PRODUCTS_READ',
  'NO_REVIEW_ROW',
  'NOT_EXPORTABLE',
  'TARGET_DIFFERS',
] as const;

export type ProductMapReviewReason =
  /** No `products` read set is recorded for this source: no review can vouch for an entry. */
  | 'NO_PRODUCTS_READ'
  /** The review has no row for the code. */
  | 'NO_REVIEW_ROW'
  /** The row is not exportable under that read (`isExportable`). */
  | 'NOT_EXPORTABLE'
  /** The row is exportable, and approved ANOTHER product than the map names. */
  | 'TARGET_DIFFERS';

export interface ProductReviewRowFacts extends ExportCandidate {
  readonly codeProduct: string;
}

export interface ProductMapReviewVerdict {
  /** The products read set fingerprint the entries were judged under (null: none recorded). */
  readonly productsReadFingerprint: string | null;
  readonly entries: number;
  /** The refused entries, by code, in code byte order. Product codes only. */
  readonly refused: readonly {
    readonly codeProduct: string;
    readonly reason: ProductMapReviewReason;
  }[];
  readonly holds: boolean;
}

export function productMapAgainstReview(
  products: ReadonlyMap<string, string>,
  rows: readonly ProductReviewRowFacts[],
  productsReadFingerprint: string | null,
): ProductMapReviewVerdict {
  const byCode = new Map(rows.map((r) => [r.codeProduct, r]));
  const refused: { codeProduct: string; reason: ProductMapReviewReason }[] = [];
  for (const [codeProduct, productId] of products) {
    const row = byCode.get(codeProduct);
    const reason: ProductMapReviewReason | null =
      productsReadFingerprint === null
        ? 'NO_PRODUCTS_READ'
        : row === undefined
          ? 'NO_REVIEW_ROW'
          : !isExportable(row, productsReadFingerprint)
            ? 'NOT_EXPORTABLE'
            : row.approvedProductId !== productId
              ? 'TARGET_DIFFERS'
              : null;
    if (reason !== null) refused.push({ codeProduct, reason });
  }
  refused.sort((a, b) =>
    a.codeProduct < b.codeProduct ? -1 : a.codeProduct > b.codeProduct ? 1 : 0,
  );
  return {
    productsReadFingerprint,
    entries: products.size,
    refused,
    holds: refused.length === 0,
  };
}

/** The refusal sentence for an APPLY run, or null when every entry holds. */
export function productMapRefusalMessage(verdict: ProductMapReviewVerdict): string | null {
  if (verdict.holds) return null;
  const listed = verdict.refused
    .map((r) => `${JSON.stringify(r.codeProduct)}: ${r.reason}`)
    .join(', ');
  return (
    `${String(verdict.refused.length)} panel-map products entr${verdict.refused.length === 1 ? 'y does' : 'ies do'} ` +
    `not agree with the approved legacy product review under products read ` +
    `${verdict.productsReadFingerprint ?? '(none recorded for this source)'} (${listed}). ` +
    'Re-run products-read and the review, then products-export, and approve the new map fingerprint. Nothing was written.'
  );
}
