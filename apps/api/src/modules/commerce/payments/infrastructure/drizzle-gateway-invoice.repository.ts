import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type {
  FxBaseAsset,
  FxSource,
  GatewayConversionPolicy,
  GatewayProviderUnit,
  Money,
  GatewayInvoiceCreationState,
  GatewayInvoiceOutcome,
  PaymentGatewayProvider,
  PaymentId,
  SalesCurrencyCode,
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
  GatewayInvoiceFxSnapshot,
  GatewayInvoiceRecord,
  GatewayInvoiceRepository,
} from '../application/gateway-invoice-ports.js';

type Row = typeof gatewayInvoices.$inferSelect;

/**
 * The FX snapshot as the row holds it, whole or absent: `gateway_invoices_fx_snapshot_check`
 * makes every column present exactly when `fx_quote_id` is, so a partial row cannot exist.
 */
function fxSnapshotOf(row: Row): GatewayInvoiceFxSnapshot | null {
  if (
    row.fxQuoteId === null ||
    row.fxSource === null ||
    row.fxBaseAsset === null ||
    row.fxQuoteCurrency === null ||
    row.fxRateMantissa === null ||
    row.fxRateScale === null ||
    row.fxFetchedAt === null ||
    row.fxQuoteState === null ||
    row.fxPolicyVersion === null ||
    row.fxUnitRatioMantissa === null ||
    row.fxUnitRatioScale === null ||
    row.fxEffectiveRateNumerator === null ||
    row.fxEffectiveRateDenominator === null
  ) {
    return null;
  }
  return {
    quoteId: row.fxQuoteId,
    source: row.fxSource as FxSource,
    baseAsset: row.fxBaseAsset as FxBaseAsset,
    quoteCurrency: row.fxQuoteCurrency as SalesCurrencyCode,
    rate: { mantissa: row.fxRateMantissa, scale: row.fxRateScale },
    sourceAt: row.fxSourceAt,
    fetchedAt: row.fxFetchedAt,
    quoteState: row.fxQuoteState as 'FRESH' | 'STALE_ALLOWED',
    policyVersion: row.fxPolicyVersion,
    unitRatio: { mantissa: row.fxUnitRatioMantissa, scale: row.fxUnitRatioScale },
    effectiveRate: {
      numerator: row.fxEffectiveRateNumerator,
      denominator: row.fxEffectiveRateDenominator,
    },
  };
}

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
    providerUnit: row.providerUnit as GatewayProviderUnit,
    sentAmount: row.sentAmount,
    conversionRateMinor: row.conversionRateMinor,
    conversionPolicy: row.conversionPolicy as GatewayConversionPolicy,
    fx: fxSnapshotOf(row),
    botInstanceId: row.botInstanceId,
    providerChargeId: row.providerChargeId,
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
      readonly providerUnit: GatewayProviderUnit;
      readonly sentAmount: bigint;
      readonly conversionRateMinor: bigint | null;
      readonly conversionPolicy: GatewayConversionPolicy;
      readonly fx: GatewayInvoiceFxSnapshot | null;
      readonly botInstanceId: string | null;
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
        conversionRateMinor: input.conversionRateMinor,
        conversionPolicy: input.conversionPolicy,
        ...(input.fx === null
          ? {}
          : {
              fxQuoteId: input.fx.quoteId,
              fxSource: input.fx.source,
              fxBaseAsset: input.fx.baseAsset,
              fxQuoteCurrency: input.fx.quoteCurrency,
              fxRateMantissa: input.fx.rate.mantissa,
              fxRateScale: input.fx.rate.scale,
              fxSourceAt: input.fx.sourceAt,
              fxFetchedAt: input.fx.fetchedAt,
              fxQuoteState: input.fx.quoteState,
              fxPolicyVersion: input.fx.policyVersion,
              fxUnitRatioMantissa: input.fx.unitRatio.mantissa,
              fxUnitRatioScale: input.fx.unitRatio.scale,
              fxEffectiveRateNumerator: input.fx.effectiveRate.numerator,
              fxEffectiveRateDenominator: input.fx.effectiveRate.denominator,
            }),
        botInstanceId: input.botInstanceId,
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

  async lockByProviderOrderId(
    scope: TenantContext,
    provider: PaymentGatewayProvider,
    providerOrderId: string,
    tx: unknown,
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
      .limit(1)
      .for('update');
    return row === undefined ? null : toRecord(row);
  }

  async findByChargeId(
    scope: TenantContext,
    provider: PaymentGatewayProvider,
    chargeId: string,
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
          eq(gatewayInvoices.providerChargeId, chargeId),
        ),
      )
      .limit(1);
    return row === undefined ? null : toRecord(row);
  }

  async recordCharge(
    scope: TenantContext,
    paymentId: PaymentId,
    charge: { readonly chargeId: string; readonly status: string; readonly dueAt: Date },
    now: Date,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(gatewayInvoices)
      .set({
        providerChargeId: charge.chargeId,
        providerPaid: true,
        providerStatus: charge.status,
        // Due now: the settlement is attempted at once by the caller, and this row is what
        // the worker settles from if that attempt does not finish.
        nextInquiryAt: charge.dueAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(gatewayInvoices.tenantId, tenantId),
          eq(gatewayInvoices.paymentId, paymentId),
          isNull(gatewayInvoices.providerChargeId),
        ),
      )
      .returning({ paymentId: gatewayInvoices.paymentId });
    return rows.length > 0;
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
      readonly note?: string | null;
      readonly firstInquiryAt: Date | null;
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
        creationErrorCode: created.note ?? null,
        // Null keeps the row's schedule: a Stars charge recorded before this commits is due.
        nextInquiryAt: created.firstInquiryAt ?? sql`${gatewayInvoices.nextInquiryAt}`,
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
        /*
         * Nothing more to ask about an invoice whose create ended — unless the provider
         * already PUSHED a payment for it (Stars: the invoice reached the customer although
         * its create's answer was lost). That row stays due, so the recorded charge settles.
         */
        nextInquiryAt: sql`CASE WHEN ${gatewayInvoices.providerChargeId} IS NULL THEN NULL ELSE ${gatewayInvoices.nextInquiryAt} END`,
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
      // Something to ask about: a created invoice, or one a webhook named for a lost create
      // — or a payment the provider pushed and Nexa recorded (Stars), settled from the row.
      or(
        isNotNull(gatewayInvoices.providerInvoiceId),
        isNotNull(gatewayInvoices.hintedInvoiceId),
        isNotNull(gatewayInvoices.providerChargeId),
      ),
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

  async releaseClaims(
    scope: TenantContext,
    lane: 'CREATION' | 'INQUIRY',
    paymentIds: readonly PaymentId[],
    leaseUntil: Date,
    now: Date,
    tx?: unknown,
  ): Promise<number> {
    if (paymentIds.length === 0) return 0;
    const tenantId = requireTenantId(scope);
    const column =
      lane === 'CREATION'
        ? gatewayInvoices.creationClaimedUntil
        : gatewayInvoices.inquiryClaimedUntil;
    const rows = await this.exec(tx)
      .update(gatewayInvoices)
      .set(
        lane === 'CREATION'
          ? { creationClaimedUntil: null, updatedAt: now }
          : { inquiryClaimedUntil: null, updatedAt: now },
      )
      .where(
        and(
          eq(gatewayInvoices.tenantId, tenantId),
          inArray(gatewayInvoices.paymentId, [...paymentIds]),
          eq(column, leaseUntil),
        ),
      )
      .returning({ paymentId: gatewayInvoices.paymentId });
    return rows.length;
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
      readonly amount: Money;
      readonly botInstanceId: string | null;
      readonly now: Date;
      readonly requireLink: boolean;
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
          // F3: a created invoice with no link a customer can open is not an open attempt.
          input.requireLink
            ? or(
                eq(gatewayInvoices.creationState, 'CREATING'),
                isNotNull(gatewayInvoices.webInvoiceUrl),
                isNotNull(gatewayInvoices.invoiceUrl),
              )
            : undefined,
          input.botInstanceId === null
            ? isNull(gatewayInvoices.botInstanceId)
            : eq(gatewayInvoices.botInstanceId, input.botInstanceId),
          eq(payments.state, 'PENDING'),
          eq(payments.customerId, input.customerId),
          input.orderId === null ? isNull(payments.orderId) : eq(payments.orderId, input.orderId),
          eq(payments.amount, input.amount.amountMinor),
          eq(payments.currency, input.amount.currency),
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
