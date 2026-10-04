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
