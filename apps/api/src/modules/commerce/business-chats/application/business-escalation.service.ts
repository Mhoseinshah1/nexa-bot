import {
  BUSINESS_HANDOFF_REQUIRED_CODE,
  BUSINESS_HANDOFF_RESOLVED_CODE,
  type BusinessEscalationTicketOutcome,
  type BusinessHandoffReason,
  type IdGenerator,
  type OperationalEventRecorder,
  type ScopeContext,
} from '@nexa/contracts';
import type {
  BusinessConversationRecord,
  BusinessConversationRepository,
  BusinessEscalationRepository,
  HandoffDetail,
  HandoffEscalation,
  TicketEscalationPort,
} from './ports.js';

export interface BusinessEscalationServiceDeps {
  readonly escalations: Pick<BusinessEscalationRepository, 'insertIfAbsent'>;
  readonly conversations: Pick<BusinessConversationRepository, 'setTicket'>;
  readonly tickets: TicketEscalationPort;
  readonly opsLog: OperationalEventRecorder;
  readonly ids: IdGenerator;
}

/**
 * TB7 — what a handoff does besides changing who holds the conversation (program §27).
 *
 * Runs INSIDE the transaction that moved the conversation into `HANDOFF_REQUIRED`, so the
 * handoff, its record, its ticket and its operator signal commit together or not at all:
 *
 * - **The ticket is the canonical escalation.** A linked customer's handoff opens a ticket, or
 *   links the conversation's own ticket or the customer's newest active one rather than
 *   opening a duplicate. An unlinked peer gets no ticket — `tickets.customer_id` is NOT NULL
 *   and a business message never creates a customer (tb0-audit §3.5, OQ-TB-40) — and the
 *   handoff is still recorded and signalled.
 * - **One record per handoff**, keyed by the epoch the handoff produced, carrying the AI's short
 *   operator-facing summary when there is one. It is never sent to the customer.
 * - **The operator-visible signal** is `support.handoff_required`, deduplicated per
 *   conversation and recovered when a person takes the conversation or returns it to the AI.
 */
export class BusinessEscalationService implements HandoffEscalation {
  constructor(private readonly deps: BusinessEscalationServiceDeps) {}

  async escalate(
    scope: ScopeContext,
    input: {
      readonly conversation: BusinessConversationRecord;
      readonly reason: BusinessHandoffReason;
      readonly detail: HandoffDetail;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<void> {
    const conversation = input.conversation;
    let ticketId: string | null = null;
    let outcome: BusinessEscalationTicketOutcome = 'NO_CUSTOMER';
    if (conversation.customerId !== null) {
      const result = await this.deps.tickets.escalateFromBusinessChat(
        scope,
        {
          customerId: conversation.customerId,
          botInstanceId: conversation.botInstanceId,
          conversationId: conversation.id,
          currentTicketId: conversation.ticketId,
          controlEpoch: conversation.controlEpoch,
          now: input.now,
        },
        tx,
      );
      ticketId = result.ticketId;
      outcome = result.outcome;
      if (ticketId !== null && ticketId !== conversation.ticketId) {
        await this.deps.conversations.setTicket(scope, conversation.id, ticketId, input.now, tx);
      }
    }
    await this.deps.escalations.insertIfAbsent(
      scope,
      {
        id: this.deps.ids.uuid(),
        conversationId: conversation.id,
        controlEpoch: conversation.controlEpoch,
        reason: input.reason,
        summary: input.detail.summary,
        ticketId,
        ticketOutcome: outcome,
        jobId: input.detail.jobId,
        now: input.now,
      },
      tx,
    );
    await this.deps.opsLog.record(
      scope,
      {
        code: BUSINESS_HANDOFF_REQUIRED_CODE,
        severity: 'WARN',
        message:
          'A Telegram Business conversation was handed to a person; the support AI will not answer it until someone returns it.',
        dedupeKey: `${BUSINESS_HANDOFF_REQUIRED_CODE}:${conversation.id}`,
        // Facts for the operator, never the customer's words or the AI's text.
        context: {
          conversationId: conversation.id,
          reason: input.reason,
          ticketId,
          ticketOutcome: outcome,
        },
      },
      tx,
    );
  }

  async resolved(scope: ScopeContext, conversationId: string, tx: unknown): Promise<void> {
    await this.deps.opsLog.record(
      scope,
      {
        code: BUSINESS_HANDOFF_RESOLVED_CODE,
        severity: 'INFO',
        message:
          'A handed-off Telegram Business conversation was taken by a person or returned to the AI.',
        recoversCode: BUSINESS_HANDOFF_REQUIRED_CODE,
        recoversDedupeKey: `${BUSINESS_HANDOFF_REQUIRED_CODE}:${conversationId}`,
        context: { conversationId },
      },
      tx,
    );
  }
}
