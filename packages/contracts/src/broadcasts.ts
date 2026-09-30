import { z } from 'zod';
import { audienceFingerprintSchema } from './audience.js';
import type { StateMachineDefinition } from './state-machine.js';
import type { TemplateDefinition } from './templates.js';

/**
 * Broadcast — «ارسال همگانی» (round N, B1; `docs/round-n-broadcast-audit.md`).
 *
 * An operator-authored message sent to a FROZEN audience, one durable row per recipient.
 *
 * ## Why this is its own lane and not the customer notification lane
 *
 * ADR-0030 closes the notification lane on purpose: a closed set of kinds pinned by a CHECK,
 * each rendering ONE frozen template, none carrying a payload. A broadcast is the opposite —
 * its whole content is operator-authored — so putting it there would need the parameterised
 * payload ADR-0030 §1 refuses and would turn that lane into "send this customer some text".
 * So a broadcast has its own tables, its own dispatcher and its own pacing, and reuses what is
 * shared: the one Telegram transport (`telegramSend`), the one template renderer
 * (`renderTemplateBody`) and the bot-token source.
 *
 * ## How the operator's text is stored and rendered
 *
 * RAW, never rendered: `broadcasts.body` holds exactly what the operator typed, with its
 * placeholders. It is validated against `BROADCAST_BODY_DEFINITION` by the same
 * `validateTemplateBody` every template is, and rendered per recipient at send time by the same
 * `renderTemplateBody`. The rendered text then travels as the `{message}` value of the
 * `bot.broadcast.message` template, so a tenant can still wrap every broadcast in a header or a
 * footer through the ordinary template editor, and nothing in the database is a rendered
 * string.
 *
 * ## Delivery semantics: AT MOST ONCE
 *
 * A recipient row is stamped `SENDING` (with `send_started_at`) in a committed transaction
 * BEFORE the Telegram request, and its outcome is recorded in a second one after. A process
 * that dies between the two leaves a stamped row; the reaper resolves it `UNCONFIRMED` and
 * NOTHING re-sends it. Telegram may have delivered it, and a duplicate promotional message to
 * tens of thousands of chats is the failure that gets a bot reported and rate-limited — worse
 * than one customer missing one message, and against the repository's standing rule that an
 * UNKNOWN outcome is never retried. A 429 is NOT unknown: Telegram declined the request and
 * said when to come back, so that recipient goes back on the queue with no attempt spent.
 */

export const BROADCAST_STATES = [
  /** Being composed. Editable; nobody is materialised yet. */
  'DRAFT',
  /** Confirmed, recipients frozen, waiting for `scheduled_at`. */
  'SCHEDULED',
  /** Recipients are being sent to. */
  'SENDING',
  /** Stopped taking new sends; resumable. Sends already in flight finish. */
  'PAUSED',
  /** No recipient is waiting any more. */
  'COMPLETED',
  /** Stopped for good; every recipient not yet attempted became CANCELLED. */
  'CANCELLED',
] as const;
export type BroadcastState = (typeof BROADCAST_STATES)[number];

export type BroadcastEvent =
  'SCHEDULE' | 'START' | 'PAUSE' | 'RESUME' | 'COMPLETE' | 'CANCEL' | 'RETRY';

/**
 * The machine. Every change is a conditional UPDATE naming its `from` states, so a replay, a
 * double click and two workers are all safe. A DRAFT is never "cancelled" — it is simply not
 * launched; once launched, cancellation never recalls a message already delivered.
 */
export const BROADCAST_MACHINE: StateMachineDefinition<BroadcastState, BroadcastEvent> = {
  name: 'Broadcast',
  initial: 'DRAFT',
  states: BROADCAST_STATES,
  /*
   * CANCELLED alone is terminal. A COMPLETED broadcast re-opens on exactly one event: an
   * operator re-queuing the recipients Telegram REFUSED (`FAILED`) — never an UNCONFIRMED or
   * UNREACHABLE one, and never a delivered one.
   */
  terminal: ['CANCELLED'],
  transitions: [
    { from: 'DRAFT', to: 'SCHEDULED', on: 'SCHEDULE' },
    { from: 'DRAFT', to: 'SENDING', on: 'START' },
    { from: 'SCHEDULED', to: 'SENDING', on: 'START' },
    { from: 'SCHEDULED', to: 'CANCELLED', on: 'CANCEL' },
    { from: 'SENDING', to: 'PAUSED', on: 'PAUSE' },
    { from: 'PAUSED', to: 'SENDING', on: 'RESUME' },
    { from: 'SENDING', to: 'COMPLETED', on: 'COMPLETE' },
    { from: 'SENDING', to: 'CANCELLED', on: 'CANCEL' },
    { from: 'PAUSED', to: 'CANCELLED', on: 'CANCEL' },
    { from: 'COMPLETED', to: 'SENDING', on: 'RETRY' },
  ],
};

