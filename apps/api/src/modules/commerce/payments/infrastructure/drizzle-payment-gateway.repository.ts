import { and, asc, count, eq, inArray } from 'drizzle-orm';
import {
  PAYMENT_GATEWAY_PROVIDERS,
  type PaymentGatewayConfig,
  type PaymentGatewayProvider,
  type PaymentGatewayStatus,
  type SalesCurrencyCode,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  customers,
  paymentGateways,
  payments,
} from '../../../../infrastructure/persistence/schema.js';
import type {
  GatewayAudienceReader,
  PaymentGatewayRecord,
  PaymentGatewayRepository,
} from '../application/gateway-ports.js';

/** The columns the record is built from. Selected explicitly, in one place. */
const COLUMNS = {
  provider: paymentGateways.provider,
  status: paymentGateways.status,
  displayName: paymentGateways.displayName,
  instructions: paymentGateways.instructions,
  minAmountMinor: paymentGateways.minAmountMinor,
  maxAmountMinor: paymentGateways.maxAmountMinor,
  boundsCurrency: paymentGateways.boundsCurrency,
  activateAfterPayments: paymentGateways.activateAfterPayments,
  deactivateAfterPayments: paymentGateways.deactivateAfterPayments,
  activateAfterAccountDays: paymentGateways.activateAfterAccountDays,
  sortOrder: paymentGateways.sortOrder,
  createdAt: paymentGateways.createdAt,
  updatedAt: paymentGateways.updatedAt,
} as const;

