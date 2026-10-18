import { sql } from 'drizzle-orm';
import type { TenantContext } from '@nexa/contracts';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type { CustomerSourceMarker } from '../application/customers-source.step.js';

export class DrizzleCustomerSourceMarker implements CustomerSourceMarker {
  async markImported(scope: TenantContext, tx: TransactionScope) {
    const tenantId = requireTenantId(scope);
    // Only `source = 'NEXA'` rows are touched, so a rerun marks nothing twice, and the ref is
    // the map's own legacy id: the same Telegram id can never be given two refs.
    const marked = await tx.tx.execute(sql`
      UPDATE customers c
         SET source = 'MIRZA', source_ref = 'user:' || m.legacy_id
        FROM legacy_import_map m
       WHERE m.tenant_id = ${tenantId} AND m.legacy_table = 'user'
         AND m.entity_type = 'CUSTOMER' AND m.status = 'IMPORTED'
         AND m.reason_code IS DISTINCT FROM 'EXISTING_CUSTOMER'
         AND c.tenant_id = m.tenant_id AND c.id = m.entity_id
         AND c.source = 'NEXA'`);
    const already = await tx.tx.execute(sql`
      SELECT count(*)::int AS n FROM customers
       WHERE tenant_id = ${tenantId} AND source = 'MIRZA'`);
    const n = Number((already.rows[0] as { n: number } | undefined)?.n ?? 0);
    const markedCount = marked.rowCount ?? 0;
    return { marked: markedCount, alreadyMarked: n - markedCount };
  }
}
