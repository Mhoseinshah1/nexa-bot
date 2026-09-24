import {
  RECEIPT_REVIEW_PUSH_MAX_ATTEMPTS,
  type ActorContext,
  type AdminId,
  type Clock,
  type CorrelationId,
  type OperationalEventRecorder,
  type PermissionKey,
  type ReceiptReviewPushState,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  CustomerButton,
  CustomerMessenger,
  CustomerSendResult,
} from '../../messaging/application/ports.js';
import type { CustomerRepository } from '../../customers/application/ports.js';
import type { PaymentRepository } from './ports.js';
import type { PaymentReceiptRepository } from './receipt-ports.js';
import { RECEIPT_PUSH_PERMISSION, mayBePushedReceipts } from './receipt-review-push.consumer.js';
import type { ReceiptReviewCaption } from './receipt-review-caption.js';
import type {
  ReceiptReviewPushRecord,
  ReceiptReviewPushRepository,
} from './receipt-review-push-ports.js';

/** How long a claimed row is held before another pass may take it. */
export const RECEIPT_PUSH_LEASE_MS = 2 * 60 * 1000;
/** The wait after a definite refusal, and the floor after a 429 that named none. */
export const RECEIPT_PUSH_BACKOFF_MS = 60 * 1000;
/** How many rows one pass takes. */
export const RECEIPT_PUSH_SWEEP_LIMIT = 50;

/**
 * The operational condition a failed push opens, per administrator, and the recovery that
 * closes it. Codes are schema (CLAUDE.md, Phase 3C): never rename one outside the release
 * that introduced it.
 */
export const RECEIPT_PUSH_FAILED_CODE = 'payments.receipt_push_failed';
export const RECEIPT_PUSH_OK_CODE = 'payments.receipt_push_ok';

export function receiptPushConditionKey(adminId: string): string {
  return `${RECEIPT_PUSH_FAILED_CODE}:${adminId}`;
}

export interface ReceiptReviewPushReport {
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

export interface ReceiptReviewPushDeps {
  readonly pushes: ReceiptReviewPushRepository;
  readonly payments: Pick<PaymentRepository, 'findById'>;
  readonly receipts: Pick<PaymentReceiptRepository, 'findById' | 'listForPayment'>;
  readonly customers: Pick<CustomerRepository, 'findById'>;
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
  readonly caption: ReceiptReviewCaption;
  /**
   * The decisions THIS administrator is shown — the same builder the pull item uses, handed
   * in by the composition root so the surface's callback vocabulary stays the surface's.
   */
  readonly keyboard: (
    paymentId: string,
    permissions: ReadonlySet<PermissionKey>,
  ) => CustomerButton[];
  readonly messenger: Pick<CustomerMessenger, 'sendFile' | 'send'>;
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
 * The send half of the administrators' receipt push (WP10 follow-up §3, ADR-0031).
 *
 * Each claimed row is ONE media message to ONE administrator: the receipt file, the File 01
 * §4 facts as its caption, and the decisions this administrator may take as its buttons. The
 * pull queue stays, and is where anything this lane does not deliver is still found.
 *
 * The outcome table is the customer lane's (ADR-0030 §2), because the property the owner
 * asked for is the one that table was built for — no uncontrolled duplicate:
 *
 *   - `DELIVERED` → DELIVERED: definitely delivered, and the only way a row says so.
 *   - `UNKNOWN` (a timeout, a 5xx, an unreadable 2xx) → UNKNOWN, terminal, never re-sent, and
 *     never recorded as delivered: an ambiguous send is not a delivery.
 *   - a send whose process died → the reaper makes it UNKNOWN; nothing re-sends it.
 *   - `RATE_LIMITED` → PENDING again at Telegram's own `retry_after`, spending no attempt.
 *   - `REFUSED` → the same caption and buttons as text from the same bot (a `file_id` the bot
 *     no longer has is the ordinary case); still refused → back off, and after
 *     `RECEIPT_REVIEW_PUSH_MAX_ATTEMPTS` refusals, FAILED.
 *
 * Every row is its own: one administrator's refusal, rate limit or stranded send touches
 * nothing of another's. FAILED and UNKNOWN open an operational condition for that administrator;
 * their next DELIVERED closes it.
 */
export class ReceiptReviewPushService {
  constructor(private readonly deps: ReceiptReviewPushDeps) {}

