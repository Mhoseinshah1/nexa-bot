import type {
  CurrencyCode,
  LedgerDirection,
  LedgerReason,
  Money,
  OrderId,
  PaymentId,
  TenantContext,
  UserId,
} from '@nexa/contracts';

/**
 * One ledger entry, as the application layer sees it.
 *
 * Every field is immutable and the database enforces it: `wallet_entries_no_update`
 * and `wallet_entries_no_delete` (migration 0033) reject both from application code.
 * There is no `update` on the repository below and there is no place to add one.
 */
export interface WalletEntryRecord {
  readonly id: string;
  readonly customerId: UserId;
  readonly direction: LedgerDirection;
  readonly reason: LedgerReason;
  /**
   * POSITIVE, always, with the sign carried by `direction`.
   *
   * A `Money` rather than a bare bigint so an amount cannot travel without its
   * currency — the defect that runs through the whole legacy financial surface, where
   * no exchange rate exists on any of seven gateways and Toman is implicit everywhere.
   */
  readonly amount: Money;
  /**
   * The movement's idempotency identity, unique per tenant.
   *
   * `wallet_entries_tenant_reference_key` is what makes a double debit impossible
   * rather than unlikely — the schema's own words. It is derived from the command's
   * idempotency key, never generated, so two replicas racing one retry compute the
   * same value without talking to each other.
   */
  readonly reference: string;
  readonly reversesEntryId: string | null;
  readonly orderId: OrderId | null;
  readonly paymentId: PaymentId | null;
  /** Set when an administrator caused it. Absent for a flow. */
  readonly actorAdminId: string | null;
  readonly note: string | null;
  readonly createdAt: Date;
}

/** What an append needs. No `id` for the caller to reuse and no `createdAt` to backdate. */
export interface WalletEntryDraft {
  readonly id: string;
  readonly customerId: UserId;
  readonly direction: LedgerDirection;
  readonly reason: LedgerReason;
  readonly amount: Money;
  readonly reference: string;
  readonly orderId?: OrderId | null;
  readonly paymentId?: PaymentId | null;
  readonly actorAdminId?: string | null;
  readonly note?: string | null;
  readonly now: Date;
}

/**
 * A balance, and the facts it was derived from.
 *
 * **Per CURRENCY, and that is not a detail.** Summing entries of different currencies
 * would be an implicit conversion at a rate nobody chose, and no conversion is frozen
 * anywhere in this system: the research found NO exchange rate and NO currency
 * selector on any of the seven gateways it inspected (`FBR-010`). So a balance is
 * always asked for in one currency and answers only about that currency.
 *
 * `entryCount` is how many entries produced it. A balance that cannot say what it was
 * derived from is the legacy summary that leaves 916,550 unexplained.
 */
export interface WalletBalance {
  readonly currency: CurrencyCode;
  readonly amountMinor: bigint;
  readonly entryCount: number;
}

/** `(createdAt, id)` — immutable columns, so a keyset over them is a stable traversal. */
export interface WalletCursor {
  /** PostgreSQL's own microsecond text, never a `Date`. See `CustomerCursor`. */
  readonly createdAt: string;
  readonly id: string;
}

/**
 * An append, and whether it actually WROTE.
 *
 * `inserted` exists so a caller can emit `WalletEntryRecorded` exactly when a movement
 * happened. Without it a retry that re-read an existing entry would emit the event
 * again — one movement, two events, and a consumer that acts per event acting twice.
 * That path is not hypothetical: `WalletService.adjust` documents reaching it when an
 * idempotency row has outlived its entry, which a restore can produce.
 */
export interface WalletAppendResult {
  readonly entry: WalletEntryRecord;
  readonly inserted: boolean;
}

export interface WalletEntryPage {
  readonly items: readonly WalletEntryRecord[];
  readonly nextCursor: WalletCursor | null;
}

export interface WalletRepository {
  /**
   * Appends an entry, or returns the one already written under this reference.
   *
   * IDEMPOTENT at the database, not in a process: the insert is an
   * `ON CONFLICT (tenant_id, reference) DO NOTHING`, and a conflict re-reads. That is
   * what makes a retry, a double-click and two replicas produce one movement —
   * `CLAUDE.md` records the same reasoning for the backup lease, and the alternative
   * (a read-then-insert) loses the race it exists to win.
   */
  append(scope: TenantContext, draft: WalletEntryDraft, tx?: unknown): Promise<WalletAppendResult>;

  /**
   * Takes the customer's row `FOR UPDATE`, so a balance read after it is a DECISION.
   *
   * Without this, two debits cannot see each other and both commit. The ledger is
   * APPEND-ONLY, so there is no shared row for two appends to contend on: under
   * PostgreSQL's default READ COMMITTED a `SELECT SUM(...)` does not block on another
   * transaction's uncommitted INSERT, so each sums a balance that omits the other,
   * each decides it can cover, and the wallet goes negative. `WALLET_ALLOWS_NEGATIVE_BALANCE`
   * is `false` and was not actually enforced under concurrency until this existed.
   *
   * The CUSTOMER row is the lock, for the reason the tenant row lock exists in the
   * dispatcher: it is a row that already exists, every movement of this wallet names
   * it, and `payments_customer_fk` guarantees it. An advisory lock would work equally
   * well and be invisible to anyone reading the schema.
   *
   * Returns false when the customer does not exist — `FOR UPDATE` on a missing row
   * locks NOTHING, which `drizzle-login-throttle.repository.ts` records as the way
   * this pattern silently stops serialising.
   */
  lockCustomer(scope: TenantContext, customerId: UserId, tx: unknown): Promise<boolean>;

  /**
   * The balance, derived by summing the ledger. There is nothing else to read.
   *
   * `CLAUDE.md`: *"Balance is derived from an append-only ledger. Never add a balance
   * column."* `wallet_entries_customer_created_idx` exists for exactly this — its own
   * comment says the sum reads the whole of a customer's slice and the page reads the
   * tail of it, so one index serves both.
   */
  balanceOf(
    scope: TenantContext,
    customerId: UserId,
    currency: CurrencyCode,
    tx?: unknown,
  ): Promise<WalletBalance>;

  list(
    scope: TenantContext,
    customerId: UserId,
    limit: number,
    cursor: WalletCursor | null,
    tx?: unknown,
  ): Promise<WalletEntryPage>;

  findByReference(
    scope: TenantContext,
    reference: string,
    tx?: unknown,
  ): Promise<WalletEntryRecord | null>;
}
