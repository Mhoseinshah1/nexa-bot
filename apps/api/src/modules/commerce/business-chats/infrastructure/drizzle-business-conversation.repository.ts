import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type {
  BusinessBotRight,
  BusinessConversationState,
  BusinessHandoffReason,
  BusinessMessageKind,
  BusinessMessageOrigin,
  BusinessOutboundOrigin,
  BusinessOutboundState,
  BusinessTakeoverReason,
  ScopeContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  businessConversations,
  businessMessages,
  businessOutboundMessages,
  customers,
  telegramBusinessConnections,
} from '../../../../infrastructure/persistence/schema.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  BusinessConversationListItem,
  BusinessConversationRecord,
  BusinessConversationRepository,
  BusinessCustomerLookup,
  BusinessMessageRecord,
  BusinessMessageRepository,
  BusinessOutboundRecord,
  BusinessOutboundRepository,
  ConversationTransition,
} from '../application/ports.js';

/**
 * TB2 persistence: conversations, the bounded transcript and the outbound lane, plus the one
 * customer lookup a business message is allowed (exact `(tenant, telegram_user_id)`).
 */

function executorOf(db: Database, tx?: unknown): Executor {
  return (tx as TransactionScope | undefined)?.tx ?? db;
}

type ConversationRow = typeof businessConversations.$inferSelect;
type MessageRow = typeof businessMessages.$inferSelect;
type OutboundRow = typeof businessOutboundMessages.$inferSelect;

function toConversation(row: ConversationRow): BusinessConversationRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    botInstanceId: row.botInstanceId,
    ownerTelegramUserId: row.ownerTelegramUserId,
    chatId: row.chatId,
    connectionRowId: row.connectionRowId,
    peerTelegramUserId: row.peerTelegramUserId,
    customerId: row.customerId,
    state: row.state as BusinessConversationState,
    controlEpoch: row.controlEpoch,
    takeoverReason: row.takeoverReason as BusinessTakeoverReason | null,
    handoffReason: row.handoffReason as BusinessHandoffReason | null,
    lastMessageAt: row.lastMessageAt,
    lastInboundAt: row.lastInboundAt,
    lastHumanAt: row.lastHumanAt,
    lastAiAt: row.lastAiAt,
    version: row.version,
  };
}

function toMessage(row: MessageRow): BusinessMessageRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    telegramMessageId: row.telegramMessageId,
    origin: row.origin as BusinessMessageOrigin,
    kind: row.kind as BusinessMessageKind,
    text: row.text,
    contentVersion: row.contentVersion,
    sentAt: row.sentAt,
    editedAt: row.editedAt,
    deletedAt: row.deletedAt,
  };
}

function toOutbound(row: OutboundRow): BusinessOutboundRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    origin: row.origin as BusinessOutboundOrigin,
    body: row.body,
    createdByAdminId: row.createdByAdminId,
    controlEpoch: row.controlEpoch,
    idempotencyKey: row.idempotencyKey,
    requestHash: row.requestHash,
    state: row.state as BusinessOutboundState,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    sendStartedAt: row.sendStartedAt,
    resolvedAt: row.resolvedAt,
    telegramMessageId: row.telegramMessageId,
    failureCode: row.failureCode,
    createdAt: row.createdAt,
  };
}

const PREVIEW_CHARS = 120;

export class DrizzleBusinessConversationRepository implements BusinessConversationRepository {
  constructor(private readonly db: Database) {}

