import { and, asc, desc, eq, inArray, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import type {
  GatewayCardChangeState,
  GatewayReceiptCaptureCloseReason,
  GatewayReceiptSubmissionState,
  PaymentId,
  TenantContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  gatewayCardChanges,
  gatewayReceiptCaptures,
  gatewayReceiptSubmissions,
  payments,
  receiptCaptures,
} from '../../../../infrastructure/persistence/schema.js';
import type {
  ClaimedCardTransferRow,
  GatewayCardChangeRecord,
  GatewayCardTransferRepository,
  GatewayReceiptCaptureRecord,
  GatewayReceiptSubmissionRecord,
} from '../application/gateway-invoice-ports.js';
import { RECEIPT_CAPTURE_LOCK_CLASS } from './drizzle-receipt.repository.js';

type ChangeRow = typeof gatewayCardChanges.$inferSelect;
type CaptureRow = typeof gatewayReceiptCaptures.$inferSelect;
type SubmissionRow = typeof gatewayReceiptSubmissions.$inferSelect;

function changeOf(row: ChangeRow): GatewayCardChangeRecord {
  return {
    id: row.id,
    paymentId: row.paymentId as PaymentId,
    botInstanceId: row.botInstanceId,
    customerId: row.customerId,
    // `gateway_card_changes_state_check` is built from the contract enum.
    state: row.state as GatewayCardChangeState,
    requestedAt: row.requestedAt,
    sentAt: row.sentAt,
    decidedAt: row.decidedAt,
    errorCode: row.errorCode,
  };
}

function captureOf(row: CaptureRow): GatewayReceiptCaptureRecord {
  return {
    id: row.id,
    botInstanceId: row.botInstanceId,
    customerId: row.customerId,
    paymentId: row.paymentId as PaymentId,
    providerInvoiceId: row.providerInvoiceId,
    openedAt: row.openedAt,
    expiresAt: row.expiresAt,
  };
}

function submissionOf(row: SubmissionRow): GatewayReceiptSubmissionRecord {
  return {
    id: row.id,
    paymentId: row.paymentId as PaymentId,
    providerInvoiceId: row.providerInvoiceId,
    botInstanceId: row.botInstanceId,
    customerId: row.customerId,
    captureId: row.captureId,
    telegramFileId: row.telegramFileId,
    telegramFileUniqueId: row.telegramFileUniqueId,
    declaredSize: row.declaredSize,
    state: row.state as GatewayReceiptSubmissionState,
    attempts: row.attempts,
    sentAt: row.sentAt,
    retryAt: row.retryAt,
    decidedAt: row.decidedAt,
    errorCode: row.errorCode,
    providerStatus: row.providerStatus,
    receiptReceived: row.receiptReceived,
    openedReview: row.openedReview,
    inquiryResolvedAt: row.inquiryResolvedAt,
    byteLength: row.byteLength,
    createdAt: row.createdAt,
  };
}

/**
 * TonPays Telegram's card-change requests, receipt capture windows and receipt submissions
 * (`docs/tonpays-telegram-gateway-audit.md` §7.3–§7.5). Every transition is ONE conditional
 * UPDATE naming its `from` states, and there is no setter: a replay, a double tap and two
 * worker replicas each move a row once. Every statement names the tenant.
 *
 * Nothing here moves money, and nothing here writes `payment_receipts`: a provider receipt
 * is never in the manual review queue and never exempts a payment from expiry.
 */
export class DrizzleGatewayCardTransferRepository implements GatewayCardTransferRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  // ---------------------------------------------------------------------------------------
  // Card changes.
  // ---------------------------------------------------------------------------------------

  async requestCardChange(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly paymentId: PaymentId;
      readonly botInstanceId: string;
      readonly customerId: string;
      readonly idempotencyKey: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<GatewayCardChangeRecord | null> {
    const tenantId = requireTenantId(scope);
    /*
     * `ON CONFLICT DO NOTHING`, with no target: either partial unique index refusing is the
     * same answer — one request is already in flight for this payment, or this tap was
     * already recorded — and neither is an error the customer did anything about.
     */
    const rows = await this.exec(tx)
      .insert(gatewayCardChanges)
      .values({
        id: input.id,
        tenantId,
        paymentId: input.paymentId,
        botInstanceId: input.botInstanceId,
        customerId: input.customerId,
        state: 'REQUESTED',
        requestedAt: input.now,
        idempotencyKey: input.idempotencyKey,
      })
      .onConflictDoNothing()
      .returning();
    const row = rows[0];
    return row === undefined ? null : changeOf(row);
  }

  async latestCardChange(
    scope: TenantContext,
    paymentId: PaymentId,
    tx?: unknown,
  ): Promise<GatewayCardChangeRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .select()
      .from(gatewayCardChanges)
      .where(
        and(eq(gatewayCardChanges.tenantId, tenantId), eq(gatewayCardChanges.paymentId, paymentId)),
      )
      .orderBy(desc(gatewayCardChanges.requestedAt), desc(gatewayCardChanges.id))
      .limit(1);
    return row === undefined ? null : changeOf(row);
  }

  async claimCardChanges(
    scope: TenantContext,
    now: Date,
    leaseMs: number,
    limit: number,
    tx: unknown,
  ): Promise<readonly ClaimedCardTransferRow<GatewayCardChangeRecord>[]> {
    const tenantId = requireTenantId(scope);
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const claimable = and(
      eq(gatewayCardChanges.tenantId, tenantId),
      inArray(gatewayCardChanges.state, ['REQUESTED', 'SENT']),
      or(isNull(gatewayCardChanges.claimedUntil), lte(gatewayCardChanges.claimedUntil, now)),
    );
    const due = this.exec(tx)
      .select({ id: gatewayCardChanges.id })
      .from(gatewayCardChanges)
      .where(claimable)
      .orderBy(asc(gatewayCardChanges.requestedAt), asc(gatewayCardChanges.id))
      .limit(limit)
      .for('update', { skipLocked: true });
    const rows = await this.exec(tx)
      .update(gatewayCardChanges)
      .set({ claimedUntil: leaseUntil })
      .where(and(claimable, sql`${gatewayCardChanges.id} IN ${due}`))
      .returning();
    return this.withPaymentFacts(
      scope,
      rows.map(changeOf).sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime()),
      tx,
    );
  }

  async markCardChangeSent(
    scope: TenantContext,
    id: string,
    now: Date,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(gatewayCardChanges)
      .set({ state: 'SENT', sentAt: now })
      .where(
        and(
          eq(gatewayCardChanges.tenantId, tenantId),
          eq(gatewayCardChanges.id, id),
          eq(gatewayCardChanges.state, 'REQUESTED'),
          isNull(gatewayCardChanges.sentAt),
        ),
      )
      .returning({ id: gatewayCardChanges.id });
    return rows.length > 0;
  }

  async decideCardChange(
    scope: TenantContext,
    id: string,
    to: Exclude<GatewayCardChangeState, 'REQUESTED' | 'SENT'>,
    errorCode: string | null,
    now: Date,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(gatewayCardChanges)
      .set({ state: to, decidedAt: now, errorCode, claimedUntil: null })
      .where(
        and(
          eq(gatewayCardChanges.tenantId, tenantId),
          eq(gatewayCardChanges.id, id),
          inArray(gatewayCardChanges.state, ['REQUESTED', 'SENT']),
        ),
      )
      .returning({ id: gatewayCardChanges.id });
    return rows.length > 0;
  }

  async releaseCardChangeClaims(
    scope: TenantContext,
    ids: readonly string[],
    leaseUntil: Date,
    tx: unknown,
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(gatewayCardChanges)
      .set({ claimedUntil: null })
      .where(
        and(
          eq(gatewayCardChanges.tenantId, tenantId),
          inArray(gatewayCardChanges.id, [...ids]),
          eq(gatewayCardChanges.claimedUntil, leaseUntil),
        ),
      )
      .returning({ id: gatewayCardChanges.id });
    return rows.length;
  }

  // ---------------------------------------------------------------------------------------
  // Receipt capture windows.
  // ---------------------------------------------------------------------------------------

  async openCapture(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly botInstanceId: string;
      readonly customerId: string;
      readonly paymentId: PaymentId;
      readonly providerInvoiceId: string;
      readonly openedAt: Date;
      readonly expiresAt: Date;
    },
    tx: unknown,
  ): Promise<GatewayReceiptCaptureRecord> {
    const tenantId = requireTenantId(scope);
    /*
     * The (tenant, bot, customer) advisory lock the MANUAL window is opened under
     * (`DrizzleReceiptCaptureRepository.lockForCustomer`), so a manual window and this one
     * opening together are serialised and the cross-close below sees the other's row.
     */
    await this.exec(tx).execute(
      sql`SELECT pg_advisory_xact_lock(${RECEIPT_CAPTURE_LOCK_CLASS},
            hashtext(${`${tenantId}:${input.botInstanceId}:${input.customerId}`}))`,
    );
    const closeReason = (expiresAt: SQL | typeof receiptCaptures.expiresAt) =>
      sql`CASE WHEN ${expiresAt} <= ${input.openedAt} THEN 'EXPIRED' ELSE 'SUPERSEDED' END`;
    // One photo, one meaning: this customer's open windows in THIS bot close first.
    await this.exec(tx)
      .update(gatewayReceiptCaptures)
      .set({
        closedAt: input.openedAt,
        closeReason: closeReason(sql`${gatewayReceiptCaptures.expiresAt}`),
      })
      .where(
        and(
          eq(gatewayReceiptCaptures.tenantId, tenantId),
          eq(gatewayReceiptCaptures.botInstanceId, input.botInstanceId),
          eq(gatewayReceiptCaptures.customerId, input.customerId),
          isNull(gatewayReceiptCaptures.closedAt),
        ),
      );
    await this.exec(tx)
      .update(receiptCaptures)
      .set({ closedAt: input.openedAt, closeReason: closeReason(receiptCaptures.expiresAt) })
      .where(
        and(
          eq(receiptCaptures.tenantId, tenantId),
          eq(receiptCaptures.botInstanceId, input.botInstanceId),
          eq(receiptCaptures.customerId, input.customerId),
          isNull(receiptCaptures.closedAt),
        ),
      );
    const rows = await this.exec(tx)
      .insert(gatewayReceiptCaptures)
      .values({
        id: input.id,
        tenantId,
        botInstanceId: input.botInstanceId,
        customerId: input.customerId,
        paymentId: input.paymentId,
        provider: 'TONPAYS_TELEGRAM',
        providerInvoiceId: input.providerInvoiceId,
        openedAt: input.openedAt,
        expiresAt: input.expiresAt,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error('gateway_receipt_captures insert returned no row.');
    return captureOf(row);
  }

  async lockCaptureNamespace(
    scope: TenantContext,
    botInstanceId: string,
    customerId: string,
    tx: unknown,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    // The very key `openCapture` and the manual window's `open` take.
    await this.exec(tx).execute(
      sql`SELECT pg_advisory_xact_lock(${RECEIPT_CAPTURE_LOCK_CLASS},
            hashtext(${`${tenantId}:${botInstanceId}:${customerId}`}))`,
    );
  }

  async findOpenCapture(
    scope: TenantContext,
    botInstanceId: string,
    customerId: string,
    tx?: unknown,
  ): Promise<GatewayReceiptCaptureRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .select()
      .from(gatewayReceiptCaptures)
      .where(
        and(
          eq(gatewayReceiptCaptures.tenantId, tenantId),
          eq(gatewayReceiptCaptures.botInstanceId, botInstanceId),
          eq(gatewayReceiptCaptures.customerId, customerId),
          isNull(gatewayReceiptCaptures.closedAt),
        ),
      )
      .limit(1);
    return row === undefined ? null : captureOf(row);
  }

  async closeCapture(
    scope: TenantContext,
    id: string,
    reason: GatewayReceiptCaptureCloseReason,
    at: Date,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(gatewayReceiptCaptures)
      .set({ closedAt: at, closeReason: reason })
      .where(
        and(
          eq(gatewayReceiptCaptures.tenantId, tenantId),
          eq(gatewayReceiptCaptures.id, id),
          isNull(gatewayReceiptCaptures.closedAt),
        ),
      )
      .returning({ id: gatewayReceiptCaptures.id });
    return rows.length > 0;
  }

  async closeCapturesForPayment(
    scope: TenantContext,
    paymentId: PaymentId,
    reason: GatewayReceiptCaptureCloseReason,
    at: Date,
    tx: unknown,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(gatewayReceiptCaptures)
      .set({ closedAt: at, closeReason: reason })
      .where(
        and(
          eq(gatewayReceiptCaptures.tenantId, tenantId),
          eq(gatewayReceiptCaptures.paymentId, paymentId),
          isNull(gatewayReceiptCaptures.closedAt),
        ),
      )
      .returning({ id: gatewayReceiptCaptures.id });
    return rows.length;
  }

  async sweepCaptures(
    scope: TenantContext,
    now: Date,
    limit: number,
    tx: unknown,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    if (limit <= 0) return 0;
    const paymentClosed = sql`EXISTS (
      SELECT 1 FROM ${payments}
       WHERE ${payments.tenantId} = ${gatewayReceiptCaptures.tenantId}
         AND ${payments.id} = ${gatewayReceiptCaptures.paymentId}
         AND (${payments.state} <> 'PENDING' OR ${payments.providerReviewUntil} IS NOT NULL))`;
    const due = this.exec(tx)
      .select({ id: gatewayReceiptCaptures.id })
      .from(gatewayReceiptCaptures)
      .where(
        and(
          eq(gatewayReceiptCaptures.tenantId, tenantId),
          isNull(gatewayReceiptCaptures.closedAt),
          or(lte(gatewayReceiptCaptures.expiresAt, now), paymentClosed),
        ),
      )
      .orderBy(asc(gatewayReceiptCaptures.expiresAt))
      .limit(limit)
      .for('update', { skipLocked: true });
    const rows = await this.exec(tx)
      .update(gatewayReceiptCaptures)
      .set({
        closedAt: now,
        closeReason: sql`CASE WHEN ${gatewayReceiptCaptures.expiresAt} <= ${now} THEN 'EXPIRED' ELSE 'PAYMENT_CLOSED' END`,
      })
      .where(
        and(
          eq(gatewayReceiptCaptures.tenantId, tenantId),
          isNull(gatewayReceiptCaptures.closedAt),
          sql`${gatewayReceiptCaptures.id} IN ${due}`,
        ),
      )
      .returning({ id: gatewayReceiptCaptures.id });
    return rows.length;
  }

  // ---------------------------------------------------------------------------------------
  // Receipt submissions.
  // ---------------------------------------------------------------------------------------

  async queueSubmission(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly paymentId: PaymentId;
      readonly providerInvoiceId: string;
      readonly botInstanceId: string;
      readonly customerId: string;
      readonly captureId: string;
      readonly telegramFileId: string;
      readonly telegramFileUniqueId: string;
      readonly declaredSize: bigint | null;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<GatewayReceiptSubmissionRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .insert(gatewayReceiptSubmissions)
      .values({
        id: input.id,
        tenantId,
        paymentId: input.paymentId,
        providerInvoiceId: input.providerInvoiceId,
        botInstanceId: input.botInstanceId,
        customerId: input.customerId,
        captureId: input.captureId,
        telegramFileId: input.telegramFileId,
        telegramFileUniqueId: input.telegramFileUniqueId,
        declaredSize: input.declaredSize,
        state: 'QUEUED',
        createdAt: input.now,
        updatedAt: input.now,
      })
      // The same photo, or a second one while one is in flight: nothing new is queued.
      .onConflictDoNothing()
      .returning();
    const row = rows[0];
    return row === undefined ? null : submissionOf(row);
  }

  async submissionsFor(
    scope: TenantContext,
    paymentId: PaymentId,
    tx?: unknown,
  ): Promise<readonly GatewayReceiptSubmissionRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(gatewayReceiptSubmissions)
      .where(
        and(
          eq(gatewayReceiptSubmissions.tenantId, tenantId),
          eq(gatewayReceiptSubmissions.paymentId, paymentId),
        ),
      )
      .orderBy(asc(gatewayReceiptSubmissions.createdAt), asc(gatewayReceiptSubmissions.id));
    return rows.map(submissionOf);
  }

  async claimSubmissions(
    scope: TenantContext,
    now: Date,
    leaseMs: number,
    limit: number,
    tx: unknown,
  ): Promise<readonly ClaimedCardTransferRow<GatewayReceiptSubmissionRecord>[]> {
    const tenantId = requireTenantId(scope);
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const claimable = and(
      eq(gatewayReceiptSubmissions.tenantId, tenantId),
      inArray(gatewayReceiptSubmissions.state, ['QUEUED', 'SENDING']),
      or(
        isNull(gatewayReceiptSubmissions.claimedUntil),
        lte(gatewayReceiptSubmissions.claimedUntil, now),
      ),
      or(isNull(gatewayReceiptSubmissions.retryAt), lte(gatewayReceiptSubmissions.retryAt, now)),
    );
    const due = this.exec(tx)
      .select({ id: gatewayReceiptSubmissions.id })
      .from(gatewayReceiptSubmissions)
      .where(claimable)
      .orderBy(asc(gatewayReceiptSubmissions.createdAt), asc(gatewayReceiptSubmissions.id))
      .limit(limit)
      .for('update', { skipLocked: true });
    const rows = await this.exec(tx)
      .update(gatewayReceiptSubmissions)
      .set({ claimedUntil: leaseUntil, updatedAt: now })
      .where(and(claimable, sql`${gatewayReceiptSubmissions.id} IN ${due}`))
      .returning();
    return this.withPaymentFacts(
      scope,
      rows.map(submissionOf).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
      tx,
    );
  }

  async markSubmissionSending(
    scope: TenantContext,
    id: string,
    byteLength: number,
    now: Date,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(gatewayReceiptSubmissions)
      .set({
        state: 'SENDING',
        sentAt: now,
        byteLength,
        attempts: sql`${gatewayReceiptSubmissions.attempts} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(gatewayReceiptSubmissions.tenantId, tenantId),
          eq(gatewayReceiptSubmissions.id, id),
          eq(gatewayReceiptSubmissions.state, 'QUEUED'),
          isNull(gatewayReceiptSubmissions.sentAt),
        ),
      )
      .returning({ id: gatewayReceiptSubmissions.id });
    return rows.length > 0;
  }

  async decideSubmission(
    scope: TenantContext,
    id: string,
    to: 'ACCEPTED' | 'REFUSED' | 'UNKNOWN' | 'ABANDONED',
    facts: {
      readonly errorCode: string | null;
      readonly providerStatus: string | null;
      readonly receiptReceived: boolean | null;
    },
    now: Date,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(gatewayReceiptSubmissions)
      .set({
        state: to,
        decidedAt: now,
        errorCode: facts.errorCode,
        providerStatus: facts.providerStatus,
        receiptReceived: facts.receiptReceived,
        claimedUntil: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(gatewayReceiptSubmissions.tenantId, tenantId),
          eq(gatewayReceiptSubmissions.id, id),
          inArray(gatewayReceiptSubmissions.state, ['QUEUED', 'SENDING']),
        ),
      )
      .returning({ id: gatewayReceiptSubmissions.id });
    return rows.length > 0;
  }

  async requeueSubmission(
    scope: TenantContext,
    id: string,
    errorCode: string,
    retryAt: Date,
    now: Date,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(gatewayReceiptSubmissions)
      .set({
        // Cleared ONLY here: the provider said, in so many words, it did not process it.
        state: 'QUEUED',
        sentAt: null,
        retryAt,
        errorCode,
        claimedUntil: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(gatewayReceiptSubmissions.tenantId, tenantId),
          eq(gatewayReceiptSubmissions.id, id),
          eq(gatewayReceiptSubmissions.state, 'SENDING'),
        ),
      )
      .returning({ id: gatewayReceiptSubmissions.id });
    return rows.length > 0;
  }

  async markOpenedReview(scope: TenantContext, id: string, tx: unknown): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(gatewayReceiptSubmissions)
      .set({ openedReview: true })
      .where(
        and(
          eq(gatewayReceiptSubmissions.tenantId, tenantId),
          eq(gatewayReceiptSubmissions.id, id),
          eq(gatewayReceiptSubmissions.state, 'ACCEPTED'),
          eq(gatewayReceiptSubmissions.openedReview, false),
        ),
      )
      .returning({ id: gatewayReceiptSubmissions.id });
    return rows.length > 0;
  }

  async resolveUnknownSubmissions(
    scope: TenantContext,
    paymentId: PaymentId,
    inquirySentAt: Date,
    now: Date,
    tx?: unknown,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(gatewayReceiptSubmissions)
      .set({ inquiryResolvedAt: now, updatedAt: now })
      .where(
        and(
          eq(gatewayReceiptSubmissions.tenantId, tenantId),
          eq(gatewayReceiptSubmissions.paymentId, paymentId),
          eq(gatewayReceiptSubmissions.state, 'UNKNOWN'),
          isNull(gatewayReceiptSubmissions.inquiryResolvedAt),
          // Only an inquiry SENT after the upload's answer was given up on resolves it.
          lt(gatewayReceiptSubmissions.decidedAt, inquirySentAt),
        ),
      )
      .returning({ id: gatewayReceiptSubmissions.id });
    return rows.length;
  }

  async releaseSubmissionClaims(
    scope: TenantContext,
    ids: readonly string[],
    leaseUntil: Date,
    tx: unknown,
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(gatewayReceiptSubmissions)
      .set({ claimedUntil: null })
      .where(
        and(
          eq(gatewayReceiptSubmissions.tenantId, tenantId),
          inArray(gatewayReceiptSubmissions.id, [...ids]),
          eq(gatewayReceiptSubmissions.claimedUntil, leaseUntil),
        ),
      )
      .returning({ id: gatewayReceiptSubmissions.id });
    return rows.length;
  }

  async backOffSubmission(
    scope: TenantContext,
    id: string,
    leaseUntil: Date,
    retryAt: Date,
    now: Date,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(gatewayReceiptSubmissions)
      // `sent_at` and `state` are deliberately untouched: a stamped upload is still UNKNOWN.
      .set({ claimedUntil: null, retryAt, updatedAt: now })
      .where(
        and(
          eq(gatewayReceiptSubmissions.tenantId, tenantId),
          eq(gatewayReceiptSubmissions.id, id),
          inArray(gatewayReceiptSubmissions.state, ['QUEUED', 'SENDING']),
          eq(gatewayReceiptSubmissions.claimedUntil, leaseUntil),
        ),
      )
      .returning({ id: gatewayReceiptSubmissions.id });
    return rows.length > 0;
  }

  // ---------------------------------------------------------------------------------------

  private async withPaymentFacts<T extends { readonly paymentId: PaymentId }>(
    scope: TenantContext,
    rows: readonly T[],
    tx: unknown,
  ): Promise<readonly ClaimedCardTransferRow<T>[]> {
    if (rows.length === 0) return [];
    const tenantId = requireTenantId(scope);
    const facts = await this.exec(tx)
      .select({
        id: payments.id,
        state: payments.state,
        expiresAt: payments.expiresAt,
        providerReviewUntil: payments.providerReviewUntil,
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
    return rows.flatMap((row) => {
      const fact = byId.get(row.paymentId);
      return fact === undefined
        ? []
        : [
            {
              row,
              paymentState: fact.state,
              paymentExpiresAt: fact.expiresAt,
              paymentReviewUntil: fact.providerReviewUntil,
            },
          ];
    });
  }
}
