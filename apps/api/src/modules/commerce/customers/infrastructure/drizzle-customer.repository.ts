import { and, asc, eq, getTableColumns, sql, type SQL } from 'drizzle-orm';
import type { CustomerStatus, UserId } from '@nexa/contracts';
import type { BotInstanceId, ScopeContext, TenantContext } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
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

  /**
   * The open transaction's executor, or the pool.
   *
   * `.tx`, not the handle itself. A `TransactionScope` WRAPS the drizzle
   * transaction — it carries the correlation id and the scope alongside it — so
   * casting it straight to an executor produced an object with no `.select`, and
   * every call made inside a transaction threw `this.exec(...).select is not a
   * function`. It was invisible outside a transaction, because the `?? this.db`
   * branch is the one the reads take; the failing calls were the block, the
   * unblock and the Telegram resolve, which is to say every write.
   *
   * The same three-line helper four other repositories have, spelled the same
   * way for the same reason.
   */
  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
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
          /*
           * The GREATER of the two, so activity never moves backwards.
           *
           * Each turn captures `Clock.now()` before opening its transaction, so two
           * concurrent updates from one customer can commit out of order: the one
           * holding the earlier timestamp reaches this upsert last and, assigning
           * unconditionally, overwrote `last_seen_at` with the older value. An operator
           * reading that column is answering "when did I last hear from them", and a
           * column that goes backwards is the "reads as activity and is not" case
           * `bot-runtime.ts` names as the reason this is written on every contact.
           *
           * `excluded` is the row this statement proposed; `customers.last_seen_at` is
           * what is already stored. `updatedAt` is deliberately NOT guarded the same
           * way — it records when the row was last written, which is now, whichever
           * statement wins.
           */
          lastSeenAt: sql`greatest(${customers.lastSeenAt}, excluded.last_seen_at)`,
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
   * knows whether there is a next one without a second COUNT.
   *
   * The cursor is compared as a ROW — `(created_at, id) > (c::timestamptz, i::uuid)` —
   * which is the form `drizzle-panel.repository.ts` uses against the same shape of
   * index, `(tenant_id, created_at, id)`. The instant arrives as PostgreSQL's own
   * microsecond text and is cast back explicitly, so the value that came out is the
   * value that goes in; see `CustomerCursor.createdAt` for what a `Date` here costs.
   *
   * `created_at` is rendered with `to_char` rather than read through the driver for the
   * same reason, and explicitly rather than by `::text`, because `::text` follows the
   * session's `DateStyle` and this has to be the same string on every connection.
   */
  async list(
    scope: TenantContext,
    search: CustomerSearch,
    limit: number,
    cursor: CustomerCursor | null,
    tx?: unknown,
  ): Promise<CustomerPage> {
    const rows = await this.listStatement(scope, search, limit, cursor, tx);

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toRecord),
      nextCursor:
        rows.length > limit && last !== undefined
          ? { createdAt: last.createdAtText, id: last.id as UserId }
          : null,
    };
  }

  /**
   * The page statement, exposed so a PLAN regression can explain it.
   *
   * Public for the same reason `DrizzlePanelRepository.pageKeysQuery` is: the plan test
   * has to explain the statement this code issues, and a retyped equivalent in a test
   * proves a plan for a query nobody runs. `panel-monitor-scale.test.ts` records that
   * failure in full — a green plan assertion against a simplified `SELECT` while
   * production also joined two child tables.
   *
   * Returns the drizzle builder rather than rows, so `customers-plan.test.ts` can call
   * `.toSQL()` on the very thing `list` awaits.
   */
  listStatement(
    scope: TenantContext,
    search: CustomerSearch,
    limit: number,
    cursor: CustomerCursor | null,
    tx?: unknown,
  ) {
    const tenantId = requireTenantId(scope);
    const conditions: SQL[] = [eq(customers.tenantId, tenantId)];

    if (search.telegramUserId !== undefined) {
      // Exact. A prefix match here would be a way to enumerate Telegram ids.
      conditions.push(eq(customers.telegramUserId, search.telegramUserId));
    }
    if (search.usernamePrefix !== undefined && search.usernamePrefix !== '') {
      /*
       * A PREFIX match, against `customers_tenant_username_idx`.
       *
       * The index is `(tenant_id, lower(username) text_pattern_ops)`, and the operator
       * class is what makes this line indexable at all: a default-collation btree
       * cannot serve `LIKE 'x%'`, so before migration 0036 the planner ignored the
       * index entirely and filtered a `customers_tenant_created_idx` walk — 12 289 rows
       * discarded to return 26, measured on 20 000 customers in one tenant. This
       * comment previously asserted the index was used, which was a promise the plan
       * did not keep; `customers-plan.test.ts` now reads the plan so neither half can
       * drift from the other again.
       *
       * `like` with a BOUND parameter, and the pattern built from an escaped needle: a
       * username containing `%` or `_` would otherwise match more than it spelled.
       */
      const needle = search.usernamePrefix.toLowerCase().replace(/[\\%_]/g, '\\$&');
      conditions.push(sql`lower(${customers.username}) like ${`${needle}%`}`);
    }
    if (search.status !== undefined) {
      conditions.push(eq(customers.status, search.status));
    }
    if (cursor !== null) {
      conditions.push(
        sql`(${customers.createdAt}, ${customers.id}) > (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
      );
    }

    return this.exec(tx)
      .select({
        ...getTableColumns(customers),
        /** The cursor's own half of the key, in the one spelling the cursor carries. */
        createdAtText: sql<string>`to_char(${customers.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(customers)
      .where(and(...conditions))
      .orderBy(asc(customers.createdAt), asc(customers.id))
      .limit(limit + 1);
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
