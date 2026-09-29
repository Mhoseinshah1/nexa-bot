import type {
  DeliveryOutcome,
  NotificationDestination,
  NotificationKind,
  NotificationStatus,
  NotificationTransportKind,
  OpsLogGroupProblem,
  OpsLogTopicCategory,
  ScopeContext,
  TemplateKey,
} from '@nexa/contracts';

/** A notification intent, as stored. */
export interface NotificationIntent {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: NotificationKind;
  readonly dedupeKey: string;
  readonly destination: NotificationDestination;
  readonly payload: Record<string, unknown>;
  readonly templateKey: TemplateKey;
  readonly status: NotificationStatus;
  /**
   * Claims ISSUED for this intent. Monotonic: it is never decremented, because
   * a claim whose process died with the socket open still has to count.
   */
  readonly attemptCount: number;
  /**
   * Claims handed back without ever reaching the transport.
   *
   * Zero unless the reader counted them; only the dispatch path does. Spend —
   * what actually counts against `maxAttempts` — is `attemptCount` minus this.
   */
  readonly releasedCount: number;
  readonly maxAttempts: number;
  readonly correlationId: string | null;
  readonly createdAt: Date;
  readonly lastAttemptAt: Date | null;
  readonly nextAttemptAt: Date;
  readonly completedAt: Date | null;
}

export interface DeliveryAttemptRecord {
  readonly id: string;
  readonly notificationId: string;
  readonly attemptNumber: number;
  readonly transport: NotificationTransportKind;
  readonly outcome: DeliveryOutcome;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly retryAfterMs: number | null;
}

/**
 * A claim that was issued and given back without reaching the transport.
 *
 * The counterpart to `DeliveryAttemptRecord`. Spend is `attemptCount` minus
 * these, so together the two say where every claim went — which is the only
 * way to read a history whose attempt list is shorter than its claim count.
 */
export interface ReleasedClaimRecord {
  readonly attemptNumber: number;
  readonly releasedAt: Date;
  /** A machine code: `tenant.not_active`, `sweep.withdrawn`. Never a sentence. */
  readonly reason: string;
}

export interface NotificationRepository {
  /**
   * Creates an intent, or returns the one that already exists.
   *
   * `created` is false when the dedupe key was already taken. That is not an
   * error: it is the same condition being reported again, and reporting it twice
   * must not produce two messages.
   */
  create(
    scope: ScopeContext,
    input: {
      readonly id: string;
      readonly kind: NotificationKind;
      readonly dedupeKey: string;
      readonly destination: NotificationDestination;
      readonly payload: Record<string, unknown>;
      readonly templateKey: TemplateKey;
      readonly maxAttempts: number;
      readonly correlationId: string | null;
      readonly now: Date;
    },
    tx?: unknown,
  ): Promise<{ readonly intent: NotificationIntent; readonly created: boolean }>;

  findById(scope: ScopeContext, id: string, tx?: unknown): Promise<NotificationIntent | null>;

  list(
    scope: ScopeContext,
    options: {
      readonly limit: number;
      /** The keyset cursor: the oldest row already shown, and its id. */
      readonly before?: { readonly at: Date; readonly id: string };
      readonly status?: NotificationStatus;
    },
    tx?: unknown,
  ): Promise<NotificationIntent[]>;

  attempts(
    scope: ScopeContext,
    notificationId: string,
    tx?: unknown,
  ): Promise<DeliveryAttemptRecord[]>;

  /**
   * The claims this intent gave back, for the operations view.
   *
   * Tenant-scoped and read-only, unlike every other reader of this table —
   * `claimDue` and `spentAttempts` count these rows to decide spend, and this
   * one exists so a person can see the same rows the arithmetic is using.
   */
  releasedClaims(
    scope: ScopeContext,
    notificationId: string,
    tx?: unknown,
  ): Promise<ReleasedClaimRecord[]>;

  /**
   * Claims intents that are due, across tenants, for the dispatcher.
   *
   * Housekeeping, in the same family as `RetentionSweeper`: it runs for the
   * installation and has no actor and no single tenant. `FOR UPDATE SKIP LOCKED`
   * makes several dispatchers safe to run at once, and the claim pushes
   * `next_attempt_at` forward by a lease so a sender that dies mid-flight
   * releases its work by expiry rather than holding it forever.
   */
  claimDue(now: Date, limit: number, leaseMs: number): Promise<NotificationIntent[]>;

