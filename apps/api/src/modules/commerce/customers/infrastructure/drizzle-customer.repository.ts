import { and, asc, eq, getTableColumns, gt, or, sql, type SQL } from 'drizzle-orm';
import type { CustomerStatus, UserId } from '@nexa/contracts';
import type { BotInstanceId, ScopeContext, TenantContext } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import { requireTenantId } from '../../../../infrastructure/persistence/unit-of-work.js';
import { customers } from '../../../../infrastructure/persistence/schema.js';
import type {
  CustomerCursor,
  CustomerPage,
  CustomerRecord,
  CustomerRepository,
  CustomerResolution,
  CustomerSearch,
} from '../application/ports.js';

/**
 * Customers, in PostgreSQL.
 *
 * Every query has `eq(customers.tenantId, …)` in its WHERE clause, including the
 * primary-key lookups. That is not redundant: a primary-key lookup without the tenant
 * returns another tenant's row, and the caller then decides what to do with something
 * it should never have seen. Filtering in the query means the row never leaves the
 * database, so there is no later check to forget — the same reasoning
 * `drizzle-panel.repository.ts` states.
 */
export class DrizzleCustomerRepository implements CustomerRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as Executor | undefined) ?? this.db;
  }

  /**
   * Find-or-create in ONE statement.
   *
   * `ON CONFLICT (tenant_id, telegram_user_id) DO UPDATE` is what makes two concurrent
   * first `/start` commands safe with no lock and no retry: both insert, one conflicts,
   * and the conflicting one takes the update branch and returns the winner's row.
   *
   * `xmax = 0` is how the statement reports which branch ran. It is a system column
   * Postgres sets on a row an UPDATE touched, so zero means "this row came from the
   * INSERT". The alternative — comparing the returned id to the one offered — would be
   * wrong for a second call from the same process that happened to pass the same id.
   *
   * `status` is deliberately absent from the DO UPDATE list. A metadata refresh is not
   * a review of an operator's block, and a path that quietly unblocked on `/start`
   * would be a block that any customer could lift.
   */
  async resolve(
    scope: TenantContext,
    input: {
      readonly id: UserId;
      readonly telegramUserId: string;
      readonly profile: {
        readonly username: string | null;
        readonly firstName: string | null;
        readonly lastName: string | null;
        readonly languageCode: string | null;
      };
      readonly botInstanceId: BotInstanceId;
      readonly now: Date;
    },
    tx?: unknown,
  ): Promise<CustomerResolution> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .insert(customers)
      .values({
        id: input.id,
        tenantId,
        telegramUserId: input.telegramUserId,
        username: input.profile.username,
        firstName: input.profile.firstName,
        lastName: input.profile.lastName,
        languageCode: input.profile.languageCode,
        status: 'ACTIVE',
        firstBotInstanceId: input.botInstanceId,
        firstSeenAt: input.now,
        lastSeenAt: input.now,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoUpdate({
        target: [customers.tenantId, customers.telegramUserId],
        set: {
          username: input.profile.username,
          firstName: input.profile.firstName,
          lastName: input.profile.lastName,
          languageCode: input.profile.languageCode,
          lastSeenAt: input.now,
          updatedAt: input.now,
        },
      })
      .returning({
        ...getTableColumns(customers),
        /** Zero when this row came from the INSERT. See the docblock. */
        insertedByThisStatement: sql<boolean>`(xmax = 0)`,
      });

    const first = rows[0];
    if (first === undefined) {
      // Unreachable: an upsert with a DO UPDATE branch always returns a row. Stated
      // rather than non-null-asserted, because a silent `undefined` here would surface
      // as a missing customer on the one path that must not have one.
      throw new Error('the customer upsert returned no row');
    }
    return { customer: toRecord(first), created: first.insertedByThisStatement === true };
  }

  async findById(scope: ScopeContext, id: UserId, tx?: unknown): Promise<CustomerRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), eq(customers.id, id)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async findByTelegramId(
    scope: TenantContext,
    telegramUserId: string,
    tx?: unknown,
  ): Promise<CustomerRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), eq(customers.telegramUserId, telegramUserId)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  /**
   * One page, by keyset.
   *
   * `limit + 1` rows are read and the extra one is discarded, which is how the page
   * knows whether there is a next one without a second COUNT. The cursor comparison is
   * the lexicographic `(created_at, id) > (c, i)` written out, because a tuple
   * comparison and an `OR` of two predicates index differently and the index declared
   * for this is `(tenant_id, created_at, id)`.
   */
  async list(
    scope: TenantContext,
    search: CustomerSearch,
    limit: number,
    cursor: CustomerCursor | null,
    tx?: unknown,
  ): Promise<CustomerPage> {
    const tenantId = requireTenantId(scope);
    const conditions: SQL[] = [eq(customers.tenantId, tenantId)];

    if (search.telegramUserId !== undefined) {
      // Exact. A prefix match here would be a way to enumerate Telegram ids.
      conditions.push(eq(customers.telegramUserId, search.telegramUserId));
    }
    if (search.usernamePrefix !== undefined && search.usernamePrefix !== '') {
      // The expression index on `lower(username)` is what this uses, so the comparison
      // is written to match it exactly. `like` with a bound parameter, and the pattern
      // built from an escaped needle: a username containing `%` would otherwise match
      // everything.
      const needle = search.usernamePrefix.toLowerCase().replace(/[\\%_]/g, '\\$&');
      conditions.push(sql`lower(${customers.username}) like ${`${needle}%`}`);
    }
    if (search.status !== undefined) {
      conditions.push(eq(customers.status, search.status));
    }
    if (cursor !== null) {
      conditions.push(
        or(
          gt(customers.createdAt, cursor.createdAt),
          and(eq(customers.createdAt, cursor.createdAt), gt(customers.id, cursor.id)) as SQL,
        ) as SQL,
      );
    }

    const rows = await this.exec(tx)
      .select()
      .from(customers)
      .where(and(...conditions))
      .orderBy(asc(customers.createdAt), asc(customers.id))
      .limit(limit + 1);

    const items = rows.slice(0, limit).map(toRecord);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor:
        rows.length > limit && last !== undefined
          ? { createdAt: last.createdAt, id: last.id }
          : null,
    };
  }

  /**
   * A conditional UPDATE naming the state it expects to find.
   *
   * `WHERE status = from` is the whole mechanism. Two operators pressing Block at once,
   * or one pressing it twice, produce one row change and one `false` — and the `false`
   * is a successful no-op, not an error, because the end state the caller asked for is
   * the end state that holds.
   */
  async setStatus(
    scope: TenantContext,
    id: UserId,
    from: CustomerStatus,
    to: CustomerStatus,
    reason: string | null,
    now: Date,
    tx?: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(customers)
      .set({
        status: to,
        // The CHECK constraint requires the time and the status to agree, so they are
        // set together rather than in two statements that could be separated later.
        blockedAt: to === 'BLOCKED' ? now : null,
        blockedReason: to === 'BLOCKED' ? reason : null,
        updatedAt: now,
      })
      .where(
        and(eq(customers.tenantId, tenantId), eq(customers.id, id), eq(customers.status, from)),
      )
      .returning({ id: customers.id });
    return rows.length > 0;
  }
}

function toRecord(row: typeof customers.$inferSelect): CustomerRecord {
  return {
    id: row.id as UserId,
    telegramUserId: row.telegramUserId,
    username: row.username,
    firstName: row.firstName,
    lastName: row.lastName,
    languageCode: row.languageCode,
    status: row.status as CustomerStatus,
    firstBotInstanceId: row.firstBotInstanceId as BotInstanceId | null,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    blockedAt: row.blockedAt,
    blockedReason: row.blockedReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
