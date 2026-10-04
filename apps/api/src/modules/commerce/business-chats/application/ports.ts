import type {
  BusinessBotRight,
  BusinessConversationState,
  BusinessHandoffReason,
  BusinessMessageKind,
  BusinessMessageOrigin,
  BusinessOutboundOrigin,
  BusinessOutboundState,
  BusinessTakeoverReason,
  ScopeContext,
} from '@nexa/contracts';
import type { BusinessConnectionReport } from '../domain/telegram-business.js';

export type { BusinessConnectionReport };

/**
 * TB1 ports. The application layer declares them; `infrastructure/` implements them.
 */

/** One stored connection. `status` is projected by `businessConnectionStatus`, never stored. */
export interface BusinessConnectionRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly botInstanceId: string;
  readonly connectionId: string;
  readonly ownerTelegramUserId: string;
  readonly ownerUserChatId: string;
  readonly isEnabled: boolean;
  readonly rights: readonly BusinessBotRight[];
  readonly connectedAt: Date;
  readonly lastConfirmedAt: Date;
  readonly supersededAt: Date | null;
  readonly version: number;
}

export interface BusinessConnectionRepository {
  find(
    scope: ScopeContext,
    botInstanceId: string,
    connectionId: string,
    tx?: unknown,
  ): Promise<BusinessConnectionRecord | null>;

  findById(scope: ScopeContext, id: string, tx?: unknown): Promise<BusinessConnectionRecord | null>;

  /** Every connection of the tenant, newest first. */
  list(scope: ScopeContext): Promise<readonly BusinessConnectionRecord[]>;

  /**
   * The row for `(bot, connection id)`, locked FOR UPDATE, or null. Taken before an
   * apply so two deliveries of reports for one connection are applied one at a time.
   */
  lock(
    scope: ScopeContext,
    botInstanceId: string,
    connectionId: string,
    tx: unknown,
  ): Promise<BusinessConnectionRecord | null>;

