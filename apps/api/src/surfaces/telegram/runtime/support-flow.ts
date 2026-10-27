// Support: the FAQ/support screen and the customer's ticket desk (list, new, category, view,
// reply window, close, and the typed or attached message that opens or answers a ticket).
// Moved verbatim out of bot-runtime.ts, which still re-exports every name it exported.
import type { CustomerButton } from '../../../modules/commerce/messaging/application/ports.js';
import { inlineLabel } from '../../../modules/commerce/messaging/application/inline-buttons.js';
import {
  TICKETS_CALLBACK_DATA,
  TICKET_NEW_CALLBACK_DATA,
  TICKET_VIEW_CALLBACK_PREFIX,
  TICKET_CATEGORY_CALLBACK_PREFIX,
  TICKET_REPLY_CALLBACK_PREFIX,
  TICKET_CLOSE_ASK_CALLBACK_PREFIX,
  TICKET_CLOSE_CALLBACK_PREFIX,
} from './callbacks.js';
import type { PendingReply } from './replies.js';
import {
  type TenantContext,
  type ActorContext,
  type BotInstanceId,
  TICKET_OPEN_MAX_PER_CUSTOMER,
  TICKET_MESSAGE_MAX_LENGTH,
  TICKET_VIEW_MESSAGE_COUNT,
  isNexaError,
  TICKET_ERROR_CODES,
  TICKET_ATTACHMENT_MAX_BYTES,
} from '@nexa/contracts';
import type { BotCommand } from './intents.js';
import type { CustomerRecord } from '../../../modules/commerce/customers/application/ports.js';
import type { TicketDeskPort } from './deps.js';
import { mainMenuButton } from './keyboards.js';
import { updateIdOf } from './intent-of.js';
import { refusal, hasRefusalReply } from './refusals.js';
import type { InboundReceiptFile } from '../../../modules/commerce/payments/application/receipt-ports.js';
import type { CustomerCaptureRecord } from '../../../modules/commerce/customers/application/customer-capture-ports.js';
import type { InboundTicketFile } from '../../../modules/commerce/tickets/application/ticket.service.js';
import { marketingPreferenceButton, reminderPreferenceButton } from './start-menu-flow.js';
import type { BotRuntime } from '../bot-runtime.js';

/** WP-A7: back to the customer's ticket list. */
export function ticketsButton(): CustomerButton {
  return {
    ...inlineLabel('tickets.back'),
    data: TICKETS_CALLBACK_DATA,
  };
}

/** WP-A7: the support screen's (and /paysupport's) way into the ticket desk. */
export function ticketDeskButton(): CustomerButton {
  return {
    ...inlineLabel('support.tickets'),
    data: TICKETS_CALLBACK_DATA,
  };
}

/** WP-A7: start a new ticket. */
export function newTicketButton(): CustomerButton {
  return {
    ...inlineLabel('tickets.new'),
    data: TICKET_NEW_CALLBACK_DATA,
  };
}

/** WP-A7: open one ticket's conversation. */
export function ticketViewButton(ticketId: string): CustomerButton {
  return {
    ...inlineLabel('tickets.view'),
    data: `${TICKET_VIEW_CALLBACK_PREFIX}${ticketId}`,
  };
}

/** WP-A7: a ticket that is not the customer's own, or does not exist — one answer. */
export function ticketNotFound(): PendingReply {
  return { key: 'bot.ticket.not_found', values: {}, buttons: [ticketsButton()], orderId: null };
}

/** WP-A7: a closed ticket refuses a reply and a close; a new ticket is the way on. */
export function ticketAlreadyClosed(): PendingReply {
  return {
    key: 'bot.ticket.already_closed',
    values: {},
    buttons: [newTicketButton(), ticketsButton()],
    orderId: null,
  };
}

// --- WP-A7: the customer's support tickets ----------------------------------------------

/**
 * The ticket desk's seven intents, or null for every other intent (and for all of them when
 * the desk is not wired). Nothing here decides a fact: every write is `TicketService`'s,
 * which re-reads the ticket and its owner inside its transaction; the screens only draw.
 */
