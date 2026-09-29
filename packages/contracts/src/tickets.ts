import { z } from 'zod';
import { uuidV7Schema, type Branded } from './ids.js';
import type { StateMachineDefinition } from './state-machine.js';
import {
  CUSTOMER_NOTIFICATION_STATES,
  type CustomerNotificationState,
} from './customer-notifications.js';

/**
 * WP-A7 — the support ticket system shared by Telegram and the Web Admin
 * (`docs/wp-a7-tickets-audit.md`).
 *
 * A ticket is a customer's conversation with support about one subject. Its messages are
 * DURABLE ROWS and the source of truth for the conversation: Telegram is how a message
 * reaches the other side, never where it lives. An administrator's reply is written as a
 * `ticket_messages` row and, in the same transaction, a `TICKET_REPLY` row on the customer
 * notification lane that names that message — so a Telegram send that fails, is rate-limited
 * or is never attempted loses nothing: the message is still in the ticket, and the lane
 * retries it on its own schedule.
 */

export type TicketId = Branded<string, 'TicketId'>;
export type TicketMessageId = Branded<string, 'TicketMessageId'>;
export type TicketCategoryId = Branded<string, 'TicketCategoryId'>;

// --- Status and its machine ------------------------------------------------------------

/**
 * Where a ticket is.
 *
 * - `OPEN` — filed by the customer; nobody from support has answered yet.
 * - `WAITING_FOR_CUSTOMER` — support answered; the next word is the customer's.
 * - `WAITING_FOR_SUPPORT` — the customer answered support; the next word is support's.
 * - `CLOSED` — finished. Nothing more is written into it until support reopens it.
 */
