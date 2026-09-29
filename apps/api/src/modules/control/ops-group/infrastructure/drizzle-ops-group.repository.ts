import { and, desc, eq, gt, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type {
  OpsLogGroupHealth,
  OpsLogGroupProblem,
  OpsLogGroupStatus,
  OpsLogTopicCategory,
  OpsLogTopicState,
  ScopeContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  opsLogConnectCodes,
  opsLogGroups,
  opsLogTopics,
} from '../../../../infrastructure/persistence/schema.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type { OpsGroupRecord, OpsGroupRepository, OpsTopicRecord } from '../application/ports.js';

type GroupRow = typeof opsLogGroups.$inferSelect;
type TopicRow = typeof opsLogTopics.$inferSelect;

function executorOf(db: Database, tx?: unknown): Executor {
  return (tx as TransactionScope | undefined)?.tx ?? db;
}

function toGroup(row: GroupRow): OpsGroupRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    botInstanceId: row.botInstanceId,
    chatId: row.chatId,
    title: row.title,
    status: row.status as OpsLogGroupStatus,
    health: row.health as OpsLogGroupHealth,
    problems: (row.problems ?? []) as OpsLogGroupProblem[],
    botMemberStatus: row.botMemberStatus,
    checkedAt: row.checkedAt,
    lastDeliveredAt: row.lastDeliveredAt,
    connectedByAdminId: row.connectedByAdminId,
    connectedAt: row.connectedAt,
    disconnectedAt: row.disconnectedAt,
  };
}

function toTopic(row: TopicRow): OpsTopicRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    groupId: row.groupId,
    chatId: row.chatId,
    category: row.category,
    state: row.state as OpsLogTopicState,
    messageThreadId: row.messageThreadId,
    creationClaimToken: row.creationClaimToken,
    creationClaimedUntil: row.creationClaimedUntil,
    recreatedCount: row.recreatedCount,
    lastDeliveredAt: row.lastDeliveredAt,
  };
}

/** A problems array literal, for the conditional updates that write one. */
function problemsArray(problems: readonly OpsLogGroupProblem[]) {
  return sql`${`{${problems.join(',')}}`}::text[]`;
}

export class DrizzleOpsGroupRepository implements OpsGroupRepository {
  constructor(private readonly db: Database) {}

