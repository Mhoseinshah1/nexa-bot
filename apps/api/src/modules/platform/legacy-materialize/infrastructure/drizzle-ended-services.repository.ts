import { sql } from 'drizzle-orm';
import type { TenantContext } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  ArchivedInvoiceRow,
  CarriedInvoice,
  EndedInvoiceInsert,
  EndedServicesCounts,
  EndedServicesRepository,
  MapFactRow,
  NeverPaidOrderInsert,
  ShapeProductRow,
} from '../application/ended-services.ports.js';

/**
 * The ended-services step's storage, in PostgreSQL. Raw SQL for the two inserts, for the
 * reason the adoption's store gives: each writes a row no business repository may — an order
 * that is `PAID` at birth with origin `LEGACY_HISTORY` at its original amount, and a service
 * that is `TERMINATED` at birth and was never provisioned.
 *
 * A never-paid invoice is one more insert: an order alone, EXPIRED or CANCELLED.
 *
 * Nothing here touches `provisioning_operations`, `service_username_reservations`,
 * `wallet_entries`, `outbox_messages` or `customer_notifications`; the database's own rules
 * (`orders_legacy_history_shape_check`, `services_terminated_at_check`,
 * `services_is_test_source_check`, the per-tenant `source_ref` unique indexes) still decide
 * what is valid, so a wrong value is a refused statement, not a stored one.
 */