export const TICKET_STATUSES = [
  'OPEN',
  'WAITING_FOR_CUSTOMER',
  'WAITING_FOR_SUPPORT',
  'CLOSED',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export const ticketStatusSchema = z.enum(TICKET_STATUSES);

/** The statuses in which a ticket still accepts messages, and counts against the open limit. */
export const TICKET_ACTIVE_STATUSES = [
  'OPEN',
  'WAITING_FOR_CUSTOMER',
  'WAITING_FOR_SUPPORT',
] as const satisfies readonly TicketStatus[];

/**
 * What moves a ticket.
 *
 * - `SUPPORT_REPLY` / `CUSTOMER_REPLY` — a message from that side. A reply that finds the
 *   ticket already where it would move it (support answering twice) is a message and no
 *   transition; a reply to a `CLOSED` ticket is refused.
 * - `SET_WAITING_FOR_CUSTOMER` / `SET_WAITING_FOR_SUPPORT` — an operator's own triage.
 * - `CLOSE` — by the customer or by support.
 * - `REOPEN` — by support only; a reopened ticket waits for support.
 */
export type TicketEvent =
  | 'SUPPORT_REPLY'
  | 'CUSTOMER_REPLY'
  | 'SET_WAITING_FOR_CUSTOMER'
  | 'SET_WAITING_FOR_SUPPORT'
  | 'CLOSE'
  | 'REOPEN';

/**
 * Every edge, and nothing else. Every status write is a conditional UPDATE naming the
 * status it moves FROM, so two operators and a customer acting at once each either win
 * their edge or are told the ticket moved.
 */
export const TICKET_MACHINE: StateMachineDefinition<TicketStatus, TicketEvent> = {
  name: 'Ticket',
  initial: 'OPEN',
  states: TICKET_STATUSES,
  // None: a CLOSED ticket can be reopened, so no status is a dead end by design.
  terminal: [],
  transitions: [
    { from: 'OPEN', to: 'WAITING_FOR_CUSTOMER', on: 'SUPPORT_REPLY' },
    { from: 'WAITING_FOR_SUPPORT', to: 'WAITING_FOR_CUSTOMER', on: 'SUPPORT_REPLY' },
    { from: 'WAITING_FOR_CUSTOMER', to: 'WAITING_FOR_SUPPORT', on: 'CUSTOMER_REPLY' },
    { from: 'OPEN', to: 'WAITING_FOR_CUSTOMER', on: 'SET_WAITING_FOR_CUSTOMER' },
    { from: 'WAITING_FOR_SUPPORT', to: 'WAITING_FOR_CUSTOMER', on: 'SET_WAITING_FOR_CUSTOMER' },
    { from: 'OPEN', to: 'WAITING_FOR_SUPPORT', on: 'SET_WAITING_FOR_SUPPORT' },
    { from: 'WAITING_FOR_CUSTOMER', to: 'WAITING_FOR_SUPPORT', on: 'SET_WAITING_FOR_SUPPORT' },
    { from: 'OPEN', to: 'CLOSED', on: 'CLOSE' },
    { from: 'WAITING_FOR_CUSTOMER', to: 'CLOSED', on: 'CLOSE' },
    { from: 'WAITING_FOR_SUPPORT', to: 'CLOSED', on: 'CLOSE' },
    { from: 'CLOSED', to: 'WAITING_FOR_SUPPORT', on: 'REOPEN' },
  ],
};

/**
 * The status a ticket has after a message from `sender`, or `null` when the ticket
 * refuses messages (it is `CLOSED`). A reply that has no edge from where the ticket is
 * leaves the status as it was: support answering twice is still waiting for the customer.
 */
export function ticketStatusAfterMessage(
  from: TicketStatus,
  sender: 'CUSTOMER' | 'ADMIN',
): TicketStatus | null {
  if (from === 'CLOSED') return null;
  const on: TicketEvent = sender === 'ADMIN' ? 'SUPPORT_REPLY' : 'CUSTOMER_REPLY';
  return TICKET_MACHINE.transitions.find((t) => t.from === from && t.on === on)?.to ?? from;
}

/** The events an operator's status change may take. Replies are not status changes. */
const MANUAL_EVENTS: ReadonlySet<TicketEvent> = new Set<TicketEvent>([
  'SET_WAITING_FOR_CUSTOMER',
  'SET_WAITING_FOR_SUPPORT',
  'CLOSE',
  'REOPEN',
]);

/**
 * The edge an operator's "set the status to `to`" takes from `from`, or `null` when there
 * is none — which the service refuses as `TICKET_TRANSITION_INVALID`. `from === to` is not
 * an edge either; the service answers it as "nothing changed" before asking.
 */
export function ticketManualEvent(from: TicketStatus, to: TicketStatus): TicketEvent | null {
  return (
    TICKET_MACHINE.transitions.find(
      (t) => t.from === from && t.to === to && MANUAL_EVENTS.has(t.on),
    )?.on ?? null
  );
}

// --- Priority, senders, system events ----------------------------------------------------

/** Operator-facing triage. A customer never chooses it; a new ticket is `NORMAL`. */
export const TICKET_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];
export const ticketPrioritySchema = z.enum(TICKET_PRIORITIES);
export const TICKET_DEFAULT_PRIORITY: TicketPriority = 'NORMAL';

/** Who wrote a message. `SYSTEM` is the conversation recording a status fact, never text. */
export const TICKET_MESSAGE_SENDERS = ['CUSTOMER', 'ADMIN', 'SYSTEM'] as const;
export type TicketMessageSender = (typeof TICKET_MESSAGE_SENDERS)[number];

/**
 * What a `SYSTEM` message records. A closed set, rendered by a template on each surface,
 * so the history reads "closed by support" in Persian without a string being stored.
 */
export const TICKET_SYSTEM_EVENTS = [
  'CLOSED_BY_CUSTOMER',
  'CLOSED_BY_SUPPORT',
  'REOPENED_BY_SUPPORT',
] as const;
export type TicketSystemEvent = (typeof TICKET_SYSTEM_EVENTS)[number];

// --- Text ------------------------------------------------------------------------------

