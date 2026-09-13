import type {
  CustomerProfileFacts,
  CustomerStatus,
  ScopeContext,
  TenantContext,
  UserId,
  BotInstanceId,
} from '@nexa/contracts';

/**
 * What a customer row looks like to the application layer.
 *
 * No Telegram update, no message text, no raw `from` object. The repository hands
 * back facts; the surface that produced them does not leak past the boundary.
 */
export interface CustomerRecord {
  readonly id: UserId;
  readonly telegramUserId: string;
  readonly username: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly languageCode: string | null;
  readonly status: CustomerStatus;
  readonly firstBotInstanceId: BotInstanceId | null;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly blockedAt: Date | null;
  readonly blockedReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * The outcome of resolving a customer from an inbound update.
 *
 * `created` is a fact about this call, not about the row: two concurrent first
 * `/start` commands both want to create, one wins the unique index, and the loser
 * must report `created: false` rather than failing. The surface uses it to pick a
 * greeting, so getting it wrong greets a returning customer as new — harmless — or
 * fails an update Telegram then redelivers, which is not.
 */
export interface CustomerResolution {
  readonly customer: CustomerRecord;
  readonly created: boolean;
}

/**
 * A page of customers, keyset-paginated.
 *
 * The cursor is `(createdAt, id)` and never a mutable column: `panels` learned that
 * the hard way in 0026, where a keyset on an editable name could not order a stable
 * traversal. A customer's username is editable by the customer themselves, which is
 * worse.
 */
export interface CustomerCursor {
  /**
   * The stored `created_at`, as PostgreSQL's OWN text, NEVER as a `Date`.
   *
   * The same rule `PanelCursor` states, for the same measured reason:
   * `timestamptz` keeps microseconds and a JavaScript `Date` keeps milliseconds,
   * and the driver TRUNCATES rather than rounds. A cursor built from a `Date` is
   * therefore strictly BELOW the row it was built from whenever that row's
   * microseconds are non-zero, so the tuple comparison lets that row back in —
   * one duplicate per page boundary, and at `limit=1` a traversal that never
   * ends because every page hands back the same cursor.
   *
   * `customers.created_at` is written by the service from a millisecond
   * `Clock.now()` today, so the rows with microseconds are the ones a restore,
   * an import, a fixture or an ops script created. That is exactly the set
   * nobody would think to test, which is why the cursor does not depend on the
   * writer's precision at all.
   *
   * Rendered by `to_char` and compared with an explicit `::timestamptz`, so the
   * value that comes out is the value that goes back in.
   */
  readonly createdAt: string;
  readonly id: UserId;
}

export interface CustomerPage {
  readonly items: readonly CustomerRecord[];
  readonly nextCursor: CustomerCursor | null;
}

/**
 * How an operator narrowed the list.
 *
 * `telegramUserId` is an EXACT match and `username` is a case-insensitive prefix.
 * The asymmetry is deliberate: a Telegram id is quoted verbatim from a support
 * conversation, so a partial match would be a way to enumerate ids, while a username
 * is half-remembered and a prefix is what an operator actually has.
 */
export interface CustomerSearch {
  readonly telegramUserId?: string;
  readonly usernamePrefix?: string;
  readonly status?: CustomerStatus;
}

export interface CustomerRepository {
  /**
   * Find-or-create by `(tenant_id, telegram_user_id)`, refreshing the profile and
   * `last_seen_at`.
   *
   * One statement, not a read followed by a write: `INSERT … ON CONFLICT … DO UPDATE`
   * is what makes two concurrent first `/start` commands safe without a lock. A
   * read-then-write would have both read nothing and both insert, and the loser would
   * surface a unique violation on a path that must answer 200.
   *
   * **Never changes `status`.** A block is an operator decision and a metadata refresh
   * is not a review of it; the legacy system's "re-adding an admin returns success and
   * writes nothing" is the same class of silent state change in the other direction.
   */
  resolve(
    scope: TenantContext,
    input: {
      readonly id: UserId;
      readonly telegramUserId: string;
      readonly profile: CustomerProfileFacts;
      readonly botInstanceId: BotInstanceId;
      readonly now: Date;
    },
    tx?: unknown,
  ): Promise<CustomerResolution>;

  findById(scope: ScopeContext, id: UserId, tx?: unknown): Promise<CustomerRecord | null>;

  findByTelegramId(
    scope: TenantContext,
    telegramUserId: string,
    tx?: unknown,
  ): Promise<CustomerRecord | null>;

  list(
    scope: TenantContext,
    search: CustomerSearch,
    limit: number,
    cursor: CustomerCursor | null,
    tx?: unknown,
  ): Promise<CustomerPage>;

  /**
   * Sets the status, and returns whether the row actually moved.
   *
   * A conditional UPDATE naming the `from` status, which is the mechanism ADR-0028
   * records for recovery state: it makes a replay, a double-click and two replicas all
   * safe without a lock, and there is no `setStatus` that would quietly remove it from
   * all three. `false` means the row was already in the target state — which is a
   * successful no-op for an idempotent command, not a failure.
   */
  setStatus(
    scope: TenantContext,
    id: UserId,
    from: CustomerStatus,
    to: CustomerStatus,
    reason: string | null,
    now: Date,
    tx?: unknown,
  ): Promise<boolean>;
}