/** Why a broadcast is paused: an operator asked, or its bot cannot send at all. */
export const BROADCAST_PAUSE_REASONS = ['OPERATOR', 'BOT_UNAVAILABLE'] as const;
export type BroadcastPauseReason = (typeof BROADCAST_PAUSE_REASONS)[number];

export const BROADCAST_CONTENT_KINDS = ['TEXT', 'PHOTO', 'VIDEO', 'DOCUMENT'] as const;
export type BroadcastContentKind = (typeof BROADCAST_CONTENT_KINDS)[number];

/**
 * The media a broadcast may carry: each type with the kind it is sent as and its own bound.
 * Declared type, file name extension and the bytes' own signature must all agree
 * (`sniffBroadcastMedia`). Bounds sit under the Bot API's upload limits (10 MB photo, 50 MB
 * other) and under the base64 request the Web Admin sends.
 */
export const BROADCAST_MEDIA_TYPES = [
  { mimeType: 'image/jpeg', kind: 'PHOTO', extension: 'jpg', maxBytes: 5 * 1024 * 1024 },
  { mimeType: 'image/png', kind: 'PHOTO', extension: 'png', maxBytes: 5 * 1024 * 1024 },
  { mimeType: 'video/mp4', kind: 'VIDEO', extension: 'mp4', maxBytes: 20 * 1024 * 1024 },
  { mimeType: 'application/pdf', kind: 'DOCUMENT', extension: 'pdf', maxBytes: 10 * 1024 * 1024 },
] as const satisfies readonly {
  readonly mimeType: string;
  readonly kind: Exclude<BroadcastContentKind, 'TEXT'>;
  readonly extension: string;
  readonly maxBytes: number;
}[];
export type BroadcastMediaType = (typeof BROADCAST_MEDIA_TYPES)[number];
export type BroadcastMediaMimeType = BroadcastMediaType['mimeType'];
export const BROADCAST_MEDIA_MIME_TYPES: readonly BroadcastMediaMimeType[] =
  BROADCAST_MEDIA_TYPES.map((type) => type.mimeType);
export const BROADCAST_MEDIA_MAX_BYTES = Math.max(
  ...BROADCAST_MEDIA_TYPES.map((type) => type.maxBytes),
);

/**
 * The media bytes a tenant may hold undelivered at once. The bytes live in the database only
 * while a broadcast can still send them; the sweep clears them after
 * `BROADCAST_MEDIA_RETENTION_DAYS` in a terminal state, and a draft's after
 * `BROADCAST_DRAFT_MEDIA_RETENTION_DAYS` untouched. A bounded staging area, never a blob store.
 */
export const BROADCAST_MEDIA_STAGED_MAX_BYTES = 200 * 1024 * 1024;
export const BROADCAST_MEDIA_RETENTION_DAYS = 7;
export const BROADCAST_DRAFT_MEDIA_RETENTION_DAYS = 30;
export const BROADCAST_MEDIA_FILE_NAME_MAX_LENGTH = 120;

/** The type a declared MIME type names, or undefined. */
export function broadcastMediaType(mimeType: string): BroadcastMediaType | undefined {
  return BROADCAST_MEDIA_TYPES.find((type) => type.mimeType === mimeType);
}

/**
 * What the bytes themselves say they are, by signature: JPEG, PNG, an ISO-BMFF `ftyp` box
 * (MP4) or `%PDF-`. `null` when they are none of those.
 */
