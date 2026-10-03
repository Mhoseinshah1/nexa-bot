import { z } from 'zod';
import type { CustomerNotificationState } from './customer-notifications.js';
import { uuidV7Schema } from './ids.js';
import {
  TICKET_REPLY_FILE_MAX_BYTES,
  normalizeTicketText,
  type TicketReplyFileMimeType,
} from './tickets.js';

/**
 * Phase A2 — a direct message from Customer 360 (`docs/direct-message-audit.md`).
 *
 * ONE operator-written message to ONE customer: text, or a photo or a document with an
 * optional caption. Separate from a broadcast in every respect an operator can feel — its
 * own permission (`users.message.send`), its own rate limit, its own history on the
 * customer's page — and NOT a second delivery subsystem: the message is a row, and the
 * customer notification lane (ADR 0030) sends it as `DIRECT_MESSAGE` or
 * `DIRECT_MESSAGE_MEDIA`, with that lane's outcome rules unchanged. In particular an
 * outcome Telegram left UNKNOWN is never sent again.
 */

/** What a direct message carries. A message is exactly one of these. */
export const DIRECT_MESSAGE_CONTENT_KINDS = ['TEXT', 'PHOTO', 'DOCUMENT'] as const;
export type DirectMessageContentKind = (typeof DIRECT_MESSAGE_CONTENT_KINDS)[number];

/**
 * The longest text, in code points after normalisation — the ticket reply's bound, which
 * already leaves room under Telegram's 4,096 for the template's heading.
 */
export const DIRECT_MESSAGE_TEXT_MAX_LENGTH = 3000;
/** The longest caption: Telegram's bound is 1,024 and the template adds a heading. */
export const DIRECT_MESSAGE_CAPTION_MAX_LENGTH = 900;

/**
 * The rate limit, counted from the message rows themselves inside the sending transaction,
 * under the tenant's direct-message lock — so two tabs, two replicas or a script cannot each
 * pass the count and together cross it. A sliding window, half-open `[now - window, now)`.
 *
 * Per operator: a person typing to customers one at a time does not reach this; a script
 * looping over customer ids does, and a broadcast is the tool for "everybody".
 * Per customer: however many operators write, one customer is not flooded.
 */
export const DIRECT_MESSAGE_RATE_WINDOW_MS = 10 * 60_000;
export const DIRECT_MESSAGE_MAX_PER_ADMIN = 30;
export const DIRECT_MESSAGE_MAX_PER_CUSTOMER = 5;

/**
 * How long a queued message stays worth sending. Past this — a block lifted days later, a
 * long outage — the lane SUPERSEDES it unsent, and the operator sees `EXPIRED`.
 */
export const DIRECT_MESSAGE_STALE_AFTER_MS = 24 * 3_600_000;

/**
 * Undelivered file bytes are cleared after this many days, and a tenant holds at most this
 * many bytes of them at once. A delivered file's bytes are cleared by the delivery itself,
 * which stamps Telegram's own `file_id` instead. A staging area, never a blob store.
 */
export const DIRECT_MESSAGE_FILE_RETENTION_DAYS = 7;
export const DIRECT_MESSAGE_FILE_STAGED_MAX_BYTES = 100 * 1024 * 1024;

/**
 * The file a direct message may carry is EXACTLY support's ticket-reply allow-list —
 * `ticketReplyFileRefusal` is the one rule (type, size, name and the bytes' own signature):
 * JPEG and PNG go as a photo, PDF and plain text as a document. One allow-list for one
 * question, "what may an operator upload to a customer".
 */
export type DirectMessageFileMimeType = TicketReplyFileMimeType;

/**
 * Where a message got to, as an OPERATOR reads it — a projection of the lane row's state,
 * never a second store of it. Telegram tells a bot that it ACCEPTED a message and nothing
 * more, so there is deliberately no "delivered" and no "read".
 *
 * - `QUEUED` — waiting for the lane: not yet tried, behind a rate limit, retrying a refusal,
 *   or paused because the customer was blocked after it was written.
 * - `SENDING` — handed to Telegram; the answer is not recorded yet.
 * - `SENT` — Telegram accepted it.
 * - `FAILED` — Telegram refused it every time it was tried, or there was no chat to reach.
 * - `UNKNOWN` — Telegram may or may not have it (a timeout, a 5xx). Never sent again.
 * - `EXPIRED` — it waited longer than `DIRECT_MESSAGE_STALE_AFTER_MS` and was not sent.
 */
export const DIRECT_MESSAGE_DELIVERY_STATES = [
  'QUEUED',
  'SENDING',
  'SENT',
  'FAILED',
  'UNKNOWN',
  'EXPIRED',
] as const;
export type DirectMessageDeliveryState = (typeof DIRECT_MESSAGE_DELIVERY_STATES)[number];

/** The projection. A message with no lane row at all (never expected) reads `FAILED`. */
export function directMessageDeliveryState(
  lane: { readonly state: CustomerNotificationState; readonly sendStarted: boolean } | null,
): DirectMessageDeliveryState {
  if (lane === null) return 'FAILED';
  switch (lane.state) {
    case 'PENDING':
      return lane.sendStarted ? 'SENDING' : 'QUEUED';
    case 'DELIVERED':
      return 'SENT';
    case 'UNCONFIRMED':
      return 'UNKNOWN';
    case 'FAILED':
      return 'FAILED';
    case 'SUPERSEDED':
      return 'EXPIRED';
  }
}

/** A text or caption as stored: the ticket normalisation, then the kind's own bound. */
export function normalizeDirectMessageText(raw: unknown): string | null {
  return normalizeTicketText(raw);
}

