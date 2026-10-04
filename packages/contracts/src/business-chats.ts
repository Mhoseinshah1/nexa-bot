import { z } from 'zod';

/**
 * TB1 — Telegram Business connections and the classification of a business message.
 *
 * ADR-0033 and `docs/support-agent/tb0-audit.md` §1. The Business connection lets the
 * tenant's bot receive the private chats of a connected Business account and send on that
 * account's behalf. Everything here is what NEXA decides from Telegram's own fields; the
 * customer-facing conversation built on it is TB2.
 */

/**
 * Every `BusinessBotRights` field the Bot API documents (Bot API 9.0+, `tb0-audit.md`
 * §1.2). A right Telegram adds later is DROPPED at the boundary rather than stored: the
 * column's CHECK names this list, and a right nothing here reads cannot change any
 * decision, so losing it loses nothing.
 */
export const BUSINESS_BOT_RIGHTS = [
  'can_reply',
  'can_read_messages',
  'can_delete_outgoing_messages',
  'can_delete_all_messages',
  'can_edit_name',
  'can_edit_bio',
  'can_edit_profile_photo',
  'can_edit_username',
  'can_change_gift_settings',
  'can_view_gifts_and_stars',
  'can_convert_gifts_to_stars',
  'can_transfer_and_upgrade_gifts',
  'can_transfer_stars',
  'can_manage_stories',
] as const;
export type BusinessBotRight = (typeof BUSINESS_BOT_RIGHTS)[number];

/**
 * The one right a support agent needs: "send and edit messages in the private chats that
 * had incoming messages in the last 24 hours". A connection without it can deliver
 * updates and still cannot answer anybody.
 */
export const BUSINESS_REQUIRED_RIGHTS = [
  'can_reply',
] as const satisfies readonly BusinessBotRight[];

/**
 * A connection's operational status — PROJECTED from what is stored, never stored itself
 * (the Phase 3 health rule: a second stored fact is a second answer that can disagree).
 *
 * - `ACTIVE` — enabled, holds every required right, not replaced.
 * - `DISABLED` — Telegram reports `is_enabled` false (the owner disconnected or paused).
 * - `RIGHTS_INSUFFICIENT` — enabled, but a required right is missing.
 * - `SUPERSEDED` — a newer connection of the same owner on the same bot replaced it
 *   (`OQ-TB-02`: whether a reconnect keeps its id is not documented).
 *
 * Only `ACTIVE` may send. Every other status fails closed.
 */
export const BUSINESS_CONNECTION_STATUSES = [
  'ACTIVE',
  'DISABLED',
  'RIGHTS_INSUFFICIENT',
  'SUPERSEDED',
] as const;
export type BusinessConnectionStatus = (typeof BUSINESS_CONNECTION_STATUSES)[number];

export function businessConnectionStatus(connection: {
  readonly isEnabled: boolean;
  readonly rights: readonly string[];
  readonly supersededAt: Date | null;
}): BusinessConnectionStatus {
  if (connection.supersededAt !== null) return 'SUPERSEDED';
  if (!connection.isEnabled) return 'DISABLED';
  const held = new Set(connection.rights);
  if (!BUSINESS_REQUIRED_RIGHTS.every((right) => held.has(right))) return 'RIGHTS_INSUFFICIENT';
  return 'ACTIVE';
}

/**
 * Who a message in a business chat came from, decided from Telegram's fields alone
 * (`tb0-audit.md` §1.4, ADR-0033 §3). Never from the text and never from timing.
 *
 * - `INBOUND` — the customer wrote to the business account.
 * - `OWN_ECHO` — a message THIS bot sent on the account's behalf.
 * - `OFFLINE` — an away, greeting or scheduled message (`is_from_offline`). Not a human.
 * - `OTHER_BOT` — another business bot sent it on the account's behalf. Treated as a
 *   human entering the conversation: it is somebody other than us speaking for the owner.
 * - `HUMAN` — the owner (or a person using the owner's account) typed it.
 */
export const BUSINESS_MESSAGE_ORIGINS = [
  'INBOUND',
  'OWN_ECHO',
  'OFFLINE',
  'OTHER_BOT',
  'HUMAN',
] as const;
export type BusinessMessageOrigin = (typeof BUSINESS_MESSAGE_ORIGINS)[number];

/** The origins that mean a person (or someone other than this bot) took the conversation. */
export const BUSINESS_TAKEOVER_ORIGINS = [
  'OTHER_BOT',
  'HUMAN',
] as const satisfies readonly BusinessMessageOrigin[];