export function sniffBroadcastMedia(bytes: Uint8Array): BroadcastMediaMimeType | null {
  const starts = (signature: readonly number[], offset = 0) =>
    bytes.length >= offset + signature.length &&
    signature.every((value, index) => bytes[offset + index] === value);
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0x66, 0x74, 0x79, 0x70], 4)) return 'video/mp4';
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  return null;
}

export const BROADCAST_MEDIA_REFUSALS = [
  'TYPE_NOT_ALLOWED',
  'TOO_LARGE',
  'SIGNATURE_MISMATCH',
  'EXTENSION_MISMATCH',
  'EMPTY',
] as const;
export type BroadcastMediaRefusal = (typeof BROADCAST_MEDIA_REFUSALS)[number];

/** The ONE media rule, asked by the Web Admin before uploading and by the API of the bytes. */
export function broadcastMediaRefusal(input: {
  readonly mimeType: string;
  readonly fileName: string;
  readonly bytes: Uint8Array;
}): BroadcastMediaRefusal | null {
  const type = broadcastMediaType(input.mimeType);
  if (type === undefined) return 'TYPE_NOT_ALLOWED';
  if (input.bytes.length === 0) return 'EMPTY';
  if (input.bytes.length > type.maxBytes) return 'TOO_LARGE';
  const extension = input.fileName.toLowerCase().split('.').at(-1) ?? '';
  const allowed = type.mimeType === 'image/jpeg' ? ['jpg', 'jpeg'] : [type.extension];
  if (!allowed.includes(extension)) return 'EXTENSION_MISMATCH';
  if (sniffBroadcastMedia(input.bytes) !== type.mimeType) return 'SIGNATURE_MISMATCH';
  return null;
}

/** A text message's raw body; Telegram's bound is 4096 and placeholders expand. */
export const BROADCAST_TEXT_MAX_LENGTH = 3800;
/** A media caption's raw body; Telegram's bound is 1024 and placeholders expand. */
export const BROADCAST_CAPTION_MAX_LENGTH = 900;
export const BROADCAST_TITLE_MAX_LENGTH = 120;
export const BROADCAST_BUTTONS_MAX = 6;
export const BROADCAST_BUTTON_LABEL_MAX_LENGTH = 40;
export const BROADCAST_BUTTON_URL_MAX_LENGTH = 512;

/**
 * From this many recipients a launch is "very large": the operator must type the recipient
 * count back, not only tick a box (ADR-0010: confirmation proportional to blast radius).
 */
export const BROADCAST_LARGE_AUDIENCE = 1000;

/**
 * The most sends per second ONE bot is given for broadcasts, across every worker replica.
 * Telegram documents about 30 per second for bulk notifications to different chats; 20 leaves
 * room for the interactive replies the same bot is making. Enforced by a per-bot pacing row
 * taken under a row lock, so two workers share one budget instead of each spending it.
 */
export const BROADCAST_SENDS_PER_SECOND = 20;

/**
 * The attempts a recipient is given for a DEFINITE refusal that may pass (a bot token that
 * could not be resolved). A 429 spends none; an UNKNOWN outcome is never attempted again.
 */
export const BROADCAST_MAX_ATTEMPTS = 3;
/** The floor under any retry: never a zero-delay loop, whatever `retry_after` says. */
export const BROADCAST_RETRY_FLOOR_MS = 5_000;
/** How long a claimed recipient is held before another worker may take it. */
export const BROADCAST_LEASE_MS = 120_000;

export const BROADCAST_RECIPIENT_STATES = [
  /** Waiting to be sent. */
  'PENDING',
  /** Stamped: a Telegram request is in flight or was, and its answer is not yet recorded. */
  'SENDING',
  /** Telegram accepted it. */
  'SENT',
  /** The request may have been delivered — timeout, 5xx, a crash mid-send. Never re-sent. */
  'UNCONFIRMED',
  /** Telegram refused it on its merits, or the attempts ran out. The operator may re-queue. */
  'FAILED',
  /** The customer blocked the bot, deleted their account, or has no chat to reach. */
  'UNREACHABLE',
  /** A live safety fact stopped it at send time: the customer was blocked by an operator. */
  'SKIPPED',
  /** The broadcast was cancelled before this recipient was attempted. */
  'CANCELLED',
] as const;
export type BroadcastRecipientState = (typeof BROADCAST_RECIPIENT_STATES)[number];