  async deliverDue(scope: TenantContext, limit: number): Promise<ReceiptReviewPushReport> {
    const counts: Record<string, number> = {};
    const report = (claimed: number): ReceiptReviewPushReport => ({
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
      new Date(now.getTime() + RECEIPT_PUSH_LEASE_MS),
      limit,
    );
    for (const row of claimed) {
      const outcome = await this.deliverOne(scope, row);
      counts[outcome] = (counts[outcome] ?? 0) + 1;
    }
    return report(claimed.length);
  }

  private async deliverOne(scope: TenantContext, row: ReceiptReviewPushRecord): Promise<string> {
    try {
      /*
       * What the message would say must still be true. A payment decided since the fan-out
       * has nothing left to review; pushing it would hand a reviewer buttons that can only
       * answer "already decided".
       */
      const payment = await this.deps.payments.findById(scope, row.paymentId);
      if (payment === null || payment.state !== 'PENDING') {
        return this.resolve(scope, row, 'SUPERSEDED', 'push.payment_decided');
      }
      /*
       * WHO, again, now: a fan-out is a moment and a send is later. An administrator
       * disabled, unbound or stripped of `receipts.review` — or of `receipts.view`, which is
       * what reads the file this message IS — in between is not sent a receipt with a
       * customer's details on it. The chat is the binding current NOW.
       */
      const reviewer = await this.deps.reviewers.reviewerById(
        scope,
        row.adminId,
        RECEIPT_PUSH_PERMISSION,
        this.deps.correlationId(),
      );
      if (reviewer === null || !mayBePushedReceipts(reviewer.permissions)) {
        return this.resolve(scope, row, 'SUPERSEDED', 'push.admin_no_authority');
      }
      const receipt = await this.deps.receipts.findById(scope, row.receiptId);
      if (receipt === null) return this.resolve(scope, row, 'FAILED', 'push.receipt_missing');

      const receipts = await this.deps.receipts.listForPayment(scope, payment.id);
      const customer = await this.deps.customers.findById(scope, payment.customerId);
      const values = await this.deps.caption.valuesFor(
        scope,
        reviewer.actor,
        payment,
        customer,
        receipts,
      );
      const buttons = this.deps.keyboard(payment.id, reviewer.permissions);

      const started = await this.deps.uow.run(scope, async (tx) =>
        this.deps.pushes.markSendStarted(scope, row.id, reviewer.chatId, this.deps.clock.now(), tx),
      );
      if (!started) return 'lost';

      let result: CustomerSendResult = await this.deps.messenger.sendFile(scope, {
        chatId: reviewer.chatId,
        botInstanceId: row.botInstanceId,
        kind: receipt.kind === 'PHOTO' ? 'PHOTO' : 'DOCUMENT',
        source: { kind: 'FILE_ID', fileId: receipt.fileId },
        caption: { templateKey: 'bot.admin.receipt', values },
        buttons,
      });
      /*
       * A file Telegram REFUSED — a `file_id` gone — is followed by the same caption and
       * buttons as text, as the pull item does (PAY-37). Not on UNKNOWN or RATE_LIMITED:
       * the first may have arrived, and the second would be refused again.
       */
      if (result.outcome === 'REFUSED') {
        result = await this.deps.messenger.send(scope, {
          chatId: reviewer.chatId,
          botInstanceId: row.botInstanceId,
          templateKey: 'bot.admin.receipt',
          values,
          buttons,
        });
      }
      return await this.record(scope, row, result);
    } catch (error: unknown) {
      // Logged, not rethrown: one row's failure must not end the pass for every other
      // administrator. A row whose send had started is the reaper's to settle.
      this.deps.logger.error(
        { err: error instanceof Error ? error.message : String(error), pushId: row.id },
        'receipt push failed',
      );
      return 'errored';
    }
  }

  private async record(
    scope: TenantContext,
    row: ReceiptReviewPushRecord,
    result: CustomerSendResult,
  ): Promise<string> {
    const at = this.deps.clock.now();
    if (result.outcome === 'DELIVERED') {
      const moved = await this.write(scope, row, 'DELIVERED', false, null, null, at);
      if (moved) await this.closeCondition(scope, row);
      return moved ? 'delivered' : 'lost';
    }
    if (result.outcome === 'RATE_LIMITED') {
      const retryAt = new Date(at.getTime() + (result.retryAfterMs ?? RECEIPT_PUSH_BACKOFF_MS));
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
      exhausted ? null : new Date(at.getTime() + RECEIPT_PUSH_BACKOFF_MS),
      'push.refused',
      at,
      exhausted ? 'push.refused' : null,
    );
    return moved ? (exhausted ? 'failed' : 'pending') : 'lost';
  }

  private async resolve(
    scope: TenantContext,
    row: ReceiptReviewPushRecord,
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
    row: ReceiptReviewPushRecord,
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
   * the log group is told once rather than once per receipt. The context carries codes and
   * ids — never the customer's caption.
   */
  private async openCondition(
    scope: TenantContext,
    row: ReceiptReviewPushRecord,
    reason: string,
    tx: TransactionScope,
  ): Promise<void> {
    await this.deps.opsLog.record(
      scope,
      {
        code: RECEIPT_PUSH_FAILED_CODE,
        severity: 'ERROR',
        message:
          'A receipt could not be pushed to an administrator in Telegram; it is still in the review queue.',
        dedupeKey: receiptPushConditionKey(row.adminId),
        context: {
          adminId: row.adminId,
          paymentId: row.paymentId,
          receiptId: row.receiptId,
          botInstanceId: row.botInstanceId,
          reason,
        },
      },
      tx,
    );
  }

  private async closeCondition(scope: TenantContext, row: ReceiptReviewPushRecord): Promise<void> {
    const dedupeKey = receiptPushConditionKey(row.adminId);
    if (!(await this.deps.conditions.conditionIsOpen(scope, dedupeKey))) return;
    await this.deps.opsLog.record(scope, {
      code: RECEIPT_PUSH_OK_CODE,
      severity: 'INFO',
      message: 'Receipts are reaching this administrator in Telegram again.',
      context: { adminId: row.adminId },
      recoversCode: RECEIPT_PUSH_FAILED_CODE,
      recoversDedupeKey: dedupeKey,
    });
  }
}