  /**
   * INSERT … ON CONFLICT DO NOTHING, then a locked read. Two first messages of one chat,
   * delivered concurrently, both reach the insert; the loser's becomes a no-op and it then
   * waits on the winner's row lock instead of failing on the unique index.
   */
  async upsertLocked(
    scope: ScopeContext,
    input: Parameters<BusinessConversationRepository['upsertLocked']>[1],
    tx: unknown,
  ): Promise<BusinessConversationRecord> {
    const tenantId = requireTenantId(scope);
    const executor = executorOf(this.db, tx);
    await executor
      .insert(businessConversations)
      .values({
        id: input.id,
        tenantId,
        botInstanceId: input.botInstanceId,
        ownerTelegramUserId: input.ownerTelegramUserId,
        chatId: input.chatId,
        connectionRowId: input.connectionRowId,
        peerTelegramUserId: input.peerTelegramUserId,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoNothing({
        target: [
          businessConversations.botInstanceId,
          businessConversations.ownerTelegramUserId,
          businessConversations.chatId,
        ],
      });
    const [row] = await executor
      .select()
      .from(businessConversations)
      .where(
        and(
          eq(businessConversations.tenantId, tenantId),
          eq(businessConversations.botInstanceId, input.botInstanceId),
          eq(businessConversations.ownerTelegramUserId, input.ownerTelegramUserId),
          eq(businessConversations.chatId, input.chatId),
        ),
      )
      .for('update')
      .limit(1);
    if (row === undefined) {
      throw new Error('business_conversations: the upserted row is not readable in scope.');
    }
    if (row.connectionRowId === input.connectionRowId) return toConversation(row);
    // Follows the LATEST connection only: a late update on a connection that has since been
    // superseded must not point the conversation back at it (TB2 review F1). Decided here,
    // against the connection row as it is now, not as the caller read it.
    const [moved] = await executor
      .update(businessConversations)
      .set({ connectionRowId: input.connectionRowId, updatedAt: input.now })
      .where(
        and(
          eq(businessConversations.tenantId, tenantId),
          eq(businessConversations.id, row.id),
          sql`EXISTS (SELECT 1 FROM ${telegramBusinessConnections} WHERE ${telegramBusinessConnections.tenantId} = ${tenantId} AND ${telegramBusinessConnections.id} = ${input.connectionRowId} AND ${telegramBusinessConnections.supersededAt} IS NULL)`,
        ),
      )
      .returning();
    return toConversation(moved ?? row);
  }

  async lockById(
    scope: ScopeContext,
    id: string,
    tx: unknown,
  ): Promise<BusinessConversationRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await executorOf(this.db, tx)
      .select()
      .from(businessConversations)
      .where(and(eq(businessConversations.tenantId, tenantId), eq(businessConversations.id, id)))
      .for('update')
      .limit(1);
    return row ? toConversation(row) : null;
  }

  async findByChat(
    scope: ScopeContext,
    key: {
      readonly botInstanceId: string;
      readonly ownerTelegramUserId: string;
      readonly chatId: string;
    },
    tx?: unknown,
  ): Promise<BusinessConversationRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await executorOf(this.db, tx)
      .select()
      .from(businessConversations)
      .where(
        and(
          eq(businessConversations.tenantId, tenantId),
          eq(businessConversations.botInstanceId, key.botInstanceId),
          eq(businessConversations.ownerTelegramUserId, key.ownerTelegramUserId),
          eq(businessConversations.chatId, key.chatId),
        ),
      )
      .limit(1);
    return row ? toConversation(row) : null;
  }

  async listItem(scope: ScopeContext, id: string): Promise<BusinessConversationListItem | null> {
    const [item] = await this.query(scope, { id, limit: 1 });
    return item ?? null;
  }

