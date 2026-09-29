import { and, asc, desc, eq, getTableColumns, gt, inArray, lte, sql, type SQL } from 'drizzle-orm';
import type {
  AudienceDefinition,
  CampaignActionKind,
  CampaignActionState,
  CampaignState,
  CurrencyCode,
  DiscountKind,
  DiscountType,
  DiscountablePurpose,
  TenantContext,
} from '@nexa/contracts';
import { CAMPAIGN_CANCELLABLE_STATES, CAMPAIGN_RUNNING_STATES } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  campaignActions,
  campaigns,
  cashbackReversals,
  discountRedemptions,
  orderCashback,
  orders,
} from '../../../../infrastructure/persistence/schema.js';
import type {
  CampaignActionConfig,
  CampaignActionRecord,
  CampaignCursor,
  CampaignDraftWrite,
  CampaignPage,
  CampaignRecord,
  CampaignRepository,
  CashbackOutcome,
  DiscountOutcome,
  StateTally,
} from '../application/ports.js';

/**
 * Campaigns in PostgreSQL (`docs/round-n-campaigns-audit.md`).
 *
 * Every state change is a conditional UPDATE naming its from-states, and those that
 * depend on time name the time too — `start` refuses a campaign whose `starts_at` is still
 * ahead, `complete` one whose `ends_at` is — so two worker replicas and a replayed command
 * each either move the row or learn that it moved. There is no `setState`.
 *
 * Every query carries the tenant, primary-key lookups included.
 */
