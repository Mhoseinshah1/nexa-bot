import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type {
  CurrencyCode,
  GatewayInvoiceCreationState,
  GatewayInvoiceOutcome,
  PaymentGatewayProvider,
  PaymentId,
  TenantContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { gatewayInvoices, payments } from '../../../../infrastructure/persistence/schema.js';
import type {
  ClaimedGatewayInvoice,
  GatewayInvoiceRecord,
  GatewayInvoiceRepository,
} from '../application/gateway-invoice-ports.js';

type Row = typeof gatewayInvoices.$inferSelect;

function toRecord(row: Row): GatewayInvoiceRecord {
  return {
    paymentId: row.paymentId as PaymentId,
    // Both constrained by CHECKs built from the contract enums.
    provider: row.provider as PaymentGatewayProvider,
    providerOrderId: row.providerOrderId,
    providerInvoiceId: row.providerInvoiceId,
    hintedInvoiceId: row.hintedInvoiceId,
    creationState: row.creationState as GatewayInvoiceCreationState,
    creationAttempts: row.creationAttempts,
    creationSentAt: row.creationSentAt,
    creationRetryAt: row.creationRetryAt,
    creationErrorCode: row.creationErrorCode,
    createdInvoiceAt: row.createdInvoiceAt,
    buyerChatIdSent: row.buyerChatIdSent,
    callbackUrlSent: row.callbackUrlSent,
    invoiceUrl: row.invoiceUrl,
    webInvoiceUrl: row.webInvoiceUrl,
    providerUnit: row.providerUnit as CurrencyCode,
    sentAmount: row.sentAmount,
    requestAmount: row.requestAmount,
    finalAmount: row.finalAmount,
    creditAmount: row.creditAmount,
    providerStatus: row.providerStatus,
    providerPaid: row.providerPaid,
    lastInquiryAt: row.lastInquiryAt,
    lastInquiryErrorCode: row.lastInquiryErrorCode,
    inquiryAttempts: row.inquiryAttempts,
    nextInquiryAt: row.nextInquiryAt,
    postDeadlineInquiries: row.postDeadlineInquiries,
    webhookStatusHint: row.webhookStatusHint,
    lastWebhookAt: row.lastWebhookAt,
    lastWebhookDeliveryId: row.lastWebhookDeliveryId,
    webhookCount: row.webhookCount,
    outcome: row.outcome as GatewayInvoiceOutcome | null,
    outcomeAt: row.outcomeAt,
    lateCompletionObservedAt: row.lateCompletionObservedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The external gateway's side of each payment attempt (WP11A). Every statement names the
 * tenant; none resolves a provider identifier globally.
 */
export class DrizzleGatewayInvoiceRepository implements GatewayInvoiceRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async open(
    scope: TenantContext,
    input: {
      readonly paymentId: PaymentId;
      readonly provider: PaymentGatewayProvider;
      readonly providerOrderId: string;
      readonly providerUnit: CurrencyCode;
      readonly sentAmount: bigint;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<GatewayInvoiceRecord> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .insert(gatewayInvoices)
      .values({
        paymentId: input.paymentId,
        tenantId,
        provider: input.provider,
        providerOrderId: input.providerOrderId,
        creationState: 'CREATING',
        providerUnit: input.providerUnit,
        sentAmount: input.sentAmount,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning();
    if (row === undefined) throw new Error('gateway invoice insert returned no row');
    return toRecord(row);
  }

  async findByPayment(
    scope: TenantContext,
    paymentId: PaymentId,
    tx?: unknown,
  ): Promise<GatewayInvoiceRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .select()
      .from(gatewayInvoices)
      .where(and(eq(gatewayInvoices.tenantId, tenantId), eq(gatewayInvoices.paymentId, paymentId)))
      .limit(1);
    return row === undefined ? null : toRecord(row);
  }

  async findByProviderOrderId(
    scope: TenantContext,
    provider: PaymentGatewayProvider,
    providerOrderId: string,
    tx?: unknown,
  ): Promise<GatewayInvoiceRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .select()
      .from(gatewayInvoices)
      .where(
        and(
          eq(gatewayInvoices.tenantId, tenantId),
          eq(gatewayInvoices.provider, provider),
          eq(gatewayInvoices.providerOrderId, providerOrderId),
        ),
      )
      .limit(1);
    return row === undefined ? null : toRecord(row);
  }

  async claimCreating(
    scope: TenantContext,
    now: Date,
    leaseMs: number,
    limit: number,
    tx?: unknown,
  ): Promise<readonly ClaimedGatewayInvoice[]> {
    const tenantId = requireTenantId(scope);
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const claimable = and(
      eq(gatewayInvoices.tenantId, tenantId),
      eq(gatewayInvoices.creationState, 'CREATING'),
      or(
        isNull(gatewayInvoices.creationClaimedUntil),
        lte(gatewayInvoices.creationClaimedUntil, now),
      ),
      or(isNull(gatewayInvoices.creationRetryAt), lte(gatewayInvoices.creationRetryAt, now)),
    );
    const due = this.exec(tx)
      .select({ paymentId: gatewayInvoices.paymentId })
      .from(gatewayInvoices)
      .where(claimable)
      .orderBy(asc(gatewayInvoices.createdAt), asc(gatewayInvoices.paymentId))
      .limit(limit)
      .for('update', { skipLocked: true });
    const rows = await this.exec(tx)
      .update(gatewayInvoices)
      .set({ creationClaimedUntil: leaseUntil, updatedAt: now })
      .where(and(claimable, sql`${gatewayInvoices.paymentId} IN ${due}`))
      .returning();
    return this.withPayments(scope, rows, tx);
  }

  async markCreationSent(
    scope: TenantContext,
    paymentId: PaymentId,
    now: Date,
    tx?: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(gatewayInvoices)
      .set({
        creationSentAt: now,
        creationAttempts: sql`${gatewayInvoices.creationAttempts} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(gatewayInvoices.tenantId, tenantId),
          eq(gatewayInvoices.paymentId, paymentId),
          eq(gatewayInvoices.creationState, 'CREATING'),
          isNull(gatewayInvoices.creationSentAt),
        ),
      )
      .returning({ paymentId: gatewayInvoices.paymentId });
    return rows.length > 0;
  }

  async recordCreated(
    scope: TenantContext,
    paymentId: PaymentId,
    created: {
      readonly invoiceId: string;
      readonly invoiceUrl: string | null;
      readonly webInvoiceUrl: string | null;
      readonly status: string | null;
      readonly requestAmount: bigint | null;
      readonly finalAmount: bigint | null;
      readonly buyerChatIdSent: boolean;
      readonly callbackUrlSent: boolean;
      readonly firstInquiryAt: Date;
    },
    now: Date,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(gatewayInvoices)
      .set({
        creationState: 'CREATED',
        providerInvoiceId: created.invoiceId,
        createdInvoiceAt: now,
        invoiceUrl: created.invoiceUrl,
        webInvoiceUrl: created.webInvoiceUrl,
        // The create's status is metadata; only an inquiry's is ever acted on.
        requestAmount: created.requestAmount,
        finalAmount: created.finalAmount,
        buyerChatIdSent: created.buyerChatIdSent,
        callbackUrlSent: created.callbackUrlSent,
        creationClaimedUntil: null,
        creationErrorCode: null,
        nextInquiryAt: created.firstInquiryAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(gatewayInvoices.tenantId, tenantId),
          eq(gatewayInvoices.paymentId, paymentId),
          eq(gatewayInvoices.creationState, 'CREATING'),
        ),
      )
      .returning({ paymentId: gatewayInvoices.paymentId });
    return rows.length > 0;
  }

  async recordCreationEnded(
    scope: TenantContext,
    paymentId: PaymentId,
    to: 'CREATE_FAILED' | 'CREATE_UNKNOWN',
    errorCode: string,
    now: Date,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(gatewayInvoices)
      .set({
        creationState: to,
        creationErrorCode: errorCode,
        creationClaimedUntil: null,
        nextInquiryAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(gatewayInvoices.tenantId, tenantId),
          eq(gatewayInvoices.paymentId, paymentId),
          eq(gatewayInvoices.creationState, 'CREATING'),
        ),
      )
      .returning({ paymentId: gatewayInvoices.paymentId });
    return rows.length > 0;
  }

  async deferCreation(
    scope: TenantContext,
    paymentId: PaymentId,
    errorCode: string,
    retryAt: Date,
    now: Date,
    tx?: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(gatewayInvoices)
      .set({
        // Cleared ONLY here, where the provider said in so many words that it did not
        // process the request. Anywhere else a stamped send means the answer is unknown.
        creationSentAt: null,
        creationClaimedUntil: null,
        creationRetryAt: retryAt,
        creationErrorCode: errorCode,
        updatedAt: now,
      })
      .where(
        and(
          eq(gatewayInvoices.tenantId, tenantId),
          eq(gatewayInvoices.paymentId, paymentId),
          eq(gatewayInvoices.creationState, 'CREATING'),
        ),
      )
      .returning({ paymentId: gatewayInvoices.paymentId });
    return rows.length > 0;
  }

  async claimInquiries(
    scope: TenantContext,
    now: Date,
    leaseMs: number,
    limit: number,
    tx?: unknown,
  ): Promise<readonly ClaimedGatewayInvoice[]> {
    const tenantId = requireTenantId(scope);
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const claimable = and(
      eq(gatewayInvoices.tenantId, tenantId),
      isNotNull(gatewayInvoices.nextInquiryAt),
      lte(gatewayInvoices.nextInquiryAt, now),
      or(
        isNull(gatewayInvoices.inquiryClaimedUntil),
        lte(gatewayInvoices.inquiryClaimedUntil, now),
      ),
      // Something to ask about: a created invoice, or one a webhook named for a lost create.
      or(isNotNull(gatewayInvoices.providerInvoiceId), isNotNull(gatewayInvoices.hintedInvoiceId)),
    );
    const due = this.exec(tx)
      .select({ paymentId: gatewayInvoices.paymentId })
      .from(gatewayInvoices)
      .where(claimable)
      .orderBy(asc(gatewayInvoices.nextInquiryAt), asc(gatewayInvoices.paymentId))
      .limit(limit)
      .for('update', { skipLocked: true });
    const rows = await this.exec(tx)
      .update(gatewayInvoices)
      .set({ inquiryClaimedUntil: leaseUntil, updatedAt: now })
      .where(and(claimable, sql`${gatewayInvoices.paymentId} IN ${due}`))
      .returning();
    return this.withPayments(scope, rows, tx);
  }

  async recordInquiry(
    scope: TenantContext,
    paymentId: PaymentId,
    result: {
      readonly status: string | null;
      readonly paid: boolean | null;
      readonly requestAmount: bigint | null;
      readonly finalAmount: bigint | null;
      readonly errorCode: string | null;
      readonly adoptInvoiceId: string | null;
      readonly nextInquiryAt: Date | null;
      readonly postDeadline: boolean;
    },
    now: Date,
    tx?: unknown,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    await this.exec(tx)
      .update(gatewayInvoices)
      .set({
        // An error leaves the last OBSERVED status standing: a failed call says nothing new.
        ...(result.status === null
          ? {}
          : {
              providerStatus: result.status,
              providerPaid: result.paid,
              requestAmount: result.requestAmount,
              finalAmount: result.finalAmount,
            }),
        ...(result.adoptInvoiceId === null ? {} : { providerInvoiceId: result.adoptInvoiceId }),
        lastInquiryAt: now,
        lastInquiryErrorCode: result.errorCode,
        inquiryAttempts: sql`${gatewayInvoices.inquiryAttempts} + 1`,
        ...(result.postDeadline
          ? { postDeadlineInquiries: sql`${gatewayInvoices.postDeadlineInquiries} + 1` }
          : {}),
        nextInquiryAt: result.nextInquiryAt,
        inquiryClaimedUntil: null,
        updatedAt: now,
      })
      .where(and(eq(gatewayInvoices.tenantId, tenantId), eq(gatewayInvoices.paymentId, paymentId)));
  }

  async recordOutcome(
    scope: TenantContext,
    paymentId: PaymentId,
    outcome: GatewayInvoiceOutcome,
    now: Date,
    tx?: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(gatewayInvoices)
      .set({ outcome, outcomeAt: now, nextInquiryAt: null, updatedAt: now })
      .where(
        and(
          eq(gatewayInvoices.tenantId, tenantId),
          eq(gatewayInvoices.paymentId, paymentId),
          isNull(gatewayInvoices.outcome),
        ),
      )
      .returning({ paymentId: gatewayInvoices.paymentId });
    return rows.length > 0;
  }

  async markLateCompletion(
    scope: TenantContext,
    paymentId: PaymentId,
    now: Date,
    tx?: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(gatewayInvoices)
      .set({ lateCompletionObservedAt: now, nextInquiryAt: null, updatedAt: now })
      .where(
        and(
          eq(gatewayInvoices.tenantId, tenantId),
          eq(gatewayInvoices.paymentId, paymentId),
          isNull(gatewayInvoices.lateCompletionObservedAt),
        ),
      )
      .returning({ paymentId: gatewayInvoices.paymentId });
    return rows.length > 0;
  }

  async recordWebhook(
    scope: TenantContext,
    paymentId: PaymentId,
    hint: {
      readonly status: string | null;
      readonly deliveryId: string | null;
      readonly creditAmount: bigint | null;
      readonly hintedInvoiceId: string | null;
      readonly inquireAt: Date | null;
    },
    now: Date,
    tx?: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(gatewayInvoices)
      .set({
        webhookStatusHint: hint.status,
        lastWebhookAt: now,
        lastWebhookDeliveryId: hint.deliveryId,
        webhookCount: sql`${gatewayInvoices.webhookCount} + 1`,
        ...(hint.creditAmount === null ? {} : { creditAmount: hint.creditAmount }),
        // A hint lands only where nothing better is known, and never replaces one.
        ...(hint.hintedInvoiceId === null
          ? {}
          : {
              hintedInvoiceId: sql`COALESCE(${gatewayInvoices.hintedInvoiceId}, ${hint.hintedInvoiceId})`,
            }),
        // Brought FORWARD only, never pushed back.
        ...(hint.inquireAt === null
          ? {}
          : {
              nextInquiryAt: sql`LEAST(COALESCE(${gatewayInvoices.nextInquiryAt}, ${hint.inquireAt}::timestamptz), ${hint.inquireAt}::timestamptz)`,
            }),
        updatedAt: now,
      })
      .where(
        and(
          eq(gatewayInvoices.tenantId, tenantId),
          eq(gatewayInvoices.paymentId, paymentId),
          // A redelivery of the delivery already recorded is a duplicate and changes nothing.
          hint.deliveryId === null
            ? undefined
            : or(
                isNull(gatewayInvoices.lastWebhookDeliveryId),
                sql`${gatewayInvoices.lastWebhookDeliveryId} <> ${hint.deliveryId}`,
              ),
        ),
      )
      .returning({ paymentId: gatewayInvoices.paymentId });
    return rows.length > 0;
  }

  async requestInquiry(
    scope: TenantContext,
    paymentId: PaymentId,
    at: Date,
    tx?: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(gatewayInvoices)
      .set({
        nextInquiryAt: sql`LEAST(COALESCE(${gatewayInvoices.nextInquiryAt}, ${at}::timestamptz), ${at}::timestamptz)`,
        updatedAt: at,
      })
      .where(
        and(
          eq(gatewayInvoices.tenantId, tenantId),
          eq(gatewayInvoices.paymentId, paymentId),
          eq(gatewayInvoices.creationState, 'CREATED'),
          isNull(gatewayInvoices.outcome),
        ),
      )
      .returning({ paymentId: gatewayInvoices.paymentId });
    return rows.length > 0;
  }

  async findOpenAttempt(
    scope: TenantContext,
    input: {
      readonly provider: PaymentGatewayProvider;
      readonly orderId: string | null;
      readonly customerId: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<GatewayInvoiceRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ invoice: gatewayInvoices })
      .from(gatewayInvoices)
      .innerJoin(
        payments,
        and(
          eq(payments.tenantId, gatewayInvoices.tenantId),
          eq(payments.id, gatewayInvoices.paymentId),
        ),
      )
      .where(
        and(
          eq(gatewayInvoices.tenantId, tenantId),
          eq(gatewayInvoices.provider, input.provider),
          inArray(gatewayInvoices.creationState, ['CREATING', 'CREATED']),
          eq(payments.state, 'PENDING'),
          eq(payments.customerId, input.customerId),
          input.orderId === null ? isNull(payments.orderId) : eq(payments.orderId, input.orderId),
          gt(payments.expiresAt, input.now),
        ),
      )
      .orderBy(sql`${gatewayInvoices.createdAt} DESC`)
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row.invoice);
  }

  private async withPayments(
    scope: TenantContext,
    rows: readonly Row[],
    tx?: unknown,
  ): Promise<readonly ClaimedGatewayInvoice[]> {
    if (rows.length === 0) return [];
    const tenantId = requireTenantId(scope);
    const facts = await this.exec(tx)
      .select({
        id: payments.id,
        customerId: payments.customerId,
        state: payments.state,
        expiresAt: payments.expiresAt,
      })
      .from(payments)
      .where(
        and(
          eq(payments.tenantId, tenantId),
          inArray(
            payments.id,
            rows.map((row) => row.paymentId),
          ),
        ),
      );
    const byId = new Map(facts.map((fact) => [fact.id, fact]));
    return rows
      .flatMap((row) => {
        const fact = byId.get(row.paymentId);
        return fact === undefined
          ? []
          : [
              {
                invoice: toRecord(row),
                customerId: fact.customerId,
                paymentState: fact.state,
                paymentExpiresAt: fact.expiresAt,
              },
            ];
      })
      .sort((a, b) => a.invoice.createdAt.getTime() - b.invoice.createdAt.getTime());
  }
}
