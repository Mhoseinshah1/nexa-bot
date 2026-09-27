import {
  RECEIPT_REVIEW_PUSH_MAX_ATTEMPTS,
  type ActorContext,
  type AdminId,
  type Clock,
  type CorrelationId,
  type OperationalEventRecorder,
  type PermissionKey,
  type ReceiptReviewPushState,
  type TemplateValues,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  CustomerButton,
  CustomerMessenger,
  CustomerSendResult,
} from '../../messaging/application/ports.js';
import { mayBePushedRefundRequests } from './service-refund-push.consumer.js';
import type {
  ServiceRefundPushRecord,
  ServiceRefundPushRepository,
} from './service-refund-push-ports.js';
import type { ServiceRefundRequestRepository } from './service-refund-request-ports.js';

/** How long a claimed row is held before another pass may take it. */
export const REFUND_PUSH_LEASE_MS = 2 * 60 * 1000;
/** The wait after a definite refusal, and the floor after a 429 that named none. */
export const REFUND_PUSH_BACKOFF_MS = 60 * 1000;
/** How many rows one pass takes. */
export const REFUND_PUSH_SWEEP_LIMIT = 50;

/**
 * The operational condition a failed push opens, per administrator, and the recovery that
 * closes it. Codes are schema (CLAUDE.md, Phase 3C): never rename one outside the release
 * that introduced it.
 */
export const REFUND_PUSH_FAILED_CODE = 'payments.refund_request_push_failed';
export const REFUND_PUSH_OK_CODE = 'payments.refund_request_push_ok';

export function refundPushConditionKey(adminId: string): string {
  return `${REFUND_PUSH_FAILED_CODE}:${adminId}`;
}

export interface ServiceRefundPushReport {
  readonly claimed: number;
  readonly delivered: number;
  readonly pending: number;
  readonly failed: number;
  readonly unknown: number;
  readonly superseded: number;
  readonly rateLimited: number;
  readonly reaped: number;
  readonly lost: number;
  readonly errored: number;
}

export interface ServiceRefundPushDeps {
  readonly pushes: ServiceRefundPushRepository;
  readonly requests: Pick<ServiceRefundRequestRepository, 'findById'>;
  /** The administrator's authority and chat, resolved NOW — `TelegramAdminService.reviewerById`. */
  readonly reviewers: {
    reviewerById(
      scope: TenantContext,
      adminId: AdminId,
      permission: PermissionKey,
      correlationId: CorrelationId,
    ): Promise<{
      readonly actor: ActorContext;
      readonly permissions: ReadonlySet<PermissionKey>;
      readonly chatId: string;
    } | null>;
  };
  /** The card's values, read from the rows as they stand now. */
  readonly card: (scope: TenantContext, requestId: string) => Promise<TemplateValues | null>;
  /**
   * The card's buttons (brief §2.5), built by the surface that owns their callback data, for
   * the recipient's own permissions: a view button whose section they cannot open is not sent.
   */
  readonly keyboard: (
    request: {
      readonly id: string;
      readonly customerId: string;
      readonly serviceId: string;
    },
    permissions: ReadonlySet<PermissionKey>,
  ) => CustomerButton[];
  readonly messenger: Pick<CustomerMessenger, 'send'>;
  readonly opsLog: OperationalEventRecorder;
  readonly conditions: {
    conditionIsOpen(scope: TenantContext, dedupeKey: string): Promise<boolean>;
  };
  readonly uow: UnitOfWork<TransactionScope>;
  readonly clock: Clock;
  readonly scopeIsActive: (scope: TenantContext) => Promise<boolean>;
  readonly correlationId: () => CorrelationId;
  readonly logger: { error: (context: Record<string, unknown>, message: string) => void };
}

/**
 * The send half of the refund-request review cards (WP19): the receipt push's lane
 * (ADR-0031) for a text card with four buttons instead of a file.
 *
 * Each claimed row is ONE message to ONE administrator. The outcome table is the receipt
 * push's, for the same reason — no uncontrolled duplicate of a card with live decision
 * buttons:
 *
 *   - `DELIVERED` → DELIVERED: definitely delivered, and the only way a row says so.
 *   - `UNKNOWN` (a timeout, a 5xx, an unreadable 2xx) → UNKNOWN, terminal, never re-sent.
 *   - a send whose process died → the reaper makes it UNKNOWN; nothing re-sends it.
 *   - `RATE_LIMITED` → PENDING again at Telegram's own `retry_after`, spending no attempt.
 *   - `REFUSED` → back off, and after `RECEIPT_REVIEW_PUSH_MAX_ATTEMPTS` refusals, FAILED.
 *
 * Nothing about the request depends on this lane: the row is the record, and the Web Admin
 * lists it whether or not any card arrived.
 */