export async function ticketTurn(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  command: BotCommand,
  customer: CustomerRecord,
  input: {
    readonly idempotencyKey: string;
    readonly botInstanceId: BotInstanceId;
    readonly update?: unknown;
  },
): Promise<PendingReply | null> {
  const desk = rt.deps.tickets;
  if (desk === undefined) return null;
  const id = command.targetId;
  switch (command.intent) {
    case 'TICKETS':
      return ticketList(rt, scope, desk, customer, input.botInstanceId);
    case 'TICKET_NEW':
      return ticketNew(rt, scope, desk, customer, input.botInstanceId);
    case 'TICKET_CATEGORY':
      return id === null ? null : ticketCategory(rt, scope, actor, desk, customer, id, input);
    case 'TICKET_VIEW':
      return id === null ? null : ticketView(rt, scope, desk, customer, input.botInstanceId, id);
    case 'TICKET_REPLY':
      return id === null ? null : ticketReplyOpen(rt, scope, actor, desk, customer, id, input);
    case 'TICKET_CLOSE_ASK':
      return id === null
        ? null
        : ticketCloseAsk(rt, scope, desk, customer, input.botInstanceId, id);
    case 'TICKET_CLOSE':
      return id === null
        ? null
        : ticketClose(rt, scope, actor, desk, customer, input.botInstanceId, id);
    default:
      return null;
  }
}

/** The ticket desk's list: the customer's tickets, active first, and a new one. */
export async function ticketList(
  rt: BotRuntime,
  scope: TenantContext,
  desk: TicketDeskPort,
  customer: CustomerRecord,
  botInstanceId: BotInstanceId,
): Promise<PendingReply> {
  const tickets = await desk.service.customerTickets(scope, customer.id, botInstanceId);
  const buttons: CustomerButton[] = [];
  for (const ticket of tickets) {
    buttons.push({
      ...inlineLabel('tickets.item', {
        status: await desk.screens.statusLabel(scope, ticket.status),
        number: ticket.number,
        category: ticket.categoryTitle,
      }),
      data: `${TICKET_VIEW_CALLBACK_PREFIX}${ticket.id}`,
    });
  }
  buttons.push(newTicketButton(), mainMenuButton());
  return {
    key: tickets.length === 0 ? 'bot.ticket.list_empty' : 'bot.ticket.list',
    values: {},
    buttons,
    orderId: null,
  };
}

/** A new ticket: the active categories. A courtesy check of the open-ticket rail first. */
export async function ticketNew(
  rt: BotRuntime,
  scope: TenantContext,
  desk: TicketDeskPort,
  customer: CustomerRecord,
  botInstanceId: BotInstanceId,
): Promise<PendingReply> {
  const open = (await desk.service.customerTickets(scope, customer.id, botInstanceId)).filter(
    (ticket) => ticket.status !== 'CLOSED',
  ).length;
  if (open >= TICKET_OPEN_MAX_PER_CUSTOMER) {
    return {
      key: 'bot.ticket.open_limit',
      values: { max: TICKET_OPEN_MAX_PER_CUSTOMER },
      buttons: [ticketsButton()],
      orderId: null,
    };
  }
  const categories = await desk.categories.activeForCustomer(scope);
  if (categories.length === 0) {
    return {
      key: 'bot.ticket.no_categories',
      values: {},
      buttons: [ticketsButton()],
      orderId: null,
    };
  }
  return {
    key: 'bot.ticket.choose_category',
    values: {},
    buttons: [
      ...categories.map((category) => ({
        ...inlineLabel('tickets.category', { title: category.title }),
        data: `${TICKET_CATEGORY_CALLBACK_PREFIX}${category.id}`,
      })),
      ticketsButton(),
    ],
    orderId: null,
  };
}

/** A category was chosen: open the window that reads the new ticket's first message. */
export async function ticketCategory(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  desk: TicketDeskPort,
  customer: CustomerRecord,
  categoryId: string,
  input: {
    readonly idempotencyKey: string;
    readonly botInstanceId: BotInstanceId;
    readonly update?: unknown;
  },
): Promise<PendingReply> {
  const category = (await desk.categories.activeForCustomer(scope)).find(
    (candidate) => candidate.id === categoryId,
  );
  // A stale button for a category since hidden: the chooser again, as it now stands.
  if (category === undefined) return ticketNew(rt, scope, desk, customer, input.botInstanceId);
  const updateId = updateIdOf(input.update);
  try {
    await rt.deps.captures.open(scope, actor, {
      idempotencyKey: `${input.idempotencyKey}:ticket-window`,
      botInstanceId: input.botInstanceId,
      customerId: customer.id,
      purpose: 'TICKET_NEW_MESSAGE',
      subjectId: category.id,
      // A window reads only messages sent after the tap that opened it.
      ...(updateId === undefined ? {} : { openedUpdateId: updateId }),
    });
  } catch (error) {
    return refusal(error);
  }
  return {
    key: 'bot.ticket.message_prompt',
    values: { category: category.title, max: TICKET_MESSAGE_MAX_LENGTH },
    buttons: [ticketsButton()],
    orderId: null,
  };
}