  async findById(
    scope: ScopeContext,
    id: string,
    tx?: unknown,
  ): Promise<BusinessConversationRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await executorOf(this.db, tx)
      .select()
      .from(businessConversations)
      .where(and(eq(businessConversations.tenantId, tenantId), eq(businessConversations.id, id)))
      .limit(1);
    return row ? toConversation(row) : null;
  }

  async transition(
    scope: ScopeContext,
    id: string,
    transition: ConversationTransition,
    tx: unknown,
  ): Promise<BusinessConversationRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await executorOf(this.db, tx)
      .update(businessConversations)
      .set({
        state: transition.to,
        ...(transition.bumpEpoch
          ? { controlEpoch: sql`${businessConversations.controlEpoch} + 1` }
          : {}),
        ...(transition.takeoverReason === undefined
          ? {}
          : { takeoverReason: transition.takeoverReason }),
        handoffReason:
          transition.to === 'HANDOFF_REQUIRED' ? (transition.handoffReason ?? null) : null,
        version: sql`${businessConversations.version} + 1`,
        updatedAt: transition.now,
      })
      .where(
        and(
          eq(businessConversations.tenantId, tenantId),
          eq(businessConversations.id, id),
          inArray(businessConversations.state, [...transition.from]),
        ),
      )
      .returning();
    return row ? toConversation(row) : null;
  }

  async touch(
    scope: ScopeContext,
    id: string,
    stamps: Parameters<BusinessConversationRepository['touch']>[2],
    tx: unknown,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    // GREATEST, so a late-delivered older message never moves an activity stamp backwards.
    await executorOf(this.db, tx)
      .update(businessConversations)
      .set({
        ...(stamps.lastMessageAt === undefined
          ? {}
          : {
              lastMessageAt: sql`GREATEST(${businessConversations.lastMessageAt}, ${stamps.lastMessageAt})`,
            }),
        ...(stamps.lastInboundAt === undefined
          ? {}
          : {
              lastInboundAt: sql`GREATEST(${businessConversations.lastInboundAt}, ${stamps.lastInboundAt})`,
            }),
        ...(stamps.lastHumanAt === undefined
          ? {}
          : {
              lastHumanAt: sql`GREATEST(${businessConversations.lastHumanAt}, ${stamps.lastHumanAt})`,
            }),
        ...(stamps.lastAiAt === undefined
          ? {}
          : { lastAiAt: sql`GREATEST(${businessConversations.lastAiAt}, ${stamps.lastAiAt})` }),
        ...(stamps.customerId === undefined ? {} : { customerId: stamps.customerId }),
        updatedAt: stamps.now,
      })
      .where(and(eq(businessConversations.tenantId, tenantId), eq(businessConversations.id, id)));
  }

  async list(
    scope: ScopeContext,
    input: Parameters<BusinessConversationRepository['list']>[1],
  ): Promise<readonly BusinessConversationListItem[]> {
    return this.query(scope, input);
  }

  private async query(
    scope: ScopeContext,
    input: Parameters<BusinessConversationRepository['list']>[1] & { readonly id?: string },
  ): Promise<readonly BusinessConversationListItem[]> {
    const tenantId = requireTenantId(scope);
    const activity = sql<Date>`COALESCE(${businessConversations.lastMessageAt}, ${businessConversations.createdAt})`;
    const rows = await this.db
      .select({
        conversation: businessConversations,
        customer: {
          id: customers.id,
          username: customers.username,
          firstName: customers.firstName,
        },
        connection: {
          isEnabled: telegramBusinessConnections.isEnabled,
          rights: telegramBusinessConnections.rights,
          supersededAt: telegramBusinessConnections.supersededAt,
        },
        activityAt: activity,
        // The latest message's opening, read in the same statement (no N+1).
        preview: sql<string | null>`(
          SELECT left(m.text, ${PREVIEW_CHARS}) FROM business_messages m
           WHERE m.tenant_id = ${businessConversations.tenantId}
             AND m.conversation_id = ${businessConversations.id}
           ORDER BY m.sent_at DESC, m.telegram_message_id DESC
           LIMIT 1)`,
      })
      .from(businessConversations)
      .innerJoin(
        telegramBusinessConnections,
        and(
          eq(telegramBusinessConnections.tenantId, businessConversations.tenantId),
          eq(telegramBusinessConnections.id, businessConversations.connectionRowId),
        ),
      )
      .leftJoin(
        customers,
        and(
          eq(customers.tenantId, businessConversations.tenantId),
          eq(customers.id, businessConversations.customerId),
        ),
      )
      .where(
        and(
          eq(businessConversations.tenantId, tenantId),
          input.id === undefined ? undefined : eq(businessConversations.id, input.id),
          input.state === undefined ? undefined : eq(businessConversations.state, input.state),
          input.before === undefined
            ? undefined
            : or(
                lt(activity, input.before.at),
                and(
                  sql`${activity} = ${input.before.at}`,
                  lt(businessConversations.id, input.before.id),
                ),
              ),
        ),
      )
      .orderBy(desc(activity), desc(businessConversations.id))
      .limit(input.limit);
    return rows.map((row) => ({
      conversation: toConversation(row.conversation),
      customer: row.customer?.id ? row.customer : null,
      connection: {
        isEnabled: row.connection.isEnabled,
        rights: (row.connection.rights ?? []) as BusinessBotRight[],
        supersededAt: row.connection.supersededAt,
      },
      preview: row.preview,
      activityAt: new Date(row.activityAt),
    }));
  }
}

