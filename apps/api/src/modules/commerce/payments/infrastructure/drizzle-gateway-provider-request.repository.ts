import { and, asc, desc, eq, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import type {
  GatewayProviderNeedKind,
  GatewayProviderRequestKind,
  GatewayProviderRequestState,
  PaymentGatewayProvider,
  PaymentId,
  TenantContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  gatewayInvoiceProviderFacts,
  gatewayInvoices,
  gatewayProviderRequests,
  gatewayReceiptSubmissions,
  payments,
} from '../../../../infrastructure/persistence/schema.js';
import type {
  ClaimedProviderRequest,
  GatewayProviderFacts,
  GatewayProviderRequestRecord,
  GatewayProviderRequestRepository,
  GatewaySiblingAttempt,
} from '../application/gateway-invoice-ports.js';
import {
  NEXA_CANCEL_KEY_PREFIX,
  NEXA_EXPIRY_CANCEL_KEY_PREFIX,
} from '../application/gateway-invoice-ports.js';

type RequestRow = typeof gatewayProviderRequests.$inferSelect;

function recordOf(row: RequestRow): GatewayProviderRequestRecord {
  return {
    id: row.id,
    paymentId: row.paymentId as PaymentId,
    botInstanceId: row.botInstanceId,
    customerId: row.customerId,
    // `gateway_provider_requests_{kind,state}_check` are built from the contract enums.
    kind: row.kind as GatewayProviderRequestKind,
    state: row.state as GatewayProviderRequestState,
    requestedAt: row.requestedAt,
    sentAt: row.sentAt,
    decidedAt: row.decidedAt,
    errorCode: row.errorCode,
    refundCardMasked: row.refundCardMasked,
    requestedByNexa:
      row.idempotencyKey.startsWith(NEXA_CANCEL_KEY_PREFIX) ||
      row.idempotencyKey.startsWith(NEXA_EXPIRY_CANCEL_KEY_PREFIX),
    requestedOnExpiry: row.idempotencyKey.startsWith(NEXA_EXPIRY_CANCEL_KEY_PREFIX),
  };
}

/**
 * Cancel and refund requests, and the provider's latest word on what the customer owes next
 * (Round 6). The request machine is `DrizzleGatewayCardTransferRepository`'s card-change one:
 * every transition is ONE conditional UPDATE naming its `from` states, there is no setter, and
 * every statement names the tenant.
 *
 * What is specific here is the sealed refund card: it is written with the request, returned
 * ONLY by `claim` / `claimedById` (the worker's reads), and wiped by the same UPDATE that
 * stamps the send or decides the row — the CHECK `gateway_provider_requests_sealed_card_check`
 * refuses any other end state. No method returns it to a surface, and none logs it.
 */
export class DrizzleGatewayProviderRequestRepository implements GatewayProviderRequestRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async request(
    scope: TenantContext,
    input: Parameters<GatewayProviderRequestRepository['request']>[1],
    tx: unknown,
  ): Promise<GatewayProviderRequestRecord | null> {
    const tenantId = requireTenantId(scope);
    // `ON CONFLICT DO NOTHING`, no target: a request of this kind already in flight, or this
    // tap already recorded, is one answer — and not an error the customer did anything about.
    const rows = await this.exec(tx)
      .insert(gatewayProviderRequests)
      .values({
        id: input.id,
        tenantId,
        paymentId: input.paymentId,
        botInstanceId: input.botInstanceId,
        customerId: input.customerId,
        kind: input.kind,
        state: 'REQUESTED',
        requestedAt: input.now,
        claimedUntil: input.claimedUntil,
        idempotencyKey: input.idempotencyKey,
        refundCardMasked: input.refund?.masked ?? null,
        refundCardCiphertext: input.refund?.sealed.ciphertext ?? null,
        refundCardKeyId: input.refund?.sealed.keyId ?? null,
      })
      .onConflictDoNothing()
      .returning();
    const row = rows[0];
    return row === undefined ? null : recordOf(row);
  }

  async requestExpiryCancel(
    scope: TenantContext,
    input: { readonly id: string; readonly paymentId: PaymentId; readonly now: Date },
    tx: unknown,
  ): Promise<GatewayProviderRequestRecord | null> {
    const tenantId = requireTenantId(scope);
    const r = gatewayProviderRequests;
    const gi = gatewayInvoices;
    const p = payments;
    const s = gatewayReceiptSubmissions;
    const key = `${NEXA_EXPIRY_CANCEL_KEY_PREFIX}${input.paymentId}`;
    /*
     * Every condition in the one statement, restated against the rows as they stand: a create
     * whose answer was lost (`CREATE_UNKNOWN`), an invoice the inquiry reported paid or anything
     * but `pending`, an attempt already decided, a cancel already asked (and not definitively
     * unprocessed), a receipt on its way — each writes nothing.
     */
    const result = await this.exec(tx).execute(sql`
      INSERT INTO ${r} (id, tenant_id, payment_id, bot_instance_id, customer_id, kind, state,
                        requested_at, claimed_until, idempotency_key)
      SELECT ${input.id}::uuid, ${gi.tenantId}, ${gi.paymentId}, ${gi.botInstanceId},
             ${p.customerId}, 'CANCEL'::text, 'REQUESTED'::text, ${input.now}::timestamptz,
             NULL::timestamptz, ${key}::text
        FROM ${gi}
        JOIN ${p} ON ${p.tenantId} = ${gi.tenantId} AND ${p.id} = ${gi.paymentId}
       WHERE ${gi.tenantId} = ${tenantId}
         AND ${gi.paymentId} = ${input.paymentId}
         AND ${p.state} = 'EXPIRED'
         AND ${p.method} = 'GATEWAY'
         AND ${gi.creationState} = 'CREATED'
         AND ${gi.providerInvoiceId} IS NOT NULL
         AND ${gi.botInstanceId} IS NOT NULL
         AND ${gi.outcome} IS NULL
         AND ${gi.providerPaid} IS NOT TRUE
         AND (${gi.providerStatus} IS NULL OR ${gi.providerStatus} = 'pending')
         AND NOT EXISTS (
               SELECT 1 FROM ${r} AS asked
                WHERE asked.tenant_id = ${gi.tenantId}
                  AND asked.payment_id = ${gi.paymentId}
                  AND asked.kind = 'CANCEL'
                  AND asked.state <> 'RATE_LIMITED')
         AND NOT EXISTS (
               SELECT 1 FROM ${s}
                WHERE ${s.tenantId} = ${gi.tenantId}
                  AND ${s.paymentId} = ${gi.paymentId}
                  AND ${s.state} IN ('QUEUED', 'SENDING', 'ACCEPTED', 'UNKNOWN'))
      ON CONFLICT DO NOTHING
      RETURNING id`);
    if (result.rows.length === 0) return null;
    return this.findOne(scope, input.id, tx);
  }

  private async findOne(
    scope: TenantContext,
    id: string,
    tx: unknown,
  ): Promise<GatewayProviderRequestRecord | null> {
    const [row] = await this.exec(tx)
      .select()
      .from(gatewayProviderRequests)
      .where(
        and(
          eq(gatewayProviderRequests.tenantId, requireTenantId(scope)),
          eq(gatewayProviderRequests.id, id),
        ),
      )
      .limit(1);
    return row === undefined ? null : recordOf(row);
  }

  async latest(
    scope: TenantContext,
    paymentId: PaymentId,
    kind: GatewayProviderRequestKind,
    tx?: unknown,
  ): Promise<GatewayProviderRequestRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .select()
      .from(gatewayProviderRequests)
      .where(
        and(
          eq(gatewayProviderRequests.tenantId, tenantId),
          eq(gatewayProviderRequests.paymentId, paymentId),
          eq(gatewayProviderRequests.kind, kind),
        ),
      )
      .orderBy(desc(gatewayProviderRequests.requestedAt), desc(gatewayProviderRequests.id))
      .limit(1);
    return row === undefined ? null : recordOf(row);
  }

  async claim(
    scope: TenantContext,
    now: Date,
    leaseMs: number,
    limit: number,
    tx: unknown,
  ): Promise<readonly ClaimedProviderRequest[]> {
    const tenantId = requireTenantId(scope);
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const claimable = and(
      eq(gatewayProviderRequests.tenantId, tenantId),
      inArray(gatewayProviderRequests.state, ['REQUESTED', 'SENT']),
      or(
        isNull(gatewayProviderRequests.claimedUntil),
        lte(gatewayProviderRequests.claimedUntil, now),
      ),
    );
    const due = this.exec(tx)
      .select({ id: gatewayProviderRequests.id })
      .from(gatewayProviderRequests)
      .where(claimable)
      .orderBy(asc(gatewayProviderRequests.requestedAt), asc(gatewayProviderRequests.id))
      .limit(limit)
      .for('update', { skipLocked: true });
    const rows = await this.exec(tx)
      .update(gatewayProviderRequests)
      .set({ claimedUntil: leaseUntil })
      .where(and(claimable, sql`${gatewayProviderRequests.id} IN ${due}`))
      .returning();
    return this.withPaymentFacts(
      scope,
      rows.sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime()),
      tx,
    );
  }

  async claimedById(
    scope: TenantContext,
    id: string,
    tx: unknown,
  ): Promise<ClaimedProviderRequest | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .select()
      .from(gatewayProviderRequests)
      .where(
        and(eq(gatewayProviderRequests.tenantId, tenantId), eq(gatewayProviderRequests.id, id)),
      )
      .limit(1);
    if (row === undefined) return null;
    const [claimed] = await this.withPaymentFacts(scope, [row], tx);
    return claimed ?? null;
  }

  async markSent(scope: TenantContext, id: string, now: Date, tx: unknown): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(gatewayProviderRequests)
      // The sealed card is wiped by the very statement that stamps the send: from here on a
      // refund exists only in the worker's memory and in the provider's hands.
      .set({
        state: 'SENT',
        sentAt: now,
        refundCardCiphertext: null,
        refundCardKeyId: null,
      })
      .where(
        and(
          eq(gatewayProviderRequests.tenantId, tenantId),
          eq(gatewayProviderRequests.id, id),
          eq(gatewayProviderRequests.state, 'REQUESTED'),
          isNull(gatewayProviderRequests.sentAt),
        ),
      )
      .returning({ id: gatewayProviderRequests.id });
    return rows.length > 0;
  }

  async requeueUnsentCancel(
    scope: TenantContext,
    id: string,
    sentAt: Date,
    notBefore: Date,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(gatewayProviderRequests)
      .set({ state: 'REQUESTED', sentAt: null, claimedUntil: notBefore })
      .where(
        and(
          eq(gatewayProviderRequests.tenantId, tenantId),
          eq(gatewayProviderRequests.id, id),
          eq(gatewayProviderRequests.kind, 'CANCEL'),
          eq(gatewayProviderRequests.state, 'SENT'),
          eq(gatewayProviderRequests.sentAt, sentAt),
        ),
      )
      .returning({ id: gatewayProviderRequests.id });
    return rows.length > 0;
  }

  async decide(
    scope: TenantContext,
    id: string,
    to: Exclude<GatewayProviderRequestState, 'REQUESTED' | 'SENT'>,
    errorCode: string | null,
    now: Date,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(gatewayProviderRequests)
      .set({
        state: to,
        decidedAt: now,
        errorCode,
        claimedUntil: null,
        refundCardCiphertext: null,
        refundCardKeyId: null,
      })
      .where(
        and(
          eq(gatewayProviderRequests.tenantId, tenantId),
          eq(gatewayProviderRequests.id, id),
          inArray(gatewayProviderRequests.state, ['REQUESTED', 'SENT']),
        ),
      )
      .returning({ id: gatewayProviderRequests.id });
    return rows.length > 0;
  }

  async releaseClaims(
    scope: TenantContext,
    ids: readonly string[],
    leaseUntil: Date,
    tx: unknown,
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(gatewayProviderRequests)
      .set({ claimedUntil: null })
      .where(
        and(
          eq(gatewayProviderRequests.tenantId, tenantId),
          inArray(gatewayProviderRequests.id, [...ids]),
          eq(gatewayProviderRequests.claimedUntil, leaseUntil),
        ),
      )
      .returning({ id: gatewayProviderRequests.id });
    return rows.length;
  }

  async siblingAttempts(
    scope: TenantContext,
    input: {
      readonly customerId: string;
      readonly provider: PaymentGatewayProvider;
      readonly botInstanceId: string;
      readonly exceptPaymentId: PaymentId;
      readonly now: Date;
      readonly includeReview?: boolean;
    },
    tx?: unknown,
  ): Promise<readonly GatewaySiblingAttempt[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({
        paymentId: gatewayInvoices.paymentId,
        botInstanceId: gatewayInvoices.botInstanceId,
        customerId: payments.customerId,
        providerInvoiceId: gatewayInvoices.providerInvoiceId,
        providerStatus: gatewayInvoices.providerStatus,
      })
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
          eq(gatewayInvoices.botInstanceId, input.botInstanceId),
          eq(gatewayInvoices.creationState, 'CREATED'),
          eq(payments.customerId, input.customerId),
          eq(payments.method, 'GATEWAY'),
          eq(payments.state, 'PENDING'),
          ...(input.includeReview === true
            ? [sql`COALESCE(${payments.providerReviewUntil}, ${payments.expiresAt}) > ${input.now}`]
            : [isNull(payments.providerReviewUntil), sql`${payments.expiresAt} > ${input.now}`]),
          ne(gatewayInvoices.paymentId, input.exceptPaymentId),
          sql`${gatewayInvoices.providerInvoiceId} IS NOT NULL`,
        ),
      )
      .orderBy(asc(payments.createdAt), asc(payments.id));
    const out: GatewaySiblingAttempt[] = [];
    for (const row of rows) {
      if (row.providerInvoiceId === null || row.botInstanceId === null) continue;
      const [cancel] = await this.exec(tx)
        .select({ state: gatewayProviderRequests.state })
        .from(gatewayProviderRequests)
        .where(
          and(
            eq(gatewayProviderRequests.tenantId, tenantId),
            eq(gatewayProviderRequests.paymentId, row.paymentId),
            eq(gatewayProviderRequests.kind, 'CANCEL'),
          ),
        )
        .orderBy(desc(gatewayProviderRequests.requestedAt), desc(gatewayProviderRequests.id))
        .limit(1);
      const [receipt] = await this.exec(tx)
        .select({ id: gatewayReceiptSubmissions.id })
        .from(gatewayReceiptSubmissions)
        .where(
          and(
            eq(gatewayReceiptSubmissions.tenantId, tenantId),
            eq(gatewayReceiptSubmissions.paymentId, row.paymentId),
            inArray(gatewayReceiptSubmissions.state, ['QUEUED', 'SENDING', 'ACCEPTED', 'UNKNOWN']),
          ),
        )
        .limit(1);
      out.push({
        paymentId: row.paymentId as PaymentId,
        botInstanceId: row.botInstanceId,
        customerId: row.customerId,
        providerInvoiceId: row.providerInvoiceId,
        providerStatus: row.providerStatus,
        latestCancelState: (cancel?.state as GatewayProviderRequestState | undefined) ?? null,
        receiptSent: receipt !== undefined,
      });
    }
    return out;
  }

  async recordFacts(
    scope: TenantContext,
    paymentId: PaymentId,
    facts: GatewayProviderFacts | null,
    now: Date,
    tx: unknown,
  ): Promise<{
    readonly reasonsChanged: boolean;
    readonly changed: boolean;
    readonly needBefore: GatewayProviderNeedKind | null;
    readonly remainingInvoiceIdBefore: string | null;
  }> {
    const tenantId = requireTenantId(scope);
    const executor = this.exec(tx);
    const [existing] = await executor
      .select()
      .from(gatewayInvoiceProviderFacts)
      .where(
        and(
          eq(gatewayInvoiceProviderFacts.tenantId, tenantId),
          eq(gatewayInvoiceProviderFacts.paymentId, paymentId),
        ),
      )
      .for('update')
      .limit(1);
    const before = Array.isArray(existing?.rejectReasons)
      ? (existing.rejectReasons as unknown[]).map(String)
      : [];
    const needBefore = (existing?.need ?? null) as GatewayProviderNeedKind | null;
    const remainingInvoiceIdBefore = existing?.remainingInvoiceId ?? null;
    if (facts === null) {
      if (existing !== undefined) {
        await executor
          .delete(gatewayInvoiceProviderFacts)
          .where(
            and(
              eq(gatewayInvoiceProviderFacts.tenantId, tenantId),
              eq(gatewayInvoiceProviderFacts.paymentId, paymentId),
            ),
          );
      }
      return {
        reasonsChanged: false,
        changed: existing !== undefined,
        needBefore,
        remainingInvoiceIdBefore,
      };
    }
    const values = {
      need: facts.need,
      remainingAmount: facts.remainingAmount,
      remainingCardNumber: facts.remainingCardNumber,
      remainingCardHolder: facts.remainingCardHolder,
      remainingInvoiceId: facts.remainingInvoiceId,
      remainingReceiptReceived: facts.remainingReceiptReceived,
      refundAmount: facts.refundAmount,
      refundPending: facts.refundPending,
      rejectReasons: [...facts.rejectReasons],
      observedAt: now,
    };
    if (existing === undefined) {
      await executor.insert(gatewayInvoiceProviderFacts).values({ tenantId, paymentId, ...values });
    } else {
      await executor
        .update(gatewayInvoiceProviderFacts)
        .set(values)
        .where(
          and(
            eq(gatewayInvoiceProviderFacts.tenantId, tenantId),
            eq(gatewayInvoiceProviderFacts.paymentId, paymentId),
          ),
        );
    }
    const reasonsChanged =
      facts.rejectReasons.length > 0 &&
      (before.length !== facts.rejectReasons.length ||
        before.some((reason, index) => reason !== facts.rejectReasons[index]));
    // Whether anything the customer's screen shows differs from what was stored.
    const changed =
      existing === undefined ||
      existing.need !== facts.need ||
      existing.remainingAmount !== facts.remainingAmount ||
      existing.remainingCardNumber !== facts.remainingCardNumber ||
      existing.remainingCardHolder !== facts.remainingCardHolder ||
      existing.remainingInvoiceId !== facts.remainingInvoiceId ||
      existing.remainingReceiptReceived !== facts.remainingReceiptReceived ||
      existing.refundAmount !== facts.refundAmount ||
      existing.refundPending !== facts.refundPending ||
      before.length !== facts.rejectReasons.length ||
      before.some((reason, index) => reason !== facts.rejectReasons[index]);
    return { reasonsChanged, changed, needBefore, remainingInvoiceIdBefore };
  }

  async factsFor(
    scope: TenantContext,
    paymentId: PaymentId,
    tx?: unknown,
  ): Promise<GatewayProviderFacts | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .select()
      .from(gatewayInvoiceProviderFacts)
      .where(
        and(
          eq(gatewayInvoiceProviderFacts.tenantId, tenantId),
          eq(gatewayInvoiceProviderFacts.paymentId, paymentId),
        ),
      )
      .limit(1);
    if (row === undefined) return null;
    return {
      need: row.need as GatewayProviderNeedKind | null,
      remainingAmount: row.remainingAmount,
      remainingCardNumber: row.remainingCardNumber,
      remainingCardHolder: row.remainingCardHolder,
      remainingInvoiceId: row.remainingInvoiceId,
      remainingReceiptReceived: row.remainingReceiptReceived,
      refundAmount: row.refundAmount,
      refundPending: row.refundPending,
      rejectReasons: Array.isArray(row.rejectReasons)
        ? (row.rejectReasons as unknown[]).map(String)
        : [],
    };
  }

  private async withPaymentFacts(
    scope: TenantContext,
    rows: readonly RequestRow[],
    tx: unknown,
  ): Promise<readonly ClaimedProviderRequest[]> {
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
              row: recordOf(row),
              sealed:
                row.refundCardCiphertext !== null && row.refundCardKeyId !== null
                  ? { ciphertext: row.refundCardCiphertext, keyId: row.refundCardKeyId }
                  : null,
              paymentState: fact.state,
              paymentExpiresAt: fact.expiresAt,
              paymentReviewUntil: fact.providerReviewUntil,
            },
          ];
    });
  }
}
