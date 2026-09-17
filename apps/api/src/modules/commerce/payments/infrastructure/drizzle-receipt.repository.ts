import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type {
  BotInstanceId,
  PaymentId,
  PaymentReceiptId,
  PaymentReceiptKind,
  ReceiptCaptureCloseReason,
  ReceiptCaptureId,
  TenantContext,
  UserId,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  paymentReceipts,
  payments,
  receiptCaptures,
} from '../../../../infrastructure/persistence/schema.js';
import type {
  InboundReceiptFile,
  PaymentReceiptRecord,
  PaymentReceiptRepository,
  ReceiptCaptureRecord,
  ReceiptCaptureRepository,
} from '../application/receipt-ports.js';

/**
 * The advisory-lock CLASS for a customer's receipt work.
 *
 * Its own class, distinct from `PAYMENT_ACCOUNT_LOCK_CLASS`, so two locks about
 * different subjects cannot collide however their object keys are derived. Exported so
 * the integration test can watch `pg_locks` for waiters on exactly this key, which is
 * what makes the interleaving test deterministic rather than a sleep.
 */
export const RECEIPT_CAPTURE_LOCK_CLASS = 0x5243;

/**
 * The upload window, in PostgreSQL.
 *
 * Every query carries the tenant, the primary-key lookups included, for the reason the
 * product repository states: a lookup without it returns another tenant's row.
 */
export class DrizzleReceiptCaptureRepository implements ReceiptCaptureRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async lockForCustomer(
    scope: TenantContext,
    botInstanceId: BotInstanceId,
    customerId: UserId,
    tx: unknown,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    /*
     * One text key built from the three ids, hashed to the int4 the two-argument form
     * takes. The TENANT is in the key even though the bot id is already unique, because
     * a lock that a tenant id cannot be read out of is a lock whose collisions cross
     * tenants — the same reasoning `lockForCreate` states.
     */
    await this.exec(tx).execute(
      sql`SELECT pg_advisory_xact_lock(${RECEIPT_CAPTURE_LOCK_CLASS},
            hashtext(${`${tenantId}:${botInstanceId}:${customerId}`}))`,
    );
  }

  async open(
    scope: TenantContext,
    input: {
      readonly id: ReceiptCaptureId;
      readonly botInstanceId: BotInstanceId;
      readonly customerId: UserId;
      readonly paymentId: PaymentId;
      readonly openedAt: Date;
      readonly expiresAt: Date;
    },
    tx: unknown,
  ): Promise<ReceiptCaptureRecord> {
    const tenantId = requireTenantId(scope);
    /*
     * Close first, then open, in the caller's transaction.
     *
     * `receipt_captures_open_key` refuses a second open row, so these cannot be two
     * commits: between them the customer would have no window, and the tap that asked
     * for one has already been answered.
     *
     * The reason is DERIVED from the row being closed rather than fixed at
     * `SUPERSEDED`, because the two cases are things an operator needs to tell apart
     * and the row is the only place they are recorded. A window whose deadline had
     * already passed was not superseded by anything — nobody sent a receipt in time —
     * and this is where that becomes `EXPIRED`. A refusal cannot record it: a refusal
     * throws and a throw rolls its own transaction back, so `ReceiptService.submit`
     * compares `expires_at` to the clock and writes nothing, and the next tap is what
     * stamps the row.
     */
    await this.exec(tx)
      .update(receiptCaptures)
      .set({
        closedAt: input.openedAt,
        closeReason: sql`CASE WHEN ${receiptCaptures.expiresAt} <= ${input.openedAt} THEN 'EXPIRED' ELSE 'SUPERSEDED' END`,
      })
      .where(
        and(
          eq(receiptCaptures.tenantId, tenantId),
          eq(receiptCaptures.botInstanceId, input.botInstanceId),
          eq(receiptCaptures.customerId, input.customerId),
          isNull(receiptCaptures.closedAt),
        ),
      );

    const rows = await this.exec(tx)
      .insert(receiptCaptures)
      .values({
        id: input.id,
        tenantId,
        botInstanceId: input.botInstanceId,
        customerId: input.customerId,
        paymentId: input.paymentId,
        openedAt: input.openedAt,
        expiresAt: input.expiresAt,
      })
      .returning({
        id: receiptCaptures.id,
        botInstanceId: receiptCaptures.botInstanceId,
        customerId: receiptCaptures.customerId,
        paymentId: receiptCaptures.paymentId,
        openedAt: receiptCaptures.openedAt,
        expiresAt: receiptCaptures.expiresAt,
      });
    const row = rows[0];
    if (row === undefined) throw new Error('receipt_captures insert returned no row.');
    return {
      id: row.id as ReceiptCaptureId,
      botInstanceId: row.botInstanceId as BotInstanceId,
      customerId: row.customerId as UserId,
      paymentId: row.paymentId as PaymentId,
      openedAt: row.openedAt,
      expiresAt: row.expiresAt,
    };
  }

  async findOpen(
    scope: TenantContext,
    botInstanceId: BotInstanceId,
    customerId: UserId,
    tx?: unknown,
  ): Promise<ReceiptCaptureRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({
        id: receiptCaptures.id,
        botInstanceId: receiptCaptures.botInstanceId,
        customerId: receiptCaptures.customerId,
        paymentId: receiptCaptures.paymentId,
        openedAt: receiptCaptures.openedAt,
        expiresAt: receiptCaptures.expiresAt,
      })
      .from(receiptCaptures)
      .where(
        and(
          eq(receiptCaptures.tenantId, tenantId),
          eq(receiptCaptures.botInstanceId, botInstanceId),
          eq(receiptCaptures.customerId, customerId),
          isNull(receiptCaptures.closedAt),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row === undefined
      ? null
      : {
          id: row.id as ReceiptCaptureId,
          botInstanceId: row.botInstanceId as BotInstanceId,
          customerId: row.customerId as UserId,
          paymentId: row.paymentId as PaymentId,
          openedAt: row.openedAt,
          expiresAt: row.expiresAt,
        };
  }

  async close(
    scope: TenantContext,
    id: ReceiptCaptureId,
    reason: ReceiptCaptureCloseReason,
    at: Date,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    /*
     * Conditional on `closed_at IS NULL`, so two photos arriving together produce ONE
     * close. The caller reads false as "somebody else already closed it", which is not
     * an error and not a second decision.
     */
    const rows = await this.exec(tx)
      .update(receiptCaptures)
      .set({ closedAt: at, closeReason: reason })
      .where(
        and(
          eq(receiptCaptures.tenantId, tenantId),
          eq(receiptCaptures.id, id),
          isNull(receiptCaptures.closedAt),
        ),
      )
      .returning({ id: receiptCaptures.id });
    return rows.length > 0;
  }
}