  async findGroup(scope: ScopeContext, tx?: unknown): Promise<OpsGroupRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await executorOf(this.db, tx)
      .select()
      .from(opsLogGroups)
      .where(eq(opsLogGroups.tenantId, tenantId))
      .limit(1);
    return row ? toGroup(row) : null;
  }

  async lockGroup(scope: ScopeContext, tx: unknown): Promise<OpsGroupRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await executorOf(this.db, tx)
      .select()
      .from(opsLogGroups)
      .where(eq(opsLogGroups.tenantId, tenantId))
      .limit(1)
      .for('update');
    return row ? toGroup(row) : null;
  }

  async insertCode(
    scope: ScopeContext,
    input: {
      readonly id: string;
      readonly botInstanceId: string;
      readonly codeHash: string;
      readonly issuedByAdminId: string;
      readonly issuedAt: Date;
      readonly expiresAt: Date;
    },
    tx: unknown,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    await executorOf(this.db, tx).insert(opsLogConnectCodes).values({
      id: input.id,
      tenantId,
      botInstanceId: input.botInstanceId,
      codeHash: input.codeHash,
      issuedByAdminId: input.issuedByAdminId,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
    });
  }

  async outstandingCodeExpiry(scope: ScopeContext, now: Date, tx?: unknown): Promise<Date | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await executorOf(this.db, tx)
      .select({ expiresAt: opsLogConnectCodes.expiresAt })
      .from(opsLogConnectCodes)
      .where(
        and(
          eq(opsLogConnectCodes.tenantId, tenantId),
          isNull(opsLogConnectCodes.consumedAt),
          gt(opsLogConnectCodes.expiresAt, now),
        ),
      )
      .orderBy(desc(opsLogConnectCodes.issuedAt))
      .limit(1);
    return row?.expiresAt ?? null;
  }

  /**
   * The single-use gate: one conditional UPDATE, keyed by tenant, bot and hash, that only
   * an unconsumed, unexpired code satisfies. Two updates racing for one code serialise on
   * its row; the second finds `consumed_at` set and matches nothing.
   */
  async consumeCode(
    scope: ScopeContext,
    input: {
      readonly botInstanceId: string;
      readonly codeHash: string;
      readonly chatId: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<{ readonly issuedByAdminId: string } | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await executorOf(this.db, tx)
      .update(opsLogConnectCodes)
      .set({ consumedAt: input.now, consumedChatId: input.chatId })
      .where(
        and(
          eq(opsLogConnectCodes.tenantId, tenantId),
          eq(opsLogConnectCodes.botInstanceId, input.botInstanceId),
          eq(opsLogConnectCodes.codeHash, input.codeHash),
          isNull(opsLogConnectCodes.consumedAt),
          gt(opsLogConnectCodes.expiresAt, input.now),
        ),
      )
      .returning({ issuedByAdminId: opsLogConnectCodes.issuedByAdminId });
    return row ?? null;
  }

  /**
   * One row per tenant, so binding is an upsert on the tenant: a first connection inserts,
   * a later one rewrites the chat, the bot and the state. The old chat's topic rows stay
   * behind, keyed by THAT chat, and are never posted to again.
   */
  async bindGroup(
    scope: ScopeContext,
    input: {
      readonly id: string;
      readonly botInstanceId: string;
      readonly chatId: string;
      readonly title: string;
      readonly connectedByAdminId: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<OpsGroupRecord> {
    const tenantId = requireTenantId(scope);
    const values = {
      botInstanceId: input.botInstanceId,
      chatId: input.chatId,
      title: input.title,
      status: 'CONNECTED' as const,
      health: 'UNVERIFIED' as const,
      problems: [] as string[],
      botMemberStatus: null,
      checkedAt: null,
      connectedByAdminId: input.connectedByAdminId,
      connectedAt: input.now,
      disconnectedAt: null,
      updatedAt: input.now,
    };
    const [row] = await executorOf(this.db, tx)
      .insert(opsLogGroups)
      .values({ id: input.id, tenantId, createdAt: input.now, ...values })
      .onConflictDoUpdate({ target: opsLogGroups.tenantId, set: values })
      .returning();
    if (!row) throw new Error('Binding the operations group returned no row.');
    return toGroup(row);
  }

  async transitionGroup(
    scope: ScopeContext,
    input: {
      readonly from: OpsLogGroupStatus;
      readonly to: OpsLogGroupStatus;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const reconnecting = input.to === 'CONNECTED';
    const rows = await executorOf(this.db, tx)
      .update(opsLogGroups)
      .set({
        status: input.to,
        disconnectedAt: reconnecting ? null : input.now,
        // A group brought back is checked again before anybody calls it healthy, and is a
        // new binding: a check that started before it cannot record over it.
        ...(reconnecting
          ? { health: 'UNVERIFIED' as const, checkedAt: null, connectedAt: input.now }
          : {}),
        updatedAt: input.now,
      })
      .where(and(eq(opsLogGroups.tenantId, tenantId), eq(opsLogGroups.status, input.from)))
      .returning({ id: opsLogGroups.id });
    return rows.length > 0;
  }

  async recordHealth(
    scope: ScopeContext,
    input: {
      readonly chatId: string;
      readonly botInstanceId: string;
      readonly connectedAt: Date;
      readonly health: OpsLogGroupHealth;
      readonly problems: readonly OpsLogGroupProblem[];
      readonly botMemberStatus: string | null;
      readonly title: string | null;
      readonly now: Date;
    },
    tx?: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await executorOf(this.db, tx)
      .update(opsLogGroups)
      .set({
        health: input.health,
        problems: problemsArray(input.problems),
        botMemberStatus: input.botMemberStatus,
        checkedAt: input.now,
        ...(input.title !== null && input.title !== '' ? { title: input.title } : {}),
        updatedAt: input.now,
      })
      .where(
        and(
          eq(opsLogGroups.tenantId, tenantId),
          eq(opsLogGroups.status, 'CONNECTED'),
          eq(opsLogGroups.chatId, input.chatId),
          eq(opsLogGroups.botInstanceId, input.botInstanceId),
          eq(opsLogGroups.connectedAt, input.connectedAt),
        ),
      )
      .returning({ id: opsLogGroups.id });
    return rows.length > 0;
  }

  async addProblem(
    scope: ScopeContext,
    input: { readonly chatId: string; readonly problem: OpsLogGroupProblem; readonly now: Date },
    tx?: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await executorOf(this.db, tx)
      .update(opsLogGroups)
      .set({
        health: 'PROBLEM',
        problems: sql`(SELECT array_agg(DISTINCT p) FROM unnest(${opsLogGroups.problems} || ARRAY[${input.problem}]::text[]) AS p)`,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(opsLogGroups.tenantId, tenantId),
          eq(opsLogGroups.chatId, input.chatId),
          eq(opsLogGroups.status, 'CONNECTED'),
        ),
      )
      .returning({ id: opsLogGroups.id });
    return rows.length > 0;
  }

  async markUnverified(
    scope: ScopeContext,
    input: { readonly chatId: string; readonly botInstanceId: string; readonly now: Date },
    tx?: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await executorOf(this.db, tx)
      .update(opsLogGroups)
      .set({ health: 'UNVERIFIED', updatedAt: input.now })
      .where(
        and(
          eq(opsLogGroups.tenantId, tenantId),
          eq(opsLogGroups.chatId, input.chatId),
          eq(opsLogGroups.botInstanceId, input.botInstanceId),
        ),
      )
      .returning({ id: opsLogGroups.id });
    return rows.length > 0;
  }

  async noteDelivered(
    scope: ScopeContext,
    input: { readonly chatId: string; readonly category: string; readonly at: Date },
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    await this.db.transaction(async (tx) => {
      await tx
        .update(opsLogGroups)
        .set({ lastDeliveredAt: input.at })
        .where(and(eq(opsLogGroups.tenantId, tenantId), eq(opsLogGroups.chatId, input.chatId)));
      await tx
        .update(opsLogTopics)
        .set({ lastDeliveredAt: input.at })
        .where(
          and(
            eq(opsLogTopics.tenantId, tenantId),
            eq(opsLogTopics.chatId, input.chatId),
            eq(opsLogTopics.category, input.category),
          ),
        );
    });
  }

  async listTopics(scope: ScopeContext, chatId: string, tx?: unknown): Promise<OpsTopicRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await executorOf(this.db, tx)
      .select()
      .from(opsLogTopics)
      .where(and(eq(opsLogTopics.tenantId, tenantId), eq(opsLogTopics.chatId, chatId)));
    return rows.map(toTopic);
  }

  async ensureTopicRow(
    scope: ScopeContext,
    input: {
      readonly id: string;
      readonly groupId: string;
      readonly chatId: string;
      readonly category: OpsLogTopicCategory;
      readonly now: Date;
    },
  ): Promise<OpsTopicRecord> {
    const tenantId = requireTenantId(scope);
    await this.db
      .insert(opsLogTopics)
      .values({
        id: input.id,
        tenantId,
        groupId: input.groupId,
        chatId: input.chatId,
        category: input.category,
        state: 'PENDING',
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoNothing({
        target: [opsLogTopics.tenantId, opsLogTopics.chatId, opsLogTopics.category],
      });
    const [row] = await this.db
      .select()
      .from(opsLogTopics)
      .where(
        and(
          eq(opsLogTopics.tenantId, tenantId),
          eq(opsLogTopics.chatId, input.chatId),
          eq(opsLogTopics.category, input.category),
        ),
      )
      .limit(1);
    if (!row) throw new Error('The topic registry row is not visible after its upsert.');
    return toTopic(row);
  }

  async markTopicMissing(
    scope: ScopeContext,
    input: { readonly topicId: string; readonly staleThreadId: number; readonly now: Date },
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .update(opsLogTopics)
      .set({ state: 'MISSING', updatedAt: input.now })
      .where(
        and(
          eq(opsLogTopics.tenantId, tenantId),
          eq(opsLogTopics.id, input.topicId),
          eq(opsLogTopics.state, 'READY'),
          eq(opsLogTopics.messageThreadId, input.staleThreadId),
        ),
      )
      .returning({ id: opsLogTopics.id });
    return rows.length > 0;
  }

  async claimTopicCreation(
    scope: ScopeContext,
    input: {
      readonly topicId: string;
      readonly token: string;
      readonly until: Date;
      readonly now: Date;
    },
  ): Promise<OpsTopicRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.db
      .update(opsLogTopics)
      .set({
        creationClaimToken: input.token,
        creationClaimedUntil: input.until,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(opsLogTopics.tenantId, tenantId),
          eq(opsLogTopics.id, input.topicId),
          ne(opsLogTopics.state, 'READY'),
          or(
            isNull(opsLogTopics.creationClaimedUntil),
            lt(opsLogTopics.creationClaimedUntil, input.now),
          ),
        ),
      )
      .returning();
    return row ? toTopic(row) : null;
  }

  async completeTopicCreation(
    scope: ScopeContext,
    input: {
      readonly topicId: string;
      readonly token: string;
      readonly threadId: number;
      readonly recreated: boolean;
      readonly now: Date;
    },
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .update(opsLogTopics)
      .set({
        state: 'READY',
        messageThreadId: input.threadId,
        creationClaimToken: null,
        creationClaimedUntil: null,
        ...(input.recreated ? { recreatedCount: sql`${opsLogTopics.recreatedCount} + 1` } : {}),
        updatedAt: input.now,
      })
      .where(
        and(
          eq(opsLogTopics.tenantId, tenantId),
          eq(opsLogTopics.id, input.topicId),
          eq(opsLogTopics.creationClaimToken, input.token),
          ne(opsLogTopics.state, 'READY'),
        ),
      )
      .returning({ id: opsLogTopics.id });
    return rows.length > 0;
  }

  async releaseTopicClaim(
    scope: ScopeContext,
    input: { readonly topicId: string; readonly token: string; readonly now: Date },
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    await this.db
      .update(opsLogTopics)
      .set({ creationClaimToken: null, creationClaimedUntil: null, updatedAt: input.now })
      .where(
        and(
          eq(opsLogTopics.tenantId, tenantId),
          eq(opsLogTopics.id, input.topicId),
          eq(opsLogTopics.creationClaimToken, input.token),
        ),
      );
  }
}
