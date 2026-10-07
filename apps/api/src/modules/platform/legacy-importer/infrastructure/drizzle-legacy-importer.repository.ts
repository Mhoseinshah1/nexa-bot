import { sql, type SQL } from 'drizzle-orm';
import {
  money,
  type CurrencyCode,
  type LegacyReadSetName,
  type ProductAudience,
  type ProductCategoryStatus,
  type ProductStatus,
  type TenantContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type { TariffCandidate } from '../../../commerce/catalog/application/legacy-shape.js';
import type { PanelFacts } from '../application/panel-mapping.js';
import type {
  LegacyCustomerInsert,
  LegacyCustomerWriter,
  LegacyImporterDestination,
  LegacyReadSetRun,
  LegacyReadSetRunRepository,
  LegacyRunInputs,
  LegacyRunInputsRepository,
} from '../application/ports.js';
import type { LegacySourceEngine } from '../application/source-port.js';

/**
 * Migration P7 — NEXA's side of the importer: batched lookups and tenant aggregates the
 * plan and the reconcile read, the run-inputs row, and the one customer insert.
 *
 * Every statement names the tenant. Lookups are chunked so a 200k-user archive is a few
 * hundred bounded statements rather than one parameter list Postgres refuses.
 */

const CHUNK = 1000;
const OPENING_REASON = 'MIGRATION_OPENING_BALANCE';
const OPENING_PREFIX = 'legacy:opening:';

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

function list(values: readonly string[]): SQL {
  return sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );
}