export class DrizzleBusinessMessageRepository implements BusinessMessageRepository {
  constructor(private readonly db: Database) {}

  async insertIfAbsent(
    scope: ScopeContext,
    row: Parameters<BusinessMessageRepository['insertIfAbsent']>[1],
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const inserted = await executorOf(this.db, tx)
      .insert(businessMessages)
      .values({
        id: row.id,
        tenantId,
        conversationId: row.conversationId,
        telegramMessageId: row.telegramMessageId,
        origin: row.origin,
        kind: row.kind,
        text: row.text,
        sentAt: row.sentAt,
        createdAt: row.now,
      })
      .onConflictDoNothing({
        target: [businessMessages.conversationId, businessMessages.telegramMessageId],
      })
      .returning({ id: businessMessages.id });
    return inserted.length > 0;
  }

  async applyEdit(
    scope: ScopeContext,
    input: Parameters<BusinessMessageRepository['applyEdit']>[1],
    tx: unknown,
  ): Promise<number | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await executorOf(this.db, tx)
      .update(businessMessages)
      .set({
        // Retention already purged this row: an edit does not bring text back (TB2 review N7).
        text: sql`CASE WHEN ${businessMessages.textPurgedAt} IS NULL THEN ${input.text}::text ELSE NULL END`,
        contentVersion: sql`${businessMessages.contentVersion} + 1`,
        editedAt: input.editedAt,
      })
      .where(
        and(
          eq(businessMessages.tenantId, tenantId),
          eq(businessMessages.conversationId, input.conversationId),
          eq(businessMessages.telegramMessageId, input.telegramMessageId),
          isNull(businessMessages.deletedAt),
          // An edit Telegram redelivers, or delivers out of order, never rewinds a newer one.
          or(isNull(businessMessages.editedAt), lt(businessMessages.editedAt, input.editedAt)),
        ),
      )
      .returning({ contentVersion: businessMessages.contentVersion });
    return row?.contentVersion ?? null;
  }

  async relabelOwnEcho(
    scope: ScopeContext,
    input: Parameters<BusinessMessageRepository['relabelOwnEcho']>[1],
    tx: unknown,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    const rows = await executorOf(this.db, tx)
      .update(businessMessages)
      .set({ origin: 'OWN_ECHO' })
      .where(
        and(
          eq(businessMessages.tenantId, tenantId),
          eq(businessMessages.conversationId, input.conversationId),
          eq(businessMessages.telegramMessageId, input.telegramMessageId),
          eq(businessMessages.origin, 'HUMAN'),
        ),
      )
      .returning({ id: businessMessages.id });
    return rows.length;
  }

  async markDeleted(
    scope: ScopeContext,
    input: Parameters<BusinessMessageRepository['markDeleted']>[1],
    tx: unknown,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    if (input.telegramMessageIds.length === 0) return 0;
    const rows = await executorOf(this.db, tx)
      .update(businessMessages)
      .set({ deletedAt: input.now, text: null, textPurgedAt: input.now })
      .where(
        and(
          eq(businessMessages.tenantId, tenantId),
          eq(businessMessages.conversationId, input.conversationId),
          inArray(businessMessages.telegramMessageId, [...input.telegramMessageIds]),
          isNull(businessMessages.deletedAt),
        ),
      )
      .returning({ id: businessMessages.id });
    return rows.length;
  }

  async recent(
    scope: ScopeContext,
    conversationId: string,
    limit: number,
  ): Promise<readonly BusinessMessageRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select()
      .from(businessMessages)
      .where(
        and(
          eq(businessMessages.tenantId, tenantId),
          eq(businessMessages.conversationId, conversationId),
        ),
      )
      .orderBy(desc(businessMessages.sentAt), desc(businessMessages.telegramMessageId))
      .limit(limit);
    return rows.map(toMessage).reverse();
  }

  async purgeText(
    scope: ScopeContext,
    cutoff: Date,
    now: Date,
    limit: number,
    tx: unknown,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    const due = executorOf(this.db, tx)
      .select({ id: businessMessages.id })
      .from(businessMessages)
      .where(
        and(
          eq(businessMessages.tenantId, tenantId),
          isNotNull(businessMessages.text),
          lt(businessMessages.sentAt, cutoff),
        ),
      )
      .orderBy(asc(businessMessages.sentAt))
      .limit(limit);
    const rows = await executorOf(this.db, tx)
      .update(businessMessages)
      .set({ text: null, textPurgedAt: now })
      .where(and(eq(businessMessages.tenantId, tenantId), inArray(businessMessages.id, due)))
      .returning({ id: businessMessages.id });
    return rows.length;
  }
}