/**
 * The placeholders an operator may use in a broadcast — the explicit, SAFE catalogue. Each is
 * a fact about the RECIPIENT, read at send time. No secret, no subscription link, no token,
 * no other customer's data: a broadcast body is typed by an operator and goes to thousands,
 * and a placeholder that could expand into a credential would be a leak with a mail-merge.
 *
 * Declared in the same `TemplateDefinition` shape every template has, so the same
 * `validateTemplateBody` and `renderTemplateBody` apply and cannot disagree.
 */
export const BROADCAST_BODY_DEFINITION: TemplateDefinition = {
  key: 'broadcast.body',
  description: 'An operator-authored broadcast message.',
  format: 'PLAIN_TEXT',
  placeholders: [
    {
      token: 'firstName',
      type: 'STRING',
      description: 'The recipient’s Telegram first name, when Telegram gave one.',
      required: false,
      repeatable: true,
    },
    {
      token: 'username',
      type: 'STRING',
      description: 'The recipient’s Telegram username without the @, when they have one.',
      required: false,
      repeatable: true,
    },
    {
      token: 'walletBalance',
      type: 'MONEY',
      description: 'The recipient’s wallet balance at send time, from the ledger.',
      required: false,
      repeatable: true,
    },
  ],
};
export type BroadcastPlaceholderToken = 'firstName' | 'username' | 'walletBalance';

// --- HTTP -------------------------------------------------------------------------------

/**
 * An `https://` or `tg://` link with a host part and no whitespace. The Telegram transport
 * parses it again before sending (`validatedButtonUrl`); this is the contract's shape check,
 * which has no URL parser to call.
 */
export const BROADCAST_BUTTON_URL_PATTERN = /^(https:\/\/[^\s/?#]+|tg:\/\/[^\s?#]+)[^\s]*$/u;

const httpsUrl = z
  .string()
  .trim()
  .min(1)
  .max(BROADCAST_BUTTON_URL_MAX_LENGTH)
  .regex(BROADCAST_BUTTON_URL_PATTERN, 'a button opens an https:// or tg:// link');

export const broadcastButtonSchema = z
  .object({
    label: z.string().trim().min(1).max(BROADCAST_BUTTON_LABEL_MAX_LENGTH),
    url: httpsUrl,
  })
  .strict();
export type BroadcastButton = z.infer<typeof broadcastButtonSchema>;

/** The composer's fields, shared by create and update. The body is checked per kind. */
const broadcastContentFields = {
  title: z.string().trim().min(1).max(BROADCAST_TITLE_MAX_LENGTH),
  contentKind: z.enum(BROADCAST_CONTENT_KINDS),
  body: z.string().max(BROADCAST_TEXT_MAX_LENGTH),
  buttons: z.array(broadcastButtonSchema).max(BROADCAST_BUTTONS_MAX).default([]),
  audience: z.unknown(),
};

export const createBroadcastRequestSchema = z
  .object({ idempotencyKey: z.string().min(8).max(255), ...broadcastContentFields })
  .strict();
export type CreateBroadcastRequest = z.input<typeof createBroadcastRequestSchema>;

export const updateBroadcastRequestSchema = z
  .object({ expectedVersion: z.number().int().positive(), ...broadcastContentFields })
  .strict();
export type UpdateBroadcastRequest = z.input<typeof updateBroadcastRequestSchema>;

/** The media, as base64 inside JSON — the tenant-media and ticket-file precedent. */
export const uploadBroadcastMediaRequestSchema = z
  .object({
    mimeType: z.string().min(1).max(100),
    fileName: z.string().trim().min(1).max(BROADCAST_MEDIA_FILE_NAME_MAX_LENGTH),
    contentBase64: z
      .string()
      .min(1)
      .refine((value) => Math.floor((value.length * 3) / 4) <= BROADCAST_MEDIA_MAX_BYTES + 3, {
        message: `at most ${BROADCAST_MEDIA_MAX_BYTES} bytes`,
      }),
  })
  .strict();
export type UploadBroadcastMediaRequest = z.infer<typeof uploadBroadcastMediaRequestSchema>;

export const BROADCAST_LAUNCH_MODES = ['NOW', 'SCHEDULE'] as const;
export type BroadcastLaunchMode = (typeof BROADCAST_LAUNCH_MODES)[number];

/**
 * The confirmation. It binds to what the operator SAW: the definition's hash, the recipient
 * count and the fingerprint of the set. The launch materialises the recipients in its own
 * transaction and refuses (`audience.changed`) when either differs — so a preview can only
 * ever authorise the send it described. From `BROADCAST_LARGE_AUDIENCE` recipients the count
 * must also be TYPED back (`typedCount`).
 */
export const launchBroadcastRequestSchema = z
  .object({
    idempotencyKey: z.string().min(8).max(255),
    mode: z.enum(BROADCAST_LAUNCH_MODES),
    scheduledAt: z.iso.datetime({ offset: true }).nullable().default(null),
    expectedVersion: z.number().int().positive(),
    expectedDefinitionHash: z.string().regex(/^[0-9a-f]{64}$/u),
    expectedRecipients: z.number().int().positive(),
    expectedFingerprint: audienceFingerprintSchema,
    confirmed: z.literal(true),
    typedCount: z.number().int().positive().nullable().default(null),
  })
  .strict()
  .refine((launch) => (launch.mode === 'SCHEDULE') === (launch.scheduledAt !== null), {
    message: 'a scheduled launch names its time, and only a scheduled one',
  });
export type LaunchBroadcastRequest = z.input<typeof launchBroadcastRequestSchema>;

export const broadcastCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  sending: z.number().int().nonnegative(),
  sent: z.number().int().nonnegative(),
  unconfirmed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  unreachable: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
});
export type BroadcastCounts = z.infer<typeof broadcastCountsSchema>;