// --- HTTP -------------------------------------------------------------------------------

/** The file, as base64 inside JSON — the ticket reply's shape. */
export const directMessageFileSchema = z
  .object({
    fileName: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(100),
    contentBase64: z
      .string()
      .min(4)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/u)
      .refine((value) => value.length % 4 === 0, { message: 'padded base64' })
      .refine((value) => Math.floor((value.length * 3) / 4) <= TICKET_REPLY_FILE_MAX_BYTES + 3, {
        message: `at most ${TICKET_REPLY_FILE_MAX_BYTES} bytes`,
      }),
  })
  .strict();
export type DirectMessageFile = z.infer<typeof directMessageFileSchema>;

/**
 * `POST /users/:id/direct-messages`. `text` is the message, or the caption when a file is
 * attached (then optional). The kind is the file's — the server decides it from the bytes.
 */
export const sendDirectMessageRequestSchema = z
  .object({
    idempotencyKey: z.string().min(8).max(255),
    text: z
      .string()
      .max(DIRECT_MESSAGE_TEXT_MAX_LENGTH * 4)
      .default(''),
    file: directMessageFileSchema.nullable().default(null),
  })
  .strict();
export type SendDirectMessageRequest = z.input<typeof sendDirectMessageRequestSchema>;

export const directMessageSchema = z.object({
  id: z.string(),
  contentKind: z.enum(DIRECT_MESSAGE_CONTENT_KINDS),
  /** The text, or the caption; null for a file sent without one. */
  text: z.string().nullable(),
  file: z
    .object({
      fileName: z.string(),
      mimeType: z.string(),
      byteLength: z.number().int().nonnegative(),
    })
    .nullable(),
  /** Who wrote it; null when that administrator no longer exists. */
  sentBy: z.object({ id: z.string(), username: z.string() }).nullable(),
  createdAt: z.iso.datetime(),
  delivery: z.enum(DIRECT_MESSAGE_DELIVERY_STATES),
  /** Definite refusals so far; a rate limit is not one. */
  attempts: z.number().int().nonnegative(),
  /** When the delivery stopped being QUEUED or SENDING, whatever it became. */
  resolvedAt: z.iso.datetime().nullable(),
});
export type DirectMessageResponseItem = z.infer<typeof directMessageSchema>;

export const directMessageResponseSchema = z.object({
  message: directMessageSchema,
  /** True when the idempotency key had already sent this message: nothing new was queued. */
  replayed: z.boolean(),
});
export type DirectMessageResponse = z.infer<typeof directMessageResponseSchema>;

export const DIRECT_MESSAGE_PAGE_DEFAULT = 20;
export const DIRECT_MESSAGE_PAGE_MAX = 50;

/**
 * Newest first; the cursor is the last row's `(createdAt, id)`, supplied whole or not at all.
 *
 * `beforeId` is a UUIDv7 at the boundary: the repository compares it against a `uuid`
 * column, so `beforeId=x` beside a valid `beforeAt` reached PostgreSQL as an invalid cast
 * and answered 500 instead of 400. The ticket and alert cursors have the same rule.
 */
export const directMessageListQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(DIRECT_MESSAGE_PAGE_MAX)
      .default(DIRECT_MESSAGE_PAGE_DEFAULT),
    beforeAt: z.iso.datetime().optional(),
    beforeId: uuidV7Schema.optional(),
  })
  .refine((query) => (query.beforeAt === undefined) === (query.beforeId === undefined), {
    message: 'beforeAt and beforeId must be supplied together.',
    path: ['beforeId'],
  });
export type DirectMessageListQuery = z.infer<typeof directMessageListQuerySchema>;

export const directMessageListResponseSchema = z.object({
  messages: z.array(directMessageSchema),
  nextCursor: z.object({ at: z.iso.datetime(), id: z.string() }).nullable(),
});
export type DirectMessageListResponse = z.infer<typeof directMessageListResponseSchema>;

/** Paths under `API_PREFIX`. */
export const DIRECT_MESSAGE_ROUTES = {
  list: (customerId: string) => `/users/${customerId}/direct-messages`,
  send: (customerId: string) => `/users/${customerId}/direct-messages`,
} as const;

/**
 * Why the target cannot be written to NOW, decided at send time inside the transaction:
 * `BLOCKED` — an operator blocked the customer; `NO_BOT` — the customer never started a
 * bot of this tenant, or that bot is not active, so there is no conversation to write into.
 */
export const DIRECT_MESSAGE_TARGET_REFUSALS = ['BLOCKED', 'NO_BOT'] as const;
export type DirectMessageTargetRefusal = (typeof DIRECT_MESSAGE_TARGET_REFUSALS)[number];

export const DIRECT_MESSAGE_ERROR_CODES = {
  /** No text, or over the kind's bound. */
  BODY_INVALID: 'direct_message.body_invalid',
  /** The file is not on the allow-list, too large, misnamed or not what it says. */
  FILE_REFUSED: 'direct_message.file_refused',
  /** The tenant already holds `DIRECT_MESSAGE_FILE_STAGED_MAX_BYTES` of undelivered files. */
  FILE_STORAGE_FULL: 'direct_message.file_storage_full',
  /** See `DIRECT_MESSAGE_TARGET_REFUSALS`; the reason is in `details.reason`. */
  TARGET_UNAVAILABLE: 'direct_message.target_unavailable',
  /** Over the per-operator or per-customer window; `details.scope` says which. */
  RATE_LIMITED: 'direct_message.rate_limited',
} as const;