export class ServiceRefundPushService {
  constructor(private readonly deps: ServiceRefundPushDeps) {}

  async deliverDue(scope: TenantContext, limit: number): Promise<ServiceRefundPushReport> {
    const counts: Record<string, number> = {};
    const report = (claimed: number): ServiceRefundPushReport => ({
      claimed,
      delivered: counts['delivered'] ?? 0,
      pending: counts['pending'] ?? 0,
      failed: counts['failed'] ?? 0,
      unknown: counts['unknown'] ?? 0,
      superseded: counts['superseded'] ?? 0,
      rateLimited: counts['rateLimited'] ?? 0,
      reaped: counts['reaped'] ?? 0,
      lost: counts['lost'] ?? 0,
      errored: counts['errored'] ?? 0,
    });
    // A stopped tenant sends nothing and loses nothing: its rows wait, PENDING.
    if (!(await this.deps.scopeIsActive(scope))) return report(0);

    const now = this.deps.clock.now();
    // Reaped and reported in ONE transaction: a row made terminal here is never claimed again,
    // so a condition recorded after it could be lost for good.
    const reaped = await this.deps.uow.run(scope, async (tx) => {
      const rows = await this.deps.pushes.reapStranded(scope, now, limit, tx);
      for (const row of rows) await this.openCondition(scope, row, 'push.send_stranded', tx);
      return rows;
    });
    counts['reaped'] = reaped.length;

    const claimed = await this.deps.pushes.claimDue(
      scope,
      now,
      new Date(now.getTime() + REFUND_PUSH_LEASE_MS),
      limit,
    );
    for (const row of claimed) {
      const outcome = await this.deliverOne(scope, row);
      counts[outcome] = (counts[outcome] ?? 0) + 1;
    }
    return report(claimed.length);
  }

  private async deliverOne(scope: TenantContext, row: ServiceRefundPushRecord): Promise<string> {
    try {
      // A request decided since the fan-out has nothing left to review.
      const request = await this.deps.requests.findById(scope, row.requestId);
      if (request === null || request.state !== 'OPEN') {
        return this.resolve(scope, row, 'SUPERSEDED', 'push.request_decided');
      }
      // WHO, again, now: a fan-out is a moment and a send is later.
      const reviewer = await this.deps.reviewers.reviewerById(
        scope,
        row.adminId,
        'refunds.issue',
        this.deps.correlationId(),
      );
      if (reviewer === null || !mayBePushedRefundRequests(reviewer.permissions)) {
        return this.resolve(scope, row, 'SUPERSEDED', 'push.admin_no_authority');
      }
      const values = await this.deps.card(scope, request.id);
      if (values === null) return this.resolve(scope, row, 'FAILED', 'push.request_missing');
      const buttons = this.deps.keyboard(request, reviewer.permissions);

      const started = await this.deps.uow.run(scope, async (tx) =>
        this.deps.pushes.markSendStarted(scope, row.id, reviewer.chatId, this.deps.clock.now(), tx),
      );
      if (!started) return 'lost';

      const result: CustomerSendResult = await this.deps.messenger.send(scope, {
        chatId: reviewer.chatId,
        botInstanceId: row.botInstanceId,
        templateKey: 'bot.admin.refund_request_card',
        values,
        buttons,
      });
      return await this.record(scope, row, result);
    } catch (error: unknown) {
      this.deps.logger.error(
        { err: error instanceof Error ? error.message : String(error), pushId: row.id },
        'refund request push failed',
      );
      return 'errored';
    }
  }