/** What a `select(COLUMNS)` yields. Written out, because the column type carries no nullability. */
interface Row {
  readonly provider: string;
  readonly status: string;
  readonly displayName: string | null;
  readonly instructions: string | null;
  readonly minAmountMinor: bigint;
  readonly maxAmountMinor: bigint;
  readonly boundsCurrency: string;
  readonly activateAfterPayments: number;
  readonly deactivateAfterPayments: number;
  readonly activateAfterAccountDays: number;
  readonly sortOrder: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function toRecord(row: Row): PaymentGatewayRecord {
  return {
    /*
     * Cast rather than re-validated, because `payment_gateways_provider_check` and
     * `payment_gateways_status_check` are built from these exact contract enums. The
     * database is the boundary that guarantees them, which is the rule
     * `docs/conventions.md` states for reading a column an enum CHECK constrains.
     */
    provider: row.provider as PaymentGatewayProvider,
    status: row.status as PaymentGatewayStatus,
    displayName: row.displayName,
    instructions: row.instructions,
    minAmountMinor: row.minAmountMinor,
    maxAmountMinor: row.maxAmountMinor,
    // `payment_gateways_bounds_currency_check` constrains it, as the two casts above.
    boundsCurrency: row.boundsCurrency as SalesCurrencyCode,
    activateAfterPayments: row.activateAfterPayments,
    deactivateAfterPayments: row.deactivateAfterPayments,
    activateAfterAccountDays: row.activateAfterAccountDays,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Payment routes, in PostgreSQL.
 *
 * Every query carries `eq(paymentGateways.tenantId, …)`, the primary-key lookups
 * included. Here the tenant term is half of the primary key rather than an extra
 * predicate, so a query that forgot it would not compile to a row lookup at all — which
 * is a nicer failure than the accounts table's, where forgetting it returns somebody
 * else's card number.
 */
export class DrizzlePaymentGatewayRepository implements PaymentGatewayRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  /** `(sort_order, provider)`, the one ordering, matching the index. */
  async list(scope: TenantContext, tx?: unknown): Promise<readonly PaymentGatewayRecord[]> {
    const tenantId = requireTenantId(scope);
    const query = this.exec(tx)
      .select(COLUMNS)
      .from(paymentGateways)
      .where(eq(paymentGateways.tenantId, tenantId))
      .orderBy(asc(paymentGateways.sortOrder), asc(paymentGateways.provider));
    /*
     * Inside a transaction, FOR SHARE. A caller that passes one is ISSUING a payment on
     * the strength of what this returns, and a plain read let an operator switch the
     * route off and commit between the read and the insert — the customer received a
     * new live transfer reference after the route was disabled. With the lock the
     * operator's `setStatus` UPDATE waits, or precedes this read and is seen. The Web
     * Admin's list passes no transaction and takes no lock; it decides nothing.
     */
    const rows = tx === undefined ? await query : await query.for('share');
    return rows.map(toRecord);
  }

  async find(
    scope: TenantContext,
    provider: PaymentGatewayProvider,
    tx?: unknown,
  ): Promise<PaymentGatewayRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select(COLUMNS)
      .from(paymentGateways)
      .where(and(eq(paymentGateways.tenantId, tenantId), eq(paymentGateways.provider, provider)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  /**
   * The zero row for every route this release can operate, for a tenant missing one.
   *
   * The SAME row migration 0071 writes, and deliberately so: a tenant provisioned after
   * this release and one upgraded into it must be indistinguishable, which is the claim
   * `recovery-permission-backfill.test.ts` reduces its own defect to. ACTIVE, because
   * the manual route IS how these installations take money; no bounds and no thresholds,
   * because that is "no additional condition".
   *
   * `ON CONFLICT DO NOTHING` rather than an upsert, so re-provisioning never resets a
   * route an operator has tuned. The count returned is rows WRITTEN, not rows wanted.
   */
  async ensureDefaults(
    scope: TenantContext,
    currency: SalesCurrencyCode,
    now: Date,
    tx?: unknown,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    const inserted = await this.exec(tx)
      .insert(paymentGateways)
      .values(
        PAYMENT_GATEWAY_PROVIDERS.map((provider) => ({
          tenantId,
          provider,
          status: 'ACTIVE' as const,
          /*
           * No display name, which is the point. NULL means "the product's own name for
           * this route" — provisioning does not invent customer-facing copy, and the
           * surface renders it from a template key.
           */
          displayName: null,
          instructions: null,
          // The zero bounds mean "unbounded", and even an unbounded route records the
          // denomination it was provisioned under: the first real bound an operator
          // types will be in it.
          boundsCurrency: currency,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .onConflictDoNothing()
      .returning({ provider: paymentGateways.provider });
    return inserted.length;
  }

  async update(
    scope: TenantContext,
    provider: PaymentGatewayProvider,
    config: PaymentGatewayConfig,
    currency: SalesCurrencyCode,
    now: Date,
    tx: unknown,
  ): Promise<PaymentGatewayRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(paymentGateways)
      .set({
        displayName: config.displayName,
        instructions: config.instructions,
        minAmountMinor: config.minAmountMinor,
        maxAmountMinor: config.maxAmountMinor,
        // Stamped with what the bounds MEAN at the moment they are written.
        boundsCurrency: currency,
        activateAfterPayments: config.eligibility.activateAfterPayments,
        deactivateAfterPayments: config.eligibility.deactivateAfterPayments,
        activateAfterAccountDays: config.eligibility.activateAfterAccountDays,
        sortOrder: config.sortOrder,
        updatedAt: now,
      })
      .where(and(eq(paymentGateways.tenantId, tenantId), eq(paymentGateways.provider, provider)))
      .returning(COLUMNS);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  /**
   * The conditional transition. `from` is in the WHERE, never checked and then written.
   *
   * A read-then-write would let two operators both see ACTIVE and both write DISABLED,
   * and the second would report a change it did not make — which for this column means
   * an audit row saying somebody switched a payment route off when they switched off
   * nothing. Naming `from` in the predicate makes the loser's UPDATE affect zero rows
   * and say so.
   */
  async setStatus(
    scope: TenantContext,
    provider: PaymentGatewayProvider,
    input: { readonly from: PaymentGatewayStatus; readonly to: PaymentGatewayStatus },
    now: Date,
    tx: unknown,
  ): Promise<PaymentGatewayRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(paymentGateways)
      .set({ status: input.to, updatedAt: now })
      .where(
        and(
          eq(paymentGateways.tenantId, tenantId),
          eq(paymentGateways.provider, provider),
          eq(paymentGateways.status, input.from),
        ),
      )
      .returning(COLUMNS);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }
}

/**
 * What the eligibility rules need to know about one customer, in PostgreSQL.
 *
 * Its own class rather than two methods bolted onto the payment repository, because the
 * counts come from two tables and only one of them is about payments.
 */
export class DrizzleGatewayAudienceReader implements GatewayAudienceReader {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  /**
   * CONFIRMED payments only, and the list is written out rather than negated.
   *
   * `inArray(['CONFIRMED'])` instead of `ne('PENDING')`, so a state added to
   * `PAYMENT_STATES` later cannot silently start counting towards a customer's payment
   * history. A new state has to be added here deliberately, which is the whole point: an
   * eligibility rule that widened itself when an unrelated enum grew is a rule nobody
   * would notice changing.
   */
  async confirmedPaymentCount(
    scope: TenantContext,
    customerId: UserId,
    tx?: unknown,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ total: count() })
      .from(payments)
      .where(
        and(
          eq(payments.tenantId, tenantId),
          eq(payments.customerId, customerId),
          inArray(payments.state, ['CONFIRMED']),
        ),
      );
    return Number(rows[0]?.total ?? 0);
  }

  async firstSeenAt(scope: TenantContext, customerId: UserId, tx?: unknown): Promise<Date | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ firstSeenAt: customers.firstSeenAt })
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), eq(customers.id, customerId)))
      .limit(1);
    return rows[0]?.firstSeenAt ?? null;
  }
}