/**
 * The longest message, in code points after trimming. Below Telegram's 4,096 so an
 * administrator's reply always fits the notification that carries it with its heading.
 */
export const TICKET_MESSAGE_MAX_LENGTH = 3000;

/** The ticket's subject: the first line of its first message, cut to this many code points. */
export const TICKET_SUBJECT_MAX_LENGTH = 80;

/**
 * A message's text as it is stored: trimmed, C0/C1 control characters other than a newline
 * and a tab removed, `null` when nothing is left. Length is judged by the caller against
 * `TICKET_MESSAGE_MAX_LENGTH`, in code points, as the database CHECK counts it.
 */
export function normalizeTicketText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = Array.from(raw)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      if (code === 0x0a || code === 0x09) return true;
      return !(code < 0x20 || (code >= 0x7f && code <= 0x9f));
    })
    .join('');
  const trimmed = cleaned.trim();
  return trimmed === '' ? null : trimmed;
}

/** Whether a normalized text is within the message bound. */
export function isTicketTextWithinBound(text: string): boolean {
  return Array.from(text).length <= TICKET_MESSAGE_MAX_LENGTH;
}

/** The subject a ticket is listed by: the first non-empty line, bounded, or `null`. */
export function ticketSubjectOf(text: string | null): string | null {
  if (text === null) return null;
  const line = text.split('\n').find((candidate) => candidate.trim() !== '');
  if (line === undefined) return null;
  const points = Array.from(line.trim());
  return points.length <= TICKET_SUBJECT_MAX_LENGTH
    ? line.trim()
    : `${points.slice(0, TICKET_SUBJECT_MAX_LENGTH - 1).join('')}…`;
}

// --- Attachments -----------------------------------------------------------------------

/**
 * What a customer may attach: a photo or a document, the two shapes a Telegram message
 * carries a file in that this installation reads. The bytes stay at Telegram — the project's
 * file pattern (`payment-receipts.ts`): a row holds the binding and Telegram's two ids, and
 * the Web Admin fetches the bytes through the API, which holds the bot token.
 */
export const TICKET_ATTACHMENT_KINDS = ['PHOTO', 'DOCUMENT'] as const;
export type TicketAttachmentKind = (typeof TICKET_ATTACHMENT_KINDS)[number];

/**
 * The largest attachment accepted: ten megabytes, Telegram's own ceiling on a photo, and
 * under the twenty megabytes the API will ever download (`PAYMENT_RECEIPT_MAX_BYTES`).
 */
export const TICKET_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * The documents accepted, by declared MIME type AND file-name extension — both must agree.
 * An allow-list rather than a deny-list: anything not here is refused, which is what keeps
 * an executable, a script, an archive, an HTML page or an SVG out whatever it is renamed to.
 */
export const TICKET_DOCUMENT_TYPES: readonly {
  readonly mimeType: string;
  readonly extensions: readonly string[];
}[] = [
  { mimeType: 'application/pdf', extensions: ['pdf'] },
  { mimeType: 'image/jpeg', extensions: ['jpg', 'jpeg'] },
  { mimeType: 'image/png', extensions: ['png'] },
  { mimeType: 'image/webp', extensions: ['webp'] },
  { mimeType: 'text/plain', extensions: ['txt'] },
];

/** Why an attachment was refused. Nothing is written for any of them. */
export const TICKET_ATTACHMENT_REFUSALS = ['TOO_LARGE', 'TYPE_NOT_ALLOWED'] as const;
export type TicketAttachmentRefusal = (typeof TICKET_ATTACHMENT_REFUSALS)[number];

/** The longest file name stored; a longer one is cut, never refused. */
export const TICKET_ATTACHMENT_FILE_NAME_MAX_LENGTH = 200;

/**
 * Whether a file may be attached, and if not why — the ONE rule both the bot and the
 * service ask.
 *
 * A PHOTO is Telegram's own re-encoded JPEG and is accepted on its size alone, with an
 * unknown size accepted because Telegram bounds a photo at ten megabytes itself. A DOCUMENT
 * must declare its size, its MIME type and a file name whose last extension belongs to that
 * type; a document missing any of the three is refused as not allowed rather than trusted.
 */
