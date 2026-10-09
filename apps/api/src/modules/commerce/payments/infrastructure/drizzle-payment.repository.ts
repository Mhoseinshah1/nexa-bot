import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  money,
  paymentTrackingCode,
  trackingCodeFromSearch,
  PAYMENT_GATEWAY_PROVIDERS,
  PAYMENT_OPS_QUEUES,
  PROVIDER_REVIEW_GATEWAY_PROVIDERS,
  type ListSearchTerm,
} from '@nexa/contracts';
import type {
  CurrencyCode,
  GatewayInvoiceCreationState,
  OrderId,
  PaymentEvidenceKind,
  PaymentGatewayProvider,
  PaymentId,
  PaymentMethod,
  PaymentOpsQueue,
  PaymentResolvedState,
  PaymentState,
  ReceiptDisposition,
  TenantContext,
  UserId,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  customerIdsWithTelegramId,
  customerIdsWithUsernamePrefix,
  readCustomerIdentities,
} from '../../../../infrastructure/persistence/list-search.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  gatewayInvoices,
  paymentReceipts,
  payments,
  receiptCredits,
} from '../../../../infrastructure/persistence/schema.js';
import {
  completedRefundCondition,
  openRefundCondition,
  paymentOpsQueueCondition,
  receiptFiledCondition,
  refundRemainingCondition,
} from './payment-ops-queue-sql.js';
import type {
  PaymentConfirmation,
  PaymentCustomerIdentity,
  PaymentCursor,
  PaymentDraft,
  PaymentGatewaySignalRecord,
  PaymentPage,
  PaymentRecord,
  PaymentRepository,
  PaymentSituationFactsRecord,
  PaymentResolution,
  PaymentSearch,
} from '../application/ports.js';

/**
 * Payments, in PostgreSQL.
 *
 * Two writes and no third: `create` and `confirm`. There is no general `update`, and
 * that is not an omission a later commit should fill in —
 * `nexa_payments_confirmation_guard` (0035) rejects any change to a CONFIRMED
 * payment's money, customer, order, method, reference, evidence, confirming
 * administrator or state, leaving only `external_reference` mutable for a gateway that
 * does not ship. A general update method would be a capability the database refuses.
 */
