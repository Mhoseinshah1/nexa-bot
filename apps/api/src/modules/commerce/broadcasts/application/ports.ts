import type {
  AudienceDefinition,
  BroadcastButton,
  BroadcastContentKind,
  BroadcastCounts,
  BroadcastFailureReason,
  BroadcastMediaMimeType,
  BroadcastPauseReason,
  BroadcastPinState,
  BroadcastPurpose,
  BroadcastRecipientState,
  BroadcastSource,
  BroadcastState,
  Money,
  TenantContext,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { AudienceEvaluation } from '../../audience/infrastructure/audience-sql.js';

/** A broadcast as the application reads it. */
export interface BroadcastRecord {
  readonly id: string;
  readonly title: string;
  readonly state: BroadcastState;
  readonly pauseReason: BroadcastPauseReason | null;
  readonly contentKind: BroadcastContentKind;
  /** RAW, as the operator typed it. */
  readonly body: string;
  readonly buttons: readonly BroadcastButton[];
  /** Round N close (§D): MARKETING leaves out opted-out customers. */
  readonly purpose: BroadcastPurpose;
  /** Round N close (§C): the message a FORWARD or COPY sends, and when a preview last reached it. */
  readonly source: BroadcastSource | null;
  readonly sourceVerifiedAt: Date | null;
  /** Round N close (§C): pin each delivered message, once, recorded apart from the send. */
  readonly pin: boolean;
  /** Round N close (§A): the frozen audience the launch copies its recipients from. */
  readonly frozenAudienceId: string | null;
  readonly audienceDefinition: AudienceDefinition;
  readonly audienceHash: string;
  readonly audienceAsOf: Date | null;
  readonly recipientCount: number | null;
  readonly audienceFingerprint: string | null;
  readonly scheduledAt: Date | null;
  readonly version: number;
  readonly createdBy: { readonly id: string; readonly username: string } | null;
  readonly launchedBy: { readonly id: string; readonly username: string } | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly launchedAt: Date | null;
  readonly startedAt: Date | null;
  readonly pausedAt: Date | null;
  readonly completedAt: Date | null;
  readonly cancelledAt: Date | null;
  readonly media: BroadcastMediaInfo | null;
}

export interface BroadcastMediaInfo {
  readonly kind: Exclude<BroadcastContentKind, 'TEXT'>;
  readonly mimeType: BroadcastMediaMimeType;
  readonly fileName: string;
  readonly byteLength: number;
  readonly available: boolean;
}

export interface BroadcastDraftInput {
  readonly id: string;
  readonly title: string;
  readonly contentKind: BroadcastContentKind;
  readonly body: string;
  readonly buttons: readonly BroadcastButton[];
  readonly purpose: BroadcastPurpose;
  readonly source: BroadcastSource | null;
  readonly pin: boolean;
  readonly audienceJson: string;
  readonly audienceHash: string;
  /** Create only: a draft is bound to its frozen audience for life. */
  readonly frozenAudienceId: string | null;
  readonly createdByAdminId: string | null;
  readonly now: Date;
}

export interface BroadcastMediaInput {
  readonly kind: Exclude<BroadcastContentKind, 'TEXT'>;
  readonly mimeType: BroadcastMediaMimeType;
  readonly fileName: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly now: Date;
}

/** A recipient claimed for sending: the frozen identity and its lease. */
export interface ClaimedRecipient {
  readonly broadcastId: string;
  readonly customerId: string;
  readonly botInstanceId: string;
  readonly chatId: string;
  readonly attempts: number;
  readonly leaseUntil: Date;
}

/** What one send needs to know about its broadcast, read once per pass per broadcast. */
export interface BroadcastContent {
  readonly id: string;
  readonly state: BroadcastState;
  readonly contentKind: BroadcastContentKind;
  readonly body: string;
  readonly buttons: readonly BroadcastButton[];
  readonly purpose: BroadcastPurpose;
  readonly source: BroadcastSource | null;
  readonly pin: boolean;
  /** Whether a BLOCKED customer is a skip (the audience asked for ACTIVE customers only). */
  readonly requiresActiveCustomer: boolean;
}

/** Where a recipient's media comes from, per bot. */
export type BroadcastMediaSource =
  | { readonly kind: 'FILE_ID'; readonly fileId: string }
  | {
      readonly kind: 'BYTES';
      readonly bytes: Uint8Array;
      readonly fileName: string;
      readonly mimeType: BroadcastMediaMimeType;
    };

/** How one recipient's send ended, as the repository records it. */
export type RecipientOutcome =
  | {
      readonly to: 'SENT';
      /** Telegram's message id, kept for the pin; null when the answer named none. */
      readonly messageId: number | null;
      /** Stamp the pin PENDING in the same write, so the pin request follows a commit. */
      readonly pinRequested: boolean;
    }
  | { readonly to: 'UNCONFIRMED'; readonly errorCode: string }
  | { readonly to: 'UNREACHABLE'; readonly errorCode: string }
  | { readonly to: 'FAILED'; readonly errorCode: string }
  | { readonly to: 'RETRY'; readonly errorCode: string; readonly nextAttemptAt: Date }
  | { readonly to: 'DEFER'; readonly errorCode: string; readonly nextAttemptAt: Date };

/** How one recipient's pin ended, as the repository records it. One attempt. */
export type PinOutcome =
  | { readonly to: 'PINNED' }
  | { readonly to: 'FAILED'; readonly errorCode: string }
  | { readonly to: 'UNCONFIRMED'; readonly errorCode: string };

export interface RecipientPageRow {
  readonly customerId: string;
  readonly firstName: string | null;
  readonly username: string | null;
  readonly state: BroadcastRecipientState;
  readonly attempts: number;
  readonly errorCode: string | null;
  readonly resolvedAt: Date | null;
  readonly pinState: BroadcastPinState | null;
  readonly pinErrorCode: string | null;
}

export interface BroadcastRepository {
  create(scope: TenantContext, draft: BroadcastDraftInput, tx: TransactionScope): Promise<void>;
  find(scope: TenantContext, id: string, tx?: unknown): Promise<BroadcastRecord | null>;
  /** Locks the row (`FOR UPDATE`) and reads it. */
  lock(scope: TenantContext, id: string, tx: TransactionScope): Promise<BroadcastRecord | null>;
  /** A DRAFT's content, conditional on its version; false when it moved. */
  updateDraft(
    scope: TenantContext,
    id: string,
    expectedVersion: number,
    input: Omit<BroadcastDraftInput, 'id' | 'createdByAdminId' | 'frozenAudienceId'>,
    tx: TransactionScope,
  ): Promise<boolean>;
  /**
   * Round N close (§C): a real preview reached the operator from the draft's source. The
   * stamp is bound to the draft that was TESTED — its version, kind and source — so an
   * edit that committed while the test was in flight leaves the edited draft unverified.
   * True when the stamp was written.
   */
  markSourceVerified(
    scope: TenantContext,
    id: string,
    tested: {
      readonly version: number;
      readonly contentKind: BroadcastContentKind;
      readonly source: BroadcastSource;
    },
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean>;
  /** Removes the media row when its kind no longer matches the draft's. */
  dropMismatchedMedia(scope: TenantContext, id: string, tx: TransactionScope): Promise<void>;
  /** Bytes the tenant holds undelivered, excluding one broadcast's own row. */
  stagedBytes(scope: TenantContext, excluding: string, tx: TransactionScope): Promise<number>;
  lockStaging(scope: TenantContext, tx: TransactionScope): Promise<void>;
  putMedia(
    scope: TenantContext,
    id: string,
    media: BroadcastMediaInput,
    tx: TransactionScope,
  ): Promise<void>;
  removeMedia(scope: TenantContext, id: string, tx: TransactionScope): Promise<boolean>;
  bumpVersion(scope: TenantContext, id: string, now: Date, tx: TransactionScope): Promise<void>;
  mediaSource(
    scope: TenantContext,
    id: string,
    botInstanceId: string,
    tx?: unknown,
  ): Promise<BroadcastMediaSource | null>;
  rememberHandle(
    scope: TenantContext,
    id: string,
    botInstanceId: string,
    fileId: string,
    tx: TransactionScope,
  ): Promise<void>;

  /**
   * Materialises the recipients of `evaluation` for broadcast `id` in the caller's
   * transaction, and answers with what was frozen: the count and the fingerprint, computed
   * from the ROWS written, not from a second evaluation.
   */
  materialise(
    scope: TenantContext,
    id: string,
    evaluation: AudienceEvaluation,
    now: Date,
    tx: TransactionScope,
  ): Promise<{ readonly count: number; readonly fingerprint: string }>;
  /**
   * Round N close (§A): the recipients COPIED from a frozen audience's members. A member who
   * opted out of promotions is written SKIPPED at once when the broadcast is MARKETING — a
   * frozen set decides WHO, never whether a promotional message may still be sent — and is
   * part of the count and fingerprint, exactly as an unreachable member is.
   */
  materialiseFromFrozen(
    scope: TenantContext,
    id: string,
    frozenAudienceId: string,
    input: { readonly excludeMarketingOptOuts: boolean; readonly now: Date },
    tx: TransactionScope,
  ): Promise<{ readonly count: number; readonly fingerprint: string }>;
  markLaunched(
    scope: TenantContext,
    id: string,
    input: {
      readonly to: 'SENDING' | 'SCHEDULED';
      readonly scheduledAt: Date | null;
      readonly asOf: Date;
      readonly count: number;
      readonly fingerprint: string;
      readonly launchedByAdminId: string | null;
      readonly now: Date;
    },
    tx: TransactionScope,
  ): Promise<boolean>;
  /** One conditional transition, naming its `from` states. */
  transition(
    scope: TenantContext,
    id: string,
    from: readonly BroadcastState[],
    to: BroadcastState,
    input: { readonly now: Date; readonly pauseReason?: BroadcastPauseReason },
    tx: TransactionScope,
  ): Promise<boolean>;
  cancelPending(scope: TenantContext, id: string, now: Date, tx: TransactionScope): Promise<number>;
  requeueFailed(scope: TenantContext, id: string, now: Date, tx: TransactionScope): Promise<number>;

  counts(
    scope: TenantContext,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, BroadcastCounts>>;
  list(
    scope: TenantContext,
    limit: number,
    cursor: { readonly createdAt: Date; readonly id: string } | null,
  ): Promise<readonly BroadcastRecord[]>;
  recipients(
    scope: TenantContext,
    id: string,
    input: {
      readonly state: BroadcastRecipientState | null;
      readonly limit: number;
      readonly after: string | null;
    },
  ): Promise<readonly RecipientPageRow[]>;
  /**
   * Broadcast V2 (program §19): the recipients that were not delivered, grouped by state and
   * transport error code, from the rows themselves — so each state's sum is that state's count.
   */
  failureReasons(scope: TenantContext, id: string): Promise<readonly BroadcastFailureReason[]>;

  /**
   * Where an operator's test send goes: the customer this tenant knows by the operator's own
   * linked Telegram account, and the bot that customer wrote to. Null when there is none.
   */
  testTargetFor(
    scope: TenantContext,
    adminId: string,
  ): Promise<{
    readonly customerId: string;
    readonly chatId: string;
    readonly botInstanceId: string;
  } | null>;

  // --- the dispatcher's half ----------------------------------------------------------
  /** SCHEDULED broadcasts whose time has come, moved to SENDING. Returns their ids. */
  startDue(scope: TenantContext, now: Date, tx: TransactionScope): Promise<readonly string[]>;
  /** Stamped sends whose lease ran out, resolved UNCONFIRMED. Returns how many. */
  reapStranded(scope: TenantContext, now: Date, tx: TransactionScope): Promise<number>;
  /** Round N close (§C): stamped pins whose answer never came, resolved UNCONFIRMED. */
  reapStrandedPins(scope: TenantContext, now: Date, tx: TransactionScope): Promise<number>;
  /** The bots that have a SENDING broadcast's recipient waiting. */
  botsWithWork(scope: TenantContext, now: Date): Promise<readonly string[]>;
  /**
   * Claims up to `max` of one bot's due recipients within the bot's shared pacing budget, in
   * the caller's transaction, taking the pacing row's lock first.
   */
  claimForBot(
    scope: TenantContext,
    botInstanceId: string,
    input: {
      readonly now: Date;
      readonly leaseUntil: Date;
      readonly max: number;
      readonly perSecond: number;
    },
    tx: TransactionScope,
  ): Promise<readonly ClaimedRecipient[]>;
  content(scope: TenantContext, id: string): Promise<BroadcastContent | null>;
  customerStatus(scope: TenantContext, customerId: string): Promise<string | null>;
  /** PENDING → SKIPPED, for a customer a live fact excludes. */
  skip(
    scope: TenantContext,
    recipient: ClaimedRecipient,
    errorCode: string,
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean>;
  /**
   * The stamp: PENDING → SENDING, only for the lease this pass holds and only while the
   * broadcast is SENDING. For a MARKETING send (`marketing`) the customer's opt-out is read
   * in this same transaction, under the customer's row lock: one that holds moves the row
   * PENDING → SKIPPED instead (`SKIPPED`). `MOVED` means the row was no longer this pass's
   * to stamp — do not send.
   */
  stamp(
    scope: TenantContext,
    recipient: ClaimedRecipient,
    input: { readonly now: Date; readonly leaseUntil: Date; readonly marketing: boolean },
    tx: TransactionScope,
  ): Promise<'STAMPED' | 'SKIPPED' | 'MOVED'>;
  /** Records the outcome of the send this pass stamped. False when the row had moved. */
  record(
    scope: TenantContext,
    recipient: ClaimedRecipient,
    stampedAt: Date,
    outcome: RecipientOutcome,
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean>;
  /**
   * Round N close (§C): the pin's outcome, for the pin THIS pass stamped (`pin_started_at`
   * = `stampedAt`, state PENDING). False when the row had moved — the reaper resolved it,
   * or the send itself was never recorded — and then nothing is written.
   */
  recordPin(
    scope: TenantContext,
    recipient: ClaimedRecipient,
    stampedAt: Date,
    outcome: PinOutcome,
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean>;
  holdBot(
    scope: TenantContext,
    botInstanceId: string,
    until: Date,
    now: Date,
    tx: TransactionScope,
  ): Promise<void>;
  /** SENDING broadcasts with nothing left to send, moved to COMPLETED. Returns their ids. */
  completeFinished(
    scope: TenantContext,
    now: Date,
    tx: TransactionScope,
  ): Promise<readonly { readonly id: string; readonly count: number | null }[]>;
  /** Clears staged media past retention. Returns how many rows it cleared. */
  purgeMedia(
    scope: TenantContext,
    input: { readonly terminalBefore: Date; readonly draftBefore: Date; readonly now: Date },
    tx: TransactionScope,
  ): Promise<number>;
}

/** What a recipient's placeholders are filled from, read at send time. */
export interface RecipientFacts {
  readonly firstName: string | null;
  readonly username: string | null;
  /** Only read when the body uses `{walletBalance}`. */
  readonly walletBalance: Money | null;
}

export interface RecipientFactsReader {
  factsFor(
    scope: TenantContext,
    customerId: string,
    options: { readonly withBalance: boolean },
  ): Promise<RecipientFacts>;
}

/** What one recipient's message is made of, before it is rendered. */
export interface BroadcastRenderRequest {
  readonly contentKind: BroadcastContentKind;
  /** RAW body; rendered for this recipient and wrapped in `bot.broadcast.message`. */
  readonly body: string;
  readonly facts: RecipientFacts;
  readonly buttons: readonly BroadcastButton[];
  /** Round N close (§C): the message a FORWARD or COPY sends; null for a composed kind. */
  readonly source: BroadcastSource | null;
}

/**
 * A message rendered for one recipient, ready to go. Opaque to the application: it is made by
 * `render` and handed back to `deliver`, so rendering — which reads the tenant's template and
 * can refuse — happens BEFORE the recipient is stamped, and the stamp is followed by exactly
 * one Telegram request.
 */
export interface RenderedBroadcast {
  readonly contentKind: BroadcastContentKind;
  /** The text, or the caption (possibly empty); empty for a FORWARD or COPY. */
  readonly text: string;
  readonly buttons: readonly BroadcastButton[];
  readonly source: BroadcastSource | null;
}

export type BroadcastRenderResult =
  | { readonly ok: true; readonly rendered: RenderedBroadcast }
  | { readonly ok: false; readonly errorCode: string };

export interface BroadcastDeliverRequest {
  readonly chatId: string;
  readonly botInstanceId: string;
  readonly rendered: RenderedBroadcast;
  readonly media: BroadcastMediaSource | null;
}

/**
 * What a broadcast send did. Kept apart at every layer, because each collapse costs somebody:
 *
 * - `RATE_LIMITED` — Telegram declined and said when to return. Nothing was sent.
 * - `UNKNOWN` — may have been delivered (timeout, 5xx, unreadable 2xx). Never re-sent.
 * - `UNREACHABLE` — the customer blocked the bot, deleted their account, or has no chat.
 * - `REFUSED` — Telegram refused this message on its merits.
 * - `BOT_UNAVAILABLE` — there is no usable token for the bot (disabled, revoked, 401).
 */
export type BroadcastSendResult =
  | { readonly outcome: 'SENT'; readonly fileId?: string; readonly messageId?: number }
  | { readonly outcome: 'RATE_LIMITED'; readonly retryAfterMs?: number }
  | { readonly outcome: 'UNKNOWN'; readonly errorCode: string }
  | { readonly outcome: 'UNREACHABLE'; readonly errorCode: string }
  | { readonly outcome: 'REFUSED'; readonly errorCode: string }
  | { readonly outcome: 'BOT_UNAVAILABLE'; readonly errorCode: string };

/**
 * What a pin did (round N close, §C). `PINNED` is Telegram's `True`; `FAILED` is a readable
 * refusal — including a 429, because a pin is attempted ONCE and never retried, so a rate
 * limit is a failure of that one attempt and not a reason to hold the bot; `UNKNOWN` may
 * have pinned (timeout, 5xx, unreadable 2xx).
 */
export type BroadcastPinResult =
  | { readonly outcome: 'PINNED' }
  | { readonly outcome: 'FAILED'; readonly errorCode: string }
  | { readonly outcome: 'UNKNOWN'; readonly errorCode: string };

export interface BroadcastTransport {
  /** Renders without sending. Never throws for a body Telegram would refuse: it says so. */
  render(scope: TenantContext, request: BroadcastRenderRequest): Promise<BroadcastRenderResult>;
  /** ONE Telegram request. Never throws for a send failure: the outcome is returned. */
  deliver(scope: TenantContext, request: BroadcastDeliverRequest): Promise<BroadcastSendResult>;
  /** ONE `pinChatMessage` request for a message this bot delivered. Never throws. */
  pin(
    scope: TenantContext,
    request: {
      readonly chatId: string;
      readonly botInstanceId: string;
      readonly messageId: number;
    },
  ): Promise<BroadcastPinResult>;
}