  /**
   * Which of these tenants are open for business, right now.
   *
   * `claimDue` already refuses an inactive tenant, but it answers once for a
   * whole batch and the batch is then delivered one intent at a time. A stop
   * that lands while the first send is outstanding has to be seen by the
   * intents behind it, or the kill switch only governs whichever message
   * happened to be first in the batch.
   */
  activeTenants(tenantIds: readonly string[]): Promise<Set<string>>;

  /**
   * Records that one claim was handed back without reaching the transport.
   *
   * NOT a failure: the attempt it never spent stops counting against its
   * allowance, and the intent becomes due again — but only if this release owns
   * the current claim, or if it is withdrawing a sweep's verdict. A straggler
   * whose send outlived its lease returns its capacity without touching the
   * schedule of whoever holds the claim now; saying "due again immediately"
   * without that qualification described a version that cancelled live leases.
   * The tenant filter in `claimDue` is what then keeps the intent queued rather
   * than sent, so a stopped installation accumulates its alerts instead of
   * losing them.
   *
   * The release is keyed by the ATTEMPT NUMBER it releases, not matched
   * against the intent's current state. That is what makes it correct with
   * several workers: two claims outstanding at once hand back in either order
   * and each restores its own capacity, and a repeat after an ambiguous commit
   * is a no-op.
   *
   * A sweep that terminalised the row in between does not make the hand-back
   * impossible, and MAY be undone — but only when the sweep is still the reason
   * the intent is failed. A `FAILED_PERMANENT` attempt row that the transport
   * itself wrote is an answer, not a guess, and a claim that never spoke to the
   * transport does not overturn it.
   *
   * Refused for an attempt that DID reach the transport: an attempt row is the
   * proof one did, and capacity is never returned for a message that was sent.
   * Refused by the statement's own predicate AND, since migration 0014, by a
   * database trigger — so it holds for a caller that stops asking.
   */
  releaseClaim(input: {
    readonly tenantId: string;
    readonly notificationId: string;
    readonly attemptNumber: number;
    readonly now: Date;
    /** A machine code for why the claim was handed back. Never a sentence. */
    readonly reason: string;
  }): Promise<{
    /** True when THIS call recorded the release; false when it was already recorded. */
    readonly released: boolean;
    /**
     * True when the release took the intent back out of a sweep's verdict —
     * FAILED to PENDING, and nothing else.
     *
     * It means that and only that. The derived-state update used to cover both
     * statuses in one statement, so this was true for every ordinary hand-back
     * as well; the two are separate statements now precisely so this flag can
     * be counted and reported without describing a stopped tenant's routine
     * work as a correction.
     */
    readonly restored: boolean;
  }>;

  /**
   * Moves intents that have spent every attempt, and are still PENDING, to
   * FAILED, writing an attempt row for each. Returns how many moved.
   *
   * The gap between `claimDue`, which refuses such a row, and `recordAttempt`,
   * which is the code that normally fails it and is exactly the code that does
   * not run when a dispatch throws before it. Without this a row sits PENDING
   * for ever: never claimed, never failed, never listed anywhere as a thing that
   * went wrong.
   *
   * CROSS-TENANT, like `claimDue` and for the same reason: installation
   * housekeeping has no actor to authorize and no one tenant to scope to. That
   * argument holds only while no surface can reach it, which is a boundary
   * check rather than a hope.
   *
   * `leaseMs` is a safety margin, not decoration: a row whose lease merely
   * expired may still be mid-send, and marking that FAILED would file a
   * delivered message as failed.
   *
   * `onOperationalSwept` (HF-A4) is told, after the sweep commits, which tenants had an
   * `OPERATIONAL_EVENT` intent among the swept rows — each once — so the dispatcher can ask
   * for their operations group to be checked again, as it does when an attempt exhausts
   * an intent. Not called when none was swept.
   */
  failExhausted(
    now: Date,
    limit: number,
    options: {
      readonly leaseMs: number;
      readonly transport: NotificationTransportKind;
      readonly onOperationalSwept?: (tenantIds: readonly string[]) => void;
    },
  ): Promise<number>;