export function ticketAttachmentRefusal(file: {
  readonly kind: TicketAttachmentKind;
  readonly mimeType: string | null;
  readonly fileName: string | null;
  readonly fileSize: bigint | null;
}): TicketAttachmentRefusal | null {
  if (file.fileSize !== null && file.fileSize > BigInt(TICKET_ATTACHMENT_MAX_BYTES)) {
    return 'TOO_LARGE';
  }
  if (file.kind === 'PHOTO') return null;
  if (file.fileSize === null || file.mimeType === null || file.fileName === null) {
    return 'TYPE_NOT_ALLOWED';
  }
  const mime = file.mimeType.trim().toLowerCase();
  const allowed = TICKET_DOCUMENT_TYPES.find((type) => type.mimeType === mime);
  if (allowed === undefined) return 'TYPE_NOT_ALLOWED';
  const dot = file.fileName.lastIndexOf('.');
  if (dot < 0) return 'TYPE_NOT_ALLOWED';
  const extension = file.fileName
    .slice(dot + 1)
    .trim()
    .toLowerCase();
  return allowed.extensions.includes(extension) ? null : 'TYPE_NOT_ALLOWED';
}

// --- Rails -----------------------------------------------------------------------------

/** How many tickets one customer may have open at once. A rail against a loop, not a policy. */
export const TICKET_OPEN_MAX_PER_CUSTOMER = 5;
/** How many messages one ticket may hold. A rail, for the same reason. */
export const TICKET_MESSAGES_MAX_PER_TICKET = 500;
/** How many tickets the customer's list in the bot shows (newest first). */
export const TICKET_CUSTOMER_LIST_LIMIT = 10;
/** How many of the latest messages the bot's conversation view shows. */
export const TICKET_VIEW_MESSAGE_COUNT = 6;
/** The bound on one message's text inside the bot's conversation view. */
export const TICKET_VIEW_MESSAGE_EXCERPT = 450;

// --- Categories ------------------------------------------------------------------------

export const TICKET_CATEGORY_TITLE_MAX_LENGTH = 64;
export const TICKET_CATEGORY_SORT_MAX = 100_000;
/** How many categories a tenant may define; a bot keyboard is not a directory. */
export const TICKET_CATEGORY_MAX = 30;

/** A category title as stored: trimmed, 1..64 code points, or `null`. */
export function normalizeTicketCategoryTitle(raw: unknown): string | null {
  const text = normalizeTicketText(raw);
  if (text === null || text.includes('\n')) return null;
  return Array.from(text).length <= TICKET_CATEGORY_TITLE_MAX_LENGTH ? text : null;
}

// --- HTTP ------------------------------------------------------------------------------

export const TICKET_PAGE_MAX = 100;

export const ticketCategoryViewSchema = z.object({
  id: z.string(),
  title: z.string(),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type TicketCategoryView = z.infer<typeof ticketCategoryViewSchema>;

export const ticketCategoryListResponseSchema = z.object({
  categories: z.array(ticketCategoryViewSchema),
});
export type TicketCategoryListResponse = z.infer<typeof ticketCategoryListResponseSchema>;

export const ticketCategoryCreateRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(255),
  title: z.string().max(TICKET_CATEGORY_TITLE_MAX_LENGTH * 4),
  sortOrder: z.number().int().min(0).max(TICKET_CATEGORY_SORT_MAX),
});
export type TicketCategoryCreateRequest = z.infer<typeof ticketCategoryCreateRequestSchema>;

