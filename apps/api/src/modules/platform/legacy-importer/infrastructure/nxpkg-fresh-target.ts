import { sql } from 'drizzle-orm';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import type { PanelFacts } from '../application/panel-mapping.js';

/**
 * Mirza `.nxpkg` importer — the FRESH TARGET guard (`docs/legacy-migration/nxpkg-importer.md`
 * §6). A Fresh Migration runs only into a tenant that holds no operational data yet:
 *
 * - `customers`, `orders`, `services`, `payments`;
 * - `wallet_entries` — the ledger (balance is derived from it; there is no other ledger table);
 * - `legacy_wallet_debts`;
 * - `legacy_import_runs` in mode `APPLY` (a DRY_RUN run writes no business row and may exist);
 * - `legacy_history_records`.
 *
 * Panels may exist — the RickPanel the services are adopted onto must. Every count is read in
 * ONE statement (one snapshot). It only reads: nothing is ever deleted, truncated or
 * overwritten to make a tenant fresh; a non-empty tenant is `FRESH_TARGET_NOT_EMPTY` with the
 * counts, and the operator decides.
 */

export const FRESH_TARGET_TABLES = [
  'customers',
  'orders',
  'services',
  'payments',
  'wallet_entries',
  'legacy_wallet_debts',
  'legacy_import_runs_apply',
  'legacy_history_records',
] as const;
export type FreshTargetTable = (typeof FRESH_TARGET_TABLES)[number];

export interface FreshTargetCheck {
  readonly fresh: boolean;
  readonly counts: Readonly<Record<FreshTargetTable, number>>;
  /** `FRESH_TARGET_NOT_EMPTY` when not fresh, else null. */
  readonly code: 'FRESH_TARGET_NOT_EMPTY' | null;
}

export async function checkFreshTarget(db: Database, tenantId: string): Promise<FreshTargetCheck> {
  const result = await db.execute<Record<FreshTargetTable, number>>(sql`
    SELECT
      (SELECT count(*)::int FROM customers WHERE tenant_id = ${tenantId}) AS customers,
      (SELECT count(*)::int FROM orders WHERE tenant_id = ${tenantId}) AS orders,
      (SELECT count(*)::int FROM services WHERE tenant_id = ${tenantId}) AS services,
      (SELECT count(*)::int FROM payments WHERE tenant_id = ${tenantId}) AS payments,
      (SELECT count(*)::int FROM wallet_entries WHERE tenant_id = ${tenantId}) AS wallet_entries,
      (SELECT count(*)::int FROM legacy_wallet_debts WHERE tenant_id = ${tenantId})
        AS legacy_wallet_debts,
      (SELECT count(*)::int FROM legacy_import_runs
        WHERE tenant_id = ${tenantId} AND mode = 'APPLY') AS legacy_import_runs_apply,
      (SELECT count(*)::int FROM legacy_history_records WHERE tenant_id = ${tenantId})
        AS legacy_history_records
  `);
  const row = result.rows[0];
  if (row === undefined) throw new Error('the fresh-target count returned no row');
  const counts = Object.fromEntries(FRESH_TARGET_TABLES.map((t) => [t, Number(row[t])])) as Record<
    FreshTargetTable,
    number
  >;
  const fresh = FRESH_TARGET_TABLES.every((t) => counts[t] === 0);
  return { fresh, counts, code: fresh ? null : 'FRESH_TARGET_NOT_EMPTY' };
}

/** Every panel of the tenant, as the panel binding checks it (no credential, no address). */
export async function tenantPanelFacts(
  db: Database,
  tenantId: string,
): Promise<readonly PanelFacts[]> {
  const result = await db.execute<{
    id: string;
    tenant_id: string;
    provider_type: string;
    status: string;
    archived: boolean;
  }>(sql`
    SELECT id, tenant_id, provider_type, status, (archived_at IS NOT NULL) AS archived
      FROM panels
     WHERE tenant_id = ${tenantId}
     ORDER BY id
  `);
  return result.rows.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    providerType: r.provider_type,
    status: r.status,
    archived: r.archived,
  }));
}