export class DrizzleCampaignRepository implements CampaignRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async insertDraft(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly write: CampaignDraftWrite;
      readonly actionIds: readonly string[];
      readonly createdByAdminId: string | null;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<CampaignRecord> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .insert(campaigns)
      .values({
        id: input.id,
        tenantId,
        ...draftColumns(input.write),
        state: 'DRAFT',
        createdByAdminId: input.createdByAdminId,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning();
    await this.insertActions(
      tenantId,
      input.id,
      input.write.actions,
      input.actionIds,
      input.now,
      tx,
    );
    return toRecord(rows[0] as CampaignRow);
  }

  async replaceDraft(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly write: CampaignDraftWrite;
      readonly actionIds: readonly string[];
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const moved = await this.exec(tx)
      .update(campaigns)
      .set({ ...draftColumns(input.write), updatedAt: input.now })
      .where(
        and(
          eq(campaigns.tenantId, tenantId),
          eq(campaigns.id, input.id),
          eq(campaigns.state, 'DRAFT'),
        ),
      )
      .returning({ id: campaigns.id });
    if (moved.length !== 1) return false;
    // A draft's actions have made nothing yet (they are all PENDING, with no link), so
    // replacing them is replacing a configuration and nothing else.
    await this.exec(tx)
      .delete(campaignActions)
      .where(and(eq(campaignActions.tenantId, tenantId), eq(campaignActions.campaignId, input.id)));
    await this.insertActions(
      tenantId,
      input.id,
      input.write.actions,
      input.actionIds,
      input.now,
      tx,
    );
    return true;
  }

  private async insertActions(
    tenantId: string,
    campaignId: string,
    actions: readonly CampaignActionConfig[],
    ids: readonly string[],
    now: Date,
    tx: unknown,
  ): Promise<void> {
    if (actions.length === 0) return;
    await this.exec(tx)
      .insert(campaignActions)
      .values(
        actions.map((action, index) => ({
          id: ids[index] as string,
          tenantId,
          campaignId,
          kind: action.kind,
          state: 'PENDING',
          config: configToJson(action),
          createdAt: now,
          updatedAt: now,
        })),
      );
  }

  async findById(scope: TenantContext, id: string, tx?: unknown): Promise<CampaignRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.tenantId, tenantId), eq(campaigns.id, id)))
      .limit(1);
    return rows[0] === undefined ? null : toRecord(rows[0]);
  }

  async lockById(scope: TenantContext, id: string, tx: unknown): Promise<CampaignRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.tenantId, tenantId), eq(campaigns.id, id)))
      .for('update')
      .limit(1);
    return rows[0] === undefined ? null : toRecord(rows[0]);
  }

  async actionsOf(
    scope: TenantContext,
    campaignId: string,
    tx?: unknown,
  ): Promise<readonly CampaignActionRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(campaignActions)
      .where(
        and(eq(campaignActions.tenantId, tenantId), eq(campaignActions.campaignId, campaignId)),
      )
      .orderBy(asc(campaignActions.kind));
    return rows.map((row) => ({
      id: row.id,
      campaignId: row.campaignId,
      kind: row.kind as CampaignActionKind,
      state: row.state as CampaignActionState,
      config: configFromJson(row.kind as CampaignActionKind, row.config),
      discountId: row.discountId,
      cashbackRuleId: row.cashbackRuleId,
      failureCode: row.failureCode,
      launchedAt: row.launchedAt,
    }));
  }

  async list(
    scope: TenantContext,
    search: { readonly state?: CampaignState },
    limit: number,
    cursor: CampaignCursor | null,
  ): Promise<CampaignPage> {
    const tenantId = requireTenantId(scope);
    const conditions: SQL[] = [eq(campaigns.tenantId, tenantId)];
    if (search.state !== undefined) conditions.push(eq(campaigns.state, search.state));
    if (cursor !== null) {
      // Newest first: strictly before the cursor in (created_at, id) descending. The
      // cursor carries PostgreSQL's own microsecond text (`keyset-cursor.ts`).
      conditions.push(
        sql`(${campaigns.createdAt}, ${campaigns.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    const rows = await this.db
      .select({
        ...getTableColumns(campaigns),
        createdAtText: sql<string>`to_char(${campaigns.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(campaigns)
      .where(and(...conditions))
      .orderBy(desc(campaigns.createdAt), desc(campaigns.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toRecord),
      nextCursor:
        rows.length > limit && last !== undefined
          ? { createdAt: last.createdAtText, id: last.id }
          : null,
    };
  }

  async schedule(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly adminId: string | null;
      readonly confirmedCount: number;
      readonly fingerprint: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<boolean> {
    return this.move(
      scope,
      input.id,
      ['DRAFT'],
      {
        state: 'SCHEDULED',
        scheduledAt: input.now,
        scheduledByAdminId: input.adminId,
        audienceFrozenAt: input.now,
        audienceConfirmedCount: input.confirmedCount,
        audienceFingerprint: input.fingerprint,
        updatedAt: input.now,
      },
      // A window already over is never scheduled, whatever the service believed.
      gt(campaigns.endsAt, input.now),
      tx,
    );
  }

  async start(scope: TenantContext, id: string, now: Date, tx: unknown): Promise<boolean> {
    return this.move(
      scope,
      id,
      ['SCHEDULED'],
      { state: 'ACTIVE', startedAt: now, updatedAt: now },
      lte(campaigns.startsAt, now),
      tx,
    );
  }

  async pause(scope: TenantContext, id: string, now: Date, tx: unknown): Promise<boolean> {
    return this.move(
      scope,
      id,
      ['ACTIVE'],
      { state: 'PAUSED', pausedAt: now, updatedAt: now },
      undefined,
      tx,
    );
  }

  async resume(scope: TenantContext, id: string, now: Date, tx: unknown): Promise<boolean> {
    return this.move(
      scope,
      id,
      ['PAUSED'],
      { state: 'ACTIVE', pausedAt: null, updatedAt: now },
      gt(campaigns.endsAt, now),
      tx,
    );
  }

  async complete(scope: TenantContext, id: string, now: Date, tx: unknown): Promise<boolean> {
    return this.move(
      scope,
      id,
      CAMPAIGN_RUNNING_STATES,
      { state: 'COMPLETED', completedAt: now, pausedAt: null, updatedAt: now },
      lte(campaigns.endsAt, now),
      tx,
    );
  }

  async cancel(
    scope: TenantContext,
    input: { readonly id: string; readonly adminId: string | null; readonly now: Date },
    tx: unknown,
  ): Promise<boolean> {
    return this.move(
      scope,
      input.id,
      CAMPAIGN_CANCELLABLE_STATES,
      {
        state: 'CANCELLED',
        cancelledAt: input.now,
        cancelledByAdminId: input.adminId,
        pausedAt: null,
        updatedAt: input.now,
      },
      undefined,
      tx,
    );
  }

  /** The one shape every edge takes: from-states named, and an optional time condition. */
  private async move(
    scope: TenantContext,
    id: string,
    from: readonly CampaignState[],
    set: Partial<typeof campaigns.$inferInsert>,
    condition: SQL | undefined,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const where = [
      eq(campaigns.tenantId, tenantId),
      eq(campaigns.id, id),
      inArray(campaigns.state, [...from]),
    ];
    if (condition !== undefined) where.push(condition);
    const rows = await this.exec(tx)
      .update(campaigns)
      .set(set)
      .where(and(...where))
      .returning({ id: campaigns.id });
    return rows.length === 1;
  }

  async dueToStart(scope: TenantContext, now: Date, limit: number): Promise<readonly string[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(
        and(
          eq(campaigns.tenantId, tenantId),
          eq(campaigns.state, 'SCHEDULED'),
          lte(campaigns.startsAt, now),
        ),
      )
      .orderBy(asc(campaigns.startsAt), asc(campaigns.id))
      .limit(limit);
    return rows.map((row) => row.id);
  }

  async dueToComplete(scope: TenantContext, now: Date, limit: number): Promise<readonly string[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(
        and(
          eq(campaigns.tenantId, tenantId),
          inArray(campaigns.state, [...CAMPAIGN_RUNNING_STATES]),
          lte(campaigns.endsAt, now),
        ),
      )
      .orderBy(asc(campaigns.endsAt), asc(campaigns.id))
      .limit(limit);
    return rows.map((row) => row.id);
  }

  async linkRule(
    scope: TenantContext,
    input: {
      readonly actionId: string;
      readonly discountId?: string;
      readonly cashbackRuleId?: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(campaignActions)
      .set({
        ...(input.discountId === undefined ? {} : { discountId: input.discountId }),
        ...(input.cashbackRuleId === undefined ? {} : { cashbackRuleId: input.cashbackRuleId }),
        state: 'LAUNCHED',
        launchedAt: input.now,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(campaignActions.tenantId, tenantId),
          eq(campaignActions.id, input.actionId),
          eq(campaignActions.state, 'PENDING'),
        ),
      )
      .returning({ id: campaignActions.id });
    return rows.length === 1;
  }

  async cancelPendingActions(
    scope: TenantContext,
    campaignId: string,
    now: Date,
    tx: unknown,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(campaignActions)
      .set({ state: 'CANCELLED', updatedAt: now })
      .where(
        and(
          eq(campaignActions.tenantId, tenantId),
          eq(campaignActions.campaignId, campaignId),
          eq(campaignActions.state, 'PENDING'),
        ),
      )
      .returning({ id: campaignActions.id });
    return rows.length;
  }

  async discountOutcome(scope: TenantContext, discountId: string): Promise<DiscountOutcome> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select({
        state: orders.state,
        currency: discountRedemptions.currency,
        count: sql<number>`count(*)::int`,
        amount: sql<string>`coalesce(sum(${discountRedemptions.amount}), 0)::text`,
      })
      .from(discountRedemptions)
      .innerJoin(
        orders,
        and(
          eq(orders.tenantId, discountRedemptions.tenantId),
          eq(orders.id, discountRedemptions.orderId),
        ),
      )
      .where(
        and(
          eq(discountRedemptions.tenantId, tenantId),
          eq(discountRedemptions.discountId, discountId),
        ),
      )
      .groupBy(orders.state, discountRedemptions.currency)
      .orderBy(asc(orders.state));
    return {
      byOrderState: rows.map((row): StateTally => ({
        state: row.state,
        count: row.count,
        amount: BigInt(row.amount),
        currency: row.currency as CurrencyCode,
      })),
    };
  }

  async cashbackOutcome(scope: TenantContext, cashbackRuleId: string): Promise<CashbackOutcome> {
    const tenantId = requireTenantId(scope);
    const byState = await this.db
      .select({
        state: orderCashback.state,
        currency: orderCashback.currency,
        count: sql<number>`count(*)::int`,
        amount: sql<string>`coalesce(sum(${orderCashback.amount}), 0)::text`,
        earned: sql<string>`coalesce(sum(${orderCashback.earnedAmount}), 0)::text`,
      })
      .from(orderCashback)
      .where(and(eq(orderCashback.tenantId, tenantId), eq(orderCashback.ruleId, cashbackRuleId)))
      .groupBy(orderCashback.state, orderCashback.currency)
      .orderBy(asc(orderCashback.state));
    const reversed = await this.db
      .select({
        recovered: sql<string>`coalesce(sum(${cashbackReversals.recoveredAmount}), 0)::text`,
        unrecovered: sql<string>`coalesce(sum(${cashbackReversals.unrecoveredAmount}), 0)::text`,
      })
      .from(cashbackReversals)
      .innerJoin(
        orderCashback,
        and(
          eq(orderCashback.tenantId, cashbackReversals.tenantId),
          eq(orderCashback.id, cashbackReversals.orderCashbackId),
        ),
      )
      .where(
        and(eq(cashbackReversals.tenantId, tenantId), eq(orderCashback.ruleId, cashbackRuleId)),
      );
    const first = reversed[0];
    return {
      byState: byState.map((row) => ({
        state: row.state,
        count: row.count,
        amount: BigInt(row.amount),
        currency: row.currency as CurrencyCode,
      })),
      earned: byState.reduce((sum, row) => sum + BigInt(row.earned), 0n),
      reversedRecovered: BigInt(first?.recovered ?? '0'),
      reversedUnrecovered: BigInt(first?.unrecovered ?? '0'),
      currency: (byState[0]?.currency as CurrencyCode | undefined) ?? null,
    };
  }
}

type CampaignRow = typeof campaigns.$inferSelect;

function draftColumns(write: CampaignDraftWrite) {
  return {
    name: write.name,
    description: write.description,
    startsAt: write.startsAt,
    endsAt: write.endsAt,
    audience: write.audience,
    audienceHash: write.audienceHash,
  };
}

function toRecord(row: CampaignRow): CampaignRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    state: row.state as CampaignState,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    audience: row.audience as AudienceDefinition,
    audienceHash: row.audienceHash,
    audienceFrozenAt: row.audienceFrozenAt,
    audienceConfirmedCount: row.audienceConfirmedCount,
    audienceFingerprint: row.audienceFingerprint,
    createdByAdminId: row.createdByAdminId,
    scheduledByAdminId: row.scheduledByAdminId,
    scheduledAt: row.scheduledAt,
    startedAt: row.startedAt,
    pausedAt: row.pausedAt,
    completedAt: row.completedAt,
    cancelledByAdminId: row.cancelledByAdminId,
    cancelledAt: row.cancelledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** `bigint` as text: JSON has no integer wide enough to be trusted with minor units. */
function configToJson(action: CampaignActionConfig): Record<string, unknown> {
  switch (action.kind) {
    case 'DISCOUNT': {
      const t = action.terms;
      return {
        ...t,
        value: t.value.toString(),
        minimumSubtotal: t.minimumSubtotal?.toString() ?? null,
        appliesTo: [...t.appliesTo],
      };
    }
    case 'CASHBACK':
      return { ...action.terms, appliesTo: [...action.terms.appliesTo] };
  }
}

function configFromJson(kind: CampaignActionKind, raw: unknown): CampaignActionConfig {
  const json = raw as Record<string, unknown>;
  switch (kind) {
    case 'DISCOUNT':
      return {
        kind,
        terms: {
          kind: json['kind'] as DiscountKind,
          code: (json['code'] as string | null) ?? null,
          type: json['type'] as DiscountType,
          value: BigInt(json['value'] as string),
          currency: (json['currency'] as CurrencyCode | null) ?? null,
          appliesTo: json['appliesTo'] as DiscountablePurpose[],
          productId: (json['productId'] as string | null) ?? null,
          categoryId: (json['categoryId'] as string | null) ?? null,
          firstPurchaseOnly: json['firstPurchaseOnly'] === true,
          minimumSubtotal:
            json['minimumSubtotal'] === null || json['minimumSubtotal'] === undefined
              ? null
              : BigInt(json['minimumSubtotal'] as string),
          totalLimit: (json['totalLimit'] as number | null) ?? null,
          perCustomerLimit: (json['perCustomerLimit'] as number | null) ?? null,
          priority: json['priority'] as number,
          stackable: json['stackable'] === true,
        },
      };
    case 'CASHBACK':
      return {
        kind,
        terms: {
          percent: json['percent'] as number,
          appliesTo: json['appliesTo'] as DiscountablePurpose[],
          productId: (json['productId'] as string | null) ?? null,
          categoryId: (json['categoryId'] as string | null) ?? null,
        },
      };
    default:
      throw new Error(`campaign action kind ${kind} has no configuration reader`);
  }
}