/** One of the customer's own tickets: its heading and its latest messages. */
export async function ticketView(
  rt: BotRuntime,
  scope: TenantContext,
  desk: TicketDeskPort,
  customer: CustomerRecord,
  botInstanceId: BotInstanceId,
  ticketId: string,
): Promise<PendingReply> {
  const found = await desk.service.customerTicket(
    scope,
    customer.id,
    botInstanceId,
    ticketId,
    TICKET_VIEW_MESSAGE_COUNT,
  );
  if (found === null) return ticketNotFound();
  const { ticket } = found;
  const rendered = await desk.screens.conversation(
    scope,
    found.messages,
    found.messageCount,
    found.filed,
  );
  const active = ticket.status !== 'CLOSED';
  return {
    key: 'bot.ticket.view',
    values: {
      number: ticket.number,
      category: ticket.categoryTitle,
      status: await desk.screens.statusLabel(scope, ticket.status),
      conversation: rendered.conversation,
      ...(rendered.olderLine === null ? {} : { olderLine: rendered.olderLine }),
    },
    buttons: [
      ...(active
        ? [
            {
              ...inlineLabel('tickets.reply'),
              data: `${TICKET_REPLY_CALLBACK_PREFIX}${ticket.id}`,
            },
            {
              ...inlineLabel('tickets.close'),
              data: `${TICKET_CLOSE_ASK_CALLBACK_PREFIX}${ticket.id}`,
            },
          ]
        : [newTicketButton()]),
      ticketsButton(),
    ],
    orderId: null,
  };
}

/** The reply button: open the window that reads the customer's reply to this ticket. */
export async function ticketReplyOpen(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  desk: TicketDeskPort,
  customer: CustomerRecord,
  ticketId: string,
  input: {
    readonly idempotencyKey: string;
    readonly botInstanceId: BotInstanceId;
    readonly update?: unknown;
  },
): Promise<PendingReply> {
  const found = await desk.service.customerTicket(
    scope,
    customer.id,
    input.botInstanceId,
    ticketId,
    1,
  );
  if (found === null) return ticketNotFound();
  if (found.ticket.status === 'CLOSED') return ticketAlreadyClosed();
  const updateId = updateIdOf(input.update);
  try {
    await rt.deps.captures.open(scope, actor, {
      idempotencyKey: `${input.idempotencyKey}:ticket-window`,
      botInstanceId: input.botInstanceId,
      customerId: customer.id,
      purpose: 'TICKET_REPLY',
      subjectId: found.ticket.id,
      ...(updateId === undefined ? {} : { openedUpdateId: updateId }),
    });
  } catch (error) {
    return refusal(error);
  }
  return {
    key: 'bot.ticket.reply_prompt',
    values: { number: found.ticket.number, max: TICKET_MESSAGE_MAX_LENGTH },
    buttons: [ticketViewButton(found.ticket.id)],
    orderId: null,
  };
}

/** The close button: the question. Writes nothing; its one button is the close. */
export async function ticketCloseAsk(
  rt: BotRuntime,
  scope: TenantContext,
  desk: TicketDeskPort,
  customer: CustomerRecord,
  botInstanceId: BotInstanceId,
  ticketId: string,
): Promise<PendingReply> {
  const found = await desk.service.customerTicket(scope, customer.id, botInstanceId, ticketId, 1);
  if (found === null) return ticketNotFound();
  if (found.ticket.status === 'CLOSED') return ticketAlreadyClosed();
  return {
    key: 'bot.ticket.close_ask',
    values: { number: found.ticket.number },
    buttons: [
      {
        ...inlineLabel('tickets.close_confirm'),
        data: `${TICKET_CLOSE_CALLBACK_PREFIX}${found.ticket.id}`,
      },
      ticketViewButton(found.ticket.id),
    ],
    orderId: null,
  };
}

/** The close itself. Closing a ticket already closed answers the same sentence. */
export async function ticketClose(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  desk: TicketDeskPort,
  customer: CustomerRecord,
  botInstanceId: BotInstanceId,
  ticketId: string,
): Promise<PendingReply> {
  try {
    const closed = await desk.service.closeByCustomer(scope, actor, {
      customerId: customer.id,
      botInstanceId,
      ticketId,
    });
    return {
      key: 'bot.ticket.closed',
      values: { number: closed.ticket.number },
      buttons: [ticketsButton()],
      orderId: null,
    };
  } catch (error) {
    if (isNexaError(error) && error.code === TICKET_ERROR_CODES.TICKET_NOT_FOUND) {
      return ticketNotFound();
    }
    return refusal(error);
  }
}