/** An operator, by the name the Web Admin shows. Never a password hash, never a session. */
const operatorSchema = z.object({ id: z.string(), username: z.string() }).nullable();

export const broadcastMediaSchema = z.object({
  mimeType: z.string(),
  fileName: z.string(),
  byteLength: z.number().int().positive(),
  /** Whether the bytes are still held (false once the retention cleared them). */
  available: z.boolean(),
});

export const broadcastSchema = z.object({
  id: z.string(),
  title: z.string(),
  state: z.enum(BROADCAST_STATES),
  pauseReason: z.enum(BROADCAST_PAUSE_REASONS).nullable(),
  contentKind: z.enum(BROADCAST_CONTENT_KINDS),
  /** RAW, as typed, placeholders included. */
  body: z.string(),
  buttons: z.array(broadcastButtonSchema),
  media: broadcastMediaSchema.nullable(),
  /** The canonical audience definition. */
  audience: z.unknown(),
  audienceHash: z.string(),
  /** Frozen at launch; null for a draft. */
  audienceAsOf: z.iso.datetime().nullable(),
  recipientCount: z.number().int().nonnegative().nullable(),
  fingerprint: z.string().nullable(),
  scheduledAt: z.iso.datetime().nullable(),
  counts: broadcastCountsSchema,
  /** Attempted recipients over the frozen total, floored, 0–100. Null for a draft. */
  progressPercent: z.number().int().min(0).max(100).nullable(),
  version: z.number().int().positive(),
  createdBy: operatorSchema,
  launchedBy: operatorSchema,
  createdAt: z.iso.datetime(),
  launchedAt: z.iso.datetime().nullable(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  cancelledAt: z.iso.datetime().nullable(),
});
export type BroadcastResponseItem = z.infer<typeof broadcastSchema>;

export const broadcastResponseSchema = z.object({ broadcast: broadcastSchema });
export type BroadcastResponse = z.infer<typeof broadcastResponseSchema>;

export const broadcastListResponseSchema = z.object({
  broadcasts: z.array(broadcastSchema),
  nextCursor: z.string().nullable(),
});
export type BroadcastListResponse = z.infer<typeof broadcastListResponseSchema>;

export const BROADCAST_PAGE_DEFAULT = 25;
export const BROADCAST_PAGE_MAX = 100;

/** `GET /broadcasts`: newest first, keyset-paged. */
export const broadcastListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(BROADCAST_PAGE_MAX).optional(),
  cursor: z.string().min(1).max(200).optional(),
});