export class DrizzlePaymentRepository implements PaymentRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  /**
   * Creates, or returns what is already written under this reference.
   *
   * The reference is derived from the command's idempotency key, so a retry lands on
   * `payments_tenant_reference_key` and re-reads rather than minting a second payment
   * for one order — which the customer could then also be asked to pay.
   */
  async create(scope: TenantContext, draft: PaymentDraft, tx?: unknown): Promise<PaymentRecord> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .insert(payments)
      .values({
        id: draft.id,
        tenantId,
        customerId: draft.customerId,
        orderId: draft.orderId,
        // No `state`: the column defaults to the machine's initial state, and a caller
        // that could name one could create a payment already CONFIRMED.
        method: draft.method,
        amount: draft.amount.amountMinor,
        currency: draft.amount.currency,
        reference: draft.reference,
        expiresAt: draft.expiresAt,
        // The route snapshot (D5), written here once and frozen by 0114 afterwards.
        gatewayProvider: draft.gatewayProvider,
        topupCashbackPercent: draft.topupCashbackPercent,
        // The fee snapshot (WP18), all three or none — `payments_customer_fee_check`.
        customerFeeBasisPoints: draft.customerFee?.basisPoints ?? null,
        customerFeeAmount: draft.customerFee?.fee.amountMinor ?? null,
        payableAmount: draft.customerFee?.payable.amountMinor ?? null,
        createdAt: draft.now,
        updatedAt: draft.now,
      })
      .onConflictDoNothing({ target: [payments.tenantId, payments.reference] })
      .returning();

    const inserted = rows[0];
    if (inserted !== undefined) return toRecord(inserted);

    const existing = await this.findByReference(scope, draft.reference, tx);
    if (existing === null) {
      // See the wallet repository: a conflict with nothing to re-read means a
      // constraint OTHER than the reference index was violated, which would make a
      // create silently a no-op. Loud, because the alternative is a customer shown
      // instructions for a payment that does not exist.
      throw new Error(
        `payment ${draft.reference} conflicted on insert but could not be re-read; ` +
          'a constraint other than payments_tenant_reference_key was violated',
      );
    }
    return existing;
  }

  async findById(scope: TenantContext, id: PaymentId, tx?: unknown): Promise<PaymentRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(payments)
      .where(and(eq(payments.tenantId, tenantId), eq(payments.id, id)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async findByIdForUpdate(
    scope: TenantContext,
    id: PaymentId,
    tx: unknown,
  ): Promise<PaymentRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(payments)
      .where(and(eq(payments.tenantId, tenantId), eq(payments.id, id)))
      .limit(1)
      .for('update');
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async findOpenTopup(
    scope: TenantContext,
    customerId: UserId,
    tx?: unknown,
  ): Promise<PaymentRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.tenantId, tenantId),
          eq(payments.customerId, customerId),
          isNull(payments.orderId),
          eq(payments.state, 'PENDING'),
          eq(payments.method, 'MANUAL_TRANSFER'),
        ),
      )
      // Oldest first, so a tenant that somehow holds two gets the one whose reference
      // the customer has had longest rather than whichever the planner returned.
      .orderBy(asc(payments.createdAt), asc(payments.id))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async findByReference(
    scope: TenantContext,
    reference: string,
    tx?: unknown,
  ): Promise<PaymentRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(payments)
      .where(and(eq(payments.tenantId, tenantId), eq(payments.reference, reference)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async list(
    scope: TenantContext,
    search: PaymentSearch,
    limit: number,
    cursor: PaymentCursor | null,
    tx?: unknown,
  ): Promise<PaymentPage> {
    const rows = await this.listStatement(scope, search, limit, cursor, tx);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toRecord),
      nextCursor:
        rows.length > limit && last !== undefined
          ? { createdAt: last.createdAtText, id: last.id as PaymentId }
          : null,
    };
  }

  /**
   * The page statement, exposed so a PLAN regression can explain it — for the reason
   * `DrizzleCustomerRepository.listStatement` gives: a retyped query in a test proves a
   * plan for something nobody runs (`list-search-plan.test.ts`).
   */
  listStatement(
    scope: TenantContext,
    search: PaymentSearch,
    limit: number,
    cursor: PaymentCursor | null,
    tx?: unknown,
  ) {
    const tenantId = requireTenantId(scope);
    const conditions: SQL[] = [eq(payments.tenantId, tenantId)];
    if (search.state !== undefined) conditions.push(eq(payments.state, search.state));
    if (search.method !== undefined) conditions.push(eq(payments.method, search.method));
    if (search.customerId !== undefined)
      conditions.push(eq(payments.customerId, search.customerId));
    if (search.orderId !== undefined) conditions.push(eq(payments.orderId, search.orderId));
    if (search.reference !== undefined) conditions.push(referenceCondition(search.reference));
    if (search.text !== undefined) conditions.push(paymentTextCondition(tenantId, search.text));
    if (search.disposition !== undefined) {
      conditions.push(sql`(${receiptDispositionSql()}) = ${search.disposition}`);
    }
    // The Payment Operations Center's facets (program §10). The queue is the SAME predicate
    // the attention counts use, so a count and the list it opens cannot disagree.
    if (search.queue !== undefined) conditions.push(paymentOpsQueueCondition(search.queue));
    if (search.gatewayProvider !== undefined) {
      conditions.push(eq(payments.gatewayProvider, search.gatewayProvider));
    }
    if (search.createdIn !== undefined) {
      // Half-open, `[start, end)`.
      conditions.push(
        sql`${payments.createdAt} >= ${search.createdIn.start.toISOString()}::timestamptz`,
        sql`${payments.createdAt} < ${search.createdIn.end.toISOString()}::timestamptz`,
      );
    }
    if (cursor !== null) {
      conditions.push(
        sql`(${payments.createdAt}, ${payments.id}) > (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
      );
    }

    return this.exec(tx)
      .select({
        ...getTableColumns(payments),
        createdAtText: sql<string>`to_char(${payments.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(payments)
      .where(and(...conditions))
      .orderBy(asc(payments.createdAt), asc(payments.id))
      .limit(limit + 1);
  }

  /**
   * The `CONFIRM` edge, as one conditional UPDATE.
   *
   * `WHERE state = 'PENDING'` is what makes two operators pressing approve, a replayed
   * request and two replicas produce ONE confirmation — the same mechanism
   * `OrderRepository.transition` uses and ADR-0028 records, with no lock and no
   * read-then-write window.
   *
   * Every column here is set by the SAME statement, because `payments_confirmed_check`
   * binds them together: `(state = 'CONFIRMED') = (confirmed_at IS NOT NULL AND
   * evidence_kind IS NOT NULL)`. Moving the state in one statement and stamping the
   * evidence in another would leave the row violating its own constraint in between.
   *
   * There is no amount parameter. See `PaymentRepository.confirm`.
   */
  async confirm(
    scope: TenantContext,
    id: PaymentId,
    confirmation: PaymentConfirmation,
    now: Date,
    tx?: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(payments)
      .set({
        state: 'CONFIRMED',
        evidenceKind: confirmation.evidenceKind,
        evidenceNote: confirmation.evidenceNote,
        confirmedByAdminId: confirmation.confirmedByAdminId,
        confirmedAt: confirmation.confirmedAt,
        updatedAt: now,
      })
      .where(
        and(eq(payments.tenantId, tenantId), eq(payments.id, id), eq(payments.state, 'PENDING')),
      )
      .returning({ id: payments.id });
    return rows.length > 0;
  }

  /**
   * The `FAIL`, `CANCEL` and `EXPIRE` edges, as one conditional UPDATE.
   *
   * `WHERE state = 'PENDING'` is the same mechanism `confirm` uses one method above and
   * carries the same guarantee across a wider set of racers: an operator rejecting
   * while the sweep expires, a customer withdrawing while an operator confirms, a
   * replayed command and two worker replicas all produce one transition and one `true`.
   *
   * Every column in one statement, because `payments_resolved_check` is an equality:
   * a statement that moved the state without stamping `resolved_at` would leave the row
   * violating its own constraint, and the database refuses it rather than storing it.
   */
  async resolve(
    scope: TenantContext,
    id: PaymentId,
    to: PaymentResolvedState,
    resolution: PaymentResolution,
    now: Date,
    tx?: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(payments)
      .set({
        state: to,
        resolvedAt: resolution.resolvedAt,
        resolvedByAdminId: resolution.resolvedByAdminId,
        resolutionNote: resolution.resolutionNote,
        updatedAt: now,
      })
      .where(
        and(
          eq(payments.tenantId, tenantId),
          eq(payments.id, id),
          eq(payments.state, 'PENDING'),
          // Never over an approved Stars checkout: the charge is on its way (#85, C2).
          notHeldAt(now),
        ),
      )
      .returning({ id: payments.id });
    return rows.length > 0;
  }

  async holdForCheckout(
    scope: TenantContext,
    id: PaymentId,
    until: Date,
    now: Date,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(payments)
      .set({ checkoutHeldUntil: until, updatedAt: now })
      .where(
        and(
          eq(payments.tenantId, tenantId),
          eq(payments.id, id),
          eq(payments.state, 'PENDING'),
          eq(payments.method, 'GATEWAY'),
        ),
      )
      .returning({ id: payments.id });
    return rows.length > 0;
  }

  async hasCheckoutHeldPendingForOrder(
    scope: TenantContext,
    orderId: OrderId,
    now: Date,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ id: payments.id })
      .from(payments)
      .where(
        and(
          eq(payments.tenantId, tenantId),
          eq(payments.orderId, orderId),
          eq(payments.state, 'PENDING'),
          gt(payments.checkoutHeldUntil, now),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /**
   * The customer's claim to have sent the transfer, as one conditional UPDATE.
   *
   * Three predicates beside the tenant and the id, and each of them is a rule stated
   * where a later caller cannot skip it. `state = 'PENDING'` — a claim about a payment
   * that is over is a claim nobody can act on. `method = 'MANUAL_TRANSFER'` —
   * `payments_customer_signal_check` says so too, and having it here means a wallet
   * payment answers `false` rather than raising an integrity error at the surface.
   * `customer_signalled_at IS NULL` — the FIRST claim is the recorded one, because the
   * moment an operator compares against their bank statement must not move when the
   * customer taps again.
   *
   * It sets `updated_at` and nothing else beyond the stamp. No state moves here: this
   * is the one write in this repository that changes what an operator can SEE without
   * changing anything about the money.
   */
  async signalSent(scope: TenantContext, id: PaymentId, now: Date, tx?: unknown): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(payments)
      .set({ customerSignalledAt: now, updatedAt: now })
      .where(
        and(
          eq(payments.tenantId, tenantId),
          eq(payments.id, id),
          eq(payments.state, 'PENDING'),
          eq(payments.method, 'MANUAL_TRANSFER'),
          isNull(payments.customerSignalledAt),
        ),
      )
      .returning({ id: payments.id });
    return rows.length > 0;
  }

  /**
   * Whether a PENDING payment against this order carries the customer's claim.
   *
   * `LIMIT 1` over the three predicates, because the caller acts on the answer alone.
   * `customer_signalled_at IS NOT NULL` is the claim; `state = 'PENDING'` is what makes
   * it still open; the order is the scope. A payment an operator already resolved is
   * not a reason to refuse a cancellation, which is why the state is in the predicate
   * rather than assumed.
   */
  async hasClaimedPendingForOrder(
    scope: TenantContext,
    orderId: OrderId,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ id: payments.id })
      .from(payments)
      .where(
        and(
          eq(payments.tenantId, tenantId),
          eq(payments.orderId, orderId),
          eq(payments.state, 'PENDING'),
          isNotNull(payments.customerSignalledAt),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /**
   * The `CANCEL` edge over every PENDING payment against one order.
   *
   * One statement rather than a read and a loop: the set is small, it is scoped to a
   * single order, and the UPDATE's own `state = 'PENDING'` is what makes it safe
   * against an operator confirming or the sweep expiring concurrently — whichever
   * commits first, the other matches nothing.
   *
   * `resolved_at` is set by the SAME statement, because `payments_resolved_check` binds
   * them: moving the state alone could not commit. No administrator and no note, for
   * the reason `PaymentService.withdrawPending` gives — nobody reviewed this, and
   * `payments_resolution_reviewer_check` would refuse an admin id in any case.
   *
   * It deliberately does NOT exclude a signalled payment. That refusal belongs to
   * `OrderService.cancelByCustomer`, which must answer the customer with a sentence
   * about their claim rather than silently cancelling one payment and not another.
   */
  async cancelPendingForOrder(
    scope: TenantContext,
    orderId: OrderId,
    now: Date,
    tx: unknown,
  ): Promise<readonly PaymentId[]> {
    const tenantId = requireTenantId(scope);
    /*
     * The order's PENDING rows are LOCKED first, in a statement of their own, so the UPDATE
     * below runs on a snapshot taken AFTER every lock is held (READ COMMITTED takes one per
     * statement). The receipt-in-flight predicate reads ANOTHER table, and PostgreSQL's
     * re-check of a row it waited for does not re-read other tables: a receipt queued under
     * the payment's lock while this statement waited would be invisible to it, and the
     * payment the customer had just sent a receipt for would be cancelled (review F3).
     */
    await this.exec(tx)
      .select({ id: payments.id })
      .from(payments)
      .where(
        and(
          eq(payments.tenantId, tenantId),
          eq(payments.orderId, orderId),
          eq(payments.state, 'PENDING'),
        ),
      )
      .for('update');
    const rows = await this.exec(tx)
      .update(payments)
      .set({ state: 'CANCELLED', resolvedAt: now, updatedAt: now })
      .where(
        and(
          eq(payments.tenantId, tenantId),
          eq(payments.orderId, orderId),
          eq(payments.state, 'PENDING'),
          /*
           * Nor one whose receipt has been sent to a provider and not yet answered (review
           * F3): the customer's transfer is very probably made. Read on the snapshot taken
           * after the lock above.
           */
          sql`NOT ${receiptInFlight()}`,
          /*
           * A SIGNALLED transfer is never withdrawn here, and the predicate belongs in
           * this statement rather than in the caller's guard.
           *
           * `OrderService.cancelByCustomer` asks whether a claim exists before it
           * writes, and READ COMMITTED lets a `signalTransferSent` commit between that
           * read and this UPDATE — so a `state = 'PENDING'` predicate alone cancelled
           * the payment whose customer had just been told it was recorded for review.
           * The guard cannot close that window; only the write can. The caller re-asks
           * afterwards and turns a row left behind into a refusal. Found by the Codex
           * review of PR #30.
           *
           * An operator's own withdrawal is unaffected: that path is
           * `PaymentService.withdrawPending` over a payment id, not this one.
           */
          isNull(payments.customerSignalledAt),
          /*
           * Nor a payment an approved Stars pre-checkout holds (Codex review of #85):
           * Telegram charges right after the approval. Row-local, so a cancellation that
           * waited on the approval's row lock re-checks it against the committed row.
           */
          notHeldAt(now),
          /*
           * Nor a payment in a provider review (TonPays Telegram, §9.6.3 f): the customer has
           * very probably sent the money and the provider is reviewing the receipt. Row-local,
           * for the reason the hold above is: a cancellation that waited on the
           * acknowledgement's row lock re-reads this column on the committed row.
           */
          isNull(payments.providerReviewUntil),
        ),
      )
      .returning({ id: payments.id });
    return rows.map((row) => row.id as PaymentId);
  }

  /**
   * The `EXPIRE` edge as a bounded set, for the sweep.
   *
   * Two statements rather than one, and the sub-select is not decoration: the UPDATE's
   * own predicates are re-checked AFTER the row lock is granted, because a sub-select
   * alone is satisfied by a scan that found the row before another writer moved it.
   * `ServiceRepository.expireDue` states the same rule and this follows it.
   *
   * `FOR UPDATE SKIP LOCKED` on the candidates is what makes two worker replicas —
   * the normal case on every rolling update — take DIFFERENT rows rather than one
   * blocking on the other's lock for the length of a tick.
   *
   * `expires_at IS NOT NULL` is redundant beside `<=` and kept for the reason
   * `ServiceRepository.expireDue` keeps its copy: it is the one place the intent is
   * written down, and a later `COALESCE(expires_at, ...)` would expire every payment
   * that has no deadline with nothing else in the query objecting. A wallet payment has
   * no deadline and is never PENDING either, so this predicate is the second of two
   * independent reasons it is never touched here.
   */
  async expireDue(
    scope: TenantContext,
    now: Date,
    limit: number,
    tx: unknown,
  ): Promise<readonly PaymentRecord[]> {
    const tenantId = requireTenantId(scope);
    if (limit <= 0) return [];

    const due = this.exec(tx)
      .select({ id: payments.id })
      .from(payments)
      .where(
        and(
          eq(payments.tenantId, tenantId),
          eq(payments.state, 'PENDING'),
          isNotNull(payments.expiresAt),
          lte(payments.expiresAt, now),
          noReceiptFiled(),
          // Never a payment in a provider review: row-local (§9.6.3 a, b).
          isNull(payments.providerReviewUntil),
        ),
      )
      .orderBy(asc(payments.expiresAt), asc(payments.id))
      .limit(limit)
      .for('update', { skipLocked: true });

    const rows = await this.exec(tx)
      .update(payments)
      .set({
        state: 'EXPIRED',
        /*
         * `resolved_at` is the CLOCK's now, not the deadline that passed.
         *
         * When the window closed and when this installation noticed are different
         * facts, and `expires_at` already records the first. Writing the deadline here
         * would make a sweep that ran an hour late look like one that ran on time.
         */
        resolvedAt: now,
        // Nobody decided this; `payments_resolution_reviewer_check` refuses an admin
        // id on anything but a FAILED payment, so these two are the schema's rule
        // restated where a caller can read it.
        resolvedByAdminId: null,
        resolutionNote: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(payments.tenantId, tenantId),
          eq(payments.state, 'PENDING'),
          isNotNull(payments.expiresAt),
          lte(payments.expiresAt, now),
          /*
           * Restated HERE, as every predicate above is, so the UPDATE never depends on
           * the sub-select alone. Today it is redundant, and the falsification record
           * says so (PAY-01u survives): the candidates are locked `FOR UPDATE SKIP
           * LOCKED` by this same statement, and `ReceiptService.submit` files a receipt
           * under that row lock, so no receipt can land between the two. It is kept for
           * the day the candidate query stops taking the lock.
           */
          noReceiptFiled(),
          /*
           * TonPays Telegram (§9.6.3): a payment whose provider acknowledged the receipt
           * before its deadline is in review, and only the review sweep moves it. ROW-LOCAL
           * and restated here: an acknowledgement that commits between this statement's
           * snapshot and its lock is seen by the re-check of the locked row's own columns,
           * which a cross-table predicate would not be.
           */
          isNull(payments.providerReviewUntil),
          sql`${payments.id} IN ${due}`,
        ),
      )
      .returning();

    return rows.map((row) => toRecord(row as Row));
  }

  async findConfirmedForOrder(
    scope: TenantContext,
    orderId: OrderId,
    tx: unknown,
  ): Promise<PaymentRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.tenantId, tenantId),
          eq(payments.orderId, orderId),
          eq(payments.state, 'CONFIRMED'),
        ),
      )
      /*
       * Newest first, and bounded to one. At most one confirmation can be standing —
       * `settlementIsFunded` sees to that — and the ordering is what makes the answer
       * deterministic rather than whatever the planner returns first if that rule is
       * ever loosened.
       */
      .orderBy(desc(payments.confirmedAt), desc(payments.id))
      .limit(1);
    return row === undefined ? null : toRecord(row as Row);
  }

  async customerIdentities(
    scope: TenantContext,
    customerIds: readonly UserId[],
    tx?: unknown,
  ): Promise<ReadonlyMap<UserId, PaymentCustomerIdentity>> {
    // The one shared reader (spec §10), so every list names a customer the same way.
    return (await readCustomerIdentities(
      this.exec(tx),
      requireTenantId(scope),
      customerIds,
    )) as ReadonlyMap<UserId, PaymentCustomerIdentity>;
  }

  async receiptDispositions(
    scope: TenantContext,
    paymentIds: readonly PaymentId[],
    tx?: unknown,
  ): Promise<ReadonlyMap<PaymentId, ReceiptDisposition>> {
    const tenantId = requireTenantId(scope);
    const found = new Map<PaymentId, ReceiptDisposition>();
    if (paymentIds.length === 0) return found;
    const rows = await this.exec(tx)
      .select({ id: payments.id, disposition: sql<string | null>`${receiptDispositionSql()}` })
      .from(payments)
      .where(and(eq(payments.tenantId, tenantId), inArray(payments.id, [...new Set(paymentIds)])));
    for (const row of rows) {
      if (row.disposition !== null) {
        found.set(row.id as PaymentId, row.disposition as ReceiptDisposition);
      }
    }
    return found;
  }

  async gatewaySignals(
    scope: TenantContext,
    paymentIds: readonly PaymentId[],
    tx?: unknown,
  ): Promise<ReadonlyMap<PaymentId, PaymentGatewaySignalRecord>> {
    const tenantId = requireTenantId(scope);
    const found = new Map<PaymentId, PaymentGatewaySignalRecord>();
    if (paymentIds.length === 0) return found;
    const rows = await this.exec(tx)
      .select({
        paymentId: gatewayInvoices.paymentId,
        creationState: gatewayInvoices.creationState,
        creationErrorCode: gatewayInvoices.creationErrorCode,
        providerStatus: gatewayInvoices.providerStatus,
        providerPaid: gatewayInvoices.providerPaid,
        lastInquiryAt: gatewayInvoices.lastInquiryAt,
        lastInquiryErrorCode: gatewayInvoices.lastInquiryErrorCode,
        outcome: gatewayInvoices.outcome,
        lateCompletionObservedAt: gatewayInvoices.lateCompletionObservedAt,
        reconcileInquiryRequestedAt: gatewayInvoices.reconcileInquiryRequestedAt,
      })
      .from(gatewayInvoices)
      .where(
        and(
          eq(gatewayInvoices.tenantId, tenantId),
          inArray(gatewayInvoices.paymentId, [...new Set(paymentIds)]),
        ),
      );
    for (const { paymentId, ...signal } of rows) found.set(paymentId as PaymentId, signal);
    return found;
  }

  /**
   * Roadmap E1: EVERY fact the classifier reads — the payment's own columns, its receipt
   * disposition, every queue predicate, the refund facts and the invoice's creation state —
   * from ONE statement, so the situation, its `needsAction` and the queues it lists under are
   * one snapshot and cannot disagree (review of PR #243, m1).
   */
  async situationFacts(
    scope: TenantContext,
    paymentIds: readonly PaymentId[],
    tx?: unknown,
  ): Promise<ReadonlyMap<PaymentId, PaymentSituationFactsRecord>> {
    const tenantId = requireTenantId(scope);
    const found = new Map<PaymentId, PaymentSituationFactsRecord>();
    if (paymentIds.length === 0) return found;
    const flags = Object.fromEntries(
      PAYMENT_OPS_QUEUES.map((queue) => [
        `q_${queue}`,
        sql<boolean>`(${paymentOpsQueueCondition(queue)})`,
      ]),
    ) as Record<string, SQL<boolean>>;
    const rows = (await this.exec(tx)
      .select({
        id: payments.id,
        state: payments.state,
        method: payments.method,
        orderId: payments.orderId,
        customerSignalledAt: payments.customerSignalledAt,
        providerReviewUntil: payments.providerReviewUntil,
        resolvedByAdminId: payments.resolvedByAdminId,
        disposition: sql<string | null>`${receiptDispositionSql()}`,
        ...flags,
        receiptFiled: sql<boolean>`(${receiptFiledCondition()})`,
        refundOpen: sql<boolean>`(${openRefundCondition()})`,
        refundCompleted: sql<boolean>`(${completedRefundCondition()})`,
        refundRemaining: sql<boolean>`(${refundRemainingCondition()})`,
        invoiceCreation: sql<string | null>`(
          SELECT gi.creation_state FROM gateway_invoices gi
           WHERE gi.tenant_id = ${payments.tenantId} AND gi.payment_id = ${payments.id})`,
      })
      .from(payments)
      .where(
        and(eq(payments.tenantId, tenantId), inArray(payments.id, [...new Set(paymentIds)])),
      )) as unknown as readonly Record<string, unknown>[];
    for (const row of rows) {
      found.set(row['id'] as PaymentId, {
        state: row['state'] as PaymentState,
        method: row['method'] as PaymentMethod,
        topup: row['orderId'] === null,
        customerSignalled: row['customerSignalledAt'] !== null,
        providerReviewOpened: row['providerReviewUntil'] !== null,
        resolvedByAdmin: row['resolvedByAdminId'] !== null,
        receiptDisposition: (row['disposition'] ?? null) as ReceiptDisposition | null,
        receiptFiled: row['receiptFiled'] === true,
        refundRemaining: row['refundRemaining'] === true,
        queues: PAYMENT_OPS_QUEUES.filter(
          (queue): queue is PaymentOpsQueue => row[`q_${queue}`] === true,
        ),
        refundOpen: row['refundOpen'] === true,
        refundCompleted: row['refundCompleted'] === true,
        invoiceCreation: (row['invoiceCreation'] ?? null) as GatewayInvoiceCreationState | null,
      });
    }
    return found;
  }

  async recordProviderReview(
    scope: TenantContext,
    id: PaymentId,
    window: { readonly acknowledgedAt: Date; readonly reviewUntil: Date },
    now: Date,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(payments)
      .set({
        providerReviewStartedAt: window.acknowledgedAt,
        providerReviewUntil: window.reviewUntil,
        updatedAt: now,
      })
      .where(
        and(
          eq(payments.tenantId, tenantId),
          eq(payments.id, id),
          eq(payments.state, 'PENDING'),
          eq(payments.method, 'GATEWAY'),
          // Only a route whose descriptor reviews (the CHECK says so too).
          inArray(payments.gatewayProvider, [...PROVIDER_REVIEW_GATEWAY_PROVIDERS]),
          // Written once: a repeated acknowledgement moves nothing.
          isNull(payments.providerReviewUntil),
          // Half-open: an acknowledgement AT the deadline opens nothing.
          gt(payments.expiresAt, window.acknowledgedAt),
        ),
      )
      .returning({ id: payments.id });
    return rows.length > 0;
  }

  async loseTrackOfReviewed(
    scope: TenantContext,
    now: Date,
    limit: number,
    tx: unknown,
  ): Promise<readonly PaymentRecord[]> {
    const tenantId = requireTenantId(scope);
    if (limit <= 0) return [];
    const reviewEnded = and(
      eq(payments.tenantId, tenantId),
      eq(payments.state, 'PENDING'),
      eq(payments.method, 'GATEWAY'),
      isNotNull(payments.providerReviewUntil),
      lte(payments.providerReviewUntil, now),
    );
    const due = this.exec(tx)
      .select({ id: payments.id })
      .from(payments)
      .where(reviewEnded)
      .orderBy(asc(payments.providerReviewUntil), asc(payments.id))
      .limit(limit)
      .for('update', { skipLocked: true });
    const rows = await this.exec(tx)
      .update(payments)
      // UNKNOWN is not a resolved state: no `resolved_at` (`payments_resolved_check`).
      .set({ state: 'UNKNOWN', updatedAt: now })
      .where(and(reviewEnded, sql`${payments.id} IN ${due}`))
      .returning();
    return rows.map((row) => toRecord(row as Row));
  }

  async loseTrack(
    scope: TenantContext,
    id: PaymentId,
    now: Date,
    tx: unknown,
  ): Promise<PaymentRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .update(payments)
      // UNKNOWN is not a resolved state: no `resolved_at` (`payments_resolved_check`).
      .set({ state: 'UNKNOWN', updatedAt: now })
      .where(
        and(
          eq(payments.tenantId, tenantId),
          eq(payments.id, id),
          eq(payments.state, 'PENDING'),
          eq(payments.method, 'GATEWAY'),
          sql`COALESCE(${payments.providerReviewUntil}, ${payments.expiresAt}) > ${now}::timestamptz`,
        ),
      )
      .returning();
    return row === undefined ? null : toRecord(row as Row);
  }

  async reconcileConfirm(
    scope: TenantContext,
    id: PaymentId,
    confirmation: PaymentConfirmation,
    now: Date,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(payments)
      .set({
        state: 'CONFIRMED',
        evidenceKind: confirmation.evidenceKind,
        evidenceNote: confirmation.evidenceNote,
        confirmedByAdminId: confirmation.confirmedByAdminId,
        confirmedAt: confirmation.confirmedAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(payments.tenantId, tenantId),
          eq(payments.id, id),
          eq(payments.state, 'UNKNOWN'),
          eq(payments.method, 'GATEWAY'),
        ),
      )
      .returning({ id: payments.id });
    return rows.length > 0;
  }

  async reconcileFail(
    scope: TenantContext,
    id: PaymentId,
    resolution: PaymentResolution,
    now: Date,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(payments)
      .set({
        state: 'FAILED',
        resolvedAt: resolution.resolvedAt,
        resolvedByAdminId: resolution.resolvedByAdminId,
        resolutionNote: resolution.resolutionNote,
        updatedAt: now,
      })
      .where(
        and(
          eq(payments.tenantId, tenantId),
          eq(payments.id, id),
          eq(payments.state, 'UNKNOWN'),
          eq(payments.method, 'GATEWAY'),
        ),
      )
      .returning({ id: payments.id });
    return rows.length > 0;
  }

  async hasProviderReviewOrUnknownForOrder(
    scope: TenantContext,
    orderId: OrderId,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ id: payments.id })
      .from(payments)
      .where(
        and(
          eq(payments.tenantId, tenantId),
          eq(payments.orderId, orderId),
          or(
            and(eq(payments.state, 'PENDING'), isNotNull(payments.providerReviewUntil)),
            eq(payments.state, 'UNKNOWN'),
            // A receipt already sent to the provider and not yet answered (review F3).
            and(eq(payments.state, 'PENDING'), receiptInFlight()),
          ),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async lockPendingForOrder(scope: TenantContext, orderId: OrderId, tx: unknown): Promise<void> {
    const tenantId = requireTenantId(scope);
    await this.exec(tx)
      .select({ id: payments.id })
      .from(payments)
      .where(
        and(
          eq(payments.tenantId, tenantId),
          eq(payments.orderId, orderId),
          eq(payments.state, 'PENDING'),
        ),
      )
      .orderBy(asc(payments.id))
      .for('update');
  }

  async hasOtherLivePaymentForOrder(
    scope: TenantContext,
    orderId: OrderId,
    except: PaymentId,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ id: payments.id })
      .from(payments)
      .where(
        and(
          eq(payments.tenantId, tenantId),
          eq(payments.orderId, orderId),
          sql`${payments.id} <> ${except}`,
          /*
           * Any PENDING one, whatever its clock says — a manual transfer with a receipt never
           * expires and can still be confirmed — an UNKNOWN one, and a CONFIRMED one: the
           * order is then paid, and a receipt for it would be a second payment.
           */
          inArray(payments.state, ['PENDING', 'UNKNOWN', 'CONFIRMED']),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async hasGatewayReceiptInFlight(
    scope: TenantContext,
    id: PaymentId,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ id: payments.id })
      .from(payments)
      .where(and(eq(payments.tenantId, tenantId), eq(payments.id, id), receiptInFlight()))
      .limit(1);
    return rows.length > 0;
  }

  async setExternalReference(
    scope: TenantContext,
    paymentId: PaymentId,
    externalReference: string,
    now: Date,
    tx?: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(payments)
      .set({ externalReference, updatedAt: now })
      .where(
        and(
          eq(payments.tenantId, tenantId),
          eq(payments.id, paymentId),
          eq(payments.method, 'GATEWAY'),
          eq(payments.state, 'PENDING'),
          isNull(payments.externalReference),
        ),
      )
      .returning({ id: payments.id });
    return rows.length > 0;
  }

  async trackingCodeFor(
    scope: TenantContext,
    paymentId: string,
    tx?: unknown,
  ): Promise<string | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .select({ reference: payments.reference })
      .from(payments)
      .where(and(eq(payments.tenantId, tenantId), eq(payments.id, paymentId)))
      .limit(1);
    // FIX-02: the PUBLIC code, never the role-suffixed reference it is derived from.
    return row === undefined ? null : paymentTrackingCode(row.reference);
  }

  async rejectionReasonFor(
    scope: TenantContext,
    paymentId: string,
    tx?: unknown,
  ): Promise<string | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .select({ note: payments.resolutionNote })
      .from(payments)
      .where(
        and(
          eq(payments.tenantId, tenantId),
          eq(payments.id, paymentId),
          eq(payments.state, 'FAILED'),
          isNotNull(payments.resolvedByAdminId),
          sql`NOT EXISTS (
            SELECT 1 FROM ${receiptCredits}
             WHERE ${receiptCredits.tenantId} = ${payments.tenantId}
               AND ${receiptCredits.paymentId} = ${payments.id})`,
        ),
      )
      .limit(1);
    const note = row?.note?.trim() ?? '';
    return note === '' || note === PRE_REASON_REJECTION_NOTE ? null : note;
  }
}

