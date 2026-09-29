import { z } from 'zod';

/**
 * WP-A4 — the Telegram operations log group and the forum topics Nexa owns in it.
 *
 * Replaces the technical manual setup, where an operator copied a numeric chat id and a
 * `message_thread_id` into three settings. Here the operator adds the bot to a forum
 * supergroup and performs ONE connection action; Nexa discovers the chat id itself from
 * the authenticated update, creates the topics it owns with `createForumTopic`, and keeps
 * their thread ids in its own registry.
 *
 * The manual settings (`ops.notifications.telegram_chat_id` and the two topic ids) remain
 * readable and honoured as an ADVANCED fallback for an installation that never connects a
 * group, and are hidden from the normal settings page (`OPS_GROUP_MANAGED_SETTING_KEYS`).
 */

// ---------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------

/**
 * The topic categories Nexa creates and owns in a connected group.
 *
 * A CATEGORY KEY, stored in a column, and not one column per topic: a third topic is a
 * new entry here, a template for its name and a route below — never a schema change. The
 * database pins only the key's shape (`OPS_LOG_TOPIC_CATEGORY_PATTERN`) for the same
 * reason, and a reader meeting a category this release does not know routes it to
 * `SYSTEM` rather than refusing it (`opsLogTopicCategoryOf`).
 */
export const OPS_LOG_TOPIC_CATEGORIES = ['SYSTEM', 'PAYMENTS'] as const;
export type OpsLogTopicCategory = (typeof OPS_LOG_TOPIC_CATEGORIES)[number];

/** The shape a category key has, in the database and on a stored destination. */
export const OPS_LOG_TOPIC_CATEGORY_PATTERN = /^[A-Z][A-Z0-9_]{0,31}$/;

export function isOpsLogTopicCategory(value: string): value is OpsLogTopicCategory {
  return (OPS_LOG_TOPIC_CATEGORIES as readonly string[]).includes(value);
}

/**
 * A stored category read back as one this release can route.
 *
 * Unknown means a LATER release wrote it (a widened vocabulary is write-compatible, not
 * reader-compatible — `docs/conventions.md`). Sending it to the system topic keeps the
 * event instead of failing it, which is the whole point of the log.
 */
export function opsLogTopicCategoryOf(value: string): OpsLogTopicCategory {
  return isOpsLogTopicCategory(value) ? value : 'SYSTEM';
}

/**
 * Where a topic stands in Nexa's registry.
 *
 * - `PENDING`: known to be owed, not created yet (or its creation is in flight).
 * - `READY`: created, and its thread id is the one Nexa posts to.
 * - `MISSING`: Telegram said the thread is gone (an operator deleted the topic). The next
 *   send recreates it, exactly once for that stale thread id.
 */
export const OPS_LOG_TOPIC_STATES = ['PENDING', 'READY', 'MISSING'] as const;
export type OpsLogTopicState = (typeof OPS_LOG_TOPIC_STATES)[number];

/** The template each owned topic is NAMED from, in Telegram. */
export const OPS_LOG_TOPIC_NAME_TEMPLATES = {
  SYSTEM: 'ops.group.topic_name.system',
  PAYMENTS: 'ops.group.topic_name.payments',
} as const satisfies Record<OpsLogTopicCategory, string>;

// ---------------------------------------------------------------------------
// Routing — explicit event → topic, not a severity threshold
// ---------------------------------------------------------------------------

/**
 * Which topic an operational event goes to, by the prefix of its code.
 *
 * EXPLICIT routing replaces the operator-set minimum severity: every meaningful
 * operational event is eligible for delivery, and this table decides WHERE, not
 * WHETHER. Severity stays on the event, internally, and is printed in the message.
 *
 * First match wins; anything unmatched goes to `SYSTEM`. The financial log (WP18) is
 * routed to `PAYMENTS` by its own caller, not through this table.
 */
export const OPS_LOG_TOPIC_ROUTES: readonly {
  readonly prefix: string;
  readonly category: OpsLogTopicCategory;
}[] = [
  { prefix: 'payments.', category: 'PAYMENTS' },
  { prefix: 'payment.', category: 'PAYMENTS' },
  { prefix: 'refunds.', category: 'PAYMENTS' },
  { prefix: 'refund.', category: 'PAYMENTS' },
  { prefix: 'wallet.', category: 'PAYMENTS' },
  { prefix: 'gateway', category: 'PAYMENTS' },
  { prefix: 'order.refunded_undeliverable', category: 'PAYMENTS' },
];

export function opsLogTopicForCode(code: string): OpsLogTopicCategory {
  for (const route of OPS_LOG_TOPIC_ROUTES) {
    if (code.startsWith(route.prefix)) return route.category;
  }
  return 'SYSTEM';
}

// ---------------------------------------------------------------------------
// The group
// ---------------------------------------------------------------------------

/**
 * Whether the tenant's group binding is in force.
 *
 * `DISCONNECTED` keeps the row — its chat, its topics, its history — so «اتصال مجدد» can
 * bring the same group back without a new code, and so an audit row naming the group
 * still has something to name.
 */
