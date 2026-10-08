import { createHash } from 'node:crypto';
import {
  COMMERCE_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  TICKET_ATTACHMENT_FILE_NAME_MAX_LENGTH,
  TICKET_CUSTOMER_LIST_LIMIT,
  TICKET_ERROR_CODES,
  TICKET_MESSAGES_MAX_PER_TICKET,
  TICKET_OPEN_MAX_PER_CUSTOMER,
  TICKET_AWAITING_SUPPORT_STATUSES,
  TICKET_PAGE_MAX,
  TICKET_REPLY_FILE_STAGED_MAX_BYTES,
  errors,
  isNexaError,
  isTicketTextWithinBound,
  normalizeTicketText,
  telegramUserIdSchema,
  ticketAttachmentRefusal,
  ticketManualEvent,
  ticketReplyFileNameOf,
  ticketReplyFileRefusal,
  ticketReplyFileTypeOf,
  ticketStatusAfterMessage,
  ticketSubjectOf,
  uuidV7Schema,
  systemJobActor,
  type ActorContext,
  type Admin,
  type AdminId,
  type AuditWriter,
  type BotInstanceId,
  type Clock,
  type CorrelationId,
  type IdGenerator,
  type OperationalEventRecorder,
  type PermissionKey,
  type TemplateValues,
  type TenantContext,
  type TicketAttachmentKind,
  type TicketCategoryId,
  type TicketId,
  type TicketMessageId,
  type TicketPriority,
  type TicketReplyAttachment,
  type TicketReplyFileMimeType,
  type TicketStatus,
  type TicketSystemEvent,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import type {
  PermissionGuard,
  PermissionResolver,
} from '../../../platform/access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
  type MutationDenial,
} from '../../../platform/access/application/authorized-mutation.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type {
  AdminRepository,
  SessionRepository,
} from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { CustomerNotifier } from '../../messaging/application/customer-notifier.js';
import type { CustomerRecord, CustomerRepository } from '../../customers/application/ports.js';
import type {
  TicketAttachmentRecord,
  TicketCategoryRepository,
  TicketContextReader,
  TicketEscalationReader,
  TicketListItem,
  TicketMessageListItem,
  TicketMessageRecord,
  TicketRecord,
  TicketReplyFileRecord,
  TicketRepository,
} from './ports.js';
import { TICKETS_VIEW_PERMISSION } from './ticket-category.service.js';

const REPLY_PERMISSION = 'tickets.reply' satisfies PermissionKey;
const ASSIGN_PERMISSION = 'tickets.assign' satisfies PermissionKey;
const CLOSE_PERMISSION = 'tickets.close' satisfies PermissionKey;
/**
 * A customer's own write, through the webhook's `SYSTEM_JOB` — the permission every
 * customer-initiated write charges (`ORDER_PLACE_PERMISSION`, the refund filing). Ownership
 * is the authorization; the guard still runs, deny by default.
 */
const CUSTOMER_PERMISSION: PermissionKey = 'maintenance.run';

/** A file from Telegram, as the surface read it. Nothing here is trusted until judged. */
export interface InboundTicketFile {
  readonly kind: TicketAttachmentKind;
  readonly fileId: string;
  readonly fileUniqueId: string;
  readonly mimeType: string | null;
  readonly fileName: string | null;
  readonly fileSize: bigint | null;
}

export interface TicketPosted {
  readonly ticket: TicketRecord;
  readonly message: TicketMessageRecord;
  /** True when this call answered an earlier one with the same key and wrote nothing. */
  readonly replayed: boolean;
}

export interface TicketChanged {
  readonly ticket: TicketRecord;
  readonly changed: boolean;
}

/** Who may read the AI's escalation note (the business-chats module's view permission). */
const BUSINESS_CHATS_VIEW_PERMISSION = 'business_chats.view' satisfies PermissionKey;

export interface TicketDetail {
  readonly item: TicketListItem;
  readonly messages: readonly TicketMessageListItem[];
  readonly customer: CustomerRecord | null;
  /** TB7: the business-chat handoffs attached to it, newest first. */
  readonly escalations: Awaited<ReturnType<TicketEscalationReader['forTicket']>>;
}

/** TB7: what a business-chat handoff did about a ticket. */
export type TicketEscalationOutcome =
  'CREATED' | 'LINKED' | 'NO_CUSTOMER' | 'CUSTOMER_BLOCKED' | 'NO_CATEGORY' | 'SCOPE_INACTIVE';

export interface TicketServiceDeps {
  readonly tickets: TicketRepository;
  readonly categories: Pick<TicketCategoryRepository, 'findById' | 'list'>;
  readonly escalations: TicketEscalationReader;
  /** TB7: the default categories, seeded in the escalation's transaction if never seeded. */
  readonly categorySeeder: { seedIn(scope: TenantContext, tx: TransactionScope): Promise<void> };
  readonly customers: Pick<CustomerRepository, 'findById' | 'list'>;
  readonly context: TicketContextReader;
  readonly admins: Pick<AdminRepository, 'findById' | 'list'>;
  readonly permissions: Pick<PermissionResolver, 'resolve'>;
  readonly notifier: Pick<CustomerNotifier, 'notifyThrough'>;
  readonly outbox: OutboxWriter;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly guard: PermissionGuard;
  readonly sessions: SessionRepository;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * WP-A7 — the support ticket system (`docs/wp-a7-tickets-audit.md`). The ONE implementation
 * the bot and the Web Admin call: neither surface holds a rule of its own.
 *
 * Four rules, each a way to lose a conversation or show it to the wrong person:
 *
 * - **A message is a row before it is anything else.** Every message — the customer's, an
 *   administrator's, a system fact — is written in the transaction that changes the ticket,
 *   and nothing about Telegram is. An administrator's reply enqueues a `TICKET_REPLY` on the
 *   customer notification lane in the same transaction; the lane sends it later, retries it
 *   on its own schedule, and whatever it does the reply is in the ticket.
 * - **Every message is idempotent by its command's key**, stored on the row: a redelivered
 *   update, a double-clicked Send, two replicas — one row, and the same key with different
 *   words is refused rather than answered with the old one.
 * - **Every status write is a conditional UPDATE naming its `from`**, under the ticket's row
 *   lock, on an edge `TICKET_MACHINE` declares.
 * - **A customer reaches only their own tickets, in their own tenant**, and another's is
 *   "not found" — one answer, no oracle.
 */
export class TicketService {
  constructor(private readonly deps: TicketServiceDeps) {}

  // --- TB7: the support agent's escalation of a Telegram Business conversation -----------

