import { alias } from 'drizzle-orm/pg-core';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { money, type Money } from '@nexa/contracts';
import type {
  CurrencyCode,
  LedgerDirection,
  LedgerReason,
  OrderId,
  PaymentId,
  TenantContext,
  UserId,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { customers, walletEntries } from '../../../../infrastructure/persistence/schema.js';
import type {
  WalletAppendResult,
  WalletBalance,
  WalletCursor,
  WalletEntryDraft,
  WalletEntryPage,
  WalletEntryRecord,
  WalletRepository,
} from '../application/ports.js';

/**
 * The wallet ledger, in PostgreSQL.
 *
 * Two things this class does NOT have, and their absence is the design:
 *
 * - **No `update` and no `delete`.** `wallet_entries_no_update` and
 *   `wallet_entries_no_delete` (migration 0033) would reject them anyway, and a method
 *   that always throws is worse than no method: it reads as a capability.
 * - **No balance column to read.** `balanceOf` sums the ledger every time. That is the
 *   whole architecture — `CLAUDE.md`: *"Balance is derived from an append-only ledger.
 *   Never add a balance column."*
 *
 * Every query carries `eq(walletEntries.tenantId, …)`, the reference lookup included,
 * for the reason `drizzle-customer.repository.ts` states: a lookup without the tenant
 * returns another tenant's row and leaves the caller to decide what to do with
 * something it should never have seen. For money that is not a leak, it is a way to
 * spend somebody else's balance.
 */
export class DrizzleWalletRepository implements WalletRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  /**
   * Appends, or returns the entry already written under this reference.
   *
   * `ON CONFLICT DO NOTHING` and then a re-read, rather than a read-then-insert. The
   * difference is the whole point: a read-then-insert has a window between the two in
   * which a concurrent retry inserts, and the loser of that race either throws a raw
   * integrity error at a customer or — worse, if it catches and retries — writes a
   * second movement. The conflict target is
   * `wallet_entries_tenant_reference_key`, which the schema calls *"the one thing that
   * makes a double debit impossible rather than unlikely."*
   *
   * The re-read is scoped and by reference, so what comes back is this tenant's entry
   * under this reference or nothing — never another tenant's row that happened to
   * collide, which cannot occur anyway because the unique index is per tenant.
   */
  async append(
    scope: TenantContext,
    draft: WalletEntryDraft,
    tx?: unknown,
  ): Promise<WalletAppendResult> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .insert(walletEntries)
      .values({
        id: draft.id,
        tenantId,
        customerId: draft.customerId,
        direction: draft.direction,
        reason: draft.reason,
        amount: draft.amount.amountMinor,
        currency: draft.amount.currency,
        reference: draft.reference,
        orderId: draft.orderId ?? null,
        paymentId: draft.paymentId ?? null,
        actorAdminId: draft.actorAdminId ?? null,
        note: draft.note ?? null,
        reversesEntryId: draft.reversesEntryId ?? null,
        createdAt: draft.now,
      })
      .onConflictDoNothing({ target: [walletEntries.tenantId, walletEntries.reference] })
      .returning();

    const written = rows[0];
    // `inserted: true` ONLY when this call wrote the row. The caller emits the domain
    // event on that, so one movement produces one event however many times it is retried.
    if (written !== undefined) return { entry: toRecord(written), inserted: true };

    const existing = await this.findByReference(scope, draft.reference, tx);
    if (existing === null) {
      /*
       * The insert conflicted and the re-read found nothing.
       *
       * Not reachable through the unique index this targets — a conflict means a row
       * with this `(tenant_id, reference)` exists and the re-read is scoped the same
       * way. It IS reachable if a future migration adds a second unique index and this
       * insert starts conflicting on that one instead, which would silently make an
       * append a no-op. Loud, because the alternative is money that quietly did not
       * move.
       */
      throw new Error(
        `wallet entry ${draft.reference} conflicted on insert but could not be re-read; ` +
          'a constraint other than wallet_entries_tenant_reference_key was violated',
      );
    }
    return { entry: existing, inserted: false };
  }

  /**
   * The serialisation point for every movement that has to read before it writes.
   *
   * `SELECT ... FOR UPDATE` on the customer row. The second transaction to ask for it
   * BLOCKS until the first commits, and its balance read then sees the first's entry —
   * which is what makes the sufficiency check a decision rather than an observation of
   * a moment that has passed.
   *
   * It has to be a row that EXISTS: `FOR UPDATE` on a missing row locks nothing and
   * serialises nothing, so this reports whether it found one and the caller refuses when
   * it did not.
   */
  async lockCustomer(scope: TenantContext, customerId: UserId, tx: unknown): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), eq(customers.id, customerId)))
      .for('update');
    return rows.length > 0;
  }

  /**
   * The balance, as a SUM over immutable rows, for ONE currency.
   *
   * The sign is applied in SQL by the same rule `signedMinor` applies in TypeScript,
   * and `wallet-balance.test.ts` asserts the two agree over a matrix — the same
   * two-statements-of-one-rule shape the catalogue predicate uses, and for the same
   * reason: the duplication is only safe while something proves it.
   *
   * `COALESCE(..., 0)` because `SUM` over no rows is NULL, and a customer with no
   * entries has a balance of zero rather than an absence of one.
   *
   * Filtering by currency is not a convenience. Summing across currencies would be an
   * implicit conversion at a rate nobody chose, and no rate exists anywhere in this
   * system — see `WalletBalance`.
   */
  async balanceOf(
    scope: TenantContext,
    customerId: UserId,
    currency: CurrencyCode,
    tx?: unknown,
  ): Promise<WalletBalance> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({
        balance: sql<string>`COALESCE(SUM(CASE WHEN ${walletEntries.direction} = 'CREDIT'
                                               THEN ${walletEntries.amount}
                                               ELSE -${walletEntries.amount} END), 0)`,
        entries: sql<string>`COUNT(*)`,
      })
      .from(walletEntries)
      .where(
        and(
          eq(walletEntries.tenantId, tenantId),
          eq(walletEntries.customerId, customerId),
          eq(walletEntries.currency, currency),
        ),
      );

    const row = rows[0];
    return {
      currency,
      /*
       * `BigInt(string)`, never `Number`.
       *
       * `SUM` over `bigint` returns `numeric`, which `node-postgres` hands back as a
       * STRING — and that is the good case. Routing it through `Number` would silently
       * lose precision past 2^53, which for IRR minor units is a balance an ordinary
       * tenant can reach.
       */
      amountMinor: row === undefined ? 0n : BigInt(row.balance),
      entryCount: row === undefined ? 0 : Number(row.entries),
    };
  }

  /**
   * What ONE payment's credit of one reason put on the wallet, read off the ledger
   * (Payment File 02 §18) — the principal of a top-up (`TOPUP_RECEIPT`, or `TOPUP_GATEWAY`
   * for an external gateway's, WP11A), its gift
   * (`CASHBACK_TOPUP`), or a reviewer's credit of a receipt (`RECEIPT_CREDIT`).
   *
   * A READER for the notification lane, in `refundedForOrder`'s shape and for its reason:
   * the producer passed a kind and a payment id and nothing else (ADR 0030 §1), and the
   * figure is derived from the append-only entries that id names. Each of the three is
   * once-per-payment by a partial unique index, so the sum is that one entry; it is
   * summed anyway, so a figure is never a guess about which row to read.
   *
   * Null when the payment has no such credit: the caller must send nothing rather than a
   * sentence with an empty or zero amount.
   */
  async creditedForPayment(
    scope: TenantContext,
    paymentId: string,
    reasons: readonly Extract<
      LedgerReason,
      'TOPUP_RECEIPT' | 'TOPUP_GATEWAY' | 'CASHBACK_TOPUP' | 'RECEIPT_CREDIT'
    >[],
    tx?: unknown,
  ): Promise<Money | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({
        currency: walletEntries.currency,
        amount: sql<string>`SUM(${walletEntries.amount})::text`,
      })
      .from(walletEntries)
      .where(
        and(
          eq(walletEntries.tenantId, tenantId),
          eq(walletEntries.paymentId, paymentId),
          inArray(walletEntries.reason, [...reasons]),
          eq(walletEntries.direction, 'CREDIT'),
        ),
      )
      .groupBy(walletEntries.currency);
    // One currency per payment: an entry is in its payment's currency. Two would be a
    // ledger this sentence cannot describe, and silence is the honest answer to that.
    const row = rows.length === 1 ? rows[0] : undefined;
    if (row === undefined) return null;
    const amount = BigInt(row.amount);
    return amount > 0n ? money(amount, row.currency as CurrencyCode) : null;
  }

  /**
   * What an order's automatic refund put back, and what the wallet held once it
   * had.
   *
   * Both derived from the append-only ledger and NOTHING stored, which is what
   * lets a message sent a week later state the same two figures it would have
   * stated at the time — and keeps the non-negotiable that a balance is derived
   * and never a column.
   *
   * ## Why not the order total, and why not today's balance
   *
   * The AMOUNT is the sum of the order's own REFUND credits rather than
   * `order.totals.total`, because an operator may already have returned part of
   * a payment by bank transfer; `refundUndeliverable` credits only what is left.
   * The sentence has to name what reached the wallet.
   *
   * The BALANCE is taken as of the last of those credits, not as of now. A
   * customer who has spent money since must not be told the refund produced a
   * balance they never had, and a resend must not disagree with the first copy.
   * `(created_at, id)` is a total order over an immutable table — `id` is uuidv7
   * and nothing updates an entry — and `wallet_entries_customer_created_idx`
   * serves exactly this comparison.
   *
   * Null when the order has no refund credit: nothing was given back, so there
   * is no sentence to send. The caller treats that as a message it must not send
   * rather than as zero, because «۰ تومان بازگردانده شد» is worse than silence.
   */
  async refundedForOrder(
    scope: TenantContext,
    orderId: string,
    tx?: unknown,
  ): Promise<{ readonly amount: Money; readonly balanceAfter: Money } | null> {
    const tenantId = requireTenantId(scope);
    const credit = alias(walletEntries, 'refund_credit');
    const rows = await this.exec(tx)
      .select({
        currency: credit.currency,
        customerId: credit.customerId,
        createdAt: credit.createdAt,
        id: credit.id,
        /*
         * Summed in the same statement that finds the latest one, so the two
         * cannot describe different sets. A correlated subquery rather than two
         * round trips: the second read could see a credit the first did not.
         */
        refunded: sql<string>`COALESCE((
          SELECT SUM(${walletEntries.amount}) FROM ${walletEntries}
           WHERE ${walletEntries.tenantId} = ${tenantId}
             AND ${walletEntries.orderId} = ${orderId}
             AND ${walletEntries.reason} = 'REFUND'
             AND ${walletEntries.direction} = 'CREDIT'
             AND ${walletEntries.currency} = ${credit.currency}
        ), 0)`,
        balance: sql<string>`COALESCE((
          SELECT SUM(CASE WHEN ${walletEntries.direction} = 'CREDIT'
                          THEN ${walletEntries.amount}
                          ELSE -${walletEntries.amount} END)
            FROM ${walletEntries}
           WHERE ${walletEntries.tenantId} = ${tenantId}
             AND ${walletEntries.customerId} = ${credit.customerId}
             AND ${walletEntries.currency} = ${credit.currency}
             AND (${walletEntries.createdAt}, ${walletEntries.id})
                 <= (${credit.createdAt}, ${credit.id})
        ), 0)`,
      })
      .from(credit)
      .where(
        and(
          eq(credit.tenantId, tenantId),
          eq(credit.orderId, orderId),
          eq(credit.reason, 'REFUND'),
          eq(credit.direction, 'CREDIT'),
        ),
      )
      // The LAST credit, so a refund written as two entries reports the balance
      // after both rather than after the first.
      .orderBy(desc(credit.createdAt), desc(credit.id))
      .limit(1);

    const row = rows[0];
    if (row === undefined) return null;
    const currency = row.currency as CurrencyCode;
    // `BigInt(string)`, for the reason `balanceOf` above states at length.
    return {
      amount: money(BigInt(row.refunded), currency),
      balanceAfter: money(BigInt(row.balance), currency),
    };
  }

  /**
   * A page of history, newest first, over the immutable `(createdAt, id)` key.
   *
   * DESCENDING, unlike `/products` and `/users`: a ledger is read from the newest
   * movement backwards, which is what an operator answering "what just happened to
   * this customer's money" is doing. The keyset is over immutable columns — an entry
   * cannot be updated, so a cursor into this table can never be invalidated by an
   * edit, which is a property the mutable-`sort_order` keyset migration 0026 retired
   * did not have.
   */
  async list(
    scope: TenantContext,
    customerId: UserId,
    currency: CurrencyCode,
    limit: number,
    cursor: WalletCursor | null,
    tx?: unknown,
  ): Promise<WalletEntryPage> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select(columns())
      .from(walletEntries)
      .where(
        and(
          eq(walletEntries.tenantId, tenantId),
          eq(walletEntries.customerId, customerId),
          // The SAME predicate `balanceOf` applies. Without it this page listed entries
          // in every currency under a balance computed from one of them, so a tenant
          // that changed `sales.currency` showed «موجودی: ۰» above a table of movements.
          eq(walletEntries.currency, currency),
          ...(cursor === null ? [] : [beforeCursor(cursor)]),
        ),
      )
      .orderBy(desc(walletEntries.createdAt), desc(walletEntries.id))
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    // The cursor is read from the ROW, not from the mapped record: `createdAtText` is
    // the rendered microsecond text and a `WalletEntryRecord` deliberately carries only
    // the `Date`. See `columns()`.
    const last = page[page.length - 1];
    return {
      items: page.map(toRecord),
      nextCursor:
        rows.length > limit && last !== undefined
          ? { createdAt: last.createdAtText, id: last.id }
          : null,
    };
  }

  async findByReference(
    scope: TenantContext,
    reference: string,
    tx?: unknown,
  ): Promise<WalletEntryRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select(columns())
      .from(walletEntries)
      .where(and(eq(walletEntries.tenantId, tenantId), eq(walletEntries.reference, reference)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }
}

