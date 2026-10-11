import { sql, type SQL } from 'drizzle-orm';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  freshTargetVerdict,
  type FreshTargetCheck,
  type FreshTargetOptions,
} from '../application/fresh-target.js';
import type { PanelFacts } from '../application/panel-mapping.js';

export type { FreshTargetCheck, FreshTargetOptions } from '../application/fresh-target.js';

/**
 * The tables the FRESH TARGET guard counts (design §6).
 *
 * A Fresh Migration runs only into a tenant that holds no operational data yet. Counted:
 *
 * - operational: `customers`, `orders`, `services`, `payments`, `payment_receipts`, `refunds`,
 *   `wallet_entries` (the ledger), `legacy_wallet_debts`, `trial_grants`, `referrals`;
 * - an earlier import's footprint: `legacy_import_runs` in mode `APPLY` (other than the run
 *   being started), `legacy_import_map`, `legacy_service_candidates`,
 *   `legacy_trial_eligibility`, `legacy_product_shapes`, `legacy_history_records`;
 * - read sets and what they feed: `legacy_read_set_runs`, `legacy_product_reviews`,
 *   `legacy_invoice_archive_runs`, `legacy_invoice_archive_staging`, `legacy_invoice_archive`.
 *   When the guard is given the source fingerprint being imported, rows recorded for THAT
 *   source (the read sets the import itself needs, taken just before it) are not counted;
 *   rows of any other source are. Without one, every row counts.
 *
 * Panels and products may exist: they are the installation's configuration, not migrated data.
 * The RickPanel the services are adopted onto must exist (§1), and the legacy product review
 * maps legacy products onto existing NEXA products and hidden shapes resolve to a current
 * tariff — so `products` is NOT counted (the shapes the import creates,
 * `legacy_product_shapes`, are). Nothing is ever deleted, truncated or overwritten to make a
 * tenant fresh.
 */

export const FRESH_TARGET_TABLES = [
  'customers',
  'orders',
  'services',
  'payments',
  'payment_receipts',
  'refunds',
  'wallet_entries',
  'legacy_wallet_debts',
  'trial_grants',
  'referrals',
  'legacy_import_runs_apply',
  'legacy_import_map',
  'legacy_service_candidates',
  'legacy_trial_eligibility',
  'legacy_product_shapes',
  'legacy_history_records',
  'legacy_read_set_runs',
  'legacy_product_reviews',
  'legacy_invoice_archive_runs',
  'legacy_invoice_archive_staging',
  'legacy_invoice_archive',
] as const;
export type FreshTargetTable = (typeof FRESH_TARGET_TABLES)[number];

/**
 * Mirza `.nxpkg` importer — the FRESH TARGET guard (`docs/legacy-migration/nxpkg-importer.md`
 * §6; the tables are `FRESH_TARGET_TABLES` above).
 *
 * Every count is read in ONE statement (one snapshot). It only reads: nothing is ever deleted,
 * truncated or overwritten to make a tenant fresh; a non-empty tenant is
 * `FRESH_TARGET_NOT_EMPTY` with the counts, and the operator decides.
 *
 * This standalone read is a courtesy (it fails a dry run or an import early). The authoritative
 * check is `freshTargetCounts` with `lockTenant`, inside the transaction that starts the APPLY
 * run (`LegacyImporterService.apply`).
 */
export async function checkFreshTarget(
  db: Database,
  tenantId: string,
  options: FreshTargetOptions = { sourceFingerprint: null },
): Promise<FreshTargetCheck & { readonly counts: Readonly<Record<FreshTargetTable, number>> }> {
  return freshTargetCounts(db, tenantId, options);
}

/**
 * The counts, on `executor`. With `lockTenant` it first takes the tenant row `FOR UPDATE`,
 * which conflicts with the `FOR KEY SHARE` every foreign-key check on `tenant_id` takes: a
 * concurrent insert of a customer, order, payment, … into this tenant waits for the caller's
 * transaction, and one that committed before the lock is seen by the count (READ COMMITTED
 * takes a new snapshot per statement). So the counts hold until the caller commits.
 */
export async function freshTargetCounts(
  executor: Executor,
  tenantId: string,
  options: FreshTargetOptions & { readonly lockTenant?: boolean },
): Promise<FreshTargetCheck & { readonly counts: Readonly<Record<FreshTargetTable, number>> }> {
  if (options.lockTenant === true) {
    const locked = await executor.execute<{ id: string }>(
      sql`SELECT id FROM tenants WHERE id = ${tenantId} FOR UPDATE`,
    );
    if (locked.rows.length !== 1) throw new Error('the fresh-target guard found no tenant row');
  }
  const fp = options.sourceFingerprint;
  // A read set recorded for THIS source is the import's own input; any other source's counts.
  const otherSource: SQL = fp === null ? sql`TRUE` : sql`source_fingerprint IS DISTINCT FROM ${fp}`;
  const otherArchiveRun: SQL =
    fp === null
      ? sql`TRUE`
      : sql`run_id NOT IN (SELECT id FROM legacy_invoice_archive_runs
                             WHERE tenant_id = ${tenantId} AND source_fingerprint = ${fp})`;
  const notThisRun: SQL =
    options.excludeRunId == null ? sql`TRUE` : sql`id <> ${options.excludeRunId}`;
  const count = (table: string, where: SQL = sql`TRUE`): SQL =>
    sql`(SELECT count(*)::int FROM ${sql.identifier(table)} WHERE tenant_id = ${tenantId} AND ${where})`;
  const columns: Readonly<Record<FreshTargetTable, SQL>> = {
    customers: count('customers'),
    orders: count('orders'),
    services: count('services'),
    payments: count('payments'),
    payment_receipts: count('payment_receipts'),
    refunds: count('refunds'),
    wallet_entries: count('wallet_entries'),
    legacy_wallet_debts: count('legacy_wallet_debts'),
    trial_grants: count('trial_grants'),
    referrals: count('referrals'),
    legacy_import_runs_apply: count('legacy_import_runs', sql`mode = 'APPLY' AND ${notThisRun}`),
    legacy_import_map: count('legacy_import_map'),
    legacy_service_candidates: count('legacy_service_candidates'),
    legacy_trial_eligibility: count('legacy_trial_eligibility'),
    legacy_product_shapes: count('legacy_product_shapes'),
    legacy_history_records: count('legacy_history_records'),
    legacy_read_set_runs: count('legacy_read_set_runs', otherSource),
    legacy_product_reviews: count('legacy_product_reviews', otherSource),
    legacy_invoice_archive_runs: count('legacy_invoice_archive_runs', otherSource),
    legacy_invoice_archive_staging: count('legacy_invoice_archive_staging', otherArchiveRun),
    legacy_invoice_archive: count('legacy_invoice_archive', otherSource),
  };
  const select = sql.join(
    FRESH_TARGET_TABLES.map((t) => sql`${columns[t]} AS ${sql.identifier(t)}`),
    sql`, `,
  );
  const result = await executor.execute<Record<FreshTargetTable, number>>(sql`SELECT ${select}`);
  const row = result.rows[0];
  if (row === undefined) throw new Error('the fresh-target count returned no row');
  const counts = Object.fromEntries(FRESH_TARGET_TABLES.map((t) => [t, Number(row[t])])) as Record<
    FreshTargetTable,
    number
  >;
  return freshTargetVerdict(counts) as FreshTargetCheck & {
    readonly counts: Readonly<Record<FreshTargetTable, number>>;
  };
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
