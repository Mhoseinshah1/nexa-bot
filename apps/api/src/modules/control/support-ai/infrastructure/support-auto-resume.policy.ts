import { and, eq, inArray, sql } from 'drizzle-orm';
import type { ScopeContext, SettingKey } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  businessConversationEscalations,
  businessOutboundMessages,
  tickets,
} from '../../../../infrastructure/persistence/schema.js';
import type { AutoResumePolicy } from '../../../commerce/business-chats/application/ports.js';
import type { DrizzleSupportAiConfigRepository } from './drizzle-support-ai.repository.js';

export const SUPPORT_AI_RESUME_AFTER_MINUTES_KEY =
  'support.ai.resume_after_minutes' satisfies SettingKey;

/**
 * Phase 4 PR-1 — the facts business-chats reads to return a SOFT hold to the AI. Reads only,
 * each in the inbound message's transaction. The window is 0 (never) unless the support AI is in
 * `AUTO_REPLY_SAFE`: a conversation nobody would answer automatically stays with its person.
 */
export class SupportAutoResumePolicy implements AutoResumePolicy {
  constructor(
    private readonly deps: {
      readonly db: Database;
      readonly configs: Pick<DrizzleSupportAiConfigRepository, 'get'>;
      readonly settings: {
        valueOf<T>(scope: ScopeContext, key: SettingKey, tx?: unknown): Promise<T>;
      };
    },
  ) {}

  async resumeAfterMinutes(scope: ScopeContext, tx: unknown): Promise<number> {
    const { config } = await this.deps.configs.get(scope, tx);
    if (config.mode !== 'AUTO_REPLY_SAFE') return 0;
    const minutes = await this.deps.settings.valueOf<number>(
      scope,
      SUPPORT_AI_RESUME_AFTER_MINUTES_KEY,
      tx,
    );
    return Number.isInteger(minutes) && minutes > 0 ? minutes : 0;
  }

  async ticketClosed(scope: ScopeContext, ticketId: string, tx: unknown): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.executor(tx)
      .select({ status: tickets.status })
      .from(tickets)
      .where(and(eq(tickets.tenantId, tenantId), eq(tickets.id, ticketId)));
    return row?.status === 'CLOSED';
  }

  async holdActivityAt(
    scope: ScopeContext,
    conversationId: string,
    epoch: number,
    tx: unknown,
  ): Promise<Date | null> {
    const tenantId = requireTenantId(scope);
    const db = this.executor(tx);
    const [handoff] = await db
      .select({ at: sql<Date | null>`max(${businessConversationEscalations.createdAt})` })
      .from(businessConversationEscalations)
      .where(
        and(
          eq(businessConversationEscalations.tenantId, tenantId),
          eq(businessConversationEscalations.conversationId, conversationId),
          eq(businessConversationEscalations.controlEpoch, epoch),
        ),
      );
    const [reply] = await db
      .select({ at: sql<Date | null>`max(${businessOutboundMessages.createdAt})` })
      .from(businessOutboundMessages)
      .where(
        and(
          eq(businessOutboundMessages.tenantId, tenantId),
          eq(businessOutboundMessages.conversationId, conversationId),
          eq(businessOutboundMessages.controlEpoch, epoch),
          inArray(businessOutboundMessages.origin, ['OPERATOR', 'ASSIST']),
        ),
      );
    const times = [handoff?.at, reply?.at]
      .filter((at): at is Date => at !== null && at !== undefined)
      .map((at) => new Date(at).getTime());
    return times.length === 0 ? null : new Date(Math.max(...times));
  }

  private executor(tx: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.deps.db;
  }
}