/** The receipts themselves. Insert and select only: the table refuses the rest (0066). */
export class DrizzlePaymentReceiptRepository implements PaymentReceiptRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async attach(
    scope: TenantContext,
    input: {
      readonly id: PaymentReceiptId;
      readonly botInstanceId: BotInstanceId;
      readonly customerId: UserId;
      readonly paymentId: PaymentId;
      readonly file: InboundReceiptFile;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<PaymentReceiptRecord | null> {
    const tenantId = requireTenantId(scope);
    /*
     * `ON CONFLICT DO NOTHING` on `payment_receipts_file_key`, which returns no row when
     * that exact file is already filed. A redelivered Telegram update is not an error
     * and the customer's answer is the same either way, so the caller reads null as
     * "already have it" rather than as a failure.
     */
    const rows = await this.exec(tx)
      .insert(paymentReceipts)
      .values({
        id: input.id,
        tenantId,
        botInstanceId: input.botInstanceId,
        customerId: input.customerId,
        paymentId: input.paymentId,
        kind: input.file.kind,
        fileId: input.file.fileId,
        fileUniqueId: input.file.fileUniqueId,
        mimeType: input.file.mimeType,
        fileSize: input.file.fileSize,
        fileName: input.file.fileName,
        telegramMessageId: input.file.telegramMessageId,
        createdAt: input.now,
      })
      .onConflictDoNothing()
      .returning(RECEIPT_COLUMNS);
    const row = rows[0];
    return row === undefined ? null : toReceipt(row);
  }

  async countForPayment(scope: TenantContext, paymentId: PaymentId, tx: unknown): Promise<number> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ n: sql<number>`count(*)::int` })
      .from(paymentReceipts)
      .where(and(eq(paymentReceipts.tenantId, tenantId), eq(paymentReceipts.paymentId, paymentId)));
    return rows[0]?.n ?? 0;
  }

  async listForPayment(
    scope: TenantContext,
    paymentId: PaymentId,
    tx?: unknown,
  ): Promise<readonly PaymentReceiptRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select(RECEIPT_COLUMNS)
      .from(paymentReceipts)
      .where(and(eq(paymentReceipts.tenantId, tenantId), eq(paymentReceipts.paymentId, paymentId)))
      .orderBy(asc(paymentReceipts.createdAt), asc(paymentReceipts.id));
    return rows.map(toReceipt);
  }

  async pendingForReview(
    scope: TenantContext,
    limit: number,
    tx?: unknown,
  ): Promise<readonly { readonly paymentId: PaymentId; readonly held: number }[]> {
    const tenantId = requireTenantId(scope);
    /*
     * One statement, joined to `payments` so the STATE is part of the predicate rather
     * than something the caller filters afterwards. `min(payments.created_at)` orders
     * the queue by when the customer started waiting; the group is what turns three
     * receipts on one payment into one row to review.
     */
    const rows = await this.exec(tx)
      .select({
        paymentId: paymentReceipts.paymentId,
        held: sql<number>`count(*)::int`,
        oldest: sql<Date>`min(${payments.createdAt})`,
      })
      .from(paymentReceipts)
      .innerJoin(
        payments,
        and(
          eq(payments.tenantId, paymentReceipts.tenantId),
          eq(payments.id, paymentReceipts.paymentId),
        ),
      )
      .where(
        and(
          eq(paymentReceipts.tenantId, tenantId),
          eq(payments.state, 'PENDING'),
          eq(payments.method, 'MANUAL_TRANSFER'),
        ),
      )
      .groupBy(paymentReceipts.paymentId)
      .orderBy(asc(sql`min(${payments.createdAt})`), asc(paymentReceipts.paymentId))
      .limit(limit);

    return rows.map((row) => ({ paymentId: row.paymentId as PaymentId, held: Number(row.held) }));
  }

  async findById(
    scope: TenantContext,
    id: PaymentReceiptId,
    tx?: unknown,
  ): Promise<PaymentReceiptRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select(RECEIPT_COLUMNS)
      .from(paymentReceipts)
      .where(and(eq(paymentReceipts.tenantId, tenantId), eq(paymentReceipts.id, id)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toReceipt(row);
  }
}

