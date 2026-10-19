import { sql } from 'drizzle-orm';
import type { TenantContext } from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { requireTenantId } from '../../../../infrastructure/persistence/unit-of-work.js';

/**
 * What the reader answers, restated structurally: this module imports nothing of the commerce
 * modules (`legacy-invoice-archive-boundary.test.ts`); provisioning's `ServiceOriginReader`
 * port is satisfied by shape.
 */
export interface ArchivedOriginalPurchase {
  readonly productName: string | null;
  readonly price: { readonly amountMinor: bigint; readonly currency: string } | null;
}

/**
 * Owner rule 2026-10-18 — what an imported service's customer originally bought, for display
 * and history: the product name and price of the archived invoice its `source_ref`
 * (`invoice:<id_invoice>`) names, from the latest VISIBLE archive revision (its run COMPLETED).
 *
 * It lives in the archive's own module (`legacy-invoice-archive-boundary.test.ts`: no commerce
 * module knows the archive); provisioning holds only the port.
 *
 * A link, not a copy: nothing is duplicated onto the service or its order (whose adoption line
 * is free by `orders_legacy_adoption_shape_check`). The archive's price is metadata — never a
 * price anything charges, renews at or refunds.
 */
export class DrizzleServiceOriginReader {
  constructor(private readonly db: Database) {}

  async originalPurchase(
    scope: TenantContext,
    service: { readonly id: string },
  ): Promise<ArchivedOriginalPurchase | null> {
    const tenantId = requireTenantId(scope);
    const result = await this.db.execute<{
      product_name: string | null;
      price_minor: string | null;
      price_currency: string | null;
    }>(sql`
      SELECT a.product_name, a.price_minor::text AS price_minor, a.price_currency
        FROM services s
        JOIN legacy_invoice_archive a
          ON a.tenant_id = s.tenant_id AND s.source_ref = 'invoice:' || a.invoice_key
        JOIN legacy_invoice_archive_runs r ON r.tenant_id = a.tenant_id AND r.id = a.run_id
       WHERE s.tenant_id = ${tenantId} AND s.id = ${service.id} AND r.state = 'COMPLETED'
       ORDER BY a.revision DESC
       LIMIT 1`);
    const row = result.rows[0];
    if (row === undefined) return null;
    const name = row.product_name?.trim() ?? '';
    const price =
      row.price_minor === null || row.price_currency === null
        ? null
        : { amountMinor: BigInt(row.price_minor), currency: row.price_currency };
    if (name === '' && price === null) return null;
    return { productName: name === '' ? null : name, price };
  }
}