  insert(
    scope: ScopeContext,
    row: {
      readonly id: string;
      readonly botInstanceId: string;
      readonly report: BusinessConnectionReport;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<{ readonly record: BusinessConnectionRecord; readonly inserted: boolean }>;

  /** Whether the owner has a live (unsuperseded) row on this bot established after `connectedAt`. */
  hasNewerLive(
    scope: ScopeContext,
    input: {
      readonly botInstanceId: string;
      readonly ownerTelegramUserId: string;
      readonly connectedAt: Date;
      readonly excludeId: string;
    },
    tx: unknown,
  ): Promise<boolean>;

  /** Marks one row superseded and returns it. */
  markSuperseded(
    scope: ScopeContext,
    id: string,
    now: Date,
    tx: unknown,
  ): Promise<BusinessConnectionRecord>;

  /** Rewrites the reported facts and advances `version`; returns the new row. */
  update(
    scope: ScopeContext,
    id: string,
    report: BusinessConnectionReport,
    now: Date,
    tx: unknown,
  ): Promise<BusinessConnectionRecord>;

  /** Stamps `last_confirmed_at` only: the report repeated what is stored. */
  confirm(scope: ScopeContext, id: string, now: Date, tx: unknown): Promise<void>;

  /**
   * Marks every OTHER live row of this owner on this bot established strictly before
   * `olderThan` superseded, returning them. `OQ-TB-02`: a newer connection id for the same
   * owner replaces the older ones — by connection age, never by arrival order.
   */
  supersedeOthers(
    scope: ScopeContext,
    input: {
      readonly botInstanceId: string;
      readonly ownerTelegramUserId: string;
      readonly keepId: string;
      readonly olderThan: Date;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<readonly BusinessConnectionRecord[]>;

  /** This bot's own Telegram id (`bot_instances.telegram_bot_id`), or null when not yet read. */
  ownBotId(scope: ScopeContext, botInstanceId: string): Promise<string | null>;
}

/** The two Telegram calls TB1 makes, behind the bot's own token. */
export interface BusinessTelegramGateway {
  /**
   * `getBusinessConnection`. `NOT_FOUND` is Telegram saying the id is unknown to it
   * (a 4xx); `UNAVAILABLE` is everything that is not an answer (5xx, 429, timeout).
   */
  getConnection(
    token: string,
    connectionId: string,
  ): Promise<
    | { readonly outcome: 'FOUND'; readonly report: BusinessConnectionReport }
    | { readonly outcome: 'NOT_FOUND'; readonly errorCode: string }
    | { readonly outcome: 'UNAVAILABLE'; readonly errorCode: string }
  >;

  /** `sendMessage` with `business_connection_id`. Never throws. */
  sendText(
    token: string,
    input: {
      readonly businessConnectionId: string;
      readonly chatId: string;
      readonly text: string;
      readonly replyToMessageId?: number;
    },
  ): Promise<
    | { readonly outcome: 'SUCCEEDED'; readonly messageId: number | null }
    | {
        readonly outcome: 'FAILED_RETRYABLE';
        readonly errorCode: string;
        readonly retryAfterMs?: number;
      }
    | { readonly outcome: 'FAILED_PERMANENT'; readonly errorCode: string }
  >;
}

/** The bot's token, ACTIVE and tenant-scoped (`tokenForBotInstance`), or null. */
export interface BusinessBotTokenSource {
  tokenForBotInstance(scope: ScopeContext, botInstanceId: string): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// TB2 — conversations, the bounded transcript, and the outbound lane
// ---------------------------------------------------------------------------

export interface BusinessConversationRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly botInstanceId: string;
  readonly ownerTelegramUserId: string;
  readonly chatId: string;
  readonly connectionRowId: string;
  readonly peerTelegramUserId: string;
  readonly customerId: string | null;
  readonly state: BusinessConversationState;
  readonly controlEpoch: number;
  readonly takeoverReason: BusinessTakeoverReason | null;
  readonly handoffReason: BusinessHandoffReason | null;
  readonly lastMessageAt: Date | null;
  readonly lastInboundAt: Date | null;
  readonly lastHumanAt: Date | null;
  readonly lastAiAt: Date | null;
  readonly version: number;
}

/**
 * A state change, as ONE conditional UPDATE naming the states it may leave (ADR-0033 §4,
 * ADR-0028's rule). `bumpEpoch` advances `control_epoch` in the same statement.
 */
export interface ConversationTransition {
  readonly from: readonly BusinessConversationState[];
  readonly to: BusinessConversationState;
  readonly bumpEpoch: boolean;
  readonly takeoverReason?: BusinessTakeoverReason | null;
  readonly handoffReason?: BusinessHandoffReason | null;
  readonly now: Date;
}

export interface BusinessConversationRepository {
  /**
   * The conversation for `(bot, owner, chat)`, created when absent, LOCKED FOR UPDATE.
   * `connectionRowId` follows the latest connection that carried the chat.
   */
  upsertLocked(
    scope: ScopeContext,
    input: {
      readonly id: string;
      readonly botInstanceId: string;
      readonly ownerTelegramUserId: string;
      readonly chatId: string;
      readonly connectionRowId: string;
      readonly peerTelegramUserId: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<BusinessConversationRecord>;

  lockById(
    scope: ScopeContext,
    id: string,
    tx: unknown,
  ): Promise<BusinessConversationRecord | null>;

  /** The conversation for `(bot, owner, chat)` without creating one. */
  findByChat(
    scope: ScopeContext,
    key: {
      readonly botInstanceId: string;
      readonly ownerTelegramUserId: string;
      readonly chatId: string;
    },
    tx?: unknown,
  ): Promise<BusinessConversationRecord | null>;

  /** One conversation with the joined facts the inbox shows. */
  listItem(scope: ScopeContext, id: string): Promise<BusinessConversationListItem | null>;
  findById(
    scope: ScopeContext,
    id: string,
    tx?: unknown,
  ): Promise<BusinessConversationRecord | null>;

  /** Null when the conversation was not in one of `transition.from`. */
  transition(
    scope: ScopeContext,
    id: string,
    transition: ConversationTransition,
    tx: unknown,
  ): Promise<BusinessConversationRecord | null>;

  /** Activity stamps and the customer link; never the state or the epoch. */
  touch(
    scope: ScopeContext,
    id: string,
    stamps: {
      readonly lastMessageAt?: Date;
      readonly lastInboundAt?: Date;
      readonly lastHumanAt?: Date;
      readonly lastAiAt?: Date;
      readonly customerId?: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<void>;

  list(
    scope: ScopeContext,
    input: {
      readonly state?: BusinessConversationState;
      readonly before?: { readonly at: Date; readonly id: string };
      readonly limit: number;
    },
  ): Promise<readonly BusinessConversationListItem[]>;
}

export interface BusinessConversationListItem {
  readonly conversation: BusinessConversationRecord;
  readonly customer: {
    readonly id: string;
    readonly username: string | null;
    readonly firstName: string | null;
  } | null;
  readonly connection: Pick<BusinessConnectionRecord, 'isEnabled' | 'rights' | 'supersededAt'>;
  readonly preview: string | null;
  /** The inbox's sort key: the latest message's time, or the row's creation. */
  readonly activityAt: Date;
}

export interface BusinessMessageRecord {
  readonly id: string;
  readonly conversationId: string;
  readonly telegramMessageId: number;
  readonly origin: BusinessMessageOrigin;
  readonly kind: BusinessMessageKind;
  readonly text: string | null;
  readonly contentVersion: number;
  readonly sentAt: Date;
  readonly editedAt: Date | null;
  readonly deletedAt: Date | null;
}

export interface BusinessMessageRepository {
  /** Inserts the message; false when `(conversation, message id)` already exists. */
  insertIfAbsent(
    scope: ScopeContext,
    row: {
      readonly id: string;
      readonly conversationId: string;
      readonly telegramMessageId: number;
      readonly origin: BusinessMessageOrigin;
      readonly kind: BusinessMessageKind;
      readonly text: string | null;
      readonly sentAt: Date;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<boolean>;

  /**
   * Applies an edit: the new text, `content_version + 1`, `edited_at`. Null when the
   * message is unknown or deleted; otherwise the new content version.
   */
  applyEdit(
    scope: ScopeContext,
    input: {
      readonly conversationId: string;
      readonly telegramMessageId: number;
      readonly text: string | null;
      readonly editedAt: Date;
    },
    tx: unknown,
  ): Promise<number | null>;

  /**
   * Our own message, stored as HUMAN because its echo was recorded before the lane wrote the
   * message id (TB2 review F2): relabelled OWN_ECHO once the id is known. Returns the count.
   */
  relabelOwnEcho(
    scope: ScopeContext,
    input: { readonly conversationId: string; readonly telegramMessageId: number },
    tx: unknown,
  ): Promise<number>;

  /** Marks deleted and purges text. Returns how many rows changed. */
  markDeleted(
    scope: ScopeContext,
    input: {
      readonly conversationId: string;
      readonly telegramMessageIds: readonly number[];
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<number>;

  recent(
    scope: ScopeContext,
    conversationId: string,
    limit: number,
  ): Promise<readonly BusinessMessageRecord[]>;

  /** Purges text sent before `cutoff`, at most `limit` rows. */
  purgeText(
    scope: ScopeContext,
    cutoff: Date,
    now: Date,
    limit: number,
    tx: unknown,
  ): Promise<number>;
}

export interface BusinessOutboundRecord {
  readonly id: string;
  readonly conversationId: string;
  readonly origin: BusinessOutboundOrigin;
  readonly body: string | null;
  readonly createdByAdminId: string | null;
  readonly controlEpoch: number;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly state: BusinessOutboundState;
  readonly attempts: number;
  readonly nextAttemptAt: Date | null;
  readonly sendStartedAt: Date | null;
  readonly resolvedAt: Date | null;
  readonly telegramMessageId: number | null;
  readonly failureCode: string | null;
  readonly createdAt: Date;
}

export interface BusinessOutboundRepository {
  insert(
    scope: ScopeContext,
    row: {
      readonly id: string;
      readonly conversationId: string;
      readonly origin: BusinessOutboundOrigin;
      readonly body: string;
      readonly createdByAdminId: string | null;
      readonly controlEpoch: number;
      readonly idempotencyKey: string;
      readonly requestHash: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<BusinessOutboundRecord>;

  findByIdempotencyKey(
    scope: ScopeContext,
    key: string,
    tx?: unknown,
  ): Promise<BusinessOutboundRecord | null>;
  findById(scope: ScopeContext, id: string, tx?: unknown): Promise<BusinessOutboundRecord | null>;
  recent(
    scope: ScopeContext,
    conversationId: string,
    limit: number,
  ): Promise<readonly BusinessOutboundRecord[]>;

  /** Whether this bot sent `telegramMessageId` in this conversation (echo proof). */
  isOwnMessage(
    scope: ScopeContext,
    input: {
      readonly botInstanceId: string;
      readonly ownerTelegramUserId: string;
      readonly chatId: string;
      readonly telegramMessageId: number;
    },
    tx?: unknown,
  ): Promise<boolean>;

  /** Leases the due rows (no send started), oldest first. */
  claimDue(
    scope: ScopeContext,
    now: Date,
    leaseUntil: Date,
    limit: number,
  ): Promise<readonly BusinessOutboundRecord[]>;

  /** PENDING and unstamped → stamped. False when somebody moved it first. */
  /**
   * Stamps the send. `lease` is the `next_attempt_at` this pass claimed the row with: a pass
   * whose lease was taken over by another (which may have sent and been told to wait) must
   * not stamp and send immediately (TB2 review N6).
   */
  markSendStarted(
    scope: ScopeContext,
    id: string,
    lease: Date | null,
    now: Date,
    tx: unknown,
  ): Promise<boolean>;

  /**
   * Resolves a PENDING row to a terminal state. `fromStamped` says whether the row must have
   * a send stamp (an outcome) or must not (a supersession before any send).
   */
  resolve(
    scope: ScopeContext,
    id: string,
    input: {
      readonly state: Exclude<BusinessOutboundState, 'PENDING'>;
      readonly fromStamped: boolean;
      readonly telegramMessageId?: number | null;
      readonly failureCode?: string | null;
      readonly attempted: boolean;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<boolean>;

  /** A 429: back to due at `nextAttemptAt`, stamp cleared, no attempt spent. */
  requeue(
    scope: ScopeContext,
    id: string,
    nextAttemptAt: Date,
    now: Date,
    tx: unknown,
  ): Promise<boolean>;

  /**
   * Supersedes every PENDING, unstamped row of a conversation created under an epoch older
   * than `epoch`. Returns how many.
   */
  supersedeStale(
    scope: ScopeContext,
    conversationId: string,
    epoch: number,
    now: Date,
    tx: unknown,
  ): Promise<number>;

  /** Stamped rows whose lease ran out: resolved UNCONFIRMED, returned so the caller can act. */
  reapStranded(
    scope: ScopeContext,
    staleBefore: Date,
    now: Date,
    limit: number,
    tx: unknown,
  ): Promise<readonly BusinessOutboundRecord[]>;

  /** Purges the body of rows resolved before `cutoff`. */
  purgeBodies(
    scope: ScopeContext,
    cutoff: Date,
    now: Date,
    limit: number,
    tx: unknown,
  ): Promise<number>;
}

/** The NEXA customer behind a Telegram id: exact `(tenant, telegram_user_id)` only. */
export interface BusinessCustomerLookup {
  byTelegramUserId(
    scope: ScopeContext,
    telegramUserId: string,
    tx?: unknown,
  ): Promise<{ readonly id: string; readonly status: string } | null>;
}