/**
 * The classification rule, in the order ADR-0033 §3 evaluates it.
 *
 * The CONSERVATIVE rule (TB0 amendment 2): an outgoing message — one whose sender is the
 * account owner — that is not POSITIVELY attributable to this bot is a human. Doubt resolves
 * toward silence, because an AI that stays quiet costs minutes and an AI that talks over
 * the owner costs the conversation.
 *
 * `knownOwnMessage` is the second, independent proof of ownership: the message id Telegram
 * returned when this bot sent it. Either proof makes it ours.
 */
export function classifyBusinessMessage(input: {
  /** `message.from.id`, or null when Telegram omitted it. */
  readonly fromUserId: string | null;
  /** The connection's owner (`BusinessConnection.user.id`). */
  readonly ownerUserId: string;
  /** `message.sender_business_bot.id`, or null. */
  readonly senderBusinessBotId: string | null;
  /** This bot's own Telegram id (`bot_instances.telegram_bot_id`), or null when unknown. */
  readonly ownBotId: string | null;
  /** `message.is_from_offline === true`. */
  readonly isFromOffline: boolean;
  /** Whether this bot's send record already holds this message id in this chat. */
  readonly knownOwnMessage: boolean;
}): BusinessMessageOrigin {
  // A message whose sender is not the owner is the customer's. A missing `from` is NOT the
  // customer: an unattributable message is never allowed to start AI work, so it falls
  // through to the outgoing branches and ends as HUMAN at worst.
  if (input.fromUserId !== null && input.fromUserId !== input.ownerUserId) return 'INBOUND';

  const viaOurBot =
    input.ownBotId !== null &&
    input.senderBusinessBotId !== null &&
    input.senderBusinessBotId === input.ownBotId;
  if (viaOurBot || input.knownOwnMessage) return 'OWN_ECHO';
  if (input.isFromOffline) return 'OFFLINE';
  if (input.senderBusinessBotId !== null) return 'OTHER_BOT';
  return 'HUMAN';
}

/**
 * Operational-event codes. A CODE IS SCHEMA (CLAUDE.md, Phase 3C): `operational_events`
 * dedupes and recovers by code, so these are named once, here, in the release that
 * introduces them.
 *
 * One condition for "this connection cannot send", with the projected status in its
 * context, rather than one code per reason: an operator's action is the same for all of
 * them (reconnect, or grant the right), and a disabled connection whose rights were also
 * reduced is one problem, not two open rows. Deduped per connection row; recovered by the
 * recovery code when the connection is ACTIVE again or superseded by one that is.
 *
 * Supersedes the two codes `tb0-audit.md` §2 sketched (`…disabled`, `…rights_insufficient`)
 * before any were recorded.
 */
export const BUSINESS_CONNECTION_UNUSABLE_CODE = 'support.business_connection.unusable';
export const BUSINESS_CONNECTION_USABLE_CODE = 'support.business_connection.usable';

/** A business update NEXA could not process (a connection it could not verify, a store failure). */
export const BUSINESS_UPDATE_FAILED_CODE = 'support.business_update_failed';

/**
 * The outcome of one send on the account's behalf. The customer messenger's four-way
 * taxonomy (ADR-0030), unchanged: a 429 is not an unknown outcome and a timeout is not a
 * rate limit (CLAUDE.md Phase 4).
 *
 * `REFUSED` with `reason: 'CONNECTION_UNUSABLE'` is NEXA refusing before any call: the
 * stored connection is not ACTIVE. Nothing reached Telegram.
 */
export const BUSINESS_SEND_OUTCOMES = ['DELIVERED', 'REFUSED', 'RATE_LIMITED', 'UNKNOWN'] as const;
export type BusinessSendOutcomeKind = (typeof BUSINESS_SEND_OUTCOMES)[number];

/**
 * The longest text one business send carries. Telegram's own message bound; the TB2 lane
 * splits nothing — an AI or operator reply longer than this is refused at the boundary.
 */
export const BUSINESS_MESSAGE_TEXT_MAX = 4096;

export const businessTextSchema = z.string().trim().min(1).max(BUSINESS_MESSAGE_TEXT_MAX);

// ---------------------------------------------------------------------------
// TB2 — the conversation, its control, and the outbound lane (ADR-0033 §4–§8)
// ---------------------------------------------------------------------------

