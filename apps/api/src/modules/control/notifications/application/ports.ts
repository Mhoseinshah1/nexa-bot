import type {
  DeliveryOutcome,
  NotificationDestination,
  NotificationKind,
  NotificationStatus,
  NotificationTransportKind,
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
  readonly attemptCount: number;
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
      readonly before?: Date;
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
   * Puts a claimed intent back, as though it had never been claimed.
   *
   * NOT a failure: the intent is due again immediately, with the attempt it
   * never spent returned to it. The tenant filter in `claimDue` is what then
   * keeps it queued rather than sent, so a stopped installation accumulates
   * its alerts instead of losing them.
   *
   * Ownership is the predicate, exactly as in `recordAttempt`: the claim's
   * `attempt_count` names the attempt in flight, so a releaser whose send
   * outlived its lease finds it changed and releases nothing.
   */
  releaseClaim(input: {
    readonly tenantId: string;
    readonly notificationId: string;
    readonly attemptNumber: number;
    readonly now: Date;
  }): Promise<{ readonly released: boolean }>;

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
   */
  failExhausted(
    now: Date,
    limit: number,
    options: { readonly leaseMs: number; readonly transport: NotificationTransportKind },
  ): Promise<number>;

  /**
   * Records one attempt and moves the intent, in one transaction.
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
  }): Promise<{ readonly moved: boolean }>;
}

/** A message, rendered and addressed, ready to leave the process. */
export interface OutboundMessage {
  readonly destination: NotificationDestination;
  readonly text: string;
  /** Decides the parse mode. Declared per template key (UNK-TXT-002). */
  readonly html: boolean;
  readonly tenantId: string;
}

export type TransportResult =
  | { readonly outcome: 'SUCCEEDED' }
  | {
      readonly outcome: 'FAILED_RETRYABLE';
      readonly errorCode: string;
      readonly errorMessage: string;
      /** What the transport asked us to wait, when it said anything. */
      readonly retryAfterMs?: number;
    }
  | {
      readonly outcome: 'FAILED_PERMANENT';
      readonly errorCode: string;
      readonly errorMessage: string;
    };

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
