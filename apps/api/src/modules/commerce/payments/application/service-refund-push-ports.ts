import type {
  AdminId,
  BotInstanceId,
  ReceiptReviewPushState,
  TenantContext,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';

/**
 * One administrator's review card for one customer service refund request (WP19): the
 * receipt push's shape (ADR-0031) applied to a different subject.
 *
 * `service_refund_request_pushes` holds it; the states are the receipt push's.
 */
export interface ServiceRefundPushRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly requestId: string;
  readonly adminId: AdminId;
  readonly botInstanceId: BotInstanceId;
  readonly state: ReceiptReviewPushState;
  readonly attempts: number;
  readonly nextAttemptAt: Date | null;
  readonly sendStartedAt: Date | null;
  readonly chatId: string | null;
  readonly lastErrorCode: string | null;
  readonly resolvedAt: Date | null;
  readonly createdAt: Date;
}

export interface ServiceRefundPushRepository {
  /**
   * One row for (request, administrator), or nothing when it exists already.
   *
   * `ON CONFLICT DO NOTHING` on the unique key: an outbox redelivery, a consumer replayed
   * after its claim was lost, and two relay replicas all land on the row that is there.
   * Returns whether THIS call wrote it.
   */
  enqueue(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly requestId: string;
      readonly adminId: AdminId;
      readonly botInstanceId: BotInstanceId;
    },
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean>;

  /**
   * Claims due PENDING rows by pushing `next_attempt_at` to the lease, conditionally, so a
   * second replica re-evaluating the same rows finds them no longer due.
   */
  claimDue(
    scope: TenantContext,
    now: Date,
    leaseUntil: Date,
    limit: number,
  ): Promise<readonly ServiceRefundPushRecord[]>;

  /**
   * Stamps the send as started and the chat it is addressed to, conditionally on the row
   * still being PENDING with no send outstanding. False means somebody else owns it.
   */
  markSendStarted(
    scope: TenantContext,
    id: string,
    chatId: string,
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean>;

  /**
   * Records an outcome. `spend` adds one definite refusal; a rate limit or a supersession
   * spends none. Conditional on PENDING, so a reaped row is never re-opened.
   */
  record(
    scope: TenantContext,
    id: string,
    to: ReceiptReviewPushState,
    input: {
      readonly spend: boolean;
      readonly nextAttemptAt: Date | null;
      readonly lastErrorCode: string | null;
    },
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean>;

  /**
   * Rows whose send started and whose lease ran out with no outcome recorded: the process
   * died after Telegram may have taken the message. They become UNKNOWN — never recorded as delivered, never
   * re-sent.
   */
  reapStranded(
    scope: TenantContext,
    now: Date,
    limit: number,
    tx: TransactionScope,
  ): Promise<readonly ServiceRefundPushRecord[]>;

  /** Every card pushed for one request, for tests and diagnostics. */
  listForRequest(
    scope: TenantContext,
    requestId: string,
  ): Promise<readonly ServiceRefundPushRecord[]>;
}