/**
 * Who holds a business conversation.
 *
 * - `AI_ACTIVE` — the AI may act, subject to the configured mode (TB4+). The default: a
 *   conversation the support agent has never been told to leave.
 * - `HUMAN_ACTIVE` — a person spoke for the business account. The AI stays silent until an
 *   operator explicitly resumes it (ADR-0033 §5).
 * - `HANDOFF_REQUIRED` — the system decided a person must act (`handoff_reason` says why).
 *   The AI stays silent.
 * - `PAUSED` — an operator stopped automation for this conversation without taking it.
 *
 * `DISABLED` is not a state: it is projected from the configuration mode and the
 * connection's status, so switching the mode off never rewrites conversations.
 */
export const BUSINESS_CONVERSATION_STATES = [
  'AI_ACTIVE',
  'HUMAN_ACTIVE',
  'HANDOFF_REQUIRED',
  'PAUSED',
] as const;
export type BusinessConversationState = (typeof BUSINESS_CONVERSATION_STATES)[number];

/** Why a conversation was last taken by a human. Stored for the operator, never decisive. */
export const BUSINESS_TAKEOVER_REASONS = [
  'HUMAN_MESSAGE',
  'OTHER_BOT',
  'OPERATOR_TAKEOVER',
  'OPERATOR_SEND',
] as const;
export type BusinessTakeoverReason = (typeof BUSINESS_TAKEOVER_REASONS)[number];

/**
 * Why the system handed a conversation to a person. A closed set pinned by a CHECK; each
 * later package that hands off for a new reason adds it here, in its own contract commit.
 */
export const BUSINESS_HANDOFF_REASONS = [
  /** A send Telegram may or may not have delivered: never resent, so a person decides. */
  'SEND_OUTCOME_UNKNOWN',
  /** Telegram refused a send the system made (not an operator's). */
  'TRANSPORT_REFUSED',
] as const;
export type BusinessHandoffReason = (typeof BUSINESS_HANDOFF_REASONS)[number];

/** What a stored message carries. Content beyond text arrives with TB6. */
export const BUSINESS_MESSAGE_KINDS = ['TEXT', 'PHOTO', 'OTHER'] as const;
export type BusinessMessageKind = (typeof BUSINESS_MESSAGE_KINDS)[number];

/**
 * Who put a row on the outbound lane.
 *
 * `OPERATOR` and `ASSIST` are a person pressing send: inserting one is itself a human
 * signal (ADR-0033 §4, TB0 review F7) and it is sent on an equal epoch alone. `AUTO` is the
 * AI (TB7) and additionally needs the conversation to be `AI_ACTIVE` at the final check.
 */
export const BUSINESS_OUTBOUND_ORIGINS = ['OPERATOR', 'ASSIST', 'AUTO'] as const;
export type BusinessOutboundOrigin = (typeof BUSINESS_OUTBOUND_ORIGINS)[number];

/**
 * The lane's states — ADR-0030's, for the same reasons:
 *
 * - `PENDING` — not yet resolved; due when `next_attempt_at` has passed and no send started.
 * - `DELIVERED` — Telegram accepted it.
 * - `UNCONFIRMED` — a send whose answer was lost (or whose process died after the stamp).
 *   NEVER resent.
 * - `FAILED` — refused, or out of attempts.
 * - `SUPERSEDED` — not sent, because the conversation moved on before the final check
 *   (another epoch, a state the origin may not send in, a stopped scope).
 */
export const BUSINESS_OUTBOUND_STATES = [
  'PENDING',
  'DELIVERED',
  'UNCONFIRMED',
  'FAILED',
  'SUPERSEDED',
] as const;
export type BusinessOutboundState = (typeof BUSINESS_OUTBOUND_STATES)[number];

/** Message text is kept this long after it was sent, then purged (ADR-0033 §8). */
export const BUSINESS_MESSAGE_TEXT_RETENTION_DAYS = 30;

/**
 * Whether a lane row may be sent, decided under the conversation's lock immediately before
 * the send stamp (ADR-0033 §4). The one predicate; the lane and its tests read it from here.
 */
export function businessOutboundSendable(input: {
  readonly origin: BusinessOutboundOrigin;
  readonly rowEpoch: number;
  readonly conversationEpoch: number;
  readonly conversationState: BusinessConversationState;
}): boolean {
  if (input.rowEpoch !== input.conversationEpoch) return false;
  if (input.origin === 'AUTO') return input.conversationState === 'AI_ACTIVE';
  return true;
}

// --- the Web Admin surface ---------------------------------------------------