/**
 * A photo or document, offered to the customer's ticket window — only when a ticket window
 * is the prompt they saw last, and read with `onlyPurposes` so a file can never close some
 * other window as though it were its text. Null leaves the file to the receipt path.
 *
 * "Saw last" is decided inside the read's transaction, under the ticket window's lock and
 * then the receipt window's: a receipt window at least as new wins and the ticket window
 * stays open. The receipt path that runs after a null is reached only when the receipt
 * window was the newer one at that instant; a ticket window opened afterwards is newer
 * than this file, and — as with `openedUpdateId` — not what it answered.
 */
export async function ticketFile(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  file: InboundReceiptFile,
  input: {
    readonly idempotencyKey: string;
    readonly botInstanceId: BotInstanceId;
    readonly update?: unknown;
  },
): Promise<PendingReply | null> {
  const desk = rt.deps.tickets;
  if (desk === undefined) return null;
  const updateId = updateIdOf(input.update);
  const read = await rt.deps.captures.readText(scope, actor, {
    idempotencyKey: `${input.idempotencyKey}:capture-file`,
    botInstanceId: input.botInstanceId,
    customerId: customer.id,
    text: file.caption ?? '',
    onlyPurposes: ['TICKET_NEW_MESSAGE', 'TICKET_REPLY'],
    yieldTo: (tx) => desk.receiptWindowOpenedAt(scope, input.botInstanceId, customer.id, tx),
    ...(updateId === undefined ? {} : { updateId }),
  });
  if (read.outcome !== 'READ') return null;
  return ticketSubmit(
    rt,
    scope,
    actor,
    customer,
    read.capture,
    file.caption,
    {
      kind: file.kind,
      fileId: file.fileId,
      fileUniqueId: file.fileUniqueId,
      mimeType: file.mimeType,
      fileName: file.fileName,
      fileSize: file.fileSize,
    },
    input,
  );
}

/**
 * What a ticket window read — text, or a file with its caption — filed as a new ticket or
 * a reply. The window closed when it was read; a refusal that asks the customer to try
 * again reopens it, reading only messages sent after this one, and a refusal that is an
 * answer ("closed", "too many open") leaves it shut.
 */