/** Strictly older than the cursor, in the DESCENDING order the list uses. */
function beforeCursor(cursor: WalletCursor) {
  const at = sql`${cursor.createdAt}::timestamptz`;
  return or(
    sql`${walletEntries.createdAt} < ${at}`,
    and(sql`${walletEntries.createdAt} = ${at}`, sql`${walletEntries.id} < ${cursor.id}`),
  );
}

function columns() {
  return {
    id: walletEntries.id,
    /*
     * PostgreSQL's own microsecond text, rendered by `to_char` rather than read back
     * through the driver.
     *
     * A JavaScript `Date` holds milliseconds and `timestamptz` holds microseconds, so
     * formatting a cursor through `Date` truncates — and two entries a microsecond
     * apart inside one millisecond would then straddle the cursor, showing one twice
     * and hiding the other. The application writes millisecond `Date`s today, so the
     * truncation would be invisible until the first row written by a backfill or by
     * SQL. The same rule `CustomerCursor` records.
     */
    createdAtText: sql<string>`to_char(${walletEntries.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    customerId: walletEntries.customerId,
    direction: walletEntries.direction,
    reason: walletEntries.reason,
    amount: walletEntries.amount,
    currency: walletEntries.currency,
    reference: walletEntries.reference,
    reversesEntryId: walletEntries.reversesEntryId,
    orderId: walletEntries.orderId,
    paymentId: walletEntries.paymentId,
    actorAdminId: walletEntries.actorAdminId,
    note: walletEntries.note,
    createdAt: walletEntries.createdAt,
  };
}

type Row = {
  id: string;
  customerId: string;
  direction: string;
  reason: string;
  amount: bigint;
  currency: string;
  reference: string;
  reversesEntryId: string | null;
  orderId: string | null;
  paymentId: string | null;
  actorAdminId: string | null;
  note: string | null;
  createdAt: Date;
};

function toRecord(row: Row): WalletEntryRecord {
  return {
    id: row.id,
    customerId: row.customerId as UserId,
    direction: row.direction as LedgerDirection,
    reason: row.reason as LedgerReason,
    // Reassembled as ONE value, so nothing downstream can read an amount without its
    // currency. Both columns are NOT NULL, so there is no half-amount to represent.
    amount: money(row.amount, row.currency as CurrencyCode),
    reference: row.reference,
    reversesEntryId: row.reversesEntryId,
    orderId: row.orderId as OrderId | null,
    paymentId: row.paymentId as PaymentId | null,
    actorAdminId: row.actorAdminId,
    note: row.note,
    createdAt: row.createdAt,
  };
}
