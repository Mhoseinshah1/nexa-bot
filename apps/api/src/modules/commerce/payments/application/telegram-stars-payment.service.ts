import {
  systemJobActor,
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

/**
 * A charge Telegram reports that no attempt of this installation can own: a payload that
 * names no attempt, a charge id already attached to another attempt, or a scope that had
 * stopped accepting work. Per charge id. Nothing settled: an operator reconciles it —
 * the charge id is what Telegram's own refund would need. Part of the schema once shipped.
 */
export const STARS_CHARGE_UNMATCHED_CODE = 'payments.gateway_charge_unmatched';

/** One `pre_checkout_query`, as the webhook read it. Telegram's shapes stop at the boundary. */
export interface StarsPreCheckoutUpdate {
  readonly queryId: string;
  readonly payerTelegramUserId: string;
  readonly currency: string;
  readonly totalAmount: bigint;
  readonly payload: string;
}

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
    'findByProviderOrderId' | 'lockByProviderOrderId' | 'findByChargeId' | 'recordCharge'
  >;
  readonly payments: Pick<PaymentRepository, 'findById'>;
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

  private async preCheckoutRefusal(
    scope: TenantContext,
    botInstanceId: string,
    update: StarsPreCheckoutUpdate,
  ): Promise<string | null> {
    if (!(await this.deps.scopeActivity.scopeIsActive(scope))) return 'SCOPE_INACTIVE';
    const invoice = await this.deps.invoices.findByProviderOrderId(scope, PROVIDER, update.payload);
    if (invoice === null) return 'UNKNOWN_PAYLOAD';
    // A charge is already on it: this attempt has been paid, and a second one must not be.
    if (invoice.providerChargeId !== null) return 'ALREADY_PAID';
    const facts = await this.factsFor(scope, invoice, botInstanceId, update);
    return facts === null ? 'UNKNOWN_PAYMENT' : starsPreCheckoutRefusal(facts);
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
        const settled = await this.deps.settlement.settleRecorded(scope, step.invoice.paymentId);
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