export async function ticketSubmit(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  capture: CustomerCaptureRecord,
  text: string | null,
  file: InboundTicketFile | null,
  input: {
    readonly idempotencyKey: string;
    readonly botInstanceId: BotInstanceId;
    readonly update?: unknown;
  },
): Promise<PendingReply | null> {
  const desk = rt.deps.tickets;
  if (desk === undefined || capture.subjectId === null) return null;
  const subjectId = capture.subjectId;
  const updateId = updateIdOf(input.update);
  const reopen = (suffix: string) =>
    rt.deps.captures.open(scope, actor, {
      idempotencyKey: `${input.idempotencyKey}:${suffix}`,
      botInstanceId: input.botInstanceId,
      customerId: customer.id,
      purpose: capture.purpose,
      subjectId,
      ...(updateId === undefined ? {} : { openedUpdateId: updateId }),
    });
  try {
    if (capture.purpose === 'TICKET_NEW_MESSAGE') {
      const opened = await desk.service.openByCustomer(scope, actor, {
        customerId: customer.id,
        botInstanceId: input.botInstanceId,
        categoryId: subjectId,
        text,
        file,
        // The update that carried the message: a redelivery opens nothing new.
        idempotencyKey: `${input.idempotencyKey}:ticket`,
      });
      return {
        key: 'bot.ticket.created',
        values: { number: opened.ticket.number },
        buttons: [ticketViewButton(opened.ticket.id), ticketsButton()],
        orderId: null,
      };
    }
    const posted = await desk.service.replyByCustomer(scope, actor, {
      customerId: customer.id,
      botInstanceId: input.botInstanceId,
      ticketId: subjectId,
      text,
      file,
      idempotencyKey: `${input.idempotencyKey}:ticket`,
    });
    return {
      key: 'bot.ticket.reply_sent',
      values: { number: posted.ticket.number },
      buttons: [ticketViewButton(posted.ticket.id), ticketsButton()],
      orderId: null,
    };
  } catch (error) {
    const code = isNexaError(error) ? error.code : null;
    const back = capture.purpose === 'TICKET_REPLY' ? ticketViewButton(subjectId) : ticketsButton();
    if (code === TICKET_ERROR_CODES.TICKET_MESSAGE_INVALID) {
      await reopen('ticket-reopen');
      return {
        key: 'bot.ticket.message_invalid',
        values: { max: TICKET_MESSAGE_MAX_LENGTH },
        buttons: [back],
        orderId: null,
      };
    }
    if (code === TICKET_ERROR_CODES.TICKET_ATTACHMENT_REFUSED) {
      await reopen('ticket-reopen');
      const tooLarge = isNexaError(error) && error.details['refusal'] === 'TOO_LARGE';
      return tooLarge
        ? {
            key: 'bot.ticket.attachment_too_large',
            values: { maxBytes: BigInt(TICKET_ATTACHMENT_MAX_BYTES) },
            buttons: [back],
            orderId: null,
          }
        : {
            key: 'bot.ticket.attachment_type_refused',
            values: {},
            buttons: [back],
            orderId: null,
          };
    }
    if (code === TICKET_ERROR_CODES.TICKET_OPEN_LIMIT) {
      return {
        key: 'bot.ticket.open_limit',
        values: { max: TICKET_OPEN_MAX_PER_CUSTOMER },
        buttons: [ticketsButton()],
        orderId: null,
      };
    }
    if (code === TICKET_ERROR_CODES.TICKET_CATEGORY_NOT_FOUND) {
      return ticketNew(rt, scope, desk, customer, input.botInstanceId);
    }
    if (code === TICKET_ERROR_CODES.TICKET_CLOSED) return ticketAlreadyClosed();
    if (code === TICKET_ERROR_CODES.TICKET_NOT_FOUND) return ticketNotFound();
    if (code === TICKET_ERROR_CODES.TICKET_MESSAGE_LIMIT) {
      return {
        key: 'bot.ticket.message_limit',
        values: {},
        buttons: [newTicketButton()],
        orderId: null,
      };
    }
    /*
     * A failure nobody answers — the database, a timeout — wrote nothing, but reading the
     * message already closed its window and the webhook answers 2xx, so Telegram will not
     * redeliver. The window is reopened so the customer's next message is still read; the
     * refund reason's rule (WP19). Best effort: the original failure is the one reported.
     */
    if (!hasRefusalReply(error)) await reopen('ticket-retry').catch(() => undefined);
    return refusal(error);
  }
}

export async function supportScreen(
  rt: BotRuntime,
  scope: TenantContext,
  customer: CustomerRecord,
): Promise<PendingReply> {
  const screen = await rt.deps.support.partsFor(scope);
  const buttons: CustomerButton[] = [
    // WP-A7: the ticket desk, from the support screen and from /paysupport alike.
    ...(rt.deps.tickets === undefined ? [] : [ticketDeskButton()]),
    ...(screen.supportUrl === null
      ? []
      : [
          {
            ...inlineLabel('support.contact'),
            url: screen.supportUrl,
          },
        ]),
    // Round N close (§D): the promotional opt-out lives on the support screen, as the
    // reverse of whatever the customer holds now — the same path /stop takes. Spec §9:
    // not drawn while the installation does not let customers change it.
    ...((await rt.deps.customers.marketingOptOutAllowed(scope))
      ? [marketingPreferenceButton(customer.marketingOptOutAt !== null)]
      : []),
    // Round 11, B6: the expiry / volume reminder switch, beside the promotional one and
    // under the same rule — not drawn while the installation does not offer the choice.
    ...((await rt.deps.customers.remindersOptOutAllowed(scope))
      ? [reminderPreferenceButton(customer.remindersOptOutAt !== null)]
      : []),
    mainMenuButton(),
  ];
  if (screen.parts.length === 0) {
    return {
      key: screen.supportUrl === null ? 'bot.support.unconfigured' : 'bot.support.contact',
      values: {},
      buttons,
      orderId: null,
    };
  }
  const last = screen.parts[screen.parts.length - 1] as string;
  return {
    key: 'bot.faq.page',
    values: { content: last },
    buttons,
    orderId: null,
    ...(screen.parts.length === 1
      ? {}
      : {
          lead: screen.parts.slice(0, -1).map((content) => ({
            kind: 'TEXT' as const,
            key: 'bot.faq.page' as const,
            values: { content },
          })),
        }),
  };
}