export class DrizzleLegacyImporterRepository
  implements
    LegacyImporterDestination,
    LegacyRunInputsRepository,
    LegacyCustomerWriter,
    LegacyReadSetRunRepository
{
  constructor(
    private readonly db: Database,
    private readonly salesCurrencyOf: (scope: TenantContext) => Promise<CurrencyCode>,
  ) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async tenantExists(scope: TenantContext): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const result = await this.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM tenants WHERE id = ${tenantId}`,
    );
    return (result.rows[0]?.n ?? 0) > 0;
  }

  salesCurrency(scope: TenantContext): Promise<string> {
    return this.salesCurrencyOf(scope);
  }

  async panels(scope: TenantContext, panelIds: readonly string[]): Promise<readonly PanelFacts[]> {
    const tenantId = requireTenantId(scope);
    if (panelIds.length === 0) return [];
    const result = await this.db.execute<{
      id: string;
      tenant_id: string;
      provider_type: string;
      status: string;
      archived: boolean;
    }>(sql`
      SELECT id, tenant_id, provider_type, status, (archived_at IS NOT NULL) AS archived
        FROM panels
       WHERE tenant_id = ${tenantId} AND id::text IN (${list(panelIds)})
    `);
    return result.rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      providerType: r.provider_type,
      status: r.status,
      archived: r.archived,
    }));
  }

  async productIds(
    scope: TenantContext,
    productIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    const tenantId = requireTenantId(scope);
    const out = new Set<string>();
    for (const part of chunks(productIds)) {
      const result = await this.db.execute<{ id: string }>(sql`
        SELECT id FROM products WHERE tenant_id = ${tenantId} AND id::text IN (${list(part)})
      `);
      for (const row of result.rows) out.add(row.id);
    }
    return out;
  }

  async customersByTelegramIds(
    scope: TenantContext,
    telegramUserIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    const tenantId = requireTenantId(scope);
    const out = new Map<string, string>();
    for (const part of chunks(telegramUserIds)) {
      const result = await this.db.execute<{ id: string; telegram_user_id: string }>(sql`
        SELECT id, telegram_user_id FROM customers
         WHERE tenant_id = ${tenantId} AND telegram_user_id IN (${list(part)})
      `);
      for (const row of result.rows) out.set(row.telegram_user_id, row.id);
    }
    return out;
  }

  async openingsByTelegramId(scope: TenantContext): Promise<ReadonlyMap<string, bigint>> {
    const tenantId = requireTenantId(scope);
    const result = await this.db.execute<{ reference: string; signed: string }>(sql`
      SELECT reference,
             (CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END)::text AS signed
        FROM wallet_entries
       WHERE tenant_id = ${tenantId} AND reason = ${OPENING_REASON}
    `);
    const out = new Map<string, bigint>();
    for (const row of result.rows) {
      if (row.reference.startsWith(OPENING_PREFIX)) {
        out.set(row.reference.slice(OPENING_PREFIX.length), BigInt(row.signed));
      }
    }
    return out;
  }

  async trialOverrides(
    scope: TenantContext,
    customerIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>> {
    const tenantId = requireTenantId(scope);
    const out = new Map<string, number>();
    for (const part of chunks(customerIds)) {
      const result = await this.db.execute<{ customer_id: string; trial_limit: number }>(sql`
        SELECT customer_id, trial_limit FROM trial_limit_overrides
         WHERE tenant_id = ${tenantId} AND customer_id::text IN (${list(part)})
      `);
      for (const row of result.rows) out.set(row.customer_id, row.trial_limit);
    }
    return out;
  }

  async trialDecided(
    scope: TenantContext,
    customerIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    const tenantId = requireTenantId(scope);
    const out = new Set<string>();
    for (const part of chunks(customerIds)) {
      const result = await this.db.execute<{ customer_id: string }>(sql`
        SELECT customer_id FROM legacy_trial_eligibility
         WHERE tenant_id = ${tenantId} AND customer_id::text IN (${list(part)})
      `);
      for (const row of result.rows) out.add(row.customer_id);
    }
    return out;
  }

  async shapesByKey(
    scope: TenantContext,
    shapeKeys: readonly string[],
  ): Promise<ReadonlyMap<string, { readonly id: string; readonly tariffStatus: string }>> {
    const tenantId = requireTenantId(scope);
    const out = new Map<string, { id: string; tariffStatus: string }>();
    for (const part of chunks(shapeKeys)) {
      const result = await this.db.execute<{
        id: string;
        shape_key: string;
        tariff_status: string;
      }>(sql`
        SELECT id, shape_key, tariff_status FROM legacy_product_shapes
         WHERE tenant_id = ${tenantId} AND shape_key IN (${list(part)})
      `);
      for (const row of result.rows)
        out.set(row.shape_key, { id: row.id, tariffStatus: row.tariff_status });
    }
    return out;
  }

  async tariffCandidates(scope: TenantContext): Promise<readonly TariffCandidate[]> {
    const tenantId = requireTenantId(scope);
    // Every ACTIVE public priced product: `resolveCurrentTariff` filters the rest, exactly
    // as the products phase's own resolution will.
    const result = await this.db.execute<{
      id: string;
      status: string;
      audience: string;
      duration_days: number;
      traffic_bytes: string;
      price_amount: string | null;
      price_currency: string | null;
      panel_bound: boolean;
      category_status: string | null;
    }>(sql`
      SELECT p.id, p.status, p.audience, p.duration_days, p.traffic_bytes::text AS traffic_bytes,
             p.price_amount::text AS price_amount, p.price_currency,
             (p.panel_id IS NOT NULL) AS panel_bound, c.status AS category_status
        FROM products p
        LEFT JOIN product_categories c ON c.id = p.category_id AND c.tenant_id = p.tenant_id
       WHERE p.tenant_id = ${tenantId} AND p.status = 'ACTIVE' AND p.audience = 'EVERYONE'
         AND p.price_amount IS NOT NULL
    `);
    return result.rows.map((r) => ({
      id: r.id,
      status: r.status as ProductStatus,
      audience: r.audience as ProductAudience,
      durationDays: r.duration_days,
      trafficBytes: BigInt(r.traffic_bytes),
      price:
        r.price_amount === null || r.price_currency === null
          ? null
          : money(BigInt(r.price_amount), r.price_currency as CurrencyCode),
      panelBound: r.panel_bound,
      categoryStatus: r.category_status as ProductCategoryStatus | null,
    }));
  }

  async walletTotals(
    scope: TenantContext,
    currency: string,
    options: { readonly excludeOpenings?: boolean } = {},
  ): Promise<{ readonly totalMinor: bigint; readonly customers: number }> {
    const tenantId = requireTenantId(scope);
    const reasons = options.excludeOpenings === true ? sql`AND reason <> ${OPENING_REASON}` : sql``;
    const result = await this.db.execute<{ total: string; customers: number }>(sql`
      SELECT
        COALESCE((SELECT sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END)
                    FROM wallet_entries WHERE tenant_id = ${tenantId} AND currency = ${currency}
                    ${reasons}), 0)::text AS total,
        (SELECT count(*)::int FROM customers WHERE tenant_id = ${tenantId}) AS customers
    `);
    const row = result.rows[0];
    return { totalMinor: BigInt(row?.total ?? '0'), customers: row?.customers ?? 0 };
  }

  async openingAggregates(scope: TenantContext) {
    const tenantId = requireTenantId(scope);
    const result = await this.db.execute<{
      n: number;
      total: string;
      positive: number;
      negative: number;
      per_customer_max: number;
    }>(sql`
      SELECT count(*)::int AS n,
             COALESCE(sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::text AS total,
             count(*) FILTER (WHERE direction = 'CREDIT')::int AS positive,
             count(*) FILTER (WHERE direction = 'DEBIT')::int AS negative,
             COALESCE((SELECT max(c)::int FROM (
               SELECT count(*) AS c FROM wallet_entries
                WHERE tenant_id = ${tenantId} AND reason = ${OPENING_REASON}
                GROUP BY customer_id) x), 0) AS per_customer_max
        FROM wallet_entries
       WHERE tenant_id = ${tenantId} AND reason = ${OPENING_REASON}
    `);
    const row = result.rows[0];
    return {
      count: row?.n ?? 0,
      sumMinor: BigInt(row?.total ?? '0'),
      positive: row?.positive ?? 0,
      negative: row?.negative ?? 0,
      perCustomerMax: row?.per_customer_max ?? 0,
    };
  }

  async trialDecisionCounts(scope: TenantContext): Promise<Readonly<Record<string, number>>> {
    const tenantId = requireTenantId(scope);
    const result = await this.db.execute<{ decision: string; n: number }>(sql`
      SELECT decision, count(*)::int AS n FROM legacy_trial_eligibility
       WHERE tenant_id = ${tenantId} GROUP BY decision ORDER BY decision
    `);
    return Object.fromEntries(result.rows.map((r) => [r.decision, r.n]));
  }

  async shapeStatusCounts(scope: TenantContext): Promise<Readonly<Record<string, number>>> {
    const tenantId = requireTenantId(scope);
    const result = await this.db.execute<{ status: string; n: number }>(sql`
      SELECT tariff_status || COALESCE('/' || unresolved_reason, '') AS status, count(*)::int AS n
        FROM legacy_product_shapes WHERE tenant_id = ${tenantId}
       GROUP BY 1 ORDER BY 1
    `);
    return Object.fromEntries(result.rows.map((r) => [r.status, r.n]));
  }

  async resolveTenantId(ref: string): Promise<string | null> {
    // Installation-wide by nature: the operator names the tenant before there is a scope.
    const result = await this.db.execute<{ id: string }>(
      sql`SELECT id FROM tenants WHERE id::text = ${ref} OR slug = ${ref}`,
    );
    return result.rows.length === 1 ? (result.rows[0]?.id ?? null) : null;
  }

  async tenantSlug(scope: TenantContext): Promise<string> {
    const tenantId = requireTenantId(scope);
    const result = await this.db.execute<{ slug: string }>(
      sql`SELECT slug FROM tenants WHERE id = ${tenantId}`,
    );
    return result.rows[0]?.slug ?? 'unknown';
  }

  async shapeFacts(scope: TenantContext, since: Date) {
    const tenantId = requireTenantId(scope);
    const result = await this.db.execute<{
      created: number;
      before: number;
      custom: number;
      unresolved: number;
    }>(sql`
      SELECT count(*) FILTER (WHERE created_at >= ${since.toISOString()}::timestamptz)::int AS created,
             count(*) FILTER (WHERE created_at < ${since.toISOString()}::timestamptz)::int AS before,
             count(*) FILTER (WHERE is_custom)::int AS custom,
             count(*) FILTER (WHERE tariff_status <> 'RESOLVED')::int AS unresolved
        FROM legacy_product_shapes WHERE tenant_id = ${tenantId}
    `);
    const row = result.rows[0];
    return {
      createdSinceRun: row?.created ?? 0,
      before: row?.before ?? 0,
      custom: row?.custom ?? 0,
      unresolved: row?.unresolved ?? 0,
    };
  }

  async auditCount(scope: TenantContext, action: string, entityId: string): Promise<number> {
    const tenantId = requireTenantId(scope);
    const result = await this.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM audit_logs
       WHERE tenant_id = ${tenantId} AND action = ${action} AND entity_id = ${entityId}
    `);
    return result.rows[0]?.n ?? 0;
  }

  async runningRun(scope: TenantContext): Promise<string | null> {
    const tenantId = requireTenantId(scope);
    const result = await this.db.execute<{ id: string }>(sql`
      SELECT id FROM legacy_import_runs WHERE tenant_id = ${tenantId} AND status = 'RUNNING'
    `);
    return result.rows[0]?.id ?? null;
  }

  async latestRun(
    scope: TenantContext,
    mode: 'DRY_RUN' | 'APPLY',
  ): Promise<{ readonly id: string; readonly status: string } | null> {
    const tenantId = requireTenantId(scope);
    const result = await this.db.execute<{ id: string; status: string }>(sql`
      SELECT id, status FROM legacy_import_runs
       WHERE tenant_id = ${tenantId} AND mode = ${mode}
       ORDER BY started_at DESC, id DESC LIMIT 1
    `);
    return result.rows[0] ?? null;
  }

  // --- run inputs -------------------------------------------------------------------------

  async record(
    scope: TenantContext,
    inputs: LegacyRunInputs,
    tx: TransactionScope,
  ): Promise<LegacyRunInputs> {
    const tenantId = requireTenantId(scope);
    await this.exec(tx).execute(sql`
      INSERT INTO legacy_import_run_inputs (
        tenant_id, run_id, source_engine, source_schema_hash, panel_mapping_fingerprint,
        wallet_currency, pre_import_wallet_total_minor, pre_import_customers, recorded_at)
      VALUES (${tenantId}, ${inputs.runId}, ${inputs.sourceEngine}, ${inputs.sourceSchemaHash},
              ${inputs.panelMappingFingerprint}, ${inputs.walletCurrency},
              ${inputs.preImportWalletTotalMinor.toString()}::bigint, ${inputs.preImportCustomers},
              ${inputs.recordedAt.toISOString()}::timestamptz)
      ON CONFLICT (tenant_id, run_id) DO NOTHING
    `);
    const stored = await this.find(scope, inputs.runId, tx);
    if (stored === null) throw new Error('the run inputs row was not written');
    return stored;
  }

  async find(scope: TenantContext, runId: string, tx?: unknown): Promise<LegacyRunInputs | null> {
    const tenantId = requireTenantId(scope);
    const result = await this.exec(tx).execute<{
      run_id: string;
      source_engine: string;
      source_schema_hash: string;
      panel_mapping_fingerprint: string;
      wallet_currency: string;
      pre: string;
      pre_import_customers: number;
      recorded_at: Date | string;
    }>(sql`
      SELECT run_id, source_engine, source_schema_hash, panel_mapping_fingerprint,
             wallet_currency, pre_import_wallet_total_minor::text AS pre, pre_import_customers,
             recorded_at
        FROM legacy_import_run_inputs WHERE tenant_id = ${tenantId} AND run_id = ${runId}
    `);
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      runId: row.run_id,
      sourceEngine: row.source_engine as LegacySourceEngine,
      sourceSchemaHash: row.source_schema_hash,
      panelMappingFingerprint: row.panel_mapping_fingerprint,
      walletCurrency: row.wallet_currency,
      preImportWalletTotalMinor: BigInt(row.pre),
      preImportCustomers: row.pre_import_customers,
      recordedAt: new Date(row.recorded_at),
    };
  }

  // --- read set runs (Mirza migration PR1) -------------------------------------------------

  async recordReadSetRun(
    scope: TenantContext,
    run: LegacyReadSetRun,
    tx: TransactionScope,
  ): Promise<{ readonly run: LegacyReadSetRun; readonly created: boolean }> {
    const tenantId = requireTenantId(scope);
    const inserted = await this.exec(tx).execute<{ id: string }>(sql`
      INSERT INTO legacy_read_set_runs (
        id, tenant_id, read_set, read_set_version, fingerprint_version, read_set_fingerprint,
        source_fingerprint, source_schema_hash, source_engine, synthetic, table_count,
        row_count, code_version, recorded_at)
      VALUES (${run.id}, ${tenantId}, ${run.readSet}, ${run.readSetVersion},
              ${run.fingerprintVersion}, ${run.readSetFingerprint}, ${run.sourceFingerprint},
              ${run.sourceSchemaHash}, ${run.sourceEngine}, ${run.synthetic}, ${run.tableCount},
              ${run.rowCount.toString()}::bigint, ${run.codeVersion},
              ${run.recordedAt.toISOString()}::timestamptz)
      ON CONFLICT ON CONSTRAINT legacy_read_set_runs_observation_key DO NOTHING
      RETURNING id
    `);
    const result = await this.exec(tx).execute<{
      id: string;
      read_set: string;
      read_set_version: number;
      fingerprint_version: string;
      read_set_fingerprint: string;
      source_fingerprint: string;
      source_schema_hash: string;
      source_engine: string;
      synthetic: boolean;
      table_count: number;
      row_count: string;
      code_version: string | null;
      recorded_at: Date | string;
    }>(sql`
      SELECT id, read_set, read_set_version, fingerprint_version, read_set_fingerprint,
             source_fingerprint, source_schema_hash, source_engine, synthetic, table_count,
             row_count::text AS row_count, code_version, recorded_at
        FROM legacy_read_set_runs
       WHERE tenant_id = ${tenantId} AND read_set = ${run.readSet}
         AND read_set_version = ${run.readSetVersion}
         AND read_set_fingerprint = ${run.readSetFingerprint}
         AND source_fingerprint = ${run.sourceFingerprint}
    `);
    const row = result.rows[0];
    if (row === undefined) throw new Error('the read set run row was not written');
    return {
      created: inserted.rows.length === 1,
      run: {
        id: row.id,
        readSet: row.read_set as LegacyReadSetName,
        readSetVersion: row.read_set_version,
        fingerprintVersion: row.fingerprint_version,
        readSetFingerprint: row.read_set_fingerprint,
        sourceFingerprint: row.source_fingerprint,
        sourceSchemaHash: row.source_schema_hash,
        sourceEngine: row.source_engine as LegacySourceEngine,
        synthetic: row.synthetic,
        tableCount: row.table_count,
        rowCount: BigInt(row.row_count),
        codeVersion: row.code_version,
        recordedAt: new Date(row.recorded_at),
      },
    };
  }

  // --- the customer insert ----------------------------------------------------------------

  /**
   * Insert-or-nothing on `(tenant, telegram_user_id)`. An existing customer is NEVER
   * modified — not its profile, not its status, not `last_seen_at` — which is the
   * difference from `CustomerRepository.resolve`, whose upsert refreshes a profile because
   * the customer just spoke to the bot. An imported customer did not.
   *
   * `first_bot_instance_id` is NULL: they arrived through no bot of this installation.
   */
  async insertIfAbsent(
    scope: TenantContext,
    input: LegacyCustomerInsert,
    tx: TransactionScope,
  ): Promise<{ readonly customerId: string; readonly created: boolean }> {
    const tenantId = requireTenantId(scope);
    const at = input.now.toISOString();
    const inserted = await this.exec(tx).execute<{ id: string }>(sql`
      INSERT INTO customers (id, tenant_id, telegram_user_id, username, status,
                             first_seen_at, last_seen_at, created_at, updated_at)
      VALUES (${input.id}, ${tenantId}, ${input.telegramUserId}, ${input.username}, 'ACTIVE',
              ${at}::timestamptz, ${at}::timestamptz, ${at}::timestamptz, ${at}::timestamptz)
      ON CONFLICT (tenant_id, telegram_user_id) DO NOTHING
      RETURNING id
    `);
    const created = inserted.rows[0];
    if (created !== undefined) return { customerId: created.id, created: true };
    const existing = await this.exec(tx).execute<{ id: string }>(sql`
      SELECT id FROM customers WHERE tenant_id = ${tenantId} AND telegram_user_id = ${input.telegramUserId}
    `);
    const row = existing.rows[0];
    if (row === undefined)
      throw new Error('a conflicting customer row vanished inside the transaction');
    return { customerId: row.id, created: false };
  }
}