  /**
   * Records one attempt and moves the intent, in one transaction.
   *
   * Refused for an attempt number whose claim was handed back: a released claim
   * never reached the transport, so an attempt row on that number would say two
   * contradictory things about it. Enforced by a database trigger rather than
   * here, because nothing serialises this against `releaseClaim`.
   *
   * The two halves have to commit together. An attempt row with no status
   * change means a retry loop that never terminates; a status change with no
   * attempt row means the thing this table exists for — what actually happened
   * on the wire — is missing for the attempt that mattered.
   *
   * Returns whether the INTENT moved. It does not when the caller's claim has
   * been superseded: a send that outlived its lease comes back to find the row
   * already claimed by a later attempt, and its outcome must not disturb that
   * attempt's lease or terminalize the intent underneath it. The attempt row is
   * written in that case too, because it happened; what is refused is the
   * status change.
   */
  recordAttempt(input: {
    readonly attemptId: string;
    readonly tenantId: string;
    readonly notificationId: string;
    readonly attemptNumber: number;
    readonly transport: NotificationTransportKind;
    readonly outcome: DeliveryOutcome;
    readonly startedAt: Date;
    readonly finishedAt: Date;
    readonly errorCode: string | null;
    readonly errorMessage: string | null;
    readonly retryAfterMs: number | null;
    readonly nextStatus: NotificationStatus;
    readonly nextAttemptAt: Date;
    /**
     * HF-A4: raise `max_attempts` by one in the same write, so this attempt is not counted
     * against the allowance. Only for a 429 — throughput, never a failure of the message —
     * and only when the intent moved: a superseded claim's outcome changes nothing.
     */
    readonly extendAllowance?: boolean;
  }): Promise<{ readonly moved: boolean }>;

  /**
   * WP-A4: puts this tenant's PRESERVED operations-log notifications back in the queue.
   *
   * Preserved means FAILED — every attempt spent, or refused outright — and still kept:
   * nothing in this lane deletes a notification or files one as sent. Only the
   * operations lane (`OPERATIONAL_EVENT` to Telegram) is requeued; a test and a message to
   * a person are not. Each intent gets `allowance` more attempts ON TOP of what it has
   * spent, so its attempt rows keep their numbers and its history stays whole; a row
   * without a topic route is given one (`routeOf`) so it reaches the connected group.
   *
   * A conditional UPDATE naming `FAILED`, so a replay or a second operator requeues
   * nothing twice. Returns how many moved.
   */
  requeuePreserved(
    scope: ScopeContext,
    input: {
      readonly now: Date;
      readonly allowance: number;
      readonly limit: number;
      /**
       * Only rows that reached FAILED at or before this instant. The automatic drain
       * passes the moment the group was found healthy, so a row that fails AGAIN after
       * its requeue is not requeued again until the next healthy check — a message that
       * can never be delivered cannot be cycled for ever.
       */
      readonly completedBefore?: Date;
      readonly routeOf: (row: {
        readonly templateKey: string;
        readonly payload: Record<string, unknown>;
      }) => OpsLogTopicCategory;
    },
    tx?: unknown,
  ): Promise<number>;

  /** How many operations-log notifications are pending, and how many are preserved unsent. */
  opsQueueCounts(
    scope: ScopeContext,
    tx?: unknown,
  ): Promise<{ readonly pending: number; readonly preserved: number }>;
}

/** A message, rendered and addressed, ready to leave the process. */
export interface OutboundMessage {
  readonly destination: NotificationDestination;
  readonly text: string;
  /** Decides the parse mode. Declared per template key (UNK-TXT-002). */
  readonly html: boolean;
  readonly tenantId: string;
  /**
   * WP-A4: the bot to send FROM, when the destination names one — the bot that was added
   * to the operations log group. Absent means any of the tenant's active bots.
   */
  readonly botInstanceId?: string;
}

// ---------------------------------------------------------------------------
// WP-A4: the operations log group, as the notification lane sees it
// ---------------------------------------------------------------------------

