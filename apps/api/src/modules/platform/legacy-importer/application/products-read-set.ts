import {
  legacyProductCode,
  type LegacyProductFactRow,
} from '../../../commerce/legacy-product-review/domain/legacy-product-facts.js';
import type { LegacyProductCodeObservation } from '../../../commerce/legacy-product-review/application/legacy-product-review.service.js';
import {
  defineLegacyReadSet,
  readLegacyReadSet,
  type LegacyReadSetBatch,
  type LegacyReadSetResult,
} from './read-set.js';
import { LEGACY_LIVE_STATUSES, type LegacyCell, type LegacySourceSession } from './source-port.js';

/**
 * Mirza migration PR2 — the `products` read set (`legacy-read-set:products:v1`): the legacy
 * `product` table, read for the legacy product review (`docs/legacy-product-review-design.md`
 * §7). A SEPARATE read set, so the frozen v1 import read set and the fingerprint the owner
 * approved do not move (`tests/unit/legacy-import-read-set-v1.test.ts`).
 *
 * The column allowlist, and the evidence for each name. The real archive's columns are
 * UNKNOWN (OQ-LPR-01 / OQ-MZ-INV-09); an optional column the source lacks is simply not
 * read (its absence is part of the schema hash, as every column of the table is), and a
 * column read is kept VERBATIM — its meaning is never guessed. Two public MirzaBot sources:
 *
 * - `mahdiMGF2/botmirzapanel` @ 92c0ed06, `table.php` (cited by the importer since P7):
 *   `id`, `code_product`, `name_product`, `price_product`, `Volume_constraint`, `Location`,
 *   `Service_time`, `Category`;
 * - `mahdiMGF2/mirza_pro` @ 8e551ecf, `db/tables/product.php` (the fork whose `agent`
 *   column the importer already treats as optional): additionally `agent`, `note`,
 *   `data_limit_reset`, `one_buy_status`, `category` (lower case), `hide_panel`.
 *
 * Deliberately NOT read: the fork's `inbounds` and `proxies`. They are panel configuration
 * and may carry proxy settings or credentials-like identifiers (OQ-MZ-INV-02); a review needs
 * neither, and a later version adds a column only in a reviewed commit with evidence.
 * Any other column is not read either.
 */
export const PRODUCTS_READ_SET_NAME = 'products' as const;
export const PRODUCTS_READ_SET_VERSION = 1;

export const PRODUCTS_READ_SET = defineLegacyReadSet({
  name: PRODUCTS_READ_SET_NAME,
  version: PRODUCTS_READ_SET_VERSION,
  tables: [
    {
      table: 'product',
      primaryKey: 'id',
      columns: ['id', 'code_product'],
      optionalColumns: [
        'name_product',
        'price_product',
        'Volume_constraint',
        'Service_time',
        'Location',
        'Category',
        'category',
        'agent',
        'note',
        'data_limit_reset',
        'one_buy_status',
        'hide_panel',
      ],
    },
  ],
});

/**
 * The live invoices naming each code, as the importer would treat them as NAMED_PRODUCT
 * candidates: a live status (`LEGACY_LIVE_STATUSES`, exact), `is_test` = 0, not custom, and
 * the trimmed code. Read from the v1 `invoice` columns — the approved v1 fingerprint binds
 * them — in the same session. Codes only: no user id, username or price is read.
 */
export async function liveInvoiceCountsByCode(
  session: LegacySourceSession,
): Promise<ReadonlyMap<string, number>> {
  const live: ReadonlySet<string> = new Set(LEGACY_LIVE_STATUSES);
  const counts = new Map<string, number>();
  for await (const [code, status, isTest, isCustom] of session.rows('invoice', [
    'code_product',
    'Status',
    'is_test',
    'is_custom',
  ])) {
    const trimmed = code?.trim() ?? '';
    if (trimmed === '' || status === null || status === undefined || !live.has(status)) continue;
    if (isTest?.trim() !== '0' || isCustom?.trim() === '1') continue;
    counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
  }
  return counts;
}

export interface ProductRowsSkipped {
  /** A NULL or blank code: the importer's hidden-shape path, never a named product. */
  CODE_EMPTY: number;
  /** Over 200 characters or a control character: no panel map could name it. */
  CODE_INVALID: number;
}

/**
 * Gathers the delivering pass's rows into per-code observations, in first-seen (primary-key
 * byte) order, and hands them over only once the WHOLE read set has been delivered and
 * verified (`finish`). Nothing is written while the legacy session is open: the MySQL source
 * refuses to run inside a database transaction (`transaction-boundary.ts`), so a transaction
 * cannot span the delivery, and holding the observations until `readLegacyReadSet` has
 * returned is what makes a `READ_SET_SNAPSHOT_DIVERGED` read write NOTHING. Memory is the
 * legacy `product` table — the merchant's plan catalogue, not a transaction table.
 */
export class ProductObservationAssembler {
  readonly skipped: ProductRowsSkipped = { CODE_EMPTY: 0, CODE_INVALID: 0 };
  rows = 0;
  private readonly byCode = new Map<string, LegacyProductFactRow[]>();

  constructor(private readonly liveCounts: ReadonlyMap<string, number>) {}

  take(batch: LegacyReadSetBatch): void {
    if (batch.table !== 'product') throw new Error(`unexpected table ${batch.table}`);
    const codeAt = batch.columns.indexOf('code_product');
    for (const cells of batch.rows) {
      this.rows += 1;
      const parsed = legacyProductCode(cells[codeAt] ?? null);
      if (!parsed.ok) {
        this.skipped[parsed.reason] += 1;
        continue;
      }
      const held = this.byCode.get(parsed.code);
      if (held === undefined) this.byCode.set(parsed.code, [factRow(batch.columns, cells)]);
      else held.push(factRow(batch.columns, cells));
    }
  }

  /** Every code, every row of it together (a duplicated code is one observation). */
  finish(): LegacyProductCodeObservation[] {
    return [...this.byCode].map(([code, rows]) => ({
      code,
      rows,
      liveInvoiceCount: this.liveCounts.get(code) ?? 0,
    }));
  }
}

function factRow(columns: readonly string[], cells: readonly LegacyCell[]): LegacyProductFactRow {
  const row: Record<string, string | null> = {};
  columns.forEach((column, index) => {
    row[column] = cells[index] ?? null;
  });
  return row;
}

/**
 * The products read set, digest only: its fingerprint and nothing else. What
 * `products-read` prints for the owner to approve, writing nothing.
 */
export function digestProductsReadSet(session: LegacySourceSession): Promise<LegacyReadSetResult> {
  return readLegacyReadSet(session, PRODUCTS_READ_SET);
}

/**
 * The products read set, delivered ONLY when it is the approved one (`readLegacyReadSet`): a
 * digest-only pass compared with `expectedFingerprint` — a mismatch is
 * `READ_SET_FINGERPRINT_MISMATCH` before `onBatch` ever runs — then the delivering pass,
 * which must reproduce it (`READ_SET_SNAPSHOT_DIVERGED` otherwise).
 */
export function readApprovedProductsReadSet(
  session: LegacySourceSession,
  expectedFingerprint: string,
  options: {
    readonly batchSize: number;
    readonly onBatch: (batch: LegacyReadSetBatch) => Promise<void> | void;
  },
): Promise<LegacyReadSetResult> {
  return readLegacyReadSet(session, PRODUCTS_READ_SET, { ...options, expectedFingerprint });
}
