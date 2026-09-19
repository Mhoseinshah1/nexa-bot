import {
  type CorrelationId,
  type Money,
  type NotificationDestination,
  type OperationalEventInput,
  type PermissionKey,
  type TemplateValues,
  type TenantContext,
} from '@nexa/contracts';
import type { TelegramAdminIdentity } from '../../../platform/identity/application/telegram-admin.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';

/**
 * The permission that decides who is TOLD, because it is the permission that
 * decides who can do anything about it.
 *
 * Told-but-powerless is noise, and powerful-but-untold is the state this whole
 * feature exists to end. The receipt lane makes the same pairing with
 * `receipts.review`.
 */
export const ORDERS_FULFIL_PERMISSION = 'orders.fulfil' as PermissionKey;

/** The condition an order in `PAID_UNFULFILLED` holds open, and its recovery. */
export const ORDER_UNFULFILLED_CODE = 'order.fulfilment_failed';
export const ORDER_FULFILLED_CODE = 'order.fulfilment_ok';

/** One condition row per ORDER, so ten stranded orders are ten items of work. */
export function unfulfilledConditionKey(orderId: string): string {
  return `${ORDER_UNFULFILLED_CODE}:${orderId}`;
}

export interface UnfulfilledOrderReporterDeps {
  readonly opsLog: {
    record(
      scope: TenantContext,
      event: OperationalEventInput,
      tx?: unknown,
    ): Promise<{ readonly id: string }>;
  };
  readonly notifications: {
    queue(
      scope: TenantContext,
      input: {
        readonly kind: 'ORDER_PAID_UNFULFILLED';
        readonly dedupeKey: string;
        readonly templateKey: 'bot.admin.order_unfulfilled';
        readonly values: TemplateValues;
        readonly destination?: NotificationDestination;
      },
      tx?: unknown,
    ): Promise<unknown>;
  };
  /** Who holds `orders.fulfil` AND has a Telegram chat to be told in. */
  readonly recipients: {
    reviewers(
      scope: TenantContext,
      permission: PermissionKey,
      correlationId: CorrelationId,
      tx?: unknown,
    ): Promise<readonly TelegramAdminIdentity[]>;
  };
}

/**
 * Says that this installation has taken money for something it could not deliver —
 * and, later, that the debt is settled.
 *
 * ONE collaborator rather than three calls at each site, because the two sites are in
 * different modules and the pair has to stay symmetric: a `strand` that opens a
 * condition nothing closes leaves an operator an ERROR that is no longer true, and a
 * `resolve` that closes one nobody opened is a recovery for nothing. They are written
 * here, together, where the asymmetry is visible.
 *
 * Everything it writes joins the CALLER's transaction. The condition, the
 * notification and the state change are one commit or none: a process that died
 * between them would leave an order stranded with nobody told, and — because the
 * condition is deduplicated per order — nothing would ever say so again.
 */
export class UnfulfilledOrderReporter {
  constructor(private readonly deps: UnfulfilledOrderReporterDeps) {}

  async strand(
    scope: TenantContext,
    order: {
      readonly id: string;
      readonly customerId: string;
      readonly panelId: string;
      readonly total: Money;
      readonly correlationId: CorrelationId;
    },
    reason: string,
    tx: TransactionScope,
  ): Promise<void> {
    await this.deps.opsLog.record(
      scope,
      {
        code: ORDER_UNFULFILLED_CODE,
        // ERROR, not WARN: this installation is holding money for something it has
        // not delivered, and the customer is waiting for it.
        severity: 'ERROR',
        message: `order ${order.id} was paid for and could not be fulfilled on its panel (${reason})`,
        dedupeKey: unfulfilledConditionKey(order.id),
        context: {
          orderId: order.id,
          customerId: order.customerId,
          panelId: order.panelId,
          reason,
          totalMinor: order.total.amountMinor.toString(),
          currency: order.total.currency,
        },
        correlationId: order.correlationId,
      },
      tx,
    );

    /*
     * One message per person who can act, deduplicated on the ORDER and the reader.
     *
     * A retry that fails again re-enters this path, and the dedupe key is what stops
     * it becoming a second message: the condition row's occurrence counter is where
     * "it happened again" belongs. Addressed to each administrator's own chat, which
     * the lane snapshots — a message sent today still says who it was for after that
     * binding is revoked tomorrow.
     */
    const recipients = await this.deps.recipients.reviewers(
      scope,
      ORDERS_FULFIL_PERMISSION,
      order.correlationId,
      tx,
    );
    for (const recipient of recipients) {
      const chatId = recipient.admin.telegramUserId;
      /* istanbul ignore next -- `listTelegramBound` selects only bound rows. */
      if (chatId === null) continue;
      await this.deps.notifications.queue(
        scope,
        {
          kind: 'ORDER_PAID_UNFULFILLED',
          dedupeKey: `order.unfulfilled:${order.id}:${recipient.admin.id}`,
          templateKey: 'bot.admin.order_unfulfilled',
          values: { reference: order.id, total: order.total, reason },
          destination: { transport: 'TELEGRAM', chatId, topicId: null },
        },
        tx,
      );
    }
  }

  /**
   * The debt is settled — the order was fulfilled, or refunded.
   *
   * Recorded whenever an order LEAVES `PAID_UNFULFILLED`, and deliberately not
   * deduplicated per occurrence beyond its own key: it closes the one condition this
   * order opened, and closing a row that is not open is a no-op rather than an error.
   */
  async resolve(
    scope: TenantContext,
    order: { readonly id: string; readonly correlationId: CorrelationId },
    outcome: string,
    tx: TransactionScope,
  ): Promise<void> {
    await this.deps.opsLog.record(
      scope,
      {
        code: ORDER_FULFILLED_CODE,
        severity: 'INFO',
        message: `order ${order.id} is no longer owed: ${outcome}`,
        dedupeKey: `${ORDER_FULFILLED_CODE}:${order.id}`,
        context: { orderId: order.id, outcome },
        correlationId: order.correlationId,
        recoversCode: ORDER_UNFULFILLED_CODE,
        recoversDedupeKey: unfulfilledConditionKey(order.id),
      },
      tx,
    );
  }
}
