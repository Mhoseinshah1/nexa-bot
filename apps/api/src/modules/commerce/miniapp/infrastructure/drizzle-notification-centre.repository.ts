import { and, eq, gte, isNotNull, isNull, sql } from 'drizzle-orm';
import type { BotInstanceId, TenantContext, UserId } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { customerNotifications } from '../../../../infrastructure/persistence/schema.js';
import type {
  NotificationCentreItem,
  NotificationCentrePosition,
  NotificationCentreRepository,
} from '../application/ports.js';

/**
 * The notification centre over `customer_notifications` (Round 11, B1): the lane's own
 * delivered rows, never a second store. A row is the centre's only if it carries
 * `rendered_text` (so only a DELIVERED one, by the table's CHECK), and every query names the
 * tenant, the customer and the bot.
 */
export class DrizzleNotificationCentreRepository implements NotificationCentreRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  /** The rows that are this customer's centre, in this tenant, from this bot. */
  private owned(
    scope: TenantContext,
    input: { readonly customerId: UserId; readonly botInstanceId: BotInstanceId },
  ) {
    return and(
      eq(customerNotifications.tenantId, requireTenantId(scope)),
      eq(customerNotifications.customerId, input.customerId),
      eq(customerNotifications.botInstanceId, input.botInstanceId),
      isNotNull(customerNotifications.renderedText),
    );
  }

  async list(
    scope: TenantContext,
    input: {
      readonly customerId: UserId;
      readonly botInstanceId: BotInstanceId;
      readonly since: Date;
      readonly after: NotificationCentrePosition | null;
      readonly limit: number;
    },
    tx?: unknown,
  ): Promise<{
    readonly items: readonly NotificationCentreItem[];
    readonly next: NotificationCentrePosition | null;
  }> {
    const at = input.after === null ? null : sql`${input.after.deliveredAtText}::timestamptz`;
    const rows = await this.exec(tx)
      .select({
        id: customerNotifications.id,
        text: customerNotifications.renderedText,
        deliveredAt: customerNotifications.resolvedAt,
        // Microsecond text, for the cursor: a `Date` holds milliseconds and would straddle it.
        deliveredAtText: sql<string>`to_char(${customerNotifications.resolvedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        readAt: customerNotifications.customerReadAt,
      })
      .from(customerNotifications)
      .where(
        and(
          this.owned(scope, input),
          gte(customerNotifications.resolvedAt, input.since),
          at === null || input.after === null
            ? undefined
            : sql`(${customerNotifications.resolvedAt}, ${customerNotifications.id}) < (${at}, ${input.after.id}::uuid)`,
        ),
      )
      .orderBy(sql`${customerNotifications.resolvedAt} DESC, ${customerNotifications.id} DESC`)
      .limit(input.limit + 1);
    const page = rows.slice(0, input.limit);
    const items = page.map((row): NotificationCentreItem => ({
      id: row.id,
      text: row.text ?? '',
      deliveredAt: row.deliveredAt ?? input.since,
      deliveredAtText: row.deliveredAtText,
      read: row.readAt !== null,
    }));
    const last = items[items.length - 1];
    return {
      items,
      next:
        rows.length > input.limit && last !== undefined
          ? { deliveredAtText: last.deliveredAtText, id: last.id }
          : null,
    };
  }

  async unreadCount(
    scope: TenantContext,
    input: {
      readonly customerId: UserId;
      readonly botInstanceId: BotInstanceId;
      readonly since: Date;
    },
    tx?: unknown,
  ): Promise<number> {
    const [row] = await this.exec(tx)
      .select({ count: sql<number>`count(*)::int` })
      .from(customerNotifications)
      .where(
        and(
          this.owned(scope, input),
          isNull(customerNotifications.customerReadAt),
          gte(customerNotifications.resolvedAt, input.since),
        ),
      );
    return row?.count ?? 0;
  }

  async markRead(
    scope: TenantContext,
    input: {
      readonly customerId: UserId;
      readonly botInstanceId: BotInstanceId;
      readonly id: string;
      readonly at: Date;
    },
    tx: unknown,
  ): Promise<'MARKED' | 'ALREADY_READ' | 'NOT_FOUND'> {
    const executor = this.exec(tx);
    const marked = await executor
      .update(customerNotifications)
      .set({ customerReadAt: input.at })
      .where(
        and(
          this.owned(scope, input),
          eq(customerNotifications.id, input.id),
          isNull(customerNotifications.customerReadAt),
        ),
      )
      .returning({ id: customerNotifications.id });
    if (marked.length > 0) return 'MARKED';
    const [existing] = await executor
      .select({ id: customerNotifications.id })
      .from(customerNotifications)
      .where(and(this.owned(scope, input), eq(customerNotifications.id, input.id)))
      .limit(1);
    return existing === undefined ? 'NOT_FOUND' : 'ALREADY_READ';
  }

  async markAllRead(
    scope: TenantContext,
    input: {
      readonly customerId: UserId;
      readonly botInstanceId: BotInstanceId;
      readonly at: Date;
    },
    tx: unknown,
  ): Promise<number> {
    const rows = await this.exec(tx)
      .update(customerNotifications)
      .set({ customerReadAt: input.at })
      .where(and(this.owned(scope, input), isNull(customerNotifications.customerReadAt)))
      .returning({ id: customerNotifications.id });
    return rows.length;
  }
}