export const OPS_LOG_GROUP_STATUSES = ['CONNECTED', 'DISCONNECTED'] as const;
export type OpsLogGroupStatus = (typeof OPS_LOG_GROUP_STATUSES)[number];

/**
 * What the last permission check found.
 *
 * `UNVERIFIED` is a group nobody has checked since it was bound or since Telegram said
 * the bot's membership changed; the worker checks it on its next pass. A group is never
 * declared `HEALTHY` without `getChat` and `getChatMember` having answered.
 */
export const OPS_LOG_GROUP_HEALTH = ['UNVERIFIED', 'HEALTHY', 'PROBLEM'] as const;
export type OpsLogGroupHealth = (typeof OPS_LOG_GROUP_HEALTH)[number];

/**
 * What can be wrong with a connected group, each with Persian remediation in the Web
 * Admin (`web.opsgroup_problem_*`).
 */
export const OPS_LOG_GROUP_PROBLEMS = [
  /** The chat is not a forum supergroup: topics are switched off. */
  'NOT_FORUM',
  /** The bot is a member but not an administrator. */
  'BOT_NOT_ADMIN',
  /** The bot may not post messages in the group. */
  'CANNOT_SEND',
  /** The bot is an administrator without the "manage topics" right. */
  'CANNOT_MANAGE_TOPICS',
  /** The bot was removed from the group, or banned. */
  'BOT_REMOVED',
  /** Telegram does not know the chat, or refused to describe it. */
  'CHAT_UNREACHABLE',
  /** The bot bound to the group is stopped, or its token is unavailable. */
  'BOT_INACTIVE',
  /** A topic Nexa owns could not be created. */
  'TOPIC_CREATE_FAILED',
] as const;
export type OpsLogGroupProblem = (typeof OPS_LOG_GROUP_PROBLEMS)[number];

// ---------------------------------------------------------------------------
// Connection codes
// ---------------------------------------------------------------------------

/** How long a connection code is accepted after it is issued. */
export const OPS_CONNECT_CODE_TTL_MINUTES = 10;

/**
 * The alphabet a code is drawn from: no 0/O, 1/I/L or U, so a code read off a screen and
 * typed into Telegram survives. Twelve characters of thirty is ~59 bits, which with a
 * ten-minute life and single use is far beyond guessing.
 */
export const OPS_CONNECT_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
export const OPS_CONNECT_CODE_LENGTH = 12;

/** The deep-link payload prefix: `https://t.me/<bot>?startgroup=ops-<code>`. */
export const OPS_CONNECT_START_PREFIX = 'ops-';

/** The group command an operator may type instead: `/connect_ops <code>`. */
export const OPS_CONNECT_COMMAND = 'connect_ops';

/**
 * The admin rights the deep link asks Telegram to grant when it adds the bot: managing
 * topics, and nothing it does not need. (An administrator of a group may post; the
 * `post_messages` right is a channel's.)
 *
 * Telegram offers them to the person adding the bot; they can still decline, which is
 * why the group is verified with `getChatMember` before it is declared healthy.
 */
export const OPS_CONNECT_ADMIN_RIGHTS = 'manage_topics';

/**
 * A code as typed or deep-linked, normalised: prefix dropped, upper case, and exactly
 * the alphabet. Null when it cannot be a code, so a malformed one is never looked up.
 */