/** Where the connected group is right now, for snapshotting a new intent's destination. */
export interface OpsGroupDestinationReader {
  /** Null when no group is connected: the lane then falls back to the manual setting. */
  current(
    scope: ScopeContext,
    category: OpsLogTopicCategory,
    tx?: unknown,
  ): Promise<{ readonly chatId: string; readonly topicId: number | null } | null>;
}

export type OpsTopicRoute =
  | {
      readonly kind: 'ROUTED';
      readonly chatId: string;
      readonly topicId: number;
      readonly botInstanceId: string;
    }
  | {
      readonly kind: 'UNAVAILABLE';
      /** A machine code for the attempt row: `ops_group.not_connected`, … */
      readonly errorCode: string;
      readonly errorMessage: string;
    };

/**
 * The dispatcher's view of the group, at SEND time.
 *
 * An intent routed to the group snapshots where the group stood when it was queued, and
 * is SENT to where the group stands now: a topic an operator deleted has been recreated,
 * or a preserved message is being retried after a reconnect. Every method is installation
 * housekeeping in the dispatcher's own sense — no actor, one tenant named per call — and
 * does its own work through the ops group service, which audits what it changes.
 */
export interface OpsTopicRouter {
  /** The group's current chat and the category's thread, creating the topic if owed. */
  resolve(tenantId: string, category: OpsLogTopicCategory): Promise<OpsTopicRoute>;
  /**
   * Telegram said `staleTopicId` is gone. Recreates the topic ONCE for that thread id —
   * a second sender that met the same missing thread finds it already recreated — and
   * returns where to send now.
   */
  recover(
    tenantId: string,
    category: OpsLogTopicCategory,
    staleTopicId: number,
  ): Promise<OpsTopicRoute>;
  /** A message reached the topic. Best-effort bookkeeping for the status panel. */
  delivered(
    tenantId: string,
    category: OpsLogTopicCategory,
    chatId: string,
    at: Date,
  ): Promise<void>;
  /** Telegram refused the CHAT, not the message: the panel should say why. */
  problem(tenantId: string, chatId: string, problem: OpsLogGroupProblem): Promise<void>;
  /**
   * HF-A4: a message routed to the group spent its whole allowance on failures that were
   * not about the message. A group recorded HEALTHY is marked for a fresh check; the check
   * that finds it healthy requeues what was preserved. Best-effort bookkeeping.
   */
  exhausted(tenantId: string): Promise<void>;
}

export type TransportResult =
  | { readonly outcome: 'SUCCEEDED' }
  | ({
      readonly outcome: 'FAILED_RETRYABLE';
      readonly errorCode: string;
      readonly errorMessage: string;
      /** What the transport asked us to wait, when it said anything. */
      readonly retryAfterMs?: number;
      /**
       * HF-A4: the provider refused for RATE (Telegram's 429), not for this message. The
       * dispatcher does not count the attempt against the allowance and holds every send
       * until the wait is over. Never set for a timeout, whose outcome is unknown.
       */
      readonly rateLimited?: boolean;
    } & TransportFailureSignals)
  | ({
      readonly outcome: 'FAILED_PERMANENT';
      readonly errorCode: string;
      readonly errorMessage: string;
    } & TransportFailureSignals);

/**
 * What a transport can say about WHY, beyond retryable or permanent (WP-A4).
 *
 * Decided by the transport, which is the only layer that reads the provider's error
 * text; the dispatcher acts on the flags without parsing a sentence.
 */
export interface TransportFailureSignals {
  /** The forum topic addressed no longer exists (an operator deleted it). */
  readonly topicMissing?: boolean;
  /** Telegram refused the CHAT, not the message: removed, unknown, or without rights. */
  readonly chatProblem?: OpsLogGroupProblem;
}

/**
 * The seam between deciding to say something and saying it.
 *
 * A transport never touches the database and is never called inside a
 * transaction. It takes a rendered message and reports what happened, and the
 * distinction between retryable and permanent is its most important output: a
 * wrong chat id retried forever is the legacy log group's sixty-identical-errors
 * failure with a scheduler in front of it.
 */
export interface NotificationTransport {
  readonly kind: NotificationTransportKind;
  send(message: OutboundMessage): Promise<TransportResult>;
}