  /**
   * Opens a ticket for a handed-off business conversation, or links the active one — in the
   * CALLER's transaction (the handoff's), so the handoff and its ticket commit together.
   *
   * - The conversation's own ticket, while still active, is linked again.
   * - Otherwise the customer's newest active ticket is linked rather than duplicated.
   * - Otherwise a ticket is opened (`origin = BUSINESS_CHAT`), idempotent on
   *   `business-conversation:<id>:escalation:<epoch>`, with one SYSTEM fact and no customer
   *   words: the transcript stays in the conversation under its 30-day retention.
   * - A blocked customer, a tenant with no active category, or a stopped tenant gets no ticket;
   *   the handoff still happens. Nothing here throws for a business reason, because a refused
   *   ticket must never undo the handoff it belongs to.
   *
   * The linked ticket records the handoff as a SYSTEM fact too, once per handoff.
   */
  async escalateFromBusinessChat(
    scope: TenantContext,
    input: {
      readonly customerId: string;
      readonly botInstanceId: string;
      readonly conversationId: string;
      readonly currentTicketId: string | null;
      readonly controlEpoch: number;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<{ readonly ticketId: string | null; readonly outcome: TicketEscalationOutcome }> {
    const scoped = tx as TransactionScope;
    const actor = systemJobActor(
      `business-escalation:${input.conversationId}`,
      input.conversationId as CorrelationId,
    );
    if (!(await this.deps.scopeActivity.scopeIsActive(scope, scoped))) {
      return { ticketId: null, outcome: 'SCOPE_INACTIVE' };
    }
    await this.deps.guard.check(scope, actor, CUSTOMER_PERMISSION, scoped);
    const customerId = input.customerId as UserId;
    const customer = await this.deps.customers.findById(scope, customerId, scoped);
    if (customer === null) return { ticketId: null, outcome: 'NO_CUSTOMER' };
    if (customer.status === 'BLOCKED') return { ticketId: null, outcome: 'CUSTOMER_BLOCKED' };
    await this.deps.tickets.lockCustomer(scope, customerId, scoped);
    const key = `business-conversation:${input.conversationId}:escalation:${input.controlEpoch}`;

    const own =
      input.currentTicketId === null
        ? null
        : await this.deps.tickets.findByIdForUpdate(scope, input.currentTicketId, scoped);
    const linkable =
      own !== null && own.customerId === customerId && own.status !== 'CLOSED'
        ? own
        : await this.deps.tickets.latestActiveForCustomer(scope, customerId, scoped);
    if (linkable !== null) {
      await this.recordEscalationFact(scope, actor, scoped, linkable.id, key, input.now);
      return { ticketId: linkable.id, outcome: 'LINKED' };
    }

    const replayed = await this.deps.tickets.findByOpeningKey(scope, key, scoped);
    if (replayed !== null) return { ticketId: replayed.id, outcome: 'LINKED' };
    let [category] = await this.deps.categories.list(scope, { activeOnly: true }, scoped);
    if (category === undefined) {
      // A tenant whose customers never opened the ticket menu has never been seeded. One that
      // was seeded and deactivated every category decided that, and is not re-seeded.
      // Never throws for a business reason (substitute review of PR #202, finding 3): an
      // operator override that renders an unusable default title refuses the SEED — which has
      // then written nothing — and the handoff goes on with no ticket (`NO_CATEGORY`), recorded
      // and signalled. A throw here would roll the handoff back with it.
      if (!(await this.seedQuietly(scope, scoped)))
        return { ticketId: null, outcome: 'NO_CATEGORY' };
      [category] = await this.deps.categories.list(scope, { activeOnly: true }, scoped);
    }
    if (category === undefined) return { ticketId: null, outcome: 'NO_CATEGORY' };
    const ticket = await this.deps.tickets.create(
      scope,
      {
        id: this.deps.ids.uuid() as TicketId,
        customerId,
        botInstanceId: input.botInstanceId as BotInstanceId,
        categoryId: category.id,
        categoryTitle: category.title,
        subject: null,
        openingKey: key,
        origin: 'BUSINESS_CHAT',
        now: input.now,
      },
      scoped,
    );
    const message = await this.recordEscalationFact(
      scope,
      actor,
      scoped,
      ticket.id,
      key,
      input.now,
    );
    await this.deps.outbox.write(scoped, actor, {
      eventType: 'TicketOpened',
      aggregateType: 'Ticket',
      aggregateId: ticket.id,
      payload: {
        ticketId: ticket.id,
        customerId: ticket.customerId,
        categoryId: ticket.categoryId,
        messageId: message?.id ?? ticket.id,
      },
    });
    await this.deps.audit.record(
      scope,
      actor,
      {
        action: 'ticket.escalate',
        entityType: 'Ticket',
        entityId: ticket.id,
        before: null,
        after: {
          customerId: ticket.customerId,
          categoryId: ticket.categoryId,
          origin: 'BUSINESS_CHAT',
          conversationId: input.conversationId,
        },
        result: 'SUCCESS',
      },
      scoped,
    );
    return { ticketId: ticket.id, outcome: 'CREATED' };
  }

  /** The default categories' seed, in the caller's transaction; false when it was refused. */
  private async seedQuietly(scope: TenantContext, tx: TransactionScope): Promise<boolean> {
    try {
      await this.deps.categorySeeder.seedIn(scope, tx);
      return true;
    } catch (error: unknown) {
      if (isNexaError(error) && error.code === TICKET_ERROR_CODES.TICKET_CATEGORY_INVALID) {
        return false;
      }
      throw error;
    }
  }

  /** The SYSTEM fact of a handoff, once per handoff key; skipped when the ticket is full. */
  private async recordEscalationFact(
    scope: TenantContext,
    actor: ActorContext,
    tx: TransactionScope,
    ticketId: TicketId,
    key: string,
    now: Date,
  ): Promise<TicketMessageRecord | null> {
    if (
      (await this.deps.tickets.countMessages(scope, ticketId, tx)) >= TICKET_MESSAGES_MAX_PER_TICKET
    ) {
      return null;
    }
    const message = await this.deps.tickets.insertMessage(
      scope,
      {
        id: this.deps.ids.uuid() as TicketMessageId,
        ticketId,
        senderType: 'SYSTEM',
        authorAdminId: null,
        body: null,
        systemEvent: 'ESCALATED_FROM_BUSINESS_CHAT',
        attachment: null,
        idempotencyKey: key,
        requestHash: hashRequest({ op: 'escalate', ticketId, key }),
        now,
      },
      tx,
    );
    if (message === null) return null;
    await this.deps.audit.record(
      scope,
      actor,
      {
        action: 'ticket.escalation_recorded',
        entityType: 'Ticket',
        entityId: ticketId,
        before: null,
        after: { messageId: message.id, key },
        result: 'SUCCESS',
      },
      tx,
    );
    return message;
  }

  // --- the customer, through the bot ------------------------------------------------------

  /** Opens a ticket with its first message. Replays answer with that ticket. */
  async openByCustomer(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly customerId: UserId;
      readonly botInstanceId: BotInstanceId;
      readonly categoryId: string;
      readonly text: string | null;
      readonly file: InboundTicketFile | null;
      readonly idempotencyKey: string;
    },
  ): Promise<TicketPosted> {
    const denial = { action: 'ticket.open', entityType: 'Ticket', entityId: null };
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      CUSTOMER_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        await this.assertCustomerActive(scope, input.customerId, tx);
        // Serialise this customer's openings first, so the replay check and the open-ticket
        // rail below both see a concurrent opening that committed while this one waited.
        await this.deps.tickets.lockCustomer(scope, input.customerId, tx);
        const replayed = await this.deps.tickets.findByOpeningKey(scope, input.idempotencyKey, tx);
        /*
         * The category is decided BEFORE the content (Codex review of #96): a category hidden
         * since the prompt is an answer ("choose again"), and judging the words first would
         * answer "send it again" and reopen a window for a category that no longer takes one.
         */
        const categoryId = uuidV7Schema.safeParse(input.categoryId);
        const category =
          replayed !== null
            ? null
            : categoryId.success
              ? await this.deps.categories.findById(scope, categoryId.data, tx)
              : null;
        if (replayed === null && (category === null || !category.isActive)) {
          throw errors.notFound(
            TICKET_ERROR_CODES.TICKET_CATEGORY_NOT_FOUND,
            'No active ticket category with that id.',
          );
        }
        const content = this.customerContent(input.text, input.file, input.botInstanceId);
        const requestHash = hashRequest({
          op: 'open',
          customerId: input.customerId,
          categoryId: input.categoryId,
          body: content.body,
          file: content.attachment?.fileUniqueId ?? null,
        });
        if (replayed !== null) {
          const first = await this.deps.tickets.findMessageByKey(scope, input.idempotencyKey, tx);
          if (
            first === null ||
            replayed.customerId !== input.customerId ||
            replayed.botInstanceId !== input.botInstanceId
          ) {
            throw this.keyReused();
          }
          this.assertSameRequest(first, requestHash);
          return { ticket: replayed, message: first, replayed: true };
        }
        /* istanbul ignore next -- refused above whenever there is no replay. */
        if (category === null) throw this.notFound();
        const open = await this.deps.tickets.countActiveForCustomer(
          scope,
          input.customerId,
          input.botInstanceId,
          tx,
        );
        if (open >= TICKET_OPEN_MAX_PER_CUSTOMER) {
          throw errors.conflict(
            TICKET_ERROR_CODES.TICKET_OPEN_LIMIT,
            'This customer already has the most open tickets allowed.',
            { max: TICKET_OPEN_MAX_PER_CUSTOMER },
          );
        }
        const now = this.deps.clock.now();
        const ticket = await this.deps.tickets.create(
          scope,
          {
            id: this.deps.ids.uuid() as TicketId,
            customerId: input.customerId,
            botInstanceId: input.botInstanceId,
            categoryId: category.id,
            categoryTitle: category.title,
            subject: ticketSubjectOf(content.body),
            openingKey: input.idempotencyKey,
            now,
          },
          tx,
        );
        const message = await this.insertOrThrow(
          scope,
          {
            id: this.deps.ids.uuid() as TicketMessageId,
            ticketId: ticket.id,
            senderType: 'CUSTOMER',
            authorAdminId: null,
            body: content.body,
            systemEvent: null,
            attachment: content.attachment,
            idempotencyKey: input.idempotencyKey,
            requestHash,
            now,
          },
          tx,
        );
        await this.deps.outbox.write(tx, actor, {
          eventType: 'TicketOpened',
          aggregateType: 'Ticket',
          aggregateId: ticket.id,
          payload: {
            ticketId: ticket.id,
            customerId: ticket.customerId,
            categoryId: ticket.categoryId,
            messageId: message.id,
          },
        });
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'ticket.open',
            entityType: 'Ticket',
            entityId: ticket.id,
            before: null,
            // The customer's words are on the row; the audit names the facts, not the text.
            after: {
              customerId: ticket.customerId,
              categoryId: ticket.categoryId,
              messageId: message.id,
              attachment: message.attachment?.kind ?? null,
            },
            result: 'SUCCESS',
          },
          tx,
        );
        return { ticket, message, replayed: false };
      },
    );
  }

  /** The customer writes in one of their own tickets. A CLOSED ticket refuses. */
  async replyByCustomer(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly customerId: UserId;
      readonly botInstanceId: BotInstanceId;
      readonly ticketId: string;
      readonly text: string | null;
      readonly file: InboundTicketFile | null;
      readonly idempotencyKey: string;
    },
  ): Promise<TicketPosted> {
    const denial = { action: 'ticket.customer_message', entityType: 'Ticket', entityId: null };
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      CUSTOMER_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        await this.assertCustomerActive(scope, input.customerId, tx);
        const ticket = await this.ownedForUpdate(
          scope,
          input.customerId,
          input.botInstanceId,
          input.ticketId,
          tx,
        );
        /*
         * A CLOSED ticket is decided BEFORE the content (Codex review of #96). Support may
         * close the ticket after the customer opened the reply prompt; judging the words
         * first answered a blank or oversized message with "send it again" and reopened the
         * window for a ticket that refuses every message. A redelivery of a message that WAS
         * written still answers with that message.
         */
        const written = await this.deps.tickets.findMessageByKey(scope, input.idempotencyKey, tx);
        if (written === null && ticket.status === 'CLOSED') throw this.closed();
        const content = this.customerContent(input.text, input.file, input.botInstanceId);
        const requestHash = hashRequest({
          op: 'customer-reply',
          ticketId: input.ticketId.toLowerCase(),
          body: content.body,
          file: content.attachment?.fileUniqueId ?? null,
        });
        const replay = await this.replayOf(scope, input.idempotencyKey, requestHash, ticket, tx);
        if (replay !== null) return replay;
        return this.post(scope, actor, tx, ticket, {
          senderType: 'CUSTOMER',
          authorAdminId: null,
          body: content.body,
          attachment: content.attachment,
          idempotencyKey: input.idempotencyKey,
          requestHash,
          audit: 'ticket.customer_message',
        });
      },
    );
  }

  /** The customer closes one of their own tickets. Closing a closed one changes nothing. */
  async closeByCustomer(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly customerId: UserId;
      readonly botInstanceId: BotInstanceId;
      readonly ticketId: string;
    },
  ): Promise<TicketChanged> {
    const denial = { action: 'ticket.close', entityType: 'Ticket', entityId: null };
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      CUSTOMER_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        // Blocked after the surface resolved them: refused here, as opening and replying are.
        await this.assertCustomerActive(scope, input.customerId, tx);
        const ticket = await this.ownedForUpdate(
          scope,
          input.customerId,
          input.botInstanceId,
          input.ticketId,
          tx,
        );
        if (ticket.status === 'CLOSED') return { ticket, changed: false };
        const moved = await this.move(scope, actor, tx, ticket, 'CLOSED', 'CLOSED_BY_CUSTOMER');
        return { ticket: moved, changed: true };
      },
    );
  }

  /**
   * The customer's own tickets opened through THIS bot, for its list: active first, then the
   * newest. Every customer-facing read and write names the bot and matches the ticket's —
   * a ticket from another of the tenant's bots is, to this one, a ticket that does not exist.
   */
  async customerTickets(
    scope: TenantContext,
    customerId: UserId,
    botInstanceId: BotInstanceId,
  ): Promise<readonly TicketRecord[]> {
    return this.deps.tickets.listForCustomer(
      scope,
      customerId,
      botInstanceId,
      TICKET_CUSTOMER_LIST_LIMIT,
    );
  }

  /**
   * One of the customer's own tickets, opened through this bot, and its latest messages; or
   * null — the same null for another customer's ticket and another bot's.
   */
  async customerTicket(
    scope: TenantContext,
    customerId: UserId,
    botInstanceId: BotInstanceId,
    ticketId: string,
    messageCount: number,
  ): Promise<{
    readonly ticket: TicketRecord;
    readonly messages: readonly TicketMessageRecord[];
    readonly messageCount: number;
    /** Which of `messages` carry a file from support (HF-A7). */
    readonly filed: ReadonlySet<string>;
  } | null> {
    const id = uuidV7Schema.safeParse(ticketId);
    if (!id.success) return null;
    const ticket = await this.deps.tickets.findById(scope, id.data);
    if (
      ticket === null ||
      ticket.customerId !== customerId ||
      ticket.botInstanceId !== botInstanceId
    ) {
      return null;
    }
    const latest = await this.deps.tickets.latestMessages(scope, ticket.id, messageCount);
    return {
      ticket,
      messages: latest.messages,
      messageCount: latest.messageCount,
      filed: latest.filed,
    };
  }

  /**
   * What `TICKET_REPLY` renders, read from the MESSAGE ROW the notification names: the
   * ticket's number and category and the reply's text exactly as stored. Null when the row
   * is not an administrator's reply — the dispatcher then sends nothing rather than guess.
   *
   * Unguarded like `ServiceRefundRequestService.notificationValues`: its one caller is the
   * notification lane, which acts on a row a guarded write enqueued.
   */
  async notificationFacts(
    scope: TenantContext,
    messageId: string,
  ): Promise<{ readonly values: TemplateValues; readonly ticketId: string } | null> {
    const message = await this.deps.tickets.findMessageById(scope, messageId);
    if (message === null || message.senderType !== 'ADMIN' || message.body === null) return null;
    const ticket = await this.deps.tickets.findById(scope, message.ticketId);
    if (ticket === null) return null;
    return {
      values: { number: ticket.number, category: ticket.categoryTitle, text: message.body },
      ticketId: ticket.id,
    };
  }

  /**
   * HF-A7: what `TICKET_REPLY_ATTACHMENT` sends — support's file, its type and its name, and
   * the caption's ticket number and category — read from the file's row and the ticket by
   * the MESSAGE id the notification names. Null when there is no such file or its bytes were
   * already cleared: the dispatcher then fails the row rather than send anything else.
   *
   * Unguarded, for `notificationFacts`' reason: its one caller is the notification lane.
   */
  async attachmentFacts(
    scope: TenantContext,
    messageId: string,
  ): Promise<{
    readonly values: TemplateValues;
    readonly ticketId: string;
    readonly file: {
      readonly kind: TicketAttachmentKind;
      readonly bytes: Uint8Array;
      readonly fileName: string;
      readonly mimeType: TicketReplyFileMimeType;
    };
  } | null> {
    const file = await this.deps.tickets.findReplyFile(scope, messageId);
    if (file === null || !file.staged) return null;
    const [ticket, bytes] = await Promise.all([
      this.deps.tickets.findById(scope, file.ticketId),
      this.deps.tickets.replyFileContent(scope, messageId),
    ]);
    if (ticket === null || bytes === null) return null;
    return {
      values: { number: ticket.number, category: ticket.categoryTitle },
      ticketId: ticket.id,
      file: { kind: file.kind, bytes, fileName: file.fileName, mimeType: file.mimeType },
    };
  }

  /**
   * HF-A7: Telegram accepted support's file. Its `file_id` is stamped and the bytes cleared,
   * in the transaction that records the delivery — from here the Web Admin reads the file
   * back from Telegram, and the staging area holds nothing for it. Called by the lane only.
   */
  async attachmentDelivered(
    scope: TenantContext,
    messageId: string,
    file: { readonly fileId: string; readonly fileUniqueId: string },
    at: Date,
    tx: TransactionScope,
  ): Promise<boolean> {
    return this.deps.tickets.markReplyFileDelivered(scope, messageId, file, at, tx);
  }

  // --- support, through the Web Admin -----------------------------------------------------

  async list(
    scope: TenantContext,
    actor: ActorContext,
    query: {
      readonly status?: TicketStatus;
      /** Roadmap B5/B6 (review N1): only tickets whose next word is support's. */
      readonly awaitingSupport?: boolean;
      readonly categoryId?: string;
      readonly customer?: string;
      readonly assigned?: string;
      readonly from?: Date;
      readonly to?: Date;
      readonly before?: { readonly at: Date; readonly id: string };
      readonly limit: number;
    },
  ): Promise<readonly TicketListItem[]> {
    await this.deps.guard.check(scope, actor, TICKETS_VIEW_PERMISSION);
    const assigned =
      query.assigned === undefined
        ? undefined
        : query.assigned === 'none'
          ? null
          : query.assigned === 'me'
            ? (this.adminIdOf(actor) as AdminId)
            : (query.assigned as AdminId);
    return this.deps.tickets.list(scope, {
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.awaitingSupport === true ? { statuses: TICKET_AWAITING_SUPPORT_STATUSES } : {}),
      ...(query.categoryId === undefined
        ? {}
        : { categoryId: query.categoryId as TicketCategoryId }),
      ...(query.customer === undefined
        ? {}
        : { customerId: await this.customerNamed(scope, query.customer) }),
      ...(assigned === undefined ? {} : { assignedAdminId: assigned }),
      ...(query.from === undefined ? {} : { from: query.from }),
      ...(query.to === undefined ? {} : { to: query.to }),
      ...(query.before === undefined ? {} : { before: query.before }),
      limit: Math.min(Math.max(query.limit, 1), TICKET_PAGE_MAX + 1),
    });
  }

  async detail(scope: TenantContext, actor: ActorContext, ticketId: string): Promise<TicketDetail> {
    await this.deps.guard.check(scope, actor, TICKETS_VIEW_PERMISSION);
    const item = await this.deps.tickets.findListItem(scope, this.ticketIdOf(ticketId));
    if (item === null) throw this.notFound();
    const [messages, customer, escalations, seesChats] = await Promise.all([
      this.deps.tickets.messagesOf(scope, item.ticket.id),
      this.deps.customers.findById(scope, item.ticket.customerId),
      this.deps.escalations.forTicket(scope, item.ticket.id, 20),
      this.deps.guard.has(scope, actor, BUSINESS_CHATS_VIEW_PERMISSION),
    ]);
    // TB7: the AI's note is a summary of the customer's Telegram Business conversation, so it is
    // the conversation's to show: `tickets.view` alone sees that a handoff happened and why,
    // never what the AI wrote about the chat (substitute review of PR #202, finding 5). Roadmap
    // A5: the topic, intent and steps tried are the same note's, and gated with it.
    return {
      item,
      messages,
      customer,
      escalations: seesChats
        ? escalations
        : escalations.map((escalation) => ({
            ...escalation,
            summary: null,
            topic: null,
            intent: null,
            stepsTried: null,
          })),
    };
  }

  /**
   * One message as the detail shows it — author and the lane's delivery state — after a
   * write. A replayed reply answers with where its notification actually is, not with the
   * PENDING it was on the first call (Codex review of #96).
   */
  async messageView(
    scope: TenantContext,
    actor: ActorContext,
    ticketId: string,
    messageId: TicketMessageId,
  ): Promise<TicketMessageListItem> {
    await this.deps.guard.check(scope, actor, TICKETS_VIEW_PERMISSION);
    const [item] = await this.deps.tickets.messagesOf(scope, this.ticketIdOf(ticketId), messageId);
    if (item === undefined) throw this.notFound();
    return item;
  }

  /** The inbox row for one ticket, after a write. Charged the view key like any read. */
  async summary(
    scope: TenantContext,
    actor: ActorContext,
    ticketId: string,
  ): Promise<TicketListItem> {
    await this.deps.guard.check(scope, actor, TICKETS_VIEW_PERMISSION);
    const item = await this.deps.tickets.findListItem(scope, this.ticketIdOf(ticketId));
    if (item === null) throw this.notFound();
    return item;
  }

  /**
   * Support replies. The message, the status move and the customer's `TICKET_REPLY` commit
   * together; the lane delivers it later, and a failed delivery leaves the reply in the
   * ticket and the lane row to retry.
   */
  async reply(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly ticketId: string;
      readonly text: string;
      /** HF-A7: one file beside the text, judged here before anything is written. */
      readonly attachment?: TicketReplyAttachment | null;
      readonly idempotencyKey: string;
    },
  ): Promise<TicketPosted> {
    const body = normalizeTicketText(input.text);
    if (body === null || !isTicketTextWithinBound(body)) throw this.messageInvalid();
    const ticketId = this.ticketIdOf(input.ticketId);
    const denial = { action: 'ticket.reply', entityType: 'Ticket', entityId: ticketId };
    await this.authorize(scope, actor, REPLY_PERMISSION, denial);
    const adminId = this.adminIdOf(actor);
    const file =
      input.attachment === undefined || input.attachment === null
        ? null
        : replyFileOf(input.attachment);
    // Namespaced by surface and administrator: two surfaces, or two people, never share a key.
    const key = `${actor.surface}:${adminId}:${input.idempotencyKey}`;
    /*
     * The file is part of the request: the same key with another file is another command.
     * Its digest, never its bytes. A reply with no file hashes exactly as it always did, so a
     * key in flight across the release that added files still replays.
     */
    const requestHash = hashRequest({
      op: 'admin-reply',
      ticketId,
      body,
      ...(file === null
        ? {}
        : { file: { sha256: file.sha256, mimeType: file.mimeType, fileName: file.fileName } }),
    });
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      REPLY_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const ticket = await this.deps.tickets.findByIdForUpdate(scope, ticketId, tx);
        if (ticket === null) throw this.notFound();
        const replay = await this.replayOf(scope, key, requestHash, ticket, tx);
        if (replay !== null) return replay;
        if (file !== null) {
          /*
           * The staging bound, under the tenant's staging lock so two replies cannot each
           * fit and together cross it. Checked before anything is written: a refusal here
           * leaves no message, no file and no notification.
           */
          await this.deps.tickets.lockReplyFileStaging(scope, tx);
          const staged = await this.deps.tickets.stagedReplyFileBytes(scope, tx);
          if (staged + file.bytes.byteLength > TICKET_REPLY_FILE_STAGED_MAX_BYTES) {
            throw errors.conflict(
              TICKET_ERROR_CODES.TICKET_ATTACHMENT_STORAGE_FULL,
              'Too many of support’s files are still waiting for Telegram.',
              { maxBytes: TICKET_REPLY_FILE_STAGED_MAX_BYTES },
            );
          }
        }
        const posted = await this.post(scope, actor, tx, ticket, {
          senderType: 'ADMIN',
          authorAdminId: adminId as AdminId,
          body,
          attachment: null,
          idempotencyKey: key,
          requestHash,
          audit: 'ticket.reply',
          ...(file === null
            ? {}
            : {
                auditFile: {
                  kind: file.kind,
                  mimeType: file.mimeType,
                  byteLength: file.bytes.byteLength,
                  sha256: file.sha256,
                },
              }),
        });
        /* istanbul ignore next -- the row lock is held and the key was checked above. */
        if (posted.replayed) return posted;
        /*
         * The customer is told through the lane, in THIS transaction: the notification can
         * exist only if the message does, and names it — never its text. It goes through the
         * bot the TICKET was opened on, not the customer's first bot: that is the conversation
         * the customer is holding it in, and the reply's buttons only make sense there.
         */
        /*
         * One instant for both lane rows (Codex review of #108): the lane claims oldest
         * first, `created_at` then `id`, so with equal times the text — enqueued first, with
         * the earlier UUIDv7 — is handed to the dispatcher before the file.
         */
        const enqueuedAt = this.deps.clock.now();
        await this.deps.notifier.notifyThrough(
          scope,
          ticket.customerId,
          ticket.botInstanceId,
          'TICKET_REPLY',
          posted.message.id,
          enqueuedAt,
          tx,
        );
        /*
         * HF-A7: support's file, staged beside the message it belongs to, and its OWN lane
         * row, enqueued after the text's so the text leaves first. Both commit with the
         * message or not at all; a Telegram failure later loses neither — the lane keeps
         * the row's state, and the bytes stay here until Telegram takes them.
         */
        if (file !== null) {
          await this.deps.tickets.insertReplyFile(
            scope,
            {
              messageId: posted.message.id,
              ticketId: ticket.id,
              botInstanceId: ticket.botInstanceId,
              kind: file.kind,
              mimeType: file.mimeType,
              fileName: file.fileName,
              content: file.bytes,
              sha256: file.sha256,
              now: this.deps.clock.now(),
            },
            tx,
          );
          await this.deps.notifier.notifyThrough(
            scope,
            ticket.customerId,
            ticket.botInstanceId,
            'TICKET_REPLY_ATTACHMENT',
            posted.message.id,
            enqueuedAt,
            tx,
          );
        }
        return posted;
      },
    );
  }

  /** Close, reopen or triage: the target status, on the one edge the machine declares. */
  async setStatus(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly ticketId: string; readonly status: TicketStatus },
  ): Promise<TicketChanged> {
    const ticketId = this.ticketIdOf(input.ticketId);
    const denial = { action: 'ticket.status', entityType: 'Ticket', entityId: ticketId };
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      CLOSE_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const ticket = await this.deps.tickets.findByIdForUpdate(scope, ticketId, tx);
        if (ticket === null) throw this.notFound();
        if (ticket.status === input.status) return { ticket, changed: false };
        const event = ticketManualEvent(ticket.status, input.status);
        if (event === null) {
          throw errors.conflict(
            TICKET_ERROR_CODES.TICKET_TRANSITION_INVALID,
            `A ticket cannot move from ${ticket.status} to ${input.status}.`,
            { from: ticket.status, to: input.status },
          );
        }
        const fact: TicketSystemEvent | null =
          event === 'CLOSE'
            ? 'CLOSED_BY_SUPPORT'
            : event === 'REOPEN'
              ? 'REOPENED_BY_SUPPORT'
              : null;
        const moved = await this.move(scope, actor, tx, ticket, input.status, fact);
        return { ticket: moved, changed: true };
      },
    );
  }

  async assign(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly ticketId: string; readonly adminId: string | null },
  ): Promise<TicketChanged> {
    const ticketId = this.ticketIdOf(input.ticketId);
    const denial = { action: 'ticket.assign', entityType: 'Ticket', entityId: ticketId };
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      ASSIGN_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const ticket = await this.deps.tickets.findByIdForUpdate(scope, ticketId, tx);
        if (ticket === null) throw this.notFound();
        const next = input.adminId === null ? null : (input.adminId.toLowerCase() as AdminId);
        if (next === ticket.assignedAdminId) return { ticket, changed: false };
        if (next !== null && !(await this.mayBeAssigned(scope, next, actor, tx))) {
          throw errors.validation(
            TICKET_ERROR_CODES.TICKET_ASSIGNEE_INVALID,
            'The assignee must be an active administrator of this tenant who may read tickets.',
          );
        }
        const moved = await this.deps.tickets.setAssignee(
          scope,
          ticket.id,
          ticket.assignedAdminId,
          next,
          this.deps.clock.now(),
          tx,
        );
        /* istanbul ignore next -- the row lock is held; nothing else can move it. */
        if (moved === null) throw this.moved();
        await this.deps.outbox.write(tx, actor, {
          eventType: 'TicketAssigned',
          aggregateType: 'Ticket',
          aggregateId: ticket.id,
          payload: { ticketId: ticket.id, from: ticket.assignedAdminId, to: next },
        });
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'ticket.assign',
            entityType: 'Ticket',
            entityId: ticket.id,
            before: { assignedAdminId: ticket.assignedAdminId },
            after: { assignedAdminId: next },
            result: 'SUCCESS',
          },
          tx,
        );
        return { ticket: moved, changed: true };
      },
    );
  }

  async setPriority(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly ticketId: string; readonly priority: TicketPriority },
  ): Promise<TicketChanged> {
    const ticketId = this.ticketIdOf(input.ticketId);
    const denial = { action: 'ticket.priority', entityType: 'Ticket', entityId: ticketId };
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      ASSIGN_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const ticket = await this.deps.tickets.findByIdForUpdate(scope, ticketId, tx);
        if (ticket === null) throw this.notFound();
        if (ticket.priority === input.priority) return { ticket, changed: false };
        const moved = await this.deps.tickets.setPriority(
          scope,
          ticket.id,
          ticket.priority,
          input.priority,
          this.deps.clock.now(),
          tx,
        );
        /* istanbul ignore next -- the row lock is held; nothing else can move it. */
        if (moved === null) throw this.moved();
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'ticket.priority',
            entityType: 'Ticket',
            entityId: ticket.id,
            before: { priority: ticket.priority },
            after: { priority: input.priority },
            result: 'SUCCESS',
          },
          tx,
        );
        return { ticket: moved, changed: true };
      },
    );
  }

  /** Links the ticket's context. Each id must be the ticket's customer's own. */
  async setLinks(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly ticketId: string;
      readonly serviceId: string | null;
      readonly orderId: string | null;
      readonly paymentId: string | null;
    },
  ): Promise<TicketChanged> {
    const ticketId = this.ticketIdOf(input.ticketId);
    const denial = { action: 'ticket.link', entityType: 'Ticket', entityId: ticketId };
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      ASSIGN_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const ticket = await this.deps.tickets.findByIdForUpdate(scope, ticketId, tx);
        if (ticket === null) throw this.notFound();
        const links = {
          serviceId: input.serviceId?.toLowerCase() ?? null,
          orderId: input.orderId?.toLowerCase() ?? null,
          paymentId: input.paymentId?.toLowerCase() ?? null,
        };
        if (
          links.serviceId === ticket.serviceId &&
          links.orderId === ticket.orderId &&
          links.paymentId === ticket.paymentId
        ) {
          return { ticket, changed: false };
        }
        for (const [kind, field, id] of [
          ['SERVICE', 'serviceId', links.serviceId],
          ['ORDER', 'orderId', links.orderId],
          ['PAYMENT', 'paymentId', links.paymentId],
        ] as const) {
          if (id === null) continue;
          const owner = await this.deps.context.ownerOf(scope, kind, id, tx);
          if (owner !== ticket.customerId) {
            throw errors.validation(
              TICKET_ERROR_CODES.TICKET_LINK_INVALID,
              `The linked ${kind.toLowerCase()} is not this customer's own.`,
              { field },
            );
          }
        }
        const moved = await this.deps.tickets.setLinks(
          scope,
          ticket.id,
          links,
          this.deps.clock.now(),
          tx,
        );
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'ticket.link',
            entityType: 'Ticket',
            entityId: ticket.id,
            before: {
              serviceId: ticket.serviceId,
              orderId: ticket.orderId,
              paymentId: ticket.paymentId,
            },
            after: links,
            result: 'SUCCESS',
          },
          tx,
        );
        return { ticket: moved, changed: true };
      },
    );
  }

  /** Who a ticket may be assigned to: ACTIVE administrators who may read tickets. */
  async assignees(scope: TenantContext, actor: ActorContext): Promise<readonly Admin[]> {
    await this.deps.guard.check(scope, actor, ASSIGN_PERMISSION);
    const all = await this.deps.admins.list(scope);
    const found: Admin[] = [];
    for (const admin of all) {
      if (await this.mayBeAssigned(scope, admin.id, actor)) found.push(admin);
    }
    return found;
  }

  /**
   * One message with its attachment, for the download route. Charged `tickets.view`; a
   * message of another tenant, or one with no file, is not found.
   */
  async attachmentOf(
    scope: TenantContext,
    actor: ActorContext,
    messageId: string,
  ): Promise<{
    readonly message: TicketMessageRecord;
    /**
     * Where the bytes are: at Telegram, fetched with the binding's bot — a customer's file,
     * or support's once Telegram accepted it — or still held here, for support's file that
     * Telegram has not taken yet (HF-A7).
     */
    readonly source:
      | {
          readonly kind: 'TELEGRAM';
          readonly binding: Pick<TicketAttachmentRecord, 'botInstanceId' | 'fileId'>;
        }
      | { readonly kind: 'STORED'; readonly bytes: Uint8Array };
  }> {
    await this.deps.guard.check(scope, actor, TICKETS_VIEW_PERMISSION);
    const id = uuidV7Schema.safeParse(messageId);
    const message = id.success ? await this.deps.tickets.findMessageById(scope, id.data) : null;
    if (message !== null && message.attachment !== null) {
      return { message, source: { kind: 'TELEGRAM', binding: message.attachment } };
    }
    const file =
      message !== null && message.senderType === 'ADMIN'
        ? await this.deps.tickets.findReplyFile(scope, message.id)
        : null;
    if (message !== null && file !== null) {
      const source = await this.replyFileSource(scope, file);
      if (source !== null) return { message, source };
    }
    throw errors.notFound(
      TICKET_ERROR_CODES.TICKET_ATTACHMENT_UNAVAILABLE,
      'That message carries no attachment.',
    );
  }

  /** Support's file: the held bytes, else Telegram's handle, else nothing left to read. */
  private async replyFileSource(
    scope: TenantContext,
    file: TicketReplyFileRecord,
  ): Promise<
    | {
        readonly kind: 'TELEGRAM';
        readonly binding: Pick<TicketAttachmentRecord, 'botInstanceId' | 'fileId'>;
      }
    | { readonly kind: 'STORED'; readonly bytes: Uint8Array }
    | null
  > {
    if (file.staged) {
      const bytes = await this.deps.tickets.replyFileContent(scope, file.messageId);
      if (bytes !== null) return { kind: 'STORED', bytes };
    }
    // Re-read: the delivery may have stamped the handle and cleared the bytes meanwhile.
    const now = file.staged ? await this.deps.tickets.findReplyFile(scope, file.messageId) : file;
    if (now === null || now.telegramFileId === null) return null;
    return {
      kind: 'TELEGRAM',
      binding: { botInstanceId: now.botInstanceId, fileId: now.telegramFileId },
    };
  }

  // --- the shared write ------------------------------------------------------------------

  /**
   * Writes one message into a locked ticket and moves its status as the message implies.
   * The caller holds the row lock and has already answered a replay.
   */
  private async post(
    scope: TenantContext,
    actor: ActorContext,
    tx: TransactionScope,
    ticket: TicketRecord,
    input: {
      readonly senderType: 'CUSTOMER' | 'ADMIN';
      readonly authorAdminId: AdminId | null;
      readonly body: string | null;
      readonly attachment: TicketAttachmentRecord | null;
      readonly idempotencyKey: string;
      readonly requestHash: string;
      readonly audit: string;
      /** HF-A7: support's file, as the audit names it — facts, never its name or bytes. */
      readonly auditFile?: {
        readonly kind: TicketAttachmentKind;
        readonly mimeType: string;
        readonly byteLength: number;
        readonly sha256: string;
      };
    },
  ): Promise<TicketPosted> {
    const next = ticketStatusAfterMessage(ticket.status, input.senderType);
    if (next === null) throw this.closed();
    if (
      (await this.deps.tickets.countMessages(scope, ticket.id, tx)) >=
      TICKET_MESSAGES_MAX_PER_TICKET
    ) {
      throw errors.conflict(
        TICKET_ERROR_CODES.TICKET_MESSAGE_LIMIT,
        'This ticket holds the most messages allowed.',
        { max: TICKET_MESSAGES_MAX_PER_TICKET },
      );
    }
    const now = this.deps.clock.now();
    const message = await this.deps.tickets.insertMessage(
      scope,
      {
        id: this.deps.ids.uuid() as TicketMessageId,
        ticketId: ticket.id,
        senderType: input.senderType,
        authorAdminId: input.authorAdminId,
        body: input.body,
        systemEvent: null,
        attachment: input.attachment,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        now,
      },
      tx,
    );
    if (message === null) {
      // The key is another message's: a replay the checks above could not see.
      const replay = await this.replayOf(
        scope,
        input.idempotencyKey,
        input.requestHash,
        ticket,
        tx,
      );
      if (replay !== null) return replay;
      /* istanbul ignore next -- a conflicting insert leaves the row it conflicted with. */
      throw this.keyReused();
    }
    const moved = await this.deps.tickets.moveStatus(
      scope,
      ticket.id,
      ticket.status,
      next,
      now,
      { touch: true },
      tx,
    );
    /* istanbul ignore next -- the row lock is held; nothing else can move it. */
    if (moved === null) throw this.moved();
    await this.deps.outbox.write(tx, actor, {
      eventType: 'TicketMessagePosted',
      aggregateType: 'Ticket',
      aggregateId: ticket.id,
      payload: { ticketId: ticket.id, messageId: message.id, senderType: input.senderType },
    });
    if (next !== ticket.status) {
      await this.deps.outbox.write(tx, actor, {
        eventType: 'TicketStatusChanged',
        aggregateType: 'Ticket',
        aggregateId: ticket.id,
        payload: { ticketId: ticket.id, from: ticket.status, to: next },
      });
    }
    await this.deps.audit.record(
      scope,
      actor,
      {
        action: input.audit,
        entityType: 'Ticket',
        entityId: ticket.id,
        before: { status: ticket.status },
        after: {
          status: next,
          messageId: message.id,
          attachment: message.attachment?.kind ?? input.auditFile?.kind ?? null,
          ...(input.auditFile === undefined ? {} : { file: input.auditFile }),
        },
        result: 'SUCCESS',
      },
      tx,
    );
    return { ticket: moved, message, replayed: false };
  }

  /** A status change on a locked ticket, with the system fact it records, if any. */
  private async move(
    scope: TenantContext,
    actor: ActorContext,
    tx: TransactionScope,
    ticket: TicketRecord,
    to: TicketStatus,
    fact: TicketSystemEvent | null,
  ): Promise<TicketRecord> {
    const now = this.deps.clock.now();
    /*
     * A status change is ALWAYS allowed, the message cap notwithstanding: a ticket at its
     * 500th message must still be closable, and refusing the close would leave it open for
     * ever. What the cap bounds is the conversation's rows, so at the cap the move writes
     * no SYSTEM fact row — the status, the outbox event and the audit row below still
     * record it (Codex review of #96). Counted under the ticket's row lock, which every
     * writer of a message holds.
     */
    const recordsFact =
      fact !== null &&
      (await this.deps.tickets.countMessages(scope, ticket.id, tx)) <
        TICKET_MESSAGES_MAX_PER_TICKET;
    const moved = await this.deps.tickets.moveStatus(
      scope,
      ticket.id,
      ticket.status,
      to,
      now,
      { touch: recordsFact },
      tx,
    );
    /* istanbul ignore next -- the row lock is held; nothing else can move it. */
    if (moved === null) throw this.moved();
    if (fact !== null && recordsFact) {
      await this.deps.tickets.insertMessage(
        scope,
        {
          id: this.deps.ids.uuid() as TicketMessageId,
          ticketId: ticket.id,
          senderType: 'SYSTEM',
          authorAdminId: null,
          body: null,
          systemEvent: fact,
          attachment: null,
          idempotencyKey: null,
          requestHash: null,
          now,
        },
        tx,
      );
    }
    await this.deps.outbox.write(tx, actor, {
      eventType: 'TicketStatusChanged',
      aggregateType: 'Ticket',
      aggregateId: ticket.id,
      payload: { ticketId: ticket.id, from: ticket.status, to },
    });
    await this.deps.audit.record(
      scope,
      actor,
      {
        action: fact === 'CLOSED_BY_CUSTOMER' ? 'ticket.close' : 'ticket.status',
        entityType: 'Ticket',
        entityId: ticket.id,
        before: { status: ticket.status },
        // `factRecorded: false` says the cap left the conversation without its SYSTEM row.
        after: { status: to, ...(fact !== null && !recordsFact ? { factRecorded: false } : {}) },
        result: 'SUCCESS',
      },
      tx,
    );
    return moved;
  }

  /**
   * The earlier message this key wrote, answered as a replay — or a refusal when the key
   * was first used for something else. Null when the key is new.
   */
  private async replayOf(
    scope: TenantContext,
    key: string,
    requestHash: string,
    ticket: TicketRecord,
    tx: TransactionScope,
  ): Promise<TicketPosted | null> {
    const first = await this.deps.tickets.findMessageByKey(scope, key, tx);
    if (first === null) return null;
    if (first.ticketId !== ticket.id) throw this.keyReused();
    this.assertSameRequest(first, requestHash);
    return { ticket, message: first, replayed: true };
  }

  private async insertOrThrow(
    scope: TenantContext,
    input: Parameters<TicketRepository['insertMessage']>[1],
    tx: TransactionScope,
  ): Promise<TicketMessageRecord> {
    const message = await this.deps.tickets.insertMessage(scope, input, tx);
    // The opening key is unique on the ticket, so its message key can only be taken by a
    // reply that reused the update's key — a different request.
    if (message === null) throw this.keyReused();
    return message;
  }

  /** The customer's text and file, judged: normalized text, an accepted file, or a refusal. */
  private customerContent(
    text: string | null,
    file: InboundTicketFile | null,
    botInstanceId: BotInstanceId,
  ): { readonly body: string | null; readonly attachment: TicketAttachmentRecord | null } {
    const body = normalizeTicketText(text);
    if (body !== null && !isTicketTextWithinBound(body)) throw this.messageInvalid();
    if (file === null) {
      if (body === null) throw this.messageInvalid();
      return { body, attachment: null };
    }
    const refusal = ticketAttachmentRefusal(file);
    if (refusal !== null) {
      throw errors.validation(
        TICKET_ERROR_CODES.TICKET_ATTACHMENT_REFUSED,
        'This file cannot be attached to a ticket.',
        { refusal },
      );
    }
    return {
      body,
      attachment: {
        kind: file.kind,
        botInstanceId,
        fileId: file.fileId,
        fileUniqueId: file.fileUniqueId,
        mimeType: file.mimeType === null ? null : file.mimeType.trim().toLowerCase(),
        fileName: fileNameOf(file.fileName),
        fileSize: file.fileSize,
      },
    };
  }

  /** The customer's own ticket, opened through this bot, locked; otherwise not-found. */
  private async ownedForUpdate(
    scope: TenantContext,
    customerId: UserId,
    botInstanceId: BotInstanceId,
    ticketId: string,
    tx: TransactionScope,
  ): Promise<TicketRecord> {
    const id = uuidV7Schema.safeParse(ticketId);
    const ticket = id.success
      ? await this.deps.tickets.findByIdForUpdate(scope, id.data, tx)
      : null;
    if (
      ticket === null ||
      ticket.customerId !== customerId ||
      ticket.botInstanceId !== botInstanceId
    ) {
      throw this.notFound();
    }
    return ticket;
  }

  /** An ACTIVE administrator of this tenant whose resolved permissions include the view. */
  private async mayBeAssigned(
    scope: TenantContext,
    adminId: AdminId,
    actor: ActorContext,
    tx?: unknown,
  ): Promise<boolean> {
    const admin = await this.deps.admins.findById(scope, adminId, tx);
    if (admin === null || admin.status !== 'ACTIVE') return false;
    const permissions = await this.deps.permissions.resolve(
      scope,
      {
        type: 'WEB_ADMIN',
        id: admin.id,
        label: admin.username,
        surface: 'WEB',
        correlationId: actor.correlationId,
      },
      tx,
    );
    return permissions.has(TICKETS_VIEW_PERMISSION);
  }

  /**
   * The customer an operator named: an internal id, a numeric Telegram id, or a username.
   * `null` when nobody matched, which the list answers with no rows.
   */
  private async customerNamed(scope: TenantContext, raw: string): Promise<UserId | null> {
    const value = raw.trim();
    const asId = uuidV7Schema.safeParse(value);
    if (asId.success) {
      const found = await this.deps.customers.findById(scope, asId.data as UserId);
      return found === null ? null : found.id;
    }
    if (telegramUserIdSchema.safeParse(value).success) {
      const page = await this.deps.customers.list(scope, { telegramUserId: value }, 1, null);
      return page.items[0]?.id ?? null;
    }
    const username = value.replace(/^@/u, '').toLowerCase();
    if (username === '') return null;
    const page = await this.deps.customers.list(scope, { username }, 1, null);
    return page.items[0]?.id ?? null;
  }

  private adminIdOf(actor: ActorContext): string {
    if (actor.id === null) {
      throw errors.permissionDenied(
        PLATFORM_ERROR_CODES.PERMISSION_DENIED,
        'Only an administrator acts on a ticket from the Web Admin.',
      );
    }
    return actor.id;
  }

  private ticketIdOf(raw: string): TicketId {
    const id = uuidV7Schema.safeParse(raw);
    if (!id.success) throw this.notFound();
    return id.data as TicketId;
  }

  private assertSameRequest(first: TicketMessageRecord, requestHash: string): void {
    if (first.requestHash !== requestHash) throw this.keyReused();
  }

  private async assertScopeActive(scope: TenantContext, tx: TransactionScope): Promise<void> {
    if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'This installation has stopped accepting work.',
      );
    }
  }

  private async assertCustomerActive(
    scope: TenantContext,
    customerId: UserId,
    tx: TransactionScope,
  ): Promise<void> {
    const customer = await this.deps.customers.findById(scope, customerId, tx);
    if (customer === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
    }
    if (customer.status === 'BLOCKED') {
      throw errors.conflict(COMMERCE_ERROR_CODES.CUSTOMER_BLOCKED, 'This account is blocked.');
    }
  }

  /** An early check that leaves the same audit trace as the one inside the transaction. */
  private async authorize(
    scope: TenantContext,
    actor: ActorContext,
    permission: PermissionKey,
    denial: MutationDenial,
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, permission);
    } catch (error) {
      await recordMutationDenial(this.mutationDeps(), scope, actor, permission, denial, error);
      throw error;
    }
  }

  private notFound() {
    return errors.notFound(TICKET_ERROR_CODES.TICKET_NOT_FOUND, 'Unknown ticket.');
  }

  private closed() {
    return errors.conflict(TICKET_ERROR_CODES.TICKET_CLOSED, 'This ticket is closed.');
  }

  private messageInvalid() {
    return errors.validation(
      TICKET_ERROR_CODES.TICKET_MESSAGE_INVALID,
      'A message is 1 to 3000 characters, or a file.',
    );
  }

  private keyReused() {
    return errors.conflict(
      PLATFORM_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH,
      'That idempotency key already wrote a different message.',
    );
  }

  private moved() {
    return errors.conflict(TICKET_ERROR_CODES.TICKET_TRANSITION_INVALID, 'The ticket moved.');
  }

  private mutationDeps() {
    return {
      uow: this.deps.uow,
      guard: this.deps.guard,
      audit: this.deps.audit,
      opsLog: this.deps.opsLog,
      sessions: this.deps.sessions,
      clock: this.deps.clock,
    };
  }
}