/** `GET /broadcasts/:id/recipients`: by customer id, optionally one state. */
export const broadcastRecipientListQuerySchema = z.object({
  state: z.enum(BROADCAST_RECIPIENT_STATES).optional(),
  limit: z.coerce.number().int().min(1).max(BROADCAST_PAGE_MAX).optional(),
  cursor: z.string().min(1).max(200).optional(),
});

/**
 * One recipient's outcome. `errorCode` is the transport's code — `telegram.rejected.403`,
 * `telegram.rate_limited`, `broadcast.no_bot` — never Telegram's free-text description, which
 * can quote a chat id.
 */
export const broadcastRecipientSchema = z.object({
  customerId: z.string(),
  firstName: z.string().nullable(),
  username: z.string().nullable(),
  state: z.enum(BROADCAST_RECIPIENT_STATES),
  attempts: z.number().int().nonnegative(),
  errorCode: z.string().nullable(),
  resolvedAt: z.iso.datetime().nullable(),
});
export type BroadcastRecipientRow = z.infer<typeof broadcastRecipientSchema>;

export const broadcastRecipientListResponseSchema = z.object({
  recipients: z.array(broadcastRecipientSchema),
  nextCursor: z.string().nullable(),
});
export type BroadcastRecipientListResponse = z.infer<typeof broadcastRecipientListResponseSchema>;

/** `POST /broadcasts/:id/test`: what the operator's own Telegram answered. */
export const broadcastTestResponseSchema = z.object({
  outcome: z.enum(['SENT', 'NOT_SENT', 'UNCONFIRMED', 'RATE_LIMITED']),
});
export type BroadcastTestResponse = z.infer<typeof broadcastTestResponseSchema>;

/** Paths under `API_PREFIX`. */
export const BROADCAST_ROUTES = {
  list: '/broadcasts',
  create: '/broadcasts',
  one: (id: string) => `/broadcasts/${id}`,
  update: (id: string) => `/broadcasts/${id}/draft`,
  media: (id: string) => `/broadcasts/${id}/media`,
  removeMedia: (id: string) => `/broadcasts/${id}/media/remove`,
  preview: (id: string) => `/broadcasts/${id}/preview`,
  test: (id: string) => `/broadcasts/${id}/test`,
  launch: (id: string) => `/broadcasts/${id}/launch`,
  pause: (id: string) => `/broadcasts/${id}/pause`,
  resume: (id: string) => `/broadcasts/${id}/resume`,
  cancel: (id: string) => `/broadcasts/${id}/cancel`,
  retryFailed: (id: string) => `/broadcasts/${id}/retry-failed`,
  recipients: (id: string) => `/broadcasts/${id}/recipients`,
} as const;

export const BROADCAST_ERROR_CODES = {
  NOT_FOUND: 'broadcast.not_found',
  /** The request is not valid for the broadcast's current state. */
  STATE_CONFLICT: 'broadcast.state_conflict',
  /** The draft changed since the editor loaded it. */
  VERSION_CONFLICT: 'broadcast.version_conflict',
  /** The body does not validate against the placeholder catalogue or its kind's bound. */
  BODY_INVALID: 'broadcast.body_invalid',
  /** A media kind with no media, or text with media. */
  MEDIA_REQUIRED: 'broadcast.media_required',
  MEDIA_REFUSED: 'broadcast.media_refused',
  /** The tenant already holds `BROADCAST_MEDIA_STAGED_MAX_BYTES` of undelivered media. */
  MEDIA_STORAGE_FULL: 'broadcast.media_storage_full',
  /** The draft's media was cleared by the retention sweep; upload it again. */
  MEDIA_EXPIRED: 'broadcast.media_expired',
  /** A large audience launched without typing its count back, or with the wrong one. */
  CONFIRMATION_REQUIRED: 'broadcast.confirmation_required',
  /** A schedule in the past. */
  SCHEDULE_INVALID: 'broadcast.schedule_invalid',
  /** The operator has no Telegram account this installation can reach for a test send. */
  TEST_TARGET_UNAVAILABLE: 'broadcast.test_target_unavailable',
} as const;
