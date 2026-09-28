import {
  EVENT_PAYLOAD_SCHEMAS,
  type CorrelationId,
  type DomainEvent,
  type EventType,
  type NotificationDestination,
  type NotificationKind,
  type PermissionKey,
  type TemplateKey,
  type TemplateValues,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import type { EventConsumer } from '../../../platform/eventing/application/event-consumer.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { CustomerRecord, CustomerRepository } from '../../customers/application/ports.js';
import type { TicketRepository } from './ports.js';

/** The operator notification lane, as support notifications need it. `NotificationService` is it. */
export interface SupportNotificationLane {
  queue(
    scope: TenantContext,
    input: {
      readonly kind: NotificationKind;
      readonly dedupeKey: string;
      readonly templateKey: TemplateKey;
      readonly values: TemplateValues;
      readonly correlationId?: string;
      readonly destination?: NotificationDestination;
    },
    tx?: unknown,
  ): Promise<unknown>;
}

/** Who may answer a ticket and could be told about one in Telegram. */
export interface SupportReviewers {
  reviewers(
    scope: TenantContext,
    permission: PermissionKey,
    correlationId: CorrelationId,
    tx?: unknown,
  ): Promise<
    readonly {
      readonly admin: { readonly id: string; readonly telegramUserId: string | null };
    }[]
  >;
}

/** A value the notification has no answer for. Punctuation, not language. */
const NONE = '—';

/**
 * New customer ticket or customer reply → a durable support notification (WP-A7).
 *
 * A CONSUMER of `TicketOpened` and of a customer's `TicketMessagePosted`, so it runs in the
 * relay's transaction after the customer's message committed and never inside it: a
 * notification that cannot be queued costs the customer nothing, and the ticket is in the
 * Web Admin's inbox either way. Database work only — it writes intents into the EXISTING
 * operator notification lane (`NotificationService.queue`), whose dispatcher sends them
 * with its own bounded retries; nothing here touches that lane's delivery.
 *
 * Two kinds of recipient, each an intent of its own:
 *
 * - the operations destination, when one is configured and the lane is switched on — the
 *   log group the operators share;
 * - each Telegram-bound administrator who may reply (`tickets.reply`): the ticket's assignee
 *   alone when it has one who can be reached, everyone who may reply otherwise. Addressed to
 *   the person, the Phase 5T shape, so a default installation with no log group still tells
 *   somebody.
 *
 * The intent's kind is `OPERATIONAL_EVENT` and the `ops.support.*` template key is what
 * makes it a support row — the financial log's reasoning: a new `NOTIFICATION_KINDS` member
 * would be one the previous release's Web Admin refuses after a rollback. It names the ticket
 * and the customer and never the customer's words, which are read in the Web Admin.
 *
 * Idempotent twice over: the relay's `processed_messages` claim, and a dedupe key per event
 * (and per administrator) on `(tenant, dedupe_key)`.
 */
export class TicketSupportNotifyConsumer implements EventConsumer {
  /** Stable: it is the key in `processed_messages`. */
  readonly name = 'tickets.support-notify';
  readonly subscribesTo: readonly EventType[] = ['TicketOpened', 'TicketMessagePosted'];

  constructor(
    private readonly deps: {
      readonly lane: SupportNotificationLane;
      readonly tickets: Pick<TicketRepository, 'findById' | 'findMessageById'>;
      readonly customers: Pick<CustomerRepository, 'findById'>;
      readonly reviewers: SupportReviewers;
    },
  ) {}

  async handle(event: DomainEvent, tx: TransactionScope): Promise<void> {
    if (event.tenantId === null) return;
    const scope: TenantContext = { tenantId: event.tenantId as never, botInstanceId: null };

    let ticketId: string;
    let messageId: string;
    let templateKey: TemplateKey;
    if (event.eventType === 'TicketOpened') {
      const payload = EVENT_PAYLOAD_SCHEMAS.TicketOpened.parse(event.payload);
      ticketId = payload.ticketId;
      messageId = payload.messageId;
      templateKey = 'ops.support.ticket_opened';
    } else {
      const payload = EVENT_PAYLOAD_SCHEMAS.TicketMessagePosted.parse(event.payload);
      // Support's own replies are told to the CUSTOMER, through their lane, not back to support.
      if (payload.senderType !== 'CUSTOMER') return;
      ticketId = payload.ticketId;
      messageId = payload.messageId;
      templateKey = 'ops.support.customer_replied';
    }

    const ticket = await this.deps.tickets.findById(scope, ticketId, tx);
    if (ticket === null) return;
    const message = await this.deps.tickets.findMessageById(scope, messageId, tx);
    const customer = await this.deps.customers.findById(scope, ticket.customerId as UserId, tx);
    const values: TemplateValues = {
      number: ticket.number,
      category: ticket.categoryTitle,
      ...who(customer),
      at: message?.createdAt ?? new Date(event.occurredAt),
    };
    const common = {
      kind: 'OPERATIONAL_EVENT' as const,
      templateKey,
      values,
      correlationId: event.correlationId,
    };

    // The shared operations destination: gated by the lane's own switch and setting.
    await this.deps.lane.queue(scope, { ...common, dedupeKey: `ticket:${event.eventId}` }, tx);

    const reviewers = (
      await this.deps.reviewers.reviewers(
        scope,
        'tickets.reply',
        event.correlationId as CorrelationId,
        tx,
      )
    ).filter((reviewer) => reviewer.admin.telegramUserId !== null);
    const assignee = reviewers.find((reviewer) => reviewer.admin.id === ticket.assignedAdminId);
    for (const reviewer of assignee === undefined ? reviewers : [assignee]) {
      await this.deps.lane.queue(
        scope,
        {
          ...common,
          dedupeKey: `ticket:${event.eventId}:${reviewer.admin.id}`,
          destination: {
            transport: 'TELEGRAM',
            chatId: reviewer.admin.telegramUserId as string,
            topicId: null,
          },
        },
        tx,
      );
    }
  }
}

/** Who wrote, as Telegram knows them. A dash, never a guess, for what is not known. */
function who(customer: CustomerRecord | null): TemplateValues {
  if (customer === null) return { telegramId: NONE, username: NONE, displayName: NONE };
  const name = [customer.firstName, customer.lastName]
    .filter((part): part is string => part !== null && part.trim() !== '')
    .join(' ');
  return {
    telegramId: customer.telegramUserId,
    username: customer.username === null ? NONE : `@${customer.username}`,
    displayName: name === '' ? NONE : name,
  };
}
