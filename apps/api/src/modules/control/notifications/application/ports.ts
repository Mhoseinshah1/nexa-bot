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
   * Records one attempt and moves the intent, in one transaction.
   *
   * The two halves have to commit together. An attempt row with no status
   * change means a retry loop that never terminates; a status change with no
   * attempt row means the thing this table exists for — what actually happened
   * on the wire — is missing for the attempt that mattered.
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
  }): Promise<void>;
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