const RECEIPT_COLUMNS = {
  id: paymentReceipts.id,
  paymentId: paymentReceipts.paymentId,
  botInstanceId: paymentReceipts.botInstanceId,
  customerId: paymentReceipts.customerId,
  kind: paymentReceipts.kind,
  fileId: paymentReceipts.fileId,
  fileUniqueId: paymentReceipts.fileUniqueId,
  mimeType: paymentReceipts.mimeType,
  fileSize: paymentReceipts.fileSize,
  fileName: paymentReceipts.fileName,
  createdAt: paymentReceipts.createdAt,
} as const;

interface ReceiptRow {
  readonly id: string;
  readonly paymentId: string;
  readonly botInstanceId: string;
  readonly customerId: string;
  readonly kind: string;
  readonly fileId: string;
  readonly fileUniqueId: string;
  readonly mimeType: string | null;
  readonly fileSize: bigint | null;
  readonly fileName: string | null;
  readonly createdAt: Date;
}

function toReceipt(row: ReceiptRow): PaymentReceiptRecord {
  return {
    id: row.id as PaymentReceiptId,
    paymentId: row.paymentId as PaymentId,
    botInstanceId: row.botInstanceId as BotInstanceId,
    customerId: row.customerId as UserId,
    // The CHECK constraint is what makes this cast safe; the column is a closed set.
    kind: row.kind as PaymentReceiptKind,
    fileId: row.fileId,
    fileUniqueId: row.fileUniqueId,
    mimeType: row.mimeType,
    fileSize: row.fileSize,
    fileName: row.fileName,
    createdAt: row.createdAt,
  };
}
