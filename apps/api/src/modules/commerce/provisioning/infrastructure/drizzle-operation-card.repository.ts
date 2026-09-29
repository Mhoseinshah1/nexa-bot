import { and, asc, eq, inArray, isNotNull, isNull, lt } from 'drizzle-orm';
import type { BotInstanceId, TenantContext, UserId } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  operationCardMessages,
  provisioningOperations,
} from '../../../../infrastructure/persistence/schema.js';
import {
  CARD_ANSWERED_OPERATIONS,
  type CardMessageRef,
  type ClaimedCard,
  type OperationCardRepository,
} from '../application/operation-card.js';

/**
 * `operation_card_messages` (R3 item 10). Every write is conditional: `attach` is an
 * insert that loses to an existing row, `claim` an UPDATE from `answered_at IS NULL`, and
 * `release` an UPDATE back to it — so two provisioner replicas are safe by construction.
 */
export class DrizzleOperationCardRepository implements OperationCardRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async attach(
    scope: TenantContext,
    operationId: string,
    card: CardMessageRef,
    now: Date,
    tx: TransactionScope,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    await this.exec(tx)
      .insert(operationCardMessages)
      .values({
        tenantId,
        operationId,
        botInstanceId: card.botInstanceId,
        chatId: card.chatId,
        messageId: card.messageId,
        createdAt: now,
      })
      .onConflictDoNothing();
  }

  async hasCard(
    scope: TenantContext,
    operationId: string,
    tx?: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ id: operationCardMessages.operationId })
      .from(operationCardMessages)
      .where(
        and(
          eq(operationCardMessages.tenantId, tenantId),
          eq(operationCardMessages.operationId, operationId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async claim(
    scope: TenantContext,
    operationId: string,
    now: Date,
    tx: TransactionScope,
  ): Promise<ClaimedCard | null> {
    const tenantId = requireTenantId(scope);
    /*
     * The card is answered only for what it is for: a SUCCEEDED disable or enable a
     * customer asked for. Stated in the UPDATE, so no caller can claim a card for an
     * operation that failed or is still running.
     */
    const answerable = this.exec(tx)
      .select({ id: provisioningOperations.id })
      .from(provisioningOperations)
      .where(
        and(
          eq(provisioningOperations.tenantId, tenantId),
          eq(provisioningOperations.id, operationId),
          eq(provisioningOperations.state, 'SUCCEEDED'),
          inArray(provisioningOperations.type, [...CARD_ANSWERED_OPERATIONS]),
          isNotNull(provisioningOperations.requestedByCustomerId),
        ),
      );
    const rows = await this.exec(tx)
      .update(operationCardMessages)
      .set({ answeredAt: now })
      .where(
        and(
          eq(operationCardMessages.tenantId, tenantId),
          eq(operationCardMessages.operationId, operationId),
          isNull(operationCardMessages.answeredAt),
          inArray(operationCardMessages.operationId, answerable),
        ),
      )
      .returning({
        botInstanceId: operationCardMessages.botInstanceId,
        chatId: operationCardMessages.chatId,
        messageId: operationCardMessages.messageId,
      });
    const card = rows[0];
    if (card === undefined) return null;
    const [operation] = await this.exec(tx)
      .select({
        serviceId: provisioningOperations.serviceId,
        requestedBy: provisioningOperations.requestedByCustomerId,
      })
      .from(provisioningOperations)
      .where(
        and(
          eq(provisioningOperations.tenantId, tenantId),
          eq(provisioningOperations.id, operationId),
        ),
      );
    /*
     * The card is drawn for the customer who ASKED, and only while the service is still
     * theirs: a service transferred away in between is not redrawn on the old owner's
     * card (the renderer's ownership read answers null and nothing is sent).
     */
    if (operation === undefined || operation.requestedBy === null) return null;
    return {
      operationId,
      serviceId: operation.serviceId,
      customerId: operation.requestedBy as UserId,
      botInstanceId: card.botInstanceId as BotInstanceId,
      chatId: card.chatId,
      messageId: card.messageId,
    };
  }

  async release(scope: TenantContext, operationId: string, tx: TransactionScope): Promise<void> {
    const tenantId = requireTenantId(scope);
    await this.exec(tx)
      .update(operationCardMessages)
      .set({ answeredAt: null })
      .where(
        and(
          eq(operationCardMessages.tenantId, tenantId),
          eq(operationCardMessages.operationId, operationId),
          isNotNull(operationCardMessages.answeredAt),
        ),
      );
  }

  async dueForAnswer(
    scope: TenantContext,
    before: Date,
    limit: number,
    tx: TransactionScope,
  ): Promise<readonly string[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ id: operationCardMessages.operationId })
      .from(operationCardMessages)
      .innerJoin(
        provisioningOperations,
        and(
          eq(provisioningOperations.tenantId, operationCardMessages.tenantId),
          eq(provisioningOperations.id, operationCardMessages.operationId),
        ),
      )
      .where(
        and(
          eq(operationCardMessages.tenantId, tenantId),
          isNull(operationCardMessages.answeredAt),
          eq(provisioningOperations.state, 'SUCCEEDED'),
          lt(provisioningOperations.completedAt, before),
        ),
      )
      .orderBy(asc(provisioningOperations.completedAt))
      .limit(limit);
    return rows.map((row) => row.id);
  }
}