/**
 * The note the Telegram surface wrote on EVERY rejection before the reason was mandatory: a
 * sentence about the surface, not a reason. It is never shown to a customer as one.
 */
const PRE_REASON_REJECTION_NOTE = 'Rejected in the Telegram management panel.';

/**
 * How a payment's receipt left review, as ONE SQL expression over the `payments` row in scope
 * (WP10 follow-up §5). The list's column, its filter and Telegram's already-resolved answer all
 * read this, so none of them can disagree about what a credited FAILED payment is.
 *
 * - Not a MANUAL_TRANSFER holding a receipt: NULL. A signal-only transfer decided without a
 *   receipt is a payment decision, not a receipt disposition.
 * - A `receipt_credits` row: CREDITED_TO_WALLET — checked BEFORE the state, because the state
 *   of a credited payment is FAILED and would otherwise read as a rejection.
 * - CONFIRMED by an administrator: APPROVED. FAILED resolved by an administrator: REJECTED.
 * - Anything else (pending, expired, withdrawn): NULL.
 */
export function receiptDispositionSql(): SQL {
  return sql`CASE
    WHEN ${payments.method} <> 'MANUAL_TRANSFER'
      OR NOT EXISTS (
        SELECT 1 FROM ${paymentReceipts}
         WHERE ${paymentReceipts.tenantId} = ${payments.tenantId}
           AND ${paymentReceipts.paymentId} = ${payments.id}
      ) THEN NULL
    WHEN EXISTS (
        SELECT 1 FROM ${receiptCredits}
         WHERE ${receiptCredits.tenantId} = ${payments.tenantId}
           AND ${receiptCredits.paymentId} = ${payments.id}
      ) THEN 'CREDITED_TO_WALLET'
    WHEN ${payments.state} = 'CONFIRMED' AND ${payments.confirmedByAdminId} IS NOT NULL
      THEN 'APPROVED'
    WHEN ${payments.state} = 'FAILED' AND ${payments.resolvedByAdminId} IS NOT NULL
      THEN 'REJECTED'
    ELSE NULL
  END`;
}