/**
 * Support's file, decoded and judged (HF-A7): the ONE rule the Web Admin also asks
 * (`ticketReplyFileRefusal`), asked again here of the decoded bytes, because nothing a
 * browser decided is trusted. A refusal writes nothing.
 */
function replyFileOf(attachment: TicketReplyAttachment): {
  readonly kind: TicketAttachmentKind;
  readonly mimeType: TicketReplyFileMimeType;
  readonly fileName: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
} {
  const decoded = Buffer.from(attachment.contentBase64, 'base64');
  const bytes = new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
  const refusal = ticketReplyFileRefusal({
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    bytes,
  });
  const type = ticketReplyFileTypeOf(attachment.mimeType);
  if (refusal !== null || type === undefined) {
    throw errors.validation(
      TICKET_ERROR_CODES.TICKET_ATTACHMENT_REFUSED,
      'This file cannot be attached to a reply.',
      { refusal: refusal ?? 'TYPE_NOT_ALLOWED' },
    );
  }
  return {
    kind: type.kind,
    mimeType: type.mimeType,
    fileName: ticketReplyFileNameOf(attachment.fileName, type),
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

/** A file name as stored: control characters and path separators removed, bounded, or null. */
function fileNameOf(raw: string | null): string | null {
  const text = normalizeTicketText(raw);
  if (text === null) return null;
  const cleaned = text.replace(/[\n\t/\\]/gu, '_');
  const points = Array.from(cleaned);
  return points.length <= TICKET_ATTACHMENT_FILE_NAME_MAX_LENGTH
    ? cleaned
    : points.slice(points.length - TICKET_ATTACHMENT_FILE_NAME_MAX_LENGTH).join('');
}