export const ticketCategoryUpdateRequestSchema = z
  .object({
    title: z
      .string()
      .max(TICKET_CATEGORY_TITLE_MAX_LENGTH * 4)
      .optional(),
    sortOrder: z.number().int().min(0).max(TICKET_CATEGORY_SORT_MAX).optional(),
    isActive: z.boolean().optional(),
  })
  .refine(
    (body) =>
      body.title !== undefined || body.sortOrder !== undefined || body.isActive !== undefined,
    { message: 'Name at least one field to change.' },
  );
export type TicketCategoryUpdateRequest = z.infer<typeof ticketCategoryUpdateRequestSchema>;

export const ticketCategoryResponseSchema = z.object({
  category: ticketCategoryViewSchema,
  /** False when the write landed on the values already stored. */
  changed: z.boolean(),
});
export type TicketCategoryResponse = z.infer<typeof ticketCategoryResponseSchema>;

export const ticketSummarySchema = z.object({
  id: z.string(),
  number: z.number().int().positive(),
  status: ticketStatusSchema,
  priority: ticketPrioritySchema,
  categoryId: z.string(),
  categoryTitle: z.string(),
  subject: z.string().nullable(),
  customerId: z.string(),
  customerTelegramUserId: z.string().nullable(),
  customerUsername: z.string().nullable(),
  customerDisplayName: z.string().nullable(),
  assignedAdminId: z.string().nullable(),
  assignedAdminUsername: z.string().nullable(),
  serviceId: z.string().nullable(),
  orderId: z.string().nullable(),
  paymentId: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  lastMessageAt: z.iso.datetime(),
  closedAt: z.iso.datetime().nullable(),
});
export type TicketSummary = z.infer<typeof ticketSummarySchema>;

/**
 * How far an administrator's reply got to the customer: the customer notification lane's
 * OWN state (`CUSTOMER_NOTIFICATION_STATES`) for the `TICKET_REPLY` row that names the
 * message, projected rather than copied — one vocabulary, one row that decides it. `null`
 * for a message that is never pushed (the customer's own, a system fact).
 */
export type TicketDeliveryState = CustomerNotificationState;

export const ticketAttachmentViewSchema = z.object({
  kind: z.enum(TICKET_ATTACHMENT_KINDS),
  mimeType: z.string().nullable(),
  fileName: z.string().nullable(),
  /** Bytes. A number, not a string: an attachment is bounded far below 2^53. */
  fileSize: z.number().int().nonnegative().nullable(),
});
export type TicketAttachmentView = z.infer<typeof ticketAttachmentViewSchema>;

export const ticketMessageViewSchema = z.object({
  id: z.string(),
  senderType: z.enum(TICKET_MESSAGE_SENDERS),
  authorAdminId: z.string().nullable(),
  authorAdminUsername: z.string().nullable(),
  body: z.string().nullable(),
  systemEvent: z.enum(TICKET_SYSTEM_EVENTS).nullable(),
  attachment: ticketAttachmentViewSchema.nullable(),
  delivery: z.enum(CUSTOMER_NOTIFICATION_STATES).nullable(),
  createdAt: z.iso.datetime(),
});
export type TicketMessageView = z.infer<typeof ticketMessageViewSchema>;

export const ticketDetailResponseSchema = z.object({
  ticket: ticketSummarySchema,
  messages: z.array(ticketMessageViewSchema),
  customer: z.object({
    id: z.string(),
    telegramUserId: z.string(),
    username: z.string().nullable(),
    displayName: z.string().nullable(),
    status: z.string(),
  }),
});
export type TicketDetailResponse = z.infer<typeof ticketDetailResponseSchema>;

/**
 * The inbox's filters. `customer` is a customer's internal id, their numeric Telegram id
 * or their Telegram username (with or without `@`) — what an operator actually holds.
 * `assigned` is an administrator's id, `me`, or `none`. `from`/`to` bound `createdAt` as a
 * half-open interval `[from, to)`.
 */