export class DrizzleEndedServicesRepository implements EndedServicesRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: TransactionScope): Executor {
    return tx?.tx ?? this.db;
  }

  async archivePage(
    scope: TenantContext,
    sourceFingerprint: string,
    after: string | null,
    limit: number,
  ): Promise<readonly ArchivedInvoiceRow[]> {
    const tenantId = requireTenantId(scope);
    // The latest VISIBLE revision (its run COMPLETED) of each invoice recorded under this
    // source: a revision of another snapshot is another import's. DISTINCT ON in key order
    // with the LIMIT beside it, so a page costs a page, not the archive.
    const result = await this.exec().execute(sql`
      SELECT DISTINCT ON (a.invoice_key)
             a.invoice_key, a.key_shape_evidenced, a.status, a.is_test, a.legacy_user_id,
             a.username, a.panel_code, a.product_name, a.price_minor, a.price_currency,
             a.sold_at, a.raw_row
        FROM legacy_invoice_archive a
        JOIN legacy_invoice_archive_runs r
          ON r.tenant_id = a.tenant_id AND r.id = a.run_id AND r.state = 'COMPLETED'
       WHERE a.tenant_id = ${tenantId}
         AND a.source_fingerprint = ${sourceFingerprint}
         AND (${after}::text IS NULL OR a.invoice_key > ${after}::text)
       ORDER BY a.invoice_key, a.revision DESC
       LIMIT ${limit}`);
    return (
      result.rows as {
        invoice_key: string;
        key_shape_evidenced: boolean;
        status: string | null;
        is_test: boolean | null;
        legacy_user_id: string | null;
        username: string | null;
        panel_code: string | null;
        product_name: string | null;
        price_minor: string | bigint | null;
        price_currency: string | null;
        sold_at: Date | string | null;
        raw_row: Record<string, string | null>;
      }[]
    ).map((r) => ({
      invoiceKey: r.invoice_key,
      keyShapeEvidenced: r.key_shape_evidenced,
      status: r.status,
      isTest: r.is_test,
      legacyUserId: r.legacy_user_id,
      username: r.username,
      panelCode: r.panel_code,
      productName: r.product_name,
      // Only IRT is a Toman price (owner decision 7); anything else is "does not read".
      priceMinor:
        r.price_minor === null || r.price_currency !== 'IRT' ? null : BigInt(r.price_minor),
      soldAt: r.sold_at === null ? null : new Date(r.sold_at),
      codePanel: r.raw_row['code_panel'] ?? null,
      volume: r.raw_row['Volume'] ?? null,
      serviceTime: r.raw_row['Service_time'] ?? null,
      timeUnit: r.raw_row['time_unit'] ?? null,
      isCustom: r.raw_row['is_custom'] ?? null,
    }));
  }

  async mapFacts(
    scope: TenantContext,
    invoiceKeys: readonly string[],
  ): Promise<ReadonlyMap<string, MapFactRow>> {
    const tenantId = requireTenantId(scope);
    const out = new Map<string, MapFactRow>();
    if (invoiceKeys.length === 0) return out;
    const result = await this.exec().execute(sql`
      SELECT legacy_id, status, reason_code, entity_type FROM legacy_import_map
       WHERE tenant_id = ${tenantId} AND legacy_table = 'invoice'
         AND legacy_id = ANY(${sql.param([...invoiceKeys])}::text[])`);
    for (const r of result.rows as {
      legacy_id: string;
      status: string;
      reason_code: string | null;
      entity_type: string | null;
    }[]) {
      out.set(r.legacy_id, {
        status: r.status,
        reasonCode: r.reason_code,
        entityType: r.entity_type,
      });
    }
    return out;
  }

  async importedCustomers(
    scope: TenantContext,
    legacyUserIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    const tenantId = requireTenantId(scope);
    const out = new Map<string, string>();
    if (legacyUserIds.length === 0) return out;
    const result = await this.exec().execute(sql`
      SELECT legacy_id, entity_id FROM legacy_import_map
       WHERE tenant_id = ${tenantId} AND legacy_table = 'user' AND status = 'IMPORTED'
         AND entity_type = 'CUSTOMER' AND entity_id IS NOT NULL
         AND legacy_id = ANY(${sql.param([...new Set(legacyUserIds)])}::text[])`);
    for (const r of result.rows as { legacy_id: string; entity_id: string }[]) {
      out.set(r.legacy_id, r.entity_id);
    }
    return out;
  }

  async panelBindings(
    scope: TenantContext,
    packageImportId: string,
  ): Promise<ReadonlyMap<string, string>> {
    const tenantId = requireTenantId(scope);
    const result = await this.exec().execute(sql`
      SELECT panel_bindings FROM legacy_nxpkg_imports
       WHERE tenant_id = ${tenantId} AND id = ${packageImportId}::uuid`);
    const raw = (result.rows as { panel_bindings: unknown }[])[0]?.panel_bindings;
    const out = new Map<string, string>();
    if (!Array.isArray(raw)) return out;
    for (const binding of raw as { codePanel?: unknown; panelId?: unknown }[]) {
      if (typeof binding.codePanel === 'string' && typeof binding.panelId === 'string') {
        out.set(binding.codePanel.trim(), binding.panelId);
      }
    }
    return out;
  }

  async shapeProducts(
    scope: TenantContext,
    shapeKeys: readonly string[],
  ): Promise<ReadonlyMap<string, ShapeProductRow>> {
    const tenantId = requireTenantId(scope);
    const out = new Map<string, ShapeProductRow>();
    if (shapeKeys.length === 0) return out;
    const result = await this.exec().execute(sql`
      SELECT s.shape_key, p.id, p.title, p.duration_days, p.traffic_bytes
        FROM legacy_product_shapes s
        JOIN products p ON p.tenant_id = s.tenant_id AND p.id = s.product_id
       WHERE s.tenant_id = ${tenantId}
         AND s.shape_key = ANY(${sql.param([...shapeKeys])}::text[])`);
    for (const r of result.rows as {
      shape_key: string;
      id: string;
      title: string;
      duration_days: number;
      traffic_bytes: string | bigint;
    }[]) {
      out.set(r.shape_key, {
        productId: r.id,
        title: r.title,
        durationDays: r.duration_days,
        trafficBytes: BigInt(r.traffic_bytes),
      });
    }
    return out;
  }

  async carried(
    scope: TenantContext,
    sourceRefs: readonly string[],
    tx?: TransactionScope,
  ): Promise<ReadonlyMap<string, CarriedInvoice>> {
    const tenantId = requireTenantId(scope);
    const out = new Map<string, CarriedInvoice>();
    if (sourceRefs.length === 0) return out;
    const refs = sql.param([...sourceRefs]);
    const result = await this.exec(tx).execute(sql`
      SELECT COALESCE(o.source_ref, s.source_ref) AS source_ref,
             o.id AS order_id, o.origin AS order_origin, o.state AS order_state,
             o.customer_id AS order_customer_id,
             o.panel_id AS order_panel_id, o.total_amount AS order_total,
             s.id AS service_id, s.state AS service_state, s.customer_id AS service_customer_id,
             s.is_test AS service_is_test
        FROM orders o
        FULL OUTER JOIN services s
          ON s.tenant_id = o.tenant_id AND s.source_ref = o.source_ref
       WHERE (o.tenant_id = ${tenantId} AND o.source_ref = ANY(${refs}::text[]))
          OR (s.tenant_id = ${tenantId} AND s.source_ref = ANY(${refs}::text[]))`);
    for (const r of result.rows as {
      source_ref: string;
      order_id: string | null;
      order_origin: string | null;
      order_state: string | null;
      order_customer_id: string | null;
      order_panel_id: string | null;
      order_total: string | bigint | null;
      service_id: string | null;
      service_state: string | null;
      service_customer_id: string | null;
      service_is_test: boolean | null;
    }[]) {
      out.set(r.source_ref, {
        orderId: r.order_id,
        orderOrigin: r.order_origin,
        orderState: r.order_state,
        orderCustomerId: r.order_customer_id,
        orderPanelId: r.order_panel_id,
        orderTotal: r.order_total === null ? null : BigInt(r.order_total),
        serviceId: r.service_id,
        serviceState: r.service_state,
        serviceCustomerId: r.service_customer_id,
        serviceIsTest: r.service_is_test,
      });
    }
    return out;
  }

  async lock(scope: TenantContext, tx: TransactionScope): Promise<void> {
    const tenantId = requireTenantId(scope);
    await tx.tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`legacy-materialize:ended-services:${tenantId}`}, 0))`,
    );
  }

  async insertEnded(
    scope: TenantContext,
    input: EndedInvoiceInsert,
    tx: TransactionScope,
  ): Promise<void> {
    await this.insertEndedMany(scope, [input], tx);
  }

  /**
   * Each invoice as history: its order and its TERMINATED service, exactly the two rows
   * `insertEnded` always wrote, many invoices a statement (orders first: a service names its
   * order).
   */
  async insertEndedMany(
    scope: TenantContext,
    inputs: readonly EndedInvoiceInsert[],
    tx: TransactionScope,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    for (let i = 0; i < inputs.length; i += ENDED_INSERT_CHUNK) {
      const chunk = inputs.slice(i, i + ENDED_INSERT_CHUNK);
      /*
       * The orders: a Mirza invoice as history. NEW_SERVICE + LEGACY_HISTORY, PAID at birth at
       * the invoice's own amount and date, no code, no deadline. `orders_legacy_history_shape_check`
       * pins MIRZA, no code and a settled state; origin is not a sale (`SALE_ORDER_ORIGINS`), so
       * no report counts the amount as revenue.
       */
      await tx.tx.execute(sql`
        INSERT INTO orders
          (id, tenant_id, customer_id, state, purpose, origin, product_id, panel_id, line_title,
           line_duration_days, line_traffic_bytes, line_device_limit, line_unit_price_amount,
           line_quantity, subtotal_amount, discount_amount, total_amount, currency, quote,
           confirmed_at, settled_at, created_at, updated_at, source, source_ref)
        VALUES ${sql.join(
          chunk.map((input) => {
            const quote = historyQuote(
              input.product.productId,
              input.purchasedAt,
              input.amountMinor,
              input.currency,
            );
            return sql`(${input.orderId}, ${tenantId}, ${input.customerId}, 'PAID', 'NEW_SERVICE',
             'LEGACY_HISTORY', ${input.product.productId}, ${input.panelId}, ${input.lineTitle},
             ${input.product.durationDays}, ${input.product.trafficBytes}, NULL,
             ${input.amountMinor}, 1, ${input.amountMinor}, 0, ${input.amountMinor},
             ${input.currency}, ${quote}::jsonb,
             ${input.purchasedAt}, ${input.purchasedAt}, ${input.purchasedAt}, ${input.now},
             'MIRZA', ${input.sourceRef})`;
          }),
          sql`, `,
        )}`);
      /*
       * The services: TERMINATED at birth. No provisioning operation, no username reservation,
       * no provider id; `provisioned_at` stays NULL ("this one never reached a panel", the
       * words `services_provisioned_at_check` uses). `delivery_state` is PENDING by default and
       * the delivery sweep reads ACTIVE services only. The recorded expiry is the purchase plus
       * the plan's days, history and nothing else: `services_expiry_idx` is partial on live
       * states.
       */
      await tx.tx.execute(sql`
        INSERT INTO services
          (id, tenant_id, customer_id, order_id, panel_id, product_id, state, provider_username,
           subscription_ref, expires_at, traffic_limit_bytes, traffic_used_bytes,
           terminated_at, created_at, updated_at, source, source_ref, is_test)
        VALUES ${sql.join(
          chunk.map(
            (input) => sql`(${input.serviceId}, ${tenantId}, ${input.customerId}, ${input.orderId},
             ${input.panelId}, ${input.product.productId}, 'TERMINATED', ${input.providerUsername},
             ${input.subscriptionRef},
             ${input.product.durationDays > 0 ? sql`${input.purchasedAt}::timestamptz + make_interval(days => ${input.product.durationDays})` : sql`NULL`},
             ${input.product.trafficBytes}, 0, ${input.now}, ${input.purchasedAt}, ${input.now},
             'MIRZA', ${input.sourceRef}, ${input.isTest})`,
          ),
          sql`, `,
        )}`);
    }
  }

  async insertNeverPaid(
    scope: TenantContext,
    input: NeverPaidOrderInsert,
    tx: TransactionScope,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    const quote = historyQuote(
      input.product.productId,
      input.createdAt,
      input.amountMinor,
      input.currency,
    );
    /*
     * A never-paid Mirza invoice as history: NEW_SERVICE + LEGACY_HISTORY in EXPIRED or
     * CANCELLED, at the invoice's own amount and date, and NOTHING beside it — no service, no
     * payment, no ledger entry, no reservation. Never settled (`settled_at` NULL, which
     * `orders_settled_at_check` requires of an unpaid state), never confirmed (no evidence it
     * was), no payment deadline (`expires_at` NULL, and `orders_expiry_idx` is on
     * AWAITING_PAYMENT only, so the order sweeper never sees it). A CANCELLED one records the
     * import time as `cancelled_at` (`orders_cancelled_at_check`), as an ended service records
     * it as `terminated_at`: Mirza kept no time for the failure. The 0253 trigger freezes the
     * state and the amounts from here on; origin is not a sale (`SALE_ORDER_ORIGINS`).
     */
    await tx.tx.execute(sql`
      INSERT INTO orders
        (id, tenant_id, customer_id, state, purpose, origin, product_id, panel_id, line_title,
         line_duration_days, line_traffic_bytes, line_device_limit, line_unit_price_amount,
         line_quantity, subtotal_amount, discount_amount, total_amount, currency, quote,
         confirmed_at, settled_at, cancelled_at, created_at, updated_at, source, source_ref)
      VALUES
        (${input.orderId}, ${tenantId}, ${input.customerId}, ${input.state}, 'NEW_SERVICE',
         'LEGACY_HISTORY', ${input.product.productId}, ${input.panelId}, ${input.lineTitle},
         ${input.product.durationDays}, ${input.product.trafficBytes}, NULL,
         ${input.amountMinor}, 1, ${input.amountMinor}, 0, ${input.amountMinor},
         ${input.currency}, ${quote}::jsonb,
         NULL, NULL, ${input.state === 'CANCELLED' ? input.now : null},
         ${input.createdAt}, ${input.now}, 'MIRZA', ${input.sourceRef})`);
  }

  async counts(scope: TenantContext): Promise<EndedServicesCounts> {
    const tenantId = requireTenantId(scope);
    // `invoice-never-paid:%` is not matched by `invoice:%` (the character after `invoice` is
    // `-`, not `:`), so the two populations are counted apart and never twice.
    const result = await this.exec().execute(sql`
      SELECT
        (SELECT count(*)::int FROM services
          WHERE tenant_id = ${tenantId} AND source = 'MIRZA' AND source_ref LIKE 'invoice:%')
          AS services,
        (SELECT count(*)::int FROM services
          WHERE tenant_id = ${tenantId} AND source = 'MIRZA' AND source_ref LIKE 'invoice:%'
            AND state = 'TERMINATED') AS terminated,
        (SELECT count(*)::int FROM orders
          WHERE tenant_id = ${tenantId} AND origin = 'LEGACY_HISTORY'
            AND (source_ref LIKE 'invoice:%' OR source_ref LIKE 'invoice-never-paid:%'))
          AS orders,
        (SELECT COALESCE(sum(total_amount), 0)::text FROM orders
          WHERE tenant_id = ${tenantId} AND origin = 'LEGACY_HISTORY' AND state = 'PAID'
            AND (source_ref LIKE 'invoice:%' OR source_ref LIKE 'invoice-never-paid:%'))
          AS paid_total,
        (SELECT count(*)::int FROM orders
          WHERE tenant_id = ${tenantId} AND origin = 'LEGACY_HISTORY'
            AND source_ref LIKE 'invoice-never-paid:%') AS never_paid,
        (SELECT COALESCE(sum(total_amount), 0)::text FROM orders
          WHERE tenant_id = ${tenantId} AND origin = 'LEGACY_HISTORY'
            AND source_ref LIKE 'invoice-never-paid:%') AS never_paid_total`);
    const row = (
      result.rows as {
        services: number;
        terminated: number;
        orders: number;
        paid_total: string;
        never_paid: number;
        never_paid_total: string;
      }[]
    )[0];
    return {
      services: row?.services ?? 0,
      terminatedServices: row?.terminated ?? 0,
      historyOrders: row?.orders ?? 0,
      paidHistoryOrdersTotalMinor: BigInt(row?.paid_total ?? '0'),
      neverPaidOrders: row?.never_paid ?? 0,
      neverPaidOrdersTotalMinor: BigInt(row?.never_paid_total ?? '0'),
    };
  }
}

/** The one-line quote a history order carries: its own amount as the base price, nothing else. */
function historyQuote(productId: string, at: Date, amountMinor: bigint, currency: 'IRT'): string {
  return JSON.stringify({
    productId,
    quotedAt: at.toISOString(),
    currency,
    finalAmount: { amountMinor: amountMinor.toString(), currency },
    trace: [
      {
        step: 'BASE_PRICE',
        effect: 'REPLACES',
        ruleId: null,
        ruleLabel: 'legacy history',
        amountBefore: { amountMinor: '0', currency },
        amountAfter: { amountMinor: amountMinor.toString(), currency },
      },
    ],
  });
}

/** Invoices per statement: 20 parameters a row at most, so 2 000 stay under PostgreSQL's 65 535. */
const ENDED_INSERT_CHUNK = 2000;