export const BUSINESS_CHAT_ROUTES = {
  list: '/business-chats',
  detail: (id: string) => `/business-chats/${encodeURIComponent(id)}`,
  send: (id: string) => `/business-chats/${encodeURIComponent(id)}/messages`,
  takeover: (id: string) => `/business-chats/${encodeURIComponent(id)}/takeover`,
  resume: (id: string) => `/business-chats/${encodeURIComponent(id)}/resume`,
  connections: '/business-connections',
} as const;

export const BUSINESS_CHAT_LIST_LIMIT = 50;
/** The detail view shows this many most recent messages; the transcript is bounded by design. */
export const BUSINESS_CHAT_DETAIL_MESSAGES = 100;

const idempotencyKeySchema = z.string().min(8).max(128);

export const businessChatSendRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  text: businessTextSchema,
});
export type BusinessChatSendRequest = z.infer<typeof businessChatSendRequestSchema>;

export const businessChatControlRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
});
export type BusinessChatControlRequest = z.infer<typeof businessChatControlRequestSchema>;

export const businessChatListQuerySchema = z.object({
  state: z.enum(BUSINESS_CONVERSATION_STATES).optional(),
  cursor: z.string().max(64).optional(),
});

const conversationSummarySchema = z.object({
  id: z.string(),
  state: z.enum(BUSINESS_CONVERSATION_STATES),
  takeoverReason: z.enum(BUSINESS_TAKEOVER_REASONS).nullable(),
  handoffReason: z.enum(BUSINESS_HANDOFF_REASONS).nullable(),
  peerTelegramUserId: z.string(),
  customer: z
    .object({ id: z.string(), username: z.string().nullable(), firstName: z.string().nullable() })
    .nullable(),
  connectionStatus: z.enum(BUSINESS_CONNECTION_STATUSES),
  lastMessageAt: z.string().nullable(),
  lastInboundAt: z.string().nullable(),
  /** The latest message's first characters; null once its text is purged or deleted. */
  preview: z.string().nullable(),
});
export type BusinessConversationSummary = z.infer<typeof conversationSummarySchema>;

export const businessChatListResponseSchema = z.object({
  conversations: z.array(conversationSummarySchema),
  nextCursor: z.string().nullable(),
});
export type BusinessChatListResponse = z.infer<typeof businessChatListResponseSchema>;

const messageViewSchema = z.object({
  id: z.string(),
  origin: z.enum(BUSINESS_MESSAGE_ORIGINS),
  kind: z.enum(BUSINESS_MESSAGE_KINDS),
  /** Null when deleted by Telegram, purged by retention, or not text. */
  text: z.string().nullable(),
  sentAt: z.string(),
  edited: z.boolean(),
  deleted: z.boolean(),
});

const outboundViewSchema = z.object({
  id: z.string(),
  origin: z.enum(BUSINESS_OUTBOUND_ORIGINS),
  state: z.enum(BUSINESS_OUTBOUND_STATES),
  text: z.string().nullable(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
  failureCode: z.string().nullable(),
});

export const businessChatDetailResponseSchema = z.object({
  conversation: conversationSummarySchema.extend({
    controlEpoch: z.number().int(),
    lastHumanAt: z.string().nullable(),
  }),
  messages: z.array(messageViewSchema),
  outbound: z.array(outboundViewSchema),
});
export type BusinessChatDetailResponse = z.infer<typeof businessChatDetailResponseSchema>;

export const businessChatControlResponseSchema = z.object({
  state: z.enum(BUSINESS_CONVERSATION_STATES),
  controlEpoch: z.number().int(),
});
export type BusinessChatControlResponse = z.infer<typeof businessChatControlResponseSchema>;

export const businessChatSendResponseSchema = z.object({
  outboundId: z.string(),
  state: z.enum(BUSINESS_OUTBOUND_STATES),
});
export type BusinessChatSendResponse = z.infer<typeof businessChatSendResponseSchema>;

export const businessConnectionViewSchema = z.object({
  id: z.string(),
  botInstanceId: z.string(),
  ownerTelegramUserId: z.string(),
  status: z.enum(BUSINESS_CONNECTION_STATUSES),
  rights: z.array(z.enum(BUSINESS_BOT_RIGHTS)),
  connectedAt: z.string(),
  lastConfirmedAt: z.string(),
});
export const businessConnectionListResponseSchema = z.object({
  connections: z.array(businessConnectionViewSchema),
});
export type BusinessConnectionListResponse = z.infer<typeof businessConnectionListResponseSchema>;
