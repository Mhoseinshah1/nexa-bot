import { and, desc, eq, or, sql } from 'drizzle-orm';
import { money } from '@nexa/contracts';
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