export class DrizzleBusinessOutboundRepository implements BusinessOutboundRepository {
  constructor(private readonly db: Database) {}

  async insert(
    scope: ScopeContext,
    row: Parameters<BusinessOutboundRepository['insert']>[1],
    tx: unknown,
  ): Promise<BusinessOutboundRecord> {
    const tenantId = requireTenantId(scope);
    const [inserted] = await executorOf(this.db, tx)
      .insert(businessOutboundMessages)
      .values({
        id: row.id,
        tenantId,
        conversationId: row.conversationId,
        origin: row.origin,
        body: row.body,
        createdByAdminId: row.createdByAdminId,
        controlEpoch: row.controlEpoch,
        idempotencyKey: row.idempotencyKey,
        requestHash: row.requestHash,
        createdAt: row.now,
        updatedAt: row.now,
      })
      .returning();
    if (inserted === undefined)
      throw new Error('business_outbound_messages: insert returned nothing.');
    return toOutbound(inserted);
  }

  async findByIdempotencyKey(
    scope: ScopeContext,
    key: string,
    tx?: unknown,
  ): Promise<BusinessOutboundRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await executorOf(this.db, tx)
      .select()
      .from(businessOutboundMessages)
      .where(
        and(
          eq(businessOutboundMessages.tenantId, tenantId),
          eq(businessOutboundMessages.idempotencyKey, key),
        ),
      )
      .limit(1);
    return row ? toOutbound(row) : null;
  }

  async findById(
    scope: ScopeContext,
    id: string,
    tx?: unknown,
  ): Promise<BusinessOutboundRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await executorOf(this.db, tx)
      .select()
      .from(businessOutboundMessages)
      .where(
        and(eq(businessOutboundMessages.tenantId, tenantId), eq(businessOutboundMessages.id, id)),
      )
      .limit(1);
    return row ? toOutbound(row) : null;
  }

  async recent(
    scope: ScopeContext,
    conversationId: string,
    limit: number,
  ): Promise<readonly BusinessOutboundRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select()
      .from(businessOutboundMessages)
      .where(
        and(
          eq(businessOutboundMessages.tenantId, tenantId),
          eq(businessOutboundMessages.conversationId, conversationId),
        ),
      )
      .orderBy(desc(businessOutboundMessages.createdAt), desc(businessOutboundMessages.id))
      .limit(limit);
    return rows.map(toOutbound).reverse();
  }

  async isOwnMessage(
    scope: ScopeContext,
    input: Parameters<BusinessOutboundRepository['isOwnMessage']>[1],
    tx?: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await executorOf(this.db, tx)
      .select({ id: businessOutboundMessages.id })
      .from(businessOutboundMessages)
      .innerJoin(
        businessConversations,
        and(
          eq(businessConversations.tenantId, businessOutboundMessages.tenantId),
          eq(businessConversations.id, businessOutboundMessages.conversationId),
        ),
      )
      .where(
        and(
          eq(businessOutboundMessages.tenantId, tenantId),
          eq(businessConversations.botInstanceId, input.botInstanceId),
          eq(businessConversations.ownerTelegramUserId, input.ownerTelegramUserId),
          eq(businessConversations.chatId, input.chatId),
          eq(businessOutboundMessages.telegramMessageId, input.telegramMessageId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Candidates then a conditional UPDATE repeating every predicate — the notification lane's
   * shape (`DrizzleCustomerNotificationRepository.claimDue`): two replicas cannot claim one
   * row, and a stamped row (a send in flight or stranded) is never due.
   */
  async claimDue(
    scope: ScopeContext,
    now: Date,
    leaseUntil: Date,
    limit: number,
  ): Promise<readonly BusinessOutboundRecord[]> {
    const tenantId = requireTenantId(scope);
    const ready = or(
      isNull(businessOutboundMessages.nextAttemptAt),
      lte(businessOutboundMessages.nextAttemptAt, now),
    );
    const selected = await this.db
      .select({ id: businessOutboundMessages.id })
      .from(businessOutboundMessages)
      .where(
        and(
          eq(businessOutboundMessages.tenantId, tenantId),
          eq(businessOutboundMessages.state, 'PENDING'),
          isNull(businessOutboundMessages.sendStartedAt),
          ready,
        ),
      )
      .orderBy(asc(businessOutboundMessages.createdAt), asc(businessOutboundMessages.id))
      .limit(limit);
    if (selected.length === 0) return [];
    const rows = await this.db
      .update(businessOutboundMessages)
      .set({ nextAttemptAt: leaseUntil, updatedAt: now })
      .where(
        and(
          eq(businessOutboundMessages.tenantId, tenantId),
          inArray(
            businessOutboundMessages.id,
            selected.map((row) => row.id),
          ),
          eq(businessOutboundMessages.state, 'PENDING'),
          isNull(businessOutboundMessages.sendStartedAt),
          ready,
        ),
      )
      .returning();
    const position = new Map(selected.map((row, index) => [row.id, index]));
    return rows
      .sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0))
      .map(toOutbound);
  }

  async markSendStarted(
    scope: ScopeContext,
    id: string,
    lease: Date | null,
    now: Date,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await executorOf(this.db, tx)
      .update(businessOutboundMessages)
      .set({ sendStartedAt: now, updatedAt: now })
      .where(
        and(
          eq(businessOutboundMessages.tenantId, tenantId),
          eq(businessOutboundMessages.id, id),
          eq(businessOutboundMessages.state, 'PENDING'),
          isNull(businessOutboundMessages.sendStartedAt),
          lease === null
            ? isNull(businessOutboundMessages.nextAttemptAt)
            : eq(businessOutboundMessages.nextAttemptAt, lease),
        ),
      )
      .returning({ id: businessOutboundMessages.id });
    return rows.length > 0;
  }

  async resolve(
    scope: ScopeContext,
    id: string,
    input: Parameters<BusinessOutboundRepository['resolve']>[2],
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await executorOf(this.db, tx)
      .update(businessOutboundMessages)
      .set({
        state: input.state,
        resolvedAt: input.now,
        nextAttemptAt: null,
        ...(input.telegramMessageId === undefined
          ? {}
          : { telegramMessageId: input.telegramMessageId }),
        ...(input.failureCode === undefined ? {} : { failureCode: input.failureCode }),
        ...(input.attempted ? { attempts: sql`${businessOutboundMessages.attempts} + 1` } : {}),
        updatedAt: input.now,
      })
      .where(
        and(
          eq(businessOutboundMessages.tenantId, tenantId),
          eq(businessOutboundMessages.id, id),
          eq(businessOutboundMessages.state, 'PENDING'),
          input.fromStamped
            ? isNotNull(businessOutboundMessages.sendStartedAt)
            : isNull(businessOutboundMessages.sendStartedAt),
        ),
      )
      .returning({ id: businessOutboundMessages.id });
    return rows.length > 0;
  }

  async requeue(
    scope: ScopeContext,
    id: string,
    nextAttemptAt: Date,
    now: Date,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await executorOf(this.db, tx)
      .update(businessOutboundMessages)
      .set({ sendStartedAt: null, nextAttemptAt, updatedAt: now })
      .where(
        and(
          eq(businessOutboundMessages.tenantId, tenantId),
          eq(businessOutboundMessages.id, id),
          eq(businessOutboundMessages.state, 'PENDING'),
          isNotNull(businessOutboundMessages.sendStartedAt),
        ),
      )
      .returning({ id: businessOutboundMessages.id });
    return rows.length > 0;
  }

  async supersedeStale(
    scope: ScopeContext,
    conversationId: string,
    epoch: number,
    now: Date,
    tx: unknown,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    const rows = await executorOf(this.db, tx)
      .update(businessOutboundMessages)
      .set({
        state: 'SUPERSEDED',
        resolvedAt: now,
        nextAttemptAt: null,
        failureCode: 'conversation.moved_on',
        updatedAt: now,
      })
      .where(
        and(
          eq(businessOutboundMessages.tenantId, tenantId),
          eq(businessOutboundMessages.conversationId, conversationId),
          eq(businessOutboundMessages.state, 'PENDING'),
          isNull(businessOutboundMessages.sendStartedAt),
          lt(businessOutboundMessages.controlEpoch, epoch),
        ),
      )
      .returning({ id: businessOutboundMessages.id });
    return rows.length;
  }

  async reapStranded(
    scope: ScopeContext,
    staleBefore: Date,
    now: Date,
    limit: number,
    tx: unknown,
  ): Promise<readonly BusinessOutboundRecord[]> {
    const tenantId = requireTenantId(scope);
    const due = executorOf(this.db, tx)
      .select({ id: businessOutboundMessages.id })
      .from(businessOutboundMessages)
      .where(
        and(
          eq(businessOutboundMessages.tenantId, tenantId),
          eq(businessOutboundMessages.state, 'PENDING'),
          isNotNull(businessOutboundMessages.sendStartedAt),
          lt(businessOutboundMessages.sendStartedAt, staleBefore),
        ),
      )
      .limit(limit);
    const rows = await executorOf(this.db, tx)
      .update(businessOutboundMessages)
      .set({
        state: 'UNCONFIRMED',
        resolvedAt: now,
        nextAttemptAt: null,
        failureCode: 'lane.send_stranded',
        attempts: sql`${businessOutboundMessages.attempts} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(businessOutboundMessages.tenantId, tenantId),
          inArray(businessOutboundMessages.id, due),
          eq(businessOutboundMessages.state, 'PENDING'),
          isNotNull(businessOutboundMessages.sendStartedAt),
        ),
      )
      .returning();
    return rows.map(toOutbound);
  }

  async purgeBodies(
    scope: ScopeContext,
    cutoff: Date,
    now: Date,
    limit: number,
    tx: unknown,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    const due = executorOf(this.db, tx)
      .select({ id: businessOutboundMessages.id })
      .from(businessOutboundMessages)
      .where(
        and(
          eq(businessOutboundMessages.tenantId, tenantId),
          isNotNull(businessOutboundMessages.body),
          lt(businessOutboundMessages.resolvedAt, cutoff),
        ),
      )
      .limit(limit);
    const rows = await executorOf(this.db, tx)
      .update(businessOutboundMessages)
      .set({ body: null, bodyPurgedAt: now, updatedAt: now })
      .where(
        and(
          eq(businessOutboundMessages.tenantId, tenantId),
          inArray(businessOutboundMessages.id, due),
        ),
      )
      .returning({ id: businessOutboundMessages.id });
    return rows.length;
  }
}

export class DrizzleBusinessCustomerLookup implements BusinessCustomerLookup {
  constructor(private readonly db: Database) {}

  async byTelegramUserId(
    scope: ScopeContext,
    telegramUserId: string,
    tx?: unknown,
  ): Promise<{ readonly id: string; readonly status: string } | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await executorOf(this.db, tx)
      .select({ id: customers.id, status: customers.status })
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), eq(customers.telegramUserId, telegramUserId)))
      .limit(1);
    return row ?? null;
  }
}
