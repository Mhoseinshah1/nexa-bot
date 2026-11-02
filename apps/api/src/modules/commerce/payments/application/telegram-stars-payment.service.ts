import {
  systemJobActor,
  TELEGRAM_STARS_CHECKOUT_HOLD_MS,
  type AuditWriter,
  type Clock,
  type CorrelationId,
  type IdGenerator,
  type OperationalEventRecorder,
  type OrderId,
  type PaymentId,
  type TenantContext,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { CustomerRepository } from '../../customers/application/ports.js';
import type { OrderRepository } from '../../orders/application/ports.js';
import {
  STARS_REFUNDED_STATUS,
  starsIdentityMismatch,
  starsPreCheckoutRefusal,
  type StarsCheckFacts,
} from '../domain/telegram-stars.js';
import type { GatewayInvoiceRecord, GatewayInvoiceRepository } from './gateway-invoice-ports.js';
import {
  GATEWAY_IDENTITY_MISMATCH_CODE,
  type GatewayPaymentService,
} from './gateway-payment.service.js';
import type { PaymentRepository } from './ports.js';

const PROVIDER = 'TELEGRAM_STARS' as const;

/** R12 F1 item 6: the audit action of a Stars charge Telegram reported refunded. */
export const STARS_CHARGE_REFUNDED_ACTION = 'gateway_invoice.charge_refunded';

/**
 * A charge Telegram reports that no attempt of this installation can own: a payload that
 * names no attempt, a charge id already attached to another attempt, or a scope that had
 * stopped accepting work. Per charge id. Nothing settled: an operator reconciles it —
 * the charge id is what Telegram's own refund would need. Part of the schema once shipped.
 */
export const STARS_CHARGE_UNMATCHED_CODE = 'payments.gateway_charge_unmatched';

/**
 * R12 F1 item 6: Telegram REFUNDED a Stars charge (`message.refunded_payment`) — money that
 * left outside the ledger, since Nexa never calls Telegram's refund itself. Per charge id; it
 * stays open for an operator, who decides what the refund means for the service or the wallet
 * the charge paid for. Part of the schema once shipped.
 */
export const STARS_CHARGE_REFUNDED_CODE = 'payments.gateway_charge_refunded';

/** One `pre_checkout_query`, as the webhook read it. Telegram's shapes stop at the boundary. */
export interface StarsPreCheckoutUpdate {
  readonly queryId: string;
  readonly payerTelegramUserId: string;
  readonly currency: string;
  readonly totalAmount: bigint;
  readonly payload: string;
}

/**
 * R12 F1 item 6: one `message.refunded_payment`, as the webhook read it — the same five facts
 * a `successful_payment` carries (Telegram's `RefundedPayment`: currency, total amount, the
 * invoice payload and the charge id). The charge id is what names the charge refunded.
 */
export interface StarsRefundedPaymentUpdate {
  readonly payerTelegramUserId: string;
  readonly currency: string;
  readonly totalAmount: bigint;
  readonly payload: string;
  readonly chargeId: string;
}

/** What recording a `refunded_payment` did. Only MARKED changed anything. */
export type StarsRefundResult = 'MARKED' | 'DUPLICATE' | 'UNMATCHED' | 'SCOPE_INACTIVE';

/** One `message.successful_payment`, as the webhook read it. */
export interface StarsSuccessfulPaymentUpdate {
  readonly payerTelegramUserId: string;
  readonly currency: string;
  readonly totalAmount: bigint;
  readonly payload: string;
  readonly chargeId: string;
}

/**
 * Answers a pre-checkout query in the payer's chat. The refusal sentence is a template,
 * rendered by the implementation; the service decides only yes or no.
 */
export interface StarsCheckoutAnswerer {
  answer(
    scope: TenantContext,
    botInstanceId: string,
    queryId: string,
    ok: boolean,
  ): Promise<boolean>;
}

export interface StarsPaymentServiceDeps {
  readonly invoices: Pick<
    GatewayInvoiceRepository,
    | 'findByProviderOrderId'
    | 'lockByProviderOrderId'
    | 'findByChargeId'
    | 'recordCharge'
    | 'markChargeRefunded'
  >;
  readonly payments: Pick<PaymentRepository, 'findById' | 'findByIdForUpdate' | 'holdForCheckout'>;
  readonly customers: Pick<CustomerRepository, 'findById'>;
  readonly orders: Pick<OrderRepository, 'findById'>;
  readonly settlement: Pick<GatewayPaymentService, 'settleRecorded'>;
  readonly answerer: StarsCheckoutAnswerer;
  readonly scopeActivity: ScopeActivityReader;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: {
    info: (context: Record<string, unknown>, message: string) => void;
    warn: (context: Record<string, unknown>, message: string) => void;
  };
}

/** What recording a `successful_payment` did. Only RECORDED and DUPLICATE settle anything. */
export type StarsRecordResult =
  'RECORDED' | 'DUPLICATE' | 'UNMATCHED' | 'MISMATCH' | 'SCOPE_INACTIVE';

type RecordStep =
  | { readonly kind: 'RECORDED' | 'DUPLICATE'; readonly invoice: GatewayInvoiceRecord }
  | { readonly kind: 'UNKNOWN_PAYLOAD' | 'CHARGE_REUSED' | 'SCOPE_INACTIVE' }
  | {
      readonly kind: 'MISMATCH';
      readonly invoice: GatewayInvoiceRecord;
      readonly reason: string;
    };

/**
 * Telegram Stars' two payment updates (Package A, audit §2.5–§2.7).
 *
 * Both arrive on the bot's own authenticated webhook, and both are answered before the
 * customer turn: a pre-checkout has ten seconds, and a `successful_payment` is money that
 * has already moved.
 *
 * - **Pre-checkout** reads and moves nothing. It approves only an attempt this bot sent,
 *   to this payer, for exactly the snapshotted Stars, still payable with a margin.
 * - **`successful_payment`** is recorded FIRST — under the invoice's row lock, after the
 *   same identity checks, with the charge id written once and unique — and only then
 *   settled, through `GatewayPaymentService.settleRecorded` and so through
 *   `PaymentService.confirmGatewayPayment`, the one exactly-once path every gateway uses.
 *   A record that throws is the webhook's 500, so Telegram redelivers: a charge nobody
 *   recorded is the one failure this route cannot repair afterwards.
 *
 * Nothing here ever refunds Stars: Telegram's Star-refund method is never called (brief A6).
 */
export class StarsPaymentService {
  constructor(private readonly deps: StarsPaymentServiceDeps) {}

  /**
   * Decide and answer one pre-checkout query. Returns whether it was approved; a refusal's
   * REASON is logged for the operator and never shown to the payer, who is told one
   * sentence whatever the reason — it would otherwise tell a stranger which payloads exist.
   */
  async preCheckout(
    scope: TenantContext,
    botInstanceId: string,
    update: StarsPreCheckoutUpdate,
  ): Promise<boolean> {
    const refusal = await this.preCheckoutRefusal(scope, botInstanceId, update);
    if (refusal !== null) {
      this.deps.logger.info({ provider: PROVIDER, reason: refusal }, 'stars pre-checkout refused');
    }
    await this.deps.answerer.answer(scope, botInstanceId, update.queryId, refusal === null);
    return refusal === null;
  }

  /**
   * Decide, and on approval HOLD the payment, in one transaction (Codex review of #85).
   *
   * Telegram charges right after an approval, so an approved attempt is money in flight: a
   * cancellation, a withdrawal or a wallet payment landing between the approval and
   * `successful_payment` would leave a charge nothing can settle. The payment row is taken
   * FOR UPDATE, decided from what that lock sees, and stamped `checkout_held_until` before
   * the answer goes out; every path that ends a PENDING payment excludes a held row in the
   * statement that moves it. The answer itself is sent after the commit — no network call
   * inside a transaction — and a transaction that fails is a refusal.
   */
  private async preCheckoutRefusal(
    scope: TenantContext,
    botInstanceId: string,
    update: StarsPreCheckoutUpdate,
  ): Promise<string | null> {
    try {
      return await this.deps.uow.run(scope, async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return 'SCOPE_INACTIVE';
        const invoice = await this.deps.invoices.lockByProviderOrderId(
          scope,
          PROVIDER,
          update.payload,
          tx,
        );
        if (invoice === null) return 'UNKNOWN_PAYLOAD';
        // A charge is already on it: this attempt has been paid, and a second one must not be.
        if (invoice.providerChargeId !== null) return 'ALREADY_PAID';
        const locked = await this.deps.payments.findByIdForUpdate(
          scope,
          invoice.paymentId as PaymentId,
          tx,
        );
        if (locked === null) return 'UNKNOWN_PAYMENT';
        const facts = await this.factsFor(scope, invoice, botInstanceId, update, tx);
        const refusal = facts === null ? 'UNKNOWN_PAYMENT' : starsPreCheckoutRefusal(facts);
        if (refusal !== null) return refusal;
        const now = this.deps.clock.now();
        const held = await this.deps.payments.holdForCheckout(
          scope,
          invoice.paymentId as PaymentId,
          new Date(now.getTime() + TELEGRAM_STARS_CHECKOUT_HOLD_MS),
          now,
          tx,
        );
        return held ? null : 'NOT_PENDING';
      });
    } catch (error) {
      this.deps.logger.warn(
        { provider: PROVIDER, error: error instanceof Error ? error.name : 'unknown' },
        'stars pre-checkout could not be decided',
      );
      return 'UNDECIDED';
    }
  }

  /**
   * Record, then settle, one `successful_payment`.
   *
   * Throws only when the RECORD could not be written — the caller answers Telegram with
   * a non-2xx so the update is redelivered. A settlement that fails is not thrown: the
   * recorded row is due, and the worker settles it from there.
   */
  async recordSuccessfulPayment(
    scope: TenantContext,
    botInstanceId: string,
    update: StarsSuccessfulPaymentUpdate,
  ): Promise<StarsRecordResult> {
    const actor = systemJobActor('gateway-payments', this.deps.ids.uuid() as CorrelationId);
    const now = this.deps.clock.now();

    const step = await this.deps.uow.run(scope, async (tx): Promise<RecordStep> => {
      /*
       * Inside the transaction, as every write path reads it. A stopped scope records
       * nothing on the attempt: the charge is reported to the operator below instead.
       */
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
        return { kind: 'SCOPE_INACTIVE' };
      }
      const invoice = await this.deps.invoices.lockByProviderOrderId(
        scope,
        PROVIDER,
        update.payload,
        tx,
      );
      if (invoice === null) return { kind: 'UNKNOWN_PAYLOAD' };
      if (invoice.providerChargeId !== null) {
        // The same charge redelivered is a no-op; a DIFFERENT charge on a paid attempt is
        // a second payment for one attempt, and nothing settles it twice.
        return invoice.providerChargeId === update.chargeId
          ? { kind: 'DUPLICATE', invoice }
          : { kind: 'MISMATCH', invoice, reason: 'SECOND_CHARGE' };
      }
      if (
        (await this.deps.invoices.findByChargeId(scope, PROVIDER, update.chargeId, tx)) !== null
      ) {
        return { kind: 'CHARGE_REUSED' };
      }
      const facts = await this.factsFor(scope, invoice, botInstanceId, update, tx);
      const mismatch = facts === null ? 'UNKNOWN_PAYMENT' : starsIdentityMismatch(facts);
      if (mismatch !== null) return { kind: 'MISMATCH', invoice, reason: mismatch };

      await this.deps.invoices.recordCharge(
        scope,
        invoice.paymentId,
        { chargeId: update.chargeId, status: 'successful_payment', dueAt: now },
        now,
        tx,
      );
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: 'gateway_invoice.payment_recorded',
          entityType: 'Payment',
          entityId: invoice.paymentId,
          before: { providerChargeId: null },
          after: {
            provider: PROVIDER,
            providerOrderId: invoice.providerOrderId,
            providerChargeId: update.chargeId,
            providerUnit: invoice.providerUnit,
            providerAmount: invoice.sentAmount.toString(),
          },
          result: 'SUCCESS',
        },
        tx,
      );
      return { kind: 'RECORDED', invoice };
    });

    switch (step.kind) {
      case 'RECORDED':
      case 'DUPLICATE': {
        /*
         * The charge is recorded and due; settling it now is only its earlier arrival. A
         * settlement that throws (the late completion's own write failing, say) is left to
         * the worker, which the row is due for — never turned into the webhook's error,
         * which would only make Telegram redeliver a charge that is already safe.
         */
        let settled: Awaited<ReturnType<GatewayPaymentService['settleRecorded']>> | 'DEFERRED';
        try {
          settled = await this.deps.settlement.settleRecorded(scope, step.invoice.paymentId);
        } catch (error) {
          this.deps.logger.warn(
            {
              paymentId: step.invoice.paymentId,
              error: error instanceof Error ? error.name : 'unknown',
            },
            'stars payment recorded; settlement left to the worker',
          );
          settled = 'DEFERRED';
        }
        this.deps.logger.info(
          { paymentId: step.invoice.paymentId, provider: PROVIDER, recorded: step.kind, settled },
          'stars payment recorded',
        );
        return step.kind;
      }
      case 'MISMATCH':
        await this.deps.opsLog.record(scope, {
          code: GATEWAY_IDENTITY_MISMATCH_CODE,
          severity: 'WARN',
          message:
            'A Telegram Stars payment named an attempt it does not belong to. Nothing was settled; ' +
            'the charge id is recorded here for the operator.',
          dedupeKey: `${GATEWAY_IDENTITY_MISMATCH_CODE}:${step.invoice.paymentId}`,
          context: {
            paymentId: step.invoice.paymentId,
            provider: PROVIDER,
            source: 'SUCCESSFUL_PAYMENT',
            reason: step.reason,
            providerChargeId: update.chargeId,
          },
        });
        return 'MISMATCH';
      case 'UNKNOWN_PAYLOAD':
      case 'CHARGE_REUSED':
      case 'SCOPE_INACTIVE':
        await this.deps.opsLog.record(scope, {
          code: STARS_CHARGE_UNMATCHED_CODE,
          severity: 'ERROR',
          message:
            'Telegram charged a customer in Stars for a payment this installation could not attach ' +
            'to an attempt. Nothing was settled or credited; reconcile it by its charge id.',
          dedupeKey: `${STARS_CHARGE_UNMATCHED_CODE}:${update.chargeId}`,
          context: {
            provider: PROVIDER,
            reason: step.kind,
            providerChargeId: update.chargeId,
            botInstanceId,
          },
        });
        return step.kind === 'SCOPE_INACTIVE' ? 'SCOPE_INACTIVE' : 'UNMATCHED';
    }
  }

  /**
   * R12 F1 item 6 — Telegram says it REFUNDED a Stars charge.
   *
   * Nexa never refunds Stars itself, so this is money that left outside the ledger (the bot's
   * owner refunded it, or Telegram did). Recorded, under the payment's lock:
   *
   * - the charge's invoice is MARKED `refunded_payment` with `provider_paid = false`, so a
   *   recorded charge that has not settled yet never settles (and `confirmGatewayPayment`
   *   re-reads that under the same lock), and the Web Admin shows the charge as refunded;
   * - an audit row with the invoice and the payment as they stood;
   * - and `payments.gateway_charge_refunded`, open per charge id, for an OPERATOR to follow
   *   up — with the order (and so the service's panel username) it paid for.
   *
   * Nothing else moves: the payment's state, the ledger, the order and the service are left as
   * they are. Whether the service is suspended or the wallet debited is the operator's call
   * (`docs/open-questions.md`, OQ-R12-F1-02); no existing refund path does it safely here.
   * The customer is told nothing by Nexa — Telegram told them. A charge that names no attempt
   * of this installation, or a stopped scope, is alerted under the same code and marks nothing.
   *
   * Throws only when the record could not be written; the caller answers Telegram non-2xx.
   */
  async recordRefundedPayment(
    scope: TenantContext,
    botInstanceId: string,
    update: StarsRefundedPaymentUpdate,
  ): Promise<StarsRefundResult> {
    const actor = systemJobActor('gateway-payments', this.deps.ids.uuid() as CorrelationId);
    const now = this.deps.clock.now();
    return this.deps.uow.run(scope, async (tx): Promise<StarsRefundResult> => {
      const alert = async (
        reason: string,
        context: Record<string, string | number | boolean | null>,
      ): Promise<void> => {
        await this.deps.opsLog.record(
          scope,
          {
            code: STARS_CHARGE_REFUNDED_CODE,
            severity: 'ERROR',
            message:
              reason === 'SETTLED_THEN_REFUNDED' ||
              reason === 'REFUNDED_UNSETTLED' ||
              reason === 'REFUNDED_BEFORE_RECORDED'
                ? 'Telegram refunded a Stars charge outside this installation. The payment is ' +
                  'marked refunded; the service and the wallet were not changed. Decide what it means.'
                : 'Telegram refunded a Stars charge this installation could not attach to an ' +
                  'attempt. Nothing was marked; find it by its charge id.',
            dedupeKey: `${STARS_CHARGE_REFUNDED_CODE}:${update.chargeId}`,
            context: {
              provider: PROVIDER,
              reason,
              providerChargeId: update.chargeId,
              botInstanceId,
              ...context,
            },
          },
          tx,
        );
      };
      // A stopped scope accepts no new work: nothing is marked, the operator is still told.
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
        await alert('SCOPE_INACTIVE', {});
        return 'SCOPE_INACTIVE';
      }
      /*
       * Codex on #360: the invoice's row LOCK, the one `recordSuccessfulPayment` records the
       * charge under — so a refund that arrives while that charge is being recorded waits for
       * it and then sees it, instead of reading "not recorded" and being answered as unmatched
       * while the charge commits and settles. Invoice first, then the payment: the order the
       * charge's own recording and its pre-checkout hold take them in.
       */
      const found = await this.deps.invoices.lockByProviderOrderId(
        scope,
        PROVIDER,
        update.payload,
        tx,
      );
      if (found === null) {
        await alert('UNMATCHED', {});
        return 'UNMATCHED';
      }
      /*
       * Codex on #360: a refund of a charge this attempt has NOT recorded yet — its
       * `successful_payment` failed to record and Telegram will deliver it again, or it is
       * still on its way. The refund is recorded as that charge's, refunded (the charge id is
       * written once, `provider_paid = false`), so the success that arrives later finds its own
       * charge already recorded and refunded and never settles it. Only for the bot the attempt
       * was sent through, and only for a charge id no other attempt holds; anything else is
       * reported and marks nothing. A refund naming a DIFFERENT charge than the one recorded is
       * not this attempt's either.
       */
      const beforeRecorded = found.providerChargeId === null;
      if (beforeRecorded) {
        const elsewhere = await this.deps.invoices.findByChargeId(
          scope,
          PROVIDER,
          update.chargeId,
          tx,
        );
        if (
          (found.botInstanceId !== null && found.botInstanceId !== botInstanceId) ||
          elsewhere !== null
        ) {
          await alert('UNMATCHED', {});
          return 'UNMATCHED';
        }
      } else if (found.providerChargeId !== update.chargeId) {
        await alert('UNMATCHED', {});
        return 'UNMATCHED';
      }
      const payment = await this.deps.payments.findByIdForUpdate(
        scope,
        found.paymentId as PaymentId,
        tx,
      );
      if (payment === null) {
        await alert('UNMATCHED', {});
        return 'UNMATCHED';
      }
      const marked = await this.deps.invoices.markChargeRefunded(
        scope,
        found.paymentId as PaymentId,
        update.chargeId,
        now,
        tx,
      );
      if (!marked.marked) return 'DUPLICATE';
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: STARS_CHARGE_REFUNDED_ACTION,
          entityType: 'Payment',
          entityId: payment.id,
          before: {
            paymentState: payment.state,
            providerStatus: marked.before?.providerStatus ?? null,
            providerPaid: marked.before?.providerPaid ?? null,
            outcome: marked.before?.outcome ?? null,
          },
          after: {
            paymentState: payment.state,
            providerStatus: STARS_REFUNDED_STATUS,
            providerPaid: false,
            provider: PROVIDER,
            providerChargeId: update.chargeId,
            // Codex on #360: the charge was recorded BY this refund (its success had not been).
            chargeRecordedByRefund: beforeRecorded,
            refundedAmount: update.totalAmount.toString(),
            refundedCurrency: update.currency,
            orderId: payment.orderId,
            // Nothing else was changed: the operator decides (OQ-R12-F1-02).
            serviceChanged: false,
            walletChanged: false,
          },
          result: 'SUCCESS',
        },
        tx,
      );
      await alert(
        payment.state === 'CONFIRMED'
          ? 'SETTLED_THEN_REFUNDED'
          : beforeRecorded
            ? 'REFUNDED_BEFORE_RECORDED'
            : 'REFUNDED_UNSETTLED',
        {
          paymentId: payment.id,
          customerId: payment.customerId,
          orderId: payment.orderId,
          paymentState: payment.state,
          refundedAmount: update.totalAmount.toString(),
          refundedCurrency: update.currency,
        },
      );
      this.deps.logger.info(
        { paymentId: payment.id, provider: PROVIDER, paymentState: payment.state },
        'stars charge refunded by telegram',
      );
      return 'MARKED';
    });
  }

  private async factsFor(
    scope: TenantContext,
    invoice: GatewayInvoiceRecord,
    botInstanceId: string,
    update: {
      readonly payerTelegramUserId: string;
      readonly currency: string;
      readonly totalAmount: bigint;
    },
    tx?: unknown,
  ): Promise<StarsCheckFacts | null> {
    const payment = await this.deps.payments.findById(scope, invoice.paymentId as PaymentId, tx);
    if (payment === null) return null;
    const customer = await this.deps.customers.findById(scope, payment.customerId as UserId, tx);
    const order =
      payment.orderId === null
        ? null
        : await this.deps.orders.findById(scope, payment.orderId as OrderId, tx);
    return {
      invoice: {
        botInstanceId: invoice.botInstanceId,
        sentAmount: invoice.sentAmount,
        providerUnit: invoice.providerUnit,
      },
      payment: { state: payment.state, expiresAt: payment.expiresAt, orderId: payment.orderId },
      customer:
        customer === null
          ? null
          : { telegramUserId: customer.telegramUserId, status: customer.status },
      orderState: order?.state ?? null,
      botInstanceId,
      update,
      now: this.deps.clock.now(),
    };
  }
}