export const ticketListQuerySchema = z
  .object({
    status: ticketStatusSchema.optional(),
    categoryId: uuidV7Schema.optional(),
    customer: z.string().trim().min(1).max(64).optional(),
    assigned: z.union([z.enum(['me', 'none']), uuidV7Schema]).optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    limit: z.coerce.number().int().positive().max(TICKET_PAGE_MAX).optional(),
    before: z.iso.datetime().optional(),
    beforeId: uuidV7Schema.optional(),
  })
  .refine((query) => (query.before === undefined) === (query.beforeId === undefined), {
    message: 'before and beforeId must be supplied together.',
    path: ['beforeId'],
  })
  .refine(
    (query) =>
      query.from === undefined ||
      query.to === undefined ||
      new Date(query.from).getTime() < new Date(query.to).getTime(),
    { message: 'from must be before to.', path: ['to'] },
  );
export type TicketListQuery = z.infer<typeof ticketListQuerySchema>;

export const ticketListResponseSchema = z.object({
  tickets: z.array(ticketSummarySchema),
  nextCursor: z.object({ at: z.iso.datetime(), id: z.string() }).nullable(),
});
export type TicketListResponse = z.infer<typeof ticketListResponseSchema>;

export const ticketReplyRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(255),
  text: z.string().max(TICKET_MESSAGE_MAX_LENGTH * 4),
});
export type TicketReplyRequest = z.infer<typeof ticketReplyRequestSchema>;

export const ticketReplyResponseSchema = z.object({
  ticket: ticketSummarySchema,
  message: ticketMessageViewSchema,
});
export type TicketReplyResponse = z.infer<typeof ticketReplyResponseSchema>;

/** A target status. Close, reopen and triage are all this one command. */
export const ticketStatusRequestSchema = z.object({ status: ticketStatusSchema });
export type TicketStatusRequest = z.infer<typeof ticketStatusRequestSchema>;

/** A target assignee: an administrator's id, or `null` to unassign. */
export const ticketAssignRequestSchema = z.object({ adminId: uuidV7Schema.nullable() });
export type TicketAssignRequest = z.infer<typeof ticketAssignRequestSchema>;

export const ticketPriorityRequestSchema = z.object({ priority: ticketPrioritySchema });
export type TicketPriorityRequest = z.infer<typeof ticketPriorityRequestSchema>;

/** The linked context, as a whole: each id must be the ticket's customer's own, or `null`. */
export const ticketLinksRequestSchema = z.object({
  serviceId: uuidV7Schema.nullable(),
  orderId: uuidV7Schema.nullable(),
  paymentId: uuidV7Schema.nullable(),
});
export type TicketLinksRequest = z.infer<typeof ticketLinksRequestSchema>;

export const ticketMutationResponseSchema = z.object({
  ticket: ticketSummarySchema,
  /** False when the ticket already stood where the command would have moved it. */
  changed: z.boolean(),
});
export type TicketMutationResponse = z.infer<typeof ticketMutationResponseSchema>;

export const ticketAssigneesResponseSchema = z.object({
  admins: z.array(z.object({ id: z.string(), username: z.string(), displayName: z.string() })),
});
export type TicketAssigneesResponse = z.infer<typeof ticketAssigneesResponseSchema>;

export const TICKET_ROUTES = {
  list: '/tickets',
  assignees: '/tickets/assignees',
  detail: (id: string) => `/tickets/${encodeURIComponent(id)}`,
  reply: (id: string) => `/tickets/${encodeURIComponent(id)}/messages`,
  status: (id: string) => `/tickets/${encodeURIComponent(id)}/status`,
  assign: (id: string) => `/tickets/${encodeURIComponent(id)}/assignee`,
  priority: (id: string) => `/tickets/${encodeURIComponent(id)}/priority`,
  links: (id: string) => `/tickets/${encodeURIComponent(id)}/links`,
  attachment: (id: string) => `/ticket-messages/${encodeURIComponent(id)}/attachment`,
  categories: '/ticket-categories',
  category: (id: string) => `/ticket-categories/${encodeURIComponent(id)}`,
} as const;