  private async record(
    scope: TenantContext,
    row: ServiceRefundPushRecord,
    result: CustomerSendResult,
  ): Promise<string> {
    const at = this.deps.clock.now();
    if (result.outcome === 'DELIVERED') {
      const moved = await this.write(scope, row, 'DELIVERED', false, null, null, at);
      if (moved) await this.closeCondition(scope, row);
      return moved ? 'delivered' : 'lost';
    }
    if (result.outcome === 'RATE_LIMITED') {
      // The later of Telegram's retry_after and the lane's back-off (WP20, brief §3.1).
      const retryAt = new Date(
        at.getTime() + Math.max(result.retryAfterMs ?? 0, REFUND_PUSH_BACKOFF_MS),
      );
      const moved = await this.write(
        scope,
        row,
        'PENDING',
        false,
        retryAt,
        'push.rate_limited',
        at,
      );
      return moved ? 'rateLimited' : 'lost';
    }
    if (result.outcome === 'UNKNOWN') {
      const moved = await this.write(
        scope,
        row,
        'UNKNOWN',
        false,
        null,
        'push.outcome_unknown',
        at,
        'push.outcome_unknown',
      );
      return moved ? 'unknown' : 'lost';
    }
    const exhausted = row.attempts + 1 >= RECEIPT_REVIEW_PUSH_MAX_ATTEMPTS;
    const moved = await this.write(
      scope,
      row,
      exhausted ? 'FAILED' : 'PENDING',
      true,
      exhausted ? null : new Date(at.getTime() + REFUND_PUSH_BACKOFF_MS),
      'push.refused',
      at,
      exhausted ? 'push.refused' : null,
    );
    return moved ? (exhausted ? 'failed' : 'pending') : 'lost';
  }

  private async resolve(
    scope: TenantContext,
    row: ServiceRefundPushRecord,
    to: ReceiptReviewPushState,
    code: string,
  ): Promise<string> {
    const moved = await this.write(
      scope,
      row,
      to,
      false,
      null,
      code,
      this.deps.clock.now(),
      to === 'FAILED' ? code : null,
    );
    return moved ? (to === 'FAILED' ? 'failed' : 'superseded') : 'lost';
  }

  private write(
    scope: TenantContext,
    row: ServiceRefundPushRecord,
    to: ReceiptReviewPushState,
    spend: boolean,
    nextAttemptAt: Date | null,
    lastErrorCode: string | null,
    at: Date,
    /**
     * The operational condition this transition opens, in the SAME transaction: FAILED and
     * UNKNOWN are terminal and never claimed again, so a condition recorded after the commit
     * would be lost for good by one failed write. Only when the transition happened.
     */
    opens: string | null = null,
  ): Promise<boolean> {
    return this.deps.uow.run(scope, async (tx) => {
      const moved = await this.deps.pushes.record(
        scope,
        row.id,
        to,
        { spend, nextAttemptAt, lastErrorCode },
        at,
        tx,
      );
      if (moved && opens !== null) await this.openCondition(scope, row, opens, tx);
      return moved;
    });
  }

  /**
   * One open condition per administrator: the operational log's dedupe collapses repeats, and
   * the log group is told once rather than once per request. The context carries codes and
   * ids — never the customer's caption.
   */
  private async openCondition(
    scope: TenantContext,
    row: ServiceRefundPushRecord,
    reason: string,
    tx: TransactionScope,
  ): Promise<void> {
    await this.deps.opsLog.record(
      scope,
      {
        code: REFUND_PUSH_FAILED_CODE,
        severity: 'ERROR',
        message:
          'A refund request could not be pushed to an administrator in Telegram; it is still open and listed in the Web Admin.',
        dedupeKey: refundPushConditionKey(row.adminId),
        context: {
          adminId: row.adminId,
          requestId: row.requestId,
          botInstanceId: row.botInstanceId,
          reason,
        },
      },
      tx,
    );
  }

  private async closeCondition(scope: TenantContext, row: ServiceRefundPushRecord): Promise<void> {
    const dedupeKey = refundPushConditionKey(row.adminId);
    if (!(await this.deps.conditions.conditionIsOpen(scope, dedupeKey))) return;
    await this.deps.opsLog.record(scope, {
      code: REFUND_PUSH_OK_CODE,
      severity: 'INFO',
      message: 'Refund requests are reaching this administrator in Telegram again.',
      context: { adminId: row.adminId },
      recoversCode: REFUND_PUSH_FAILED_CODE,
      recoversDedupeKey: dedupeKey,
    });
  }
}