/**
 * No receipt is on file for this payment — the one condition under which a PENDING
 * transfer may still expire (Payment File 02 §9, D1).
 *
 * A submitted receipt has no timer: it stays reviewable until a reviewer approves,
 * rejects or credits it. Tenant-scoped as well as keyed by the payment, because every
 * read here is; `payment_receipts_payment_idx` leads with both.
 */
function noReceiptFiled(): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM ${paymentReceipts}
                  WHERE ${paymentReceipts.tenantId} = ${payments.tenantId}
                    AND ${paymentReceipts.paymentId} = ${payments.id})`;
}

type Row = {
  id: string;
  customerId: string;
  orderId: string | null;
  state: string;
  method: string;
  amount: bigint;
  currency: string;
  reference: string;
  evidenceKind: string | null;
  evidenceNote: string | null;
  externalReference: string | null;
  confirmedAt: Date | null;
  confirmedByAdminId: string | null;
  resolvedAt: Date | null;
  resolvedByAdminId: string | null;
  resolutionNote: string | null;
  customerSignalledAt: Date | null;
  checkoutHeldUntil: Date | null;
  expiresAt: Date | null;
  gatewayProvider: string | null;
  topupCashbackPercent: number | null;
  customerFeeBasisPoints: number | null;
  customerFeeAmount: bigint | null;
  payableAmount: bigint | null;
  providerReviewStartedAt: Date | null;
  providerReviewUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function toRecord(row: Row): PaymentRecord {
  return {
    id: row.id as PaymentId,
    customerId: row.customerId as UserId,
    orderId: row.orderId as OrderId | null,
    state: row.state as PaymentState,
    method: row.method as PaymentMethod,
    // One value, so nothing downstream can read an amount without its currency.
    amount: money(row.amount, row.currency as CurrencyCode),
    reference: row.reference,
    evidenceKind: row.evidenceKind as PaymentEvidenceKind | null,
    evidenceNote: row.evidenceNote,
    externalReference: row.externalReference,
    confirmedAt: row.confirmedAt,
    confirmedByAdminId: row.confirmedByAdminId,
    resolvedAt: row.resolvedAt,
    resolvedByAdminId: row.resolvedByAdminId,
    resolutionNote: row.resolutionNote,
    customerSignalledAt: row.customerSignalledAt,
    checkoutHeldUntil: row.checkoutHeldUntil,
    expiresAt: row.expiresAt,
    // `payments_gateway_provider_check` is built from the contract enum.
    gatewayProvider: row.gatewayProvider as PaymentGatewayProvider | null,
    topupCashbackPercent: row.topupCashbackPercent,
    customerFee:
      row.customerFeeBasisPoints === null ||
      row.customerFeeAmount === null ||
      row.payableAmount === null
        ? null
        : {
            basisPoints: row.customerFeeBasisPoints,
            fee: money(row.customerFeeAmount, row.currency as CurrencyCode),
            payable: money(row.payableAmount, row.currency as CurrencyCode),
          },
    providerReviewStartedAt: row.providerReviewStartedAt,
    providerReviewUntil: row.providerReviewUntil,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** No approved Stars checkout holds the row at `now` (Codex review of #85, C2). */
function notHeldAt(now: Date) {
  return or(isNull(payments.checkoutHeldUntil), lte(payments.checkoutHeldUntil, now));
}

/**
 * A provider receipt the customer has SENT for this payment that the provider has not yet
 * answered, or whose answer is still being decided (`docs/tonpays-telegram-gateway-audit.md`
 * §9.6.3 f; independent review F3): queued, on the wire, accepted, or lost and not yet
 * resolved by an inquiry. Money the customer has very probably moved — the manual-transfer
 * precedent is `customer_signalled_at`. Raw SQL over the submissions table, correlated on
 * the payment row, so the predicate composes into any payments query.
 */
function receiptInFlight(): SQL {
  return sql`EXISTS (
    SELECT 1 FROM gateway_receipt_submissions s
     WHERE s.tenant_id = ${payments.tenantId}
       AND s.payment_id = ${payments.id}
       AND (s.state IN ('QUEUED', 'SENDING', 'ACCEPTED')
            OR (s.state = 'UNKNOWN' AND s.inquiry_resolved_at IS NULL)))`;
}

/**
 * The payment list's one search box (spec §10), as a predicate every arm of which an index
 * serves — `payments_customer_created_idx`, the primary key, `payments_tenant_order_idx`,
 * `payments_tenant_reference_key` and `payments_tenant_external_reference_idx` — so an
 * `OR` of them is a BitmapOr rather than a walk of the tenant's payments. Exact matches
 * only: a partial match over money opens somebody else's payment by typing four characters.
 */
function paymentTextCondition(tenantId: string, term: ListSearchTerm): SQL {
  switch (term.kind) {
    case 'TELEGRAM_ID':
      // Digits are also what a bank tracking number is, so the references are asked too —
      // and a gateway's own ids, which are often digits (CentralPay's order id, NOWPayments'
      // payment id).
      return or(
        sql`${payments.customerId} = ANY(${customerIdsWithTelegramId(tenantId, term.value)})`,
        referenceCondition(term.value),
        eq(payments.externalReference, term.value),
        sql`${payments.id} = ANY(${paymentIdsWithProviderReference(tenantId, term.value)})`,
      ) as SQL;
    case 'UUID':
      // A gateway's own id can be uuid-shaped too (an invoice or charge id), and the box
      // classifies by shape: the provider ids are asked here as they are for digits and text.
      return or(
        eq(payments.id, term.value),
        eq(payments.customerId, term.value),
        eq(payments.orderId, term.value),
        sql`${payments.id} = ANY(${paymentIdsWithProviderReference(tenantId, term.value)})`,
      ) as SQL;
    case 'USERNAME':
      return sql`${payments.customerId} = ANY(${customerIdsWithUsernamePrefix(tenantId, term.value)})`;
    case 'TEXT':
      return or(
        referenceCondition(term.value),
        eq(payments.externalReference, term.value),
        sql`${payments.id} = ANY(${paymentIdsWithProviderReference(tenantId, term.value)})`,
      ) as SQL;
  }
}

/**
 * A payment by what an operator was QUOTED (FIX-02): the stored reference exactly, as before,
 * or — when the term is shaped like one — the public tracking code the customer was shown,
 * which is the reference's operation-id half (`paymentTrackingCode`). An old suffixed reference
 * pasted from an earlier screen is reduced to its code too, so both shapes find the payment.
 *
 * `split_part(reference, ':', 1)` is the code for every reference `referenceFor` writes, and
 * `payments_tenant_tracking_code_idx` indexes exactly that expression, so the arm is an index
 * scan beside `payments_tenant_reference_key`. A code is not a unique key — it is 64 bits of a
 * hash — so this is a predicate that may match more than one row, and the list shows them all.
 */
function referenceCondition(value: string): SQL {
  const code = trackingCodeFromSearch(value);
  if (code === null) return eq(payments.reference, value);
  return or(
    eq(payments.reference, value),
    sql`split_part(${payments.reference}, ':', 1) = ${code}`,
  ) as SQL;
}

/**
 * The payments whose gateway invoice carries this provider id EXACTLY — the provider's order
 * id, invoice id, charge / reference id, or the payment id or invoice id a verified webhook
 * named (Payment Operations Center, program §10: what an operator copies out of a provider's
 * dashboard). The hinted invoice id is the only invoice id an attempt whose create answer was
 * lost (CREATE_UNKNOWN) carries until an inquiry adopts it, so leaving it out made exactly the
 * attempts an operator is chasing unfindable by the id the provider shows them.
 * An InitPlan, like `customerIdsWithTelegramId`, so it is evaluated once. `provider = ANY`
 * lets the three `(tenant_id, provider, …)` unique keys serve their arms; the two hinted ids
 * have their own partial indexes (`gateway_invoices_tenant_hinted_payment_idx`,
 * `gateway_invoices_tenant_hinted_invoice_idx`). Exact only, for the reason every arm here is
 * exact.
 */
function paymentIdsWithProviderReference(tenantId: string, value: string): SQL {
  const providers = sql.join(
    PAYMENT_GATEWAY_PROVIDERS.map((provider) => sql`${provider}`),
    sql`, `,
  );
  return sql`ARRAY(SELECT ${gatewayInvoices.paymentId} FROM ${gatewayInvoices}
    WHERE ${gatewayInvoices.tenantId} = ${tenantId}
      AND ((${gatewayInvoices.provider} IN (${providers}) AND (${gatewayInvoices.providerOrderId} = ${value}
             OR ${gatewayInvoices.providerInvoiceId} = ${value}
             OR ${gatewayInvoices.providerChargeId} = ${value}))
        OR ${gatewayInvoices.hintedPaymentId} = ${value}
        OR ${gatewayInvoices.hintedInvoiceId} = ${value}))`;
}
