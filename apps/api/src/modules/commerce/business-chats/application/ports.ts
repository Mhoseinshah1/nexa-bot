import type {
  BusinessBotRight,
  BusinessConversationState,
  BusinessEscalationTicketOutcome,
  BusinessHandoffReason,
  BusinessMessageKind,
  BusinessMessageOrigin,
  BusinessOutboundOrigin,
  BusinessOutboundState,
  BusinessTakeoverReason,
  ScopeContext,
} from '@nexa/contracts';
import type {
  BusinessConnectionReport,
  BusinessPhotoReference,
} from '../domain/telegram-business.js';

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
    | {
        readonly outcome: 'SUCCEEDED';
        readonly messageId: number | null;
        /** Telegram's own `date` for the sent message, or null when it gave none. */
        readonly sentAt: Date | null;
      }
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
  /** TB7: the ticket this conversation escalated to, if any. */
  readonly ticketId: string | null;
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

  /** TB7: links the conversation to the ticket its handoff created or linked. */
  setTicket(
    scope: ScopeContext,
    id: string,
    ticketId: string,
    now: Date,
    tx: unknown,
  ): Promise<void>;

  list(
    scope: ScopeContext,
    input: {
      readonly state?: BusinessConversationState;
      /**
       * The keyset of the last row of the previous page: its priority
       * (`businessInboxPriority`), its activity and its id. All three, or no cursor.
       */
      readonly before?: { readonly priority: 0 | 1; readonly at: Date; readonly id: string };
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
  /**
   * TB10: the oldest customer message after the latest delivered reply, read in the same
   * statement; null when there is none. `businessUnansweredSince` decides from it.
   */
  readonly firstUnansweredAt: Date | null;
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
  /** TB6: the photo reference, while the message holds one. */
  readonly photo: BusinessPhotoReference | null;
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
      /** TB6: a PHOTO's largest-size reference; never bytes, never a URL. */
      readonly photo: BusinessPhotoReference | null;
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
      /** TB6: replaces the reference of a PHOTO row only (an edit can replace the media). */
      readonly photo: BusinessPhotoReference | null;
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

  /**
   * TB6: one message's photo reference, read by the tenant, the conversation AND the row id
   * together — a message of another conversation or another tenant is null, never a file id.
   */
  photoReference(
    scope: ScopeContext,
    input: { readonly conversationId: string; readonly messageId: string },
  ): Promise<BusinessPhotoReference | null>;

  /**
   * D8: one message of a conversation by its row id, read by the tenant, the conversation AND
   * the id together — another conversation's or tenant's message is null.
   */
  findById(
    scope: ScopeContext,
    conversationId: string,
    id: string,
    tx?: unknown,
  ): Promise<BusinessMessageRecord | null>;

  /** TB7: one message of a conversation by Telegram's id (the AUTO job's trigger). */
  findByTelegramId(
    scope: ScopeContext,
    conversationId: string,
    telegramMessageId: number,
    tx?: unknown,
  ): Promise<BusinessMessageRecord | null>;

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

  /** Stamped rows whose lease ran out (oldest stamp first), at most `limit`. */
  strandedIds(scope: ScopeContext, staleBefore: Date, limit: number): Promise<readonly string[]>;

  /**
   * One stranded row resolved UNCONFIRMED, returned so the caller can act; null when it is no
   * longer PENDING and stamped before `staleBefore`.
   */
  reapStrandedRow(
    scope: ScopeContext,
    id: string,
    staleBefore: Date,
    now: Date,
    tx: unknown,
  ): Promise<BusinessOutboundRecord | null>;

  /** Purges the body of rows resolved before `cutoff`. */
  purgeBodies(
    scope: ScopeContext,
    cutoff: Date,
    now: Date,
    limit: number,
    tx: unknown,
  ): Promise<number>;

  /**
   * TB7 — the loop guard's facts: AUTO rows that were not superseded, at the conversation's
   * CURRENT epoch (every human signal and every resume moves it, so these are the automatic
   * replies since a person last acted), and since `since` whatever the epoch.
   */
  countAuto(
    scope: ScopeContext,
    input: { readonly conversationId: string; readonly epoch: number; readonly since: Date },
    tx?: unknown,
  ): Promise<{ readonly atEpoch: number; readonly inWindow: number }>;
}

// ---------------------------------------------------------------------------
// TB7 — automatic replies and the handoff's escalation
// ---------------------------------------------------------------------------

/**
 * Called inside the transaction that recorded an INBOUND customer message, under the
 * conversation's lock. The support AI decides whether an automatic job is owed (mode, state)
 * and coalesces it. Implemented in `control/support-ai`; business-chats never knows a mode.
 */
export interface InboundAutoTrigger {
  onInbound(
    scope: ScopeContext,
    input: {
      readonly conversation: BusinessConversationRecord;
      readonly telegramMessageId: number;
      readonly contentVersion: number;
      readonly edited: boolean;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<void>;
}

/** Whether a tenant's mode currently allows an AUTO row to be sent (read at the final check). */
export interface AutoReplyModeReader {
  autoReplyEnabled(scope: ScopeContext, tx: unknown): Promise<boolean>;
}

/** What a handoff carries beyond its reason: the AI's note, when the AI produced one. */
export interface HandoffDetail {
  readonly summary: string | null;
  readonly jobId: string | null;
}

/**
 * Called inside the transaction that moved a conversation INTO `HANDOFF_REQUIRED`, and inside
 * the one that moved it OUT of it to a person or back to the AI.
 */
/**
 * TB8 — when an operator hands a conversation back to the AI, the support reply they gave in it
 * may hold a reusable lesson. Called inside the resume's transaction, under the conversation's
 * lock; it only ENQUEUES a learning job (or decides not to) and never throws for a business
 * reason, because a refused learning job must not undo the handback.
 */
export interface HandbackLearningTrigger {
  onHandBack(
    scope: ScopeContext,
    input: { readonly conversation: BusinessConversationRecord; readonly now: Date },
    tx: unknown,
  ): Promise<void>;
}

export interface HandoffEscalation {
  escalate(
    scope: ScopeContext,
    input: {
      readonly conversation: BusinessConversationRecord;
      readonly reason: BusinessHandoffReason;
      readonly detail: HandoffDetail;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<void>;
  resolved(scope: ScopeContext, conversationId: string, tx: unknown): Promise<void>;
}

export interface BusinessEscalationRecord {
  readonly id: string;
  readonly conversationId: string;
  readonly controlEpoch: number;
  readonly reason: BusinessHandoffReason;
  readonly summary: string | null;
  readonly ticketId: string | null;
  readonly ticketOutcome: BusinessEscalationTicketOutcome;
  readonly jobId: string | null;
  readonly createdAt: Date;
}

export interface BusinessEscalationRepository {
  /** Once per handoff: false when this `(conversation, epoch)` was already recorded. */
  insertIfAbsent(
    scope: ScopeContext,
    row: {
      readonly id: string;
      readonly conversationId: string;
      readonly controlEpoch: number;
      readonly reason: BusinessHandoffReason;
      readonly summary: string | null;
      readonly ticketId: string | null;
      readonly ticketOutcome: BusinessEscalationTicketOutcome;
      readonly jobId: string | null;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<boolean>;
  forConversation(
    scope: ScopeContext,
    conversationId: string,
    limit: number,
  ): Promise<readonly BusinessEscalationRecord[]>;
  forTicket(
    scope: ScopeContext,
    ticketId: string,
    limit: number,
  ): Promise<readonly BusinessEscalationRecord[]>;
  purgeText(
    scope: ScopeContext,
    cutoff: Date,
    now: Date,
    limit: number,
    tx: unknown,
  ): Promise<number>;
}

/**
 * The ticket system, as a handoff needs it (implemented by `TicketService`): open a ticket for
 * the conversation's customer, or link the active one, idempotently, in the caller's
 * transaction.
 */
export interface TicketEscalationPort {
  escalateFromBusinessChat(
    scope: ScopeContext,
    input: {
      readonly customerId: string;
      readonly botInstanceId: string;
      readonly conversationId: string;
      readonly currentTicketId: string | null;
      readonly controlEpoch: number;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<{
    readonly ticketId: string | null;
    readonly outcome: BusinessEscalationTicketOutcome;
  }>;
}

/** The NEXA customer behind a Telegram id: exact `(tenant, telegram_user_id)` only. */
export interface BusinessCustomerLookup {
  byTelegramUserId(
    scope: ScopeContext,
    telegramUserId: string,
    tx?: unknown,
  ): Promise<{ readonly id: string; readonly status: string } | null>;
}
