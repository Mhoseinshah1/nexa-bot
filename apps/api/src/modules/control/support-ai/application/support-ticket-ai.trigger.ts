import type { IdGenerator, ScopeContext, SettingKey, TenantContext } from '@nexa/contracts';
import type {
  TicketMessageRecord,
  TicketRecord,
  TicketSupportAiHooks,
} from '../../../commerce/tickets/application/ports.js';
import type { AutoResumePolicy } from '../../../commerce/business-chats/application/ports.js';
import { ticketAiGate } from '../domain/ticket-ai-gate.js';
import type { DrizzleSupportAiConfigRepository } from '../infrastructure/drizzle-support-ai.repository.js';
import type { DrizzleSupportAiTicketRepository } from '../infrastructure/drizzle-support-ai-ticket.repository.js';

export const SUPPORT_AI_TICKETS_ENABLED_KEY = 'support.ai.tickets_enabled' satisfies SettingKey;

export interface SupportTicketAiTriggerDeps {
  readonly settings: {
    valueOf<T>(scope: ScopeContext, key: SettingKey, tx?: unknown): Promise<T>;
  };
  readonly configs: Pick<DrizzleSupportAiConfigRepository, 'get'>;
  readonly tickets: Pick<
    DrizzleSupportAiTicketRepository,
    'hold' | 'writeHold' | 'activity' | 'queued' | 'insert' | 'finish' | 'lastAiReplyAt'
  >;
  /** The Business chats' own resume window (`support.ai.resume_after_minutes`). */
  readonly resume: Pick<AutoResumePolicy, 'resumeAfterMinutes'>;
  readonly ids: IdGenerator;
  readonly clock: { now(): Date };
}

/**
 * Phase 4 PR-4 — the ticket service's one call into the support AI, made in the customer's own
 * transaction after their message is written.
 *
 *   - **Off means nothing.** With `support.ai.tickets_enabled` off (the default), or the support
 *     AI not in the automatic mode, this returns before it reads or writes anything else.
 *   - Only a ticket the customer opened themselves (`BOT`) is answered: a ticket the support
 *     agent escalated from a Business chat was handed to a person on purpose.
 *   - The gate (`ticketAiGate`, the Business chats' resume rule) decides whether the AI may
 *     answer: a person's reply or a handoff holds the ticket; a SOFT hold ends by itself, a
 *     HARD one never does.
 *   - The job is coalesced like a Business one: a newer customer message replaces the pending
 *     job (it is finished as `dropped_coalesced`), and the new job is due a settle delay later.
 */
export class SupportTicketAiTrigger implements TicketSupportAiHooks {
  constructor(private readonly deps: SupportTicketAiTriggerDeps) {}

  async customerMessagePosted(
    scope: TenantContext,
    input: { readonly ticket: TicketRecord; readonly message: TicketMessageRecord },
    tx: unknown,
  ): Promise<void> {
    const { ticket, message } = input;
    if (!(await this.deps.settings.valueOf<boolean>(scope, SUPPORT_AI_TICKETS_ENABLED_KEY, tx))) {
      return;
    }
    if (ticket.origin !== 'BOT' || ticket.status === 'CLOSED') return;
    const { config } = await this.deps.configs.get(scope, tx);
    if (config.mode !== 'AUTO_REPLY_SAFE') return;
    const now = this.deps.clock.now();
    const [hold, activity, windowMinutes] = await Promise.all([
      this.deps.tickets.hold(scope, ticket.id, tx),
      this.deps.tickets.activity(scope, ticket.id, tx),
      this.deps.resume.resumeAfterMinutes(scope, tx),
    ]);
    const gate = ticketAiGate({
      hold,
      lastAdminAt: activity.lastAdminAt,
      previousMessageAt: activity.previousMessageAt,
      windowMinutes,
      now,
    });
    if (gate.kind === 'PAUSED') return;
    if (gate.kind === 'RESUME') {
      await this.deps.tickets.writeHold(
        scope,
        {
          ticketId: ticket.id,
          state: 'AI_ACTIVE',
          epoch: gate.epoch,
          handoffKind: null,
          handoffReason: null,
          heldAt: now,
        },
        now,
        tx,
      );
    }
    const pending = await this.deps.tickets.queued(scope, ticket.id, tx);
    if (pending !== null) {
      await this.deps.tickets.finish(scope, pending.id, { outcome: 'dropped_coalesced', now }, tx);
    }
    const lastAiAt = await this.deps.tickets.lastAiReplyAt(scope, ticket.id, tx);
    const settle = now.getTime() + config.settleDelaySeconds * 1000;
    const cooled = lastAiAt === null ? 0 : lastAiAt.getTime() + config.cooldownSeconds * 1000;
    await this.deps.tickets.insert(
      scope,
      {
        id: this.deps.ids.uuid(),
        ticketId: ticket.id,
        triggerMessageId: message.id,
        epoch: gate.epoch,
        // The later of the settle delay and the owner's cooldown after the AI's last answer in
        // this ticket — the Business chats' pacing and provider-cost protection.
        dueAt: new Date(Math.max(settle, cooled)),
        now,
      },
      tx,
    );
  }
}