export function normaliseOpsConnectCode(raw: string): string | null {
  let value = raw.trim();
  if (value.toLowerCase().startsWith(OPS_CONNECT_START_PREFIX)) {
    value = value.slice(OPS_CONNECT_START_PREFIX.length);
  }
  value = value.toUpperCase();
  if (value.length !== OPS_CONNECT_CODE_LENGTH) return null;
  for (const character of value) {
    if (!OPS_CONNECT_CODE_ALPHABET.includes(character)) return null;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Settings this panel supersedes
// ---------------------------------------------------------------------------

/**
 * Registry keys the normal settings page does not show (WP-A4).
 *
 * The chat and topic ids are the manual fallback, edited only under the ops group
 * panel's advanced section. `min_severity` is RETIRED — stored values stay valid and
 * readable, and nothing reads them for the Telegram stream. `max_attempts` is an internal
 * operational default. None of them is deleted: a stored value must keep parsing, and the
 * settings API still returns every key.
 */
export const OPS_GROUP_MANAGED_SETTING_KEYS = [
  'ops.notifications.telegram_chat_id',
  'ops.notifications.telegram_topic_id',
  'ops.notifications.payments_topic_id',
  'ops.notifications.min_severity',
  'ops.notifications.max_attempts',
] as const;

/** The delivery allowance of one ops-log notification, and after a manual retry. */
export const OPS_NOTIFICATION_DEFAULT_MAX_ATTEMPTS = 10;

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export const OPS_GROUP_ERROR_CODES = {
  /** A bot id that is not one of this tenant's ACTIVE bots. */
  BOT_NOT_AVAILABLE: 'ops_group.bot_not_available',
  /** An action that needs a group, with none ever connected. */
  NOT_CONNECTED: 'ops_group.not_connected',
} as const;

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const isoInstant = z.string();
const idempotencyKey = z.string().min(8).max(255);

export const opsLogTopicViewSchema = z.object({
  category: z.enum(OPS_LOG_TOPIC_CATEGORIES),
  state: z.enum(OPS_LOG_TOPIC_STATES),
  /** When Nexa last delivered a message into this topic. */
  lastDeliveredAt: isoInstant.nullable(),
  /** How many times Nexa has had to recreate it after it was deleted. */
  recreatedCount: z.number().int().nonnegative(),
});
export type OpsLogTopicView = z.infer<typeof opsLogTopicViewSchema>;

export const opsLogGroupViewSchema = z.object({
  /**
   * `NOT_CONFIGURED` when no group has ever been connected. The Web Admin shows «قطع»
   * for both it and `DISCONNECTED`.
   */
  connection: z.enum(['CONNECTED', 'DISCONNECTED', 'NOT_CONFIGURED']),
  group: z
    .object({
      title: z.string(),
      bot: z.object({ id: z.string(), username: z.string() }),
      connectedAt: isoInstant,
      disconnectedAt: isoInstant.nullable(),
    })
    .nullable(),
  health: z.enum(OPS_LOG_GROUP_HEALTH),
  problems: z.array(z.enum(OPS_LOG_GROUP_PROBLEMS)),
  checkedAt: isoInstant.nullable(),
  lastDeliveredAt: isoInstant.nullable(),
  topics: z.array(opsLogTopicViewSchema),
  /** Ops-log notifications waiting to go out, and those preserved unsent after failing. */
  queue: z.object({
    pending: z.number().int().nonnegative(),
    preserved: z.number().int().nonnegative(),
  }),
  /** Whether the `ops_notifications` feature is on. Off queues nothing at all. */
  laneEnabled: z.boolean(),
  /** A connection code is outstanding until this instant. The code itself is not echoed. */
  pendingCodeExpiresAt: isoInstant.nullable(),
  /** The tenant's ACTIVE bots, for choosing which one joins the group. */
  bots: z.array(z.object({ id: z.string(), username: z.string() })),
  /** The advanced manual fallback, as configured. Used only when no group is connected. */
  manual: z.object({
    configured: z.boolean(),
    inUse: z.boolean(),
  }),
});
export type OpsLogGroupView = z.infer<typeof opsLogGroupViewSchema>;

export const opsLogGroupResponseSchema = z.object({ opsGroup: opsLogGroupViewSchema });
export type OpsLogGroupResponse = z.infer<typeof opsLogGroupResponseSchema>;

export const issueOpsConnectCodeRequestSchema = z.object({
  idempotencyKey,
  botInstanceId: z.string().min(1).max(64),
});
export type IssueOpsConnectCodeRequest = z.infer<typeof issueOpsConnectCodeRequestSchema>;

export const opsConnectCodeResponseSchema = z.object({
  /** The code. Shown once: it is stored only as a hash. */
  code: z.string(),
  /** `/connect_ops <code>`, to send in the group. */
  command: z.string(),
  /** `https://t.me/<bot>?startgroup=ops-<code>&admin=…`: adds the bot and connects. */
  deepLink: z.string(),
  expiresAt: isoInstant,
  botUsername: z.string(),
});
export type OpsConnectCodeResponse = z.infer<typeof opsConnectCodeResponseSchema>;

/** Every other action carries only its idempotency key. */
export const opsGroupActionRequestSchema = z.object({ idempotencyKey });
export type OpsGroupActionRequest = z.infer<typeof opsGroupActionRequestSchema>;

export const opsGroupTestResponseSchema = z.object({
  opsGroup: opsLogGroupViewSchema,
  results: z.array(
    z.object({
      category: z.enum(OPS_LOG_TOPIC_CATEGORIES),
      outcome: z.enum(['SENT', 'FAILED']),
      /** A machine code for a failure; null when sent. */
      errorCode: z.string().nullable(),
    }),
  ),
});
export type OpsGroupTestResponse = z.infer<typeof opsGroupTestResponseSchema>;

export const opsGroupRequeueResponseSchema = z.object({
  opsGroup: opsLogGroupViewSchema,
  /** How many preserved notifications were put back in the queue. */
  requeued: z.number().int().nonnegative(),
});
export type OpsGroupRequeueResponse = z.infer<typeof opsGroupRequeueResponseSchema>;

export const OPS_GROUP_ROUTES = {
  status: '/ops-group',
  connectCode: '/ops-group/connect-code',
  verify: '/ops-group/verify',
  test: '/ops-group/test',
  reconnect: '/ops-group/reconnect',
  disconnect: '/ops-group/disconnect',
  requeue: '/ops-group/requeue',
} as const;
