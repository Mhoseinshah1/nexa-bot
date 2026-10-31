import {
  EVENT_PAYLOAD_SCHEMAS,
  money,
  paymentTrackingCode,
  toPersianDigits,
  type CurrencyCode,
  type DomainEvent,
  type GatewayProviderRequestState,
  type EventType,
  type Money,
  type NotificationDestination,
  type NotificationKind,
  type OpsLogButton,
  type OpsLogTypeId,
  type PaymentId,
  type TemplateKey,
  type TemplateValue,
  type TemplateValues,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import type { EventConsumer } from '../../../platform/eventing/application/event-consumer.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { CustomerRecord, CustomerRepository } from '../../customers/application/ports.js';
import { identityOf, oneLine, serviceUsernameValue } from '../../ops-log/application/presenters.js';
import type { CustomerFact, OpsLogFacts, OpsLogWords } from '../../ops-log/application/ports.js';
import type {
  GatewayInvoiceRecord,
  GatewayInvoiceRepository,
  GatewayProviderRequestRepository,
} from './gateway-invoice-ports.js';
import { gatewaySettlementDeadline } from '../domain/settlement.js';
import { failureStatusOf, paymentFailureOutcome } from '../domain/payment-failure-outcome.js';
import type { PaymentRecord, PaymentRepository } from './ports.js';
import type { ServiceRefundRequestRepository } from './service-refund-request-ports.js';

/** The notification lane, as the financial log needs it. `NotificationService` is it. */
export interface FinancialLogLane {
  financialDestination(scope: TenantContext, tx?: unknown): Promise<NotificationDestination | null>;
  queue(
    scope: TenantContext,
    input: {
      readonly kind: NotificationKind;
      readonly dedupeKey: string;
      readonly templateKey: TemplateKey;
      readonly values: TemplateValues;
      readonly correlationId?: string;
      readonly destination?: NotificationDestination;
      /** Round 4 PR-D: the log type (its switch and topic) and the buttons under the message. */
      readonly logType?: OpsLogTypeId;
      readonly buttons?: readonly OpsLogButton[];
    },
    tx?: unknown,
  ): Promise<unknown>;
}

/** A cancel request that reached the provider (or may have): the ones that can explain a `canceled`. */
const SENT_CANCEL_STATES: ReadonlySet<GatewayProviderRequestState> = new Set([
  'SENT',
  'APPLIED',
  'UNKNOWN',
] as GatewayProviderRequestState[]);

/** How much of one gateway rejection reason the log quotes. */
const REJECT_REASON_MAX = 120;

/** Every ledger reason a payment's wallet credit is written under. */
const PAYMENT_CREDIT_REASONS = [
  'TOPUP_GATEWAY',
  'TOPUP_RECEIPT',
  'TOPUP_STARS',
  'TOPUP_CRYPTO',
  'RECEIPT_CREDIT',
  'CASHBACK_TOPUP',
] as const;

/**
 * The financial log (WP18, reworked by Round 4 PR-D, L1-L6): one provider-neutral pipeline
 * from a committed financial fact to the log group's payments topic.
 *
 * A CONSUMER, so it runs in the outbox relay's transaction, after the business transaction
 * committed, and never inside it — a log that fails, is not configured, or is never
 * delivered cannot roll back, delay or veto money. It does database work only
 * (`EventConsumer` forbids the network here): it reads the rows it renders and writes one
 * intent into the operator notification lane, which sends it later, outside every
 * transaction, with that lane's bounded retries.
 *
 * The intent's kind is `OPERATIONAL_EVENT`, and the `ops.financial.*` template key is
 * what makes it a financial row. A kind of its own would be one the previous release's
 * Web Admin refuses (`notificationSchema.kind` is a strict enum), so a rollback would take
 * its whole notifications page down; an unfamiliar template key is only a string there.
 *
 * What it renders is named field by field — a short public code instead of an id, the
 * method's name ONCE and in Persian, the amounts, a Telegram id, username and display name,
 * and the wallet BEFORE and AFTER, derived from the ledger. Never a raw provider payload, an
 * invoice or payment link, a subscription link, a key, a token or an operator's free-text
 * note, and never an id of a row: the buttons carry those, and a button is not a text line.
 *
 * Idempotent twice over: the relay's `processed_messages` claim, and the dedupe key
 * `fin:<event id>` on `(tenant, dedupe_key)`, so a replay whose claim was lost writes
 * nothing new.
 */
export class FinancialLogConsumer implements EventConsumer {
  /** Stable: it is the key in `processed_messages`. */
  readonly name = 'payments.financial-log';
  readonly subscribesTo: readonly EventType[] = [
    'PaymentConfirmed',
    'PaymentFailed',
    'PaymentLateCompletionObserved',
    // R5A item 4: a late approval credited to the wallet (log L5, its own message).
    'PaymentLateCredited',
    // TonPays Telegram (§9.6.4): a provider review that lapsed with no trustworthy answer.
    'PaymentOutcomeUnknown',
    // R9 C1: an open attempt paid less or more than invoiced, or a credit_amount that differs.
    'GatewayPaymentAttentionRaised',
    'RefundCompleted',
    'RefundFailed',
    'ServiceRefundRequestResolved',
  ];

  constructor(
    private readonly deps: {
      readonly lane: FinancialLogLane;
      readonly payments: Pick<PaymentRepository, 'findById'>;
      readonly customers: Pick<CustomerRepository, 'findById'>;
      readonly invoices: Pick<GatewayInvoiceRepository, 'findByPayment'>;
      /** The facts the ledger and the orders hold: balances, order codes, services, admins. */
      readonly facts: OpsLogFacts;
      readonly words: OpsLogWords;
      /** WP19: the request an outcome names, read as it stands. */
      readonly refundRequests: Pick<ServiceRefundRequestRepository, 'findById'>;
      /**
       * R8 A3: a payment's cancel request (who cancelled) and the gateway's rejection reasons.
       * Absent: a bare `canceled` reads as cancelled in the gateway, and no reasons are listed.
       */
      readonly providerRequests?: Pick<GatewayProviderRequestRepository, 'latest' | 'factsFor'>;
    },
  ) {}

  async handle(event: DomainEvent, tx: TransactionScope): Promise<void> {
    // Every financial fact is a tenant's; a platform-scoped copy has no log group.
    if (event.tenantId === null) return;
    const scope: TenantContext = { tenantId: event.tenantId as never, botInstanceId: null };

    const destination = await this.deps.lane.financialDestination(scope, tx);
    // Not configured, or switched off: the rows are the record, and nothing is owed.
    if (destination === null) return;

    const rendered = await this.render(scope, event, tx);
    if (rendered === null) return;
    await this.deps.lane.queue(
      scope,
      {
        kind: 'OPERATIONAL_EVENT',
        dedupeKey: `fin:${event.eventId}`,
        templateKey: rendered.templateKey,
        values: rendered.values,
        correlationId: event.correlationId,
        destination,
        logType: rendered.logType,
        buttons: rendered.buttons,
      },
      tx,
    );
  }

  /**
   * R8 A3: which of the four L4 headlines a `PaymentFailed` is, and the line under it — who
   * cancelled, the rejection's reasons, or the real cause — written into `values`.
   */
  private async failureHeadline(
    scope: TenantContext,
    payment: PaymentRecord,
    cause: 'REJECTED' | 'GATEWAY_FAILED',
    values: Record<string, TemplateValue>,
    tx: TransactionScope,
  ): Promise<TemplateKey> {
    const { words } = this.deps;
    const requests = this.deps.providerRequests;
    const note = payment.resolutionNote ?? null;
    const status = failureStatusOf(note);
    const bareCancel =
      cause === 'GATEWAY_FAILED' && (status === 'canceled' || status === 'cancelled');
    const request =
      bareCancel && requests !== undefined
        ? await requests.latest(scope, payment.id, 'CANCEL', tx)
        : null;
    const outcome = paymentFailureOutcome({
      cause,
      resolutionNote: note,
      // Only a cancel that was SENT can have been what the provider then reported.
      cancelRequest:
        request !== null && SENT_CANCEL_STATES.has(request.state)
          ? { byNexa: request.requestedByNexa === true }
          : null,
    });
    switch (outcome.kind) {
      case 'CANCELLED':
        values['cancelledBy'] = words.cancelledBy(outcome.by);
        return 'ops.financial.invoice_cancelled' as TemplateKey;
      case 'EXPIRED':
        return 'ops.financial.payment_expired' as TemplateKey;
      case 'RECEIPT_REJECTED': {
        let reasons: readonly string[] = [];
        if (outcome.by === 'OPERATOR') {
          // The operator's reason — mandatory, and already sent to the customer word for word.
          const reason = oneLine(note);
          reasons = reason === null ? [] : [reason];
        } else if (requests !== undefined) {
          const facts = await requests.factsFor(scope, payment.id, tx);
          reasons = (facts?.rejectReasons ?? [])
            .map((one) => oneLine(one, REJECT_REASON_MAX))
            .filter((one): one is string => one !== null);
        }
        values['rejectReasons'] = words.rejectReasons(outcome.by, reasons);
        return 'ops.financial.receipt_rejected' as TemplateKey;
      }
      case 'FAILED':
        values['cause'] =
          cause === 'REJECTED'
            ? words.paymentFailure(cause)
            : words.gatewayFailureCause(outcome.code);
        return 'ops.financial.payment_failed' as TemplateKey;
    }
  }

  private async render(
    scope: TenantContext,
    event: DomainEvent,
    tx: TransactionScope,
  ): Promise<{
    readonly templateKey: TemplateKey;
    readonly values: TemplateValues;
    readonly logType: OpsLogTypeId;
    readonly buttons: readonly OpsLogButton[];
  } | null> {
    const { words, facts } = this.deps;
    switch (event.eventType as EventType) {
      case 'PaymentConfirmed': {
        const payload = EVENT_PAYLOAD_SCHEMAS.PaymentConfirmed.parse(event.payload);
        const found = await this.facts(scope, event.aggregateId as PaymentId, tx);
        if (found === null) return null;
        const { payment, customer, invoice } = found;
        // A payment the import carried as history credits and settles nothing: no message.
        if (payload.evidenceKind === 'LEGACY_IMPORT' || payment.source !== 'NEXA') return null;
        const order =
          payment.orderId === null ? null : await facts.order(scope, payment.orderId, tx);
        const crypto = payment.gatewayProvider === 'NOWPAYMENTS';
        // Round 6 item 6: a TetraPay payment names how it was paid - «تتراپی (آنلاین)» or «(کارت)».
        const paidHow = words.providerMethodName(invoice?.providerMethod ?? null);
        const common: Record<string, TemplateValue> = {
          method:
            words.methodName(payment.method, payment.gatewayProvider) +
            (paidHow === null ? '' : ` (${paidHow})`),
          ...who(customer, words),
          reference: paymentTrackingCode(payment),
          ...amounts(payment),
          ...providerLines(invoice),
          evidence: words.evidenceName(payload.evidenceKind),
          at: payment.confirmedAt ?? new Date(event.occurredAt),
        };
        if (order?.code !== null && order?.code !== undefined) common['orderCode'] = order.code;
        // R11 A7: an order tied to a service names the service's panel account (a top-up has none).
        if (payment.orderId !== null) {
          await this.withServiceUsername(scope, payment.orderId, common, tx);
        }
        const buttons: OpsLogButton[] = [
          { kind: 'USER', ref: payment.customerId },
          { kind: 'PAYMENT', ref: payment.id },
        ];

        if (payment.orderId === null) {
          // The gift actually CREDITED, read from the ledger — never recomputed here.
          const entries = await facts.entriesOfPayment(
            scope,
            payment.id,
            [...PAYMENT_CREDIT_REASONS],
            tx,
          );
          const gift = entries.find((entry) => entry.reason === 'CASHBACK_TOPUP');
          const balance = await facts.balanceAround(
            scope,
            payment.customerId,
            payment.amount.currency,
            entries.map((entry) => entry.id),
            tx,
          );
          const values: Record<string, TemplateValue> = { ...common };
          if (balance !== null) {
            values['balanceBefore'] = balance.before;
            values['balanceAfter'] = balance.after;
          }
          if (crypto) {
            return {
              templateKey: 'ops.log.payment_crypto' as TemplateKey,
              values: cryptoValues(values, invoice, words, true),
              logType: 'PAYMENT_CRYPTO',
              buttons,
            };
          }
          values['gift'] = gift?.amount ?? money(0n, payment.amount.currency);
          return {
            templateKey: 'ops.financial.topup_credited' as TemplateKey,
            values,
            logType: 'PAYMENT_TOPUP',
            buttons,
          };
        }
        // A wallet payment: the wallet on either side of this order's purchase debit.
        if (payment.method === 'WALLET') {
          const entries = await facts.entriesOfOrder(scope, payment.orderId, 'PURCHASE', tx);
          const balance = await facts.balanceAround(
            scope,
            payment.customerId,
            payment.amount.currency,
            entries.map((entry) => entry.id),
            tx,
          );
          if (balance !== null) {
            common['balanceBefore'] = balance.before;
            common['balanceAfter'] = balance.after;
          }
        }
        if (crypto) {
          return {
            templateKey: 'ops.log.payment_crypto' as TemplateKey,
            values: cryptoValues(common, invoice, words, false),
            logType: 'PAYMENT_CRYPTO',
            buttons,
          };
        }
        // C2: what was bought, which operation it was, and the two badges. The badge token is
        // always present (empty when none applies): the title line is made of its words and
        // this token, and the renderer drops a line whose tokens are ALL absent.
        const paidValues: Record<string, TemplateValue> = { ...common };
        /*
         * Hotfix v0.8.2-e (the owner's request): a WALLET payment prints no «کارمزد درگاه: ۰»
         * and no «منبع تأیید: کسر از کیف پول». It goes through no gateway, so it has no fee,
         * and its evidence is the debit the wallet's before → after line already shows. Every
         * other method keeps both lines; the renderer drops a line whose tokens are absent.
         */
        if (payment.method === 'WALLET') {
          delete paidValues['fee'];
          delete paidValues['evidence'];
        }
        if (order !== null) {
          paidValues['productTitle'] = order.title;
          paidValues['operation'] = words.paidOperation(order.purpose);
          paidValues['badges'] =
            words.badges({ firstPurchase: order.isFirstPurchase, reseller: order.reseller }) ?? '';
        }
        return {
          templateKey: 'ops.financial.order_paid' as TemplateKey,
          values: paidValues,
          logType: 'PAYMENT_ORDER',
          buttons: [
            ...buttons,
            ...(order === null ? [] : [{ kind: 'ORDER' as const, ref: order.id }]),
          ],
        };
      }
      case 'PaymentFailed': {
        const payload = EVENT_PAYLOAD_SCHEMAS.PaymentFailed.parse(event.payload);
        const found = await this.facts(scope, event.aggregateId as PaymentId, tx);
        if (found === null || found.payment.source !== 'NEXA') return null;
        const { payment, customer } = found;
        const values: Record<string, TemplateValue> = {
          method: words.methodName(payment.method, payment.gatewayProvider),
          ...who(customer, words),
          reference: paymentTrackingCode(payment),
          ...amounts(payment),
          at: payment.resolvedAt ?? new Date(event.occurredAt),
        };
        await this.withOrderCode(scope, payment, values, tx);
        // R8 A3: one headline per outcome, derived from the payment row (`paymentFailureOutcome`).
        const templateKey = await this.failureHeadline(scope, payment, payload.cause, values, tx);
        return {
          templateKey,
          values,
          logType: 'PAYMENT_FAILED',
          buttons: [
            { kind: 'USER', ref: payment.customerId },
            { kind: 'PAYMENT', ref: payment.id },
          ],
        };
      }
      case 'PaymentLateCompletionObserved':
      case 'PaymentOutcomeUnknown': {
        const late = (event.eventType as EventType) === 'PaymentLateCompletionObserved';
        const route = late
          ? EVENT_PAYLOAD_SCHEMAS.PaymentLateCompletionObserved.parse(event.payload).provider
          : null;
        const found = await this.facts(scope, event.aggregateId as PaymentId, tx);
        if (found === null || found.payment.source !== 'NEXA') return null;
        const { payment, customer, invoice } = found;
        const values: Record<string, TemplateValue> = {
          gateway: words.gatewayName(route ?? payment.gatewayProvider),
          ...who(customer, words),
          reference: paymentTrackingCode(payment),
          ...amounts(payment),
          ...providerLines(invoice),
          at: new Date(event.occurredAt),
        };
        await this.withOrderCode(scope, payment, values, tx);
        // The payment is not credited: the one thing an operator can do is credit it by hand.
        return {
          templateKey: (late
            ? 'ops.financial.late_completion'
            : 'ops.financial.outcome_unknown') as TemplateKey,
          values,
          logType: 'PAYMENT_LATE',
          buttons: [
            { kind: 'MANUAL_CREDIT', ref: payment.customerId },
            { kind: 'USER', ref: payment.customerId },
          ],
        };
      }
      case 'GatewayPaymentAttentionRaised': {
        const payload = EVENT_PAYLOAD_SCHEMAS.GatewayPaymentAttentionRaised.parse(event.payload);
        const found = await this.facts(scope, event.aggregateId as PaymentId, tx);
        if (found === null || found.payment.source !== 'NEXA') return null;
        const { payment, customer, invoice } = found;
        const unit = invoice === null ? null : providerUnitWord(invoice.providerUnit);
        const providerFigure = (amount: bigint | null | undefined): string | null =>
          amount === null || amount === undefined || unit === null
            ? null
            : toPersianDigits(`${amount.toString()} ${unit}`);
        const values: Record<string, TemplateValue> = {
          ...who(customer, words),
          reference: paymentTrackingCode(payment),
          ...amounts(payment),
          at: new Date(event.occurredAt),
        };
        if (invoice?.providerInvoiceId != null) {
          values['providerInvoiceId'] = invoice.providerInvoiceId;
        }
        await this.withOrderCode(scope, payment, values, tx);
        const buttons: OpsLogButton[] = [
          { kind: 'USER', ref: payment.customerId },
          { kind: 'PAYMENT', ref: payment.id },
        ];
        if (payload.reason === 'CREDIT_AMOUNT_MISMATCH') {
          const credit = providerFigure(invoice?.creditAmount);
          // The figure is what this message is about: without it there is nothing to say.
          if (credit === null || invoice === null) return null;
          values['gateway'] = words.gatewayName(payment.gatewayProvider);
          values['creditAmount'] = credit;
          const invoiced = providerFigure(invoice.sentAmount);
          if (invoiced !== null) values['invoicedAmount'] = invoiced;
          return {
            templateKey: 'ops.financial.credit_amount_mismatch' as TemplateKey,
            values,
            logType: 'PAYMENT_LATE',
            buttons,
          };
        }
        values['method'] = words.methodName(payment.method, payment.gatewayProvider);
        // What the provider asked for, as it said it now: diagnostic lines, never settled.
        const need = await this.deps.providerRequests?.factsFor(scope, payment.id, tx);
        if (payload.reason === 'UNDERPAID') {
          const remaining = providerFigure(need?.remainingAmount);
          if (remaining !== null) values['remainingAmount'] = remaining;
          if (need?.remainingInvoiceId != null) {
            values['remainderInvoiceId'] = need.remainingInvoiceId;
          }
        } else {
          const refund = providerFigure(need?.refundAmount);
          if (refund !== null) values['refundAmount'] = refund;
        }
        return {
          templateKey: (payload.reason === 'UNDERPAID'
            ? 'ops.financial.payment_underpaid'
            : 'ops.financial.payment_overpaid') as TemplateKey,
          values,
          logType: 'PAYMENT_FAILED',
          buttons,
        };
      }
      case 'PaymentLateCredited': {
        const payload = EVENT_PAYLOAD_SCHEMAS.PaymentLateCredited.parse(event.payload);
        const found = await this.facts(scope, event.aggregateId as PaymentId, tx);
        if (found === null || found.payment.source !== 'NEXA') return null;
        const { payment, customer } = found;
        const occurredAt = new Date(event.occurredAt);
        const currency = payload.currency as CurrencyCode;
        // R12 F1: money returned for an attempt that could no longer pay its order has its own
        // message — it was never "approved after the deadline". An older event is a late approval.
        const returned = payload.basis === 'RETURNED';
        const values: Record<string, TemplateValue> = {
          gateway: words.gatewayName(payload.provider),
          ...who(customer, words),
          reference: paymentTrackingCode(payment),
          amount: money(BigInt(payload.amountMinor), currency),
          // When the payment stopped being payable in Nexa, against when the approval was credited.
          ...(returned ? {} : { expiredAt: gatewaySettlementDeadline(payment) ?? occurredAt }),
          approvedAt: occurredAt,
        };
        await this.withOrderCode(scope, payment, values, tx);
        // The wallet on either side of THIS payment's late credit, found by its entry.
        const balance = await facts.balanceAround(
          scope,
          payment.customerId,
          currency,
          [payload.entryId],
          tx,
        );
        if (balance !== null) {
          values['balanceBefore'] = balance.before;
          values['balanceAfter'] = balance.after;
        }
        return {
          templateKey: (returned
            ? 'ops.financial.late_credit_returned'
            : 'ops.financial.late_credit') as TemplateKey,
          values,
          logType: 'PAYMENT_LATE',
          buttons: [
            { kind: 'USER', ref: payment.customerId },
            { kind: 'PAYMENT', ref: payment.id },
          ],
        };
      }
      case 'RefundCompleted':
      case 'RefundFailed': {
        const completed = (event.eventType as EventType) === 'RefundCompleted';
        const payload = completed
          ? EVENT_PAYLOAD_SCHEMAS.RefundCompleted.parse(event.payload)
          : EVENT_PAYLOAD_SCHEMAS.RefundFailed.parse(event.payload);
        const found = await this.facts(scope, payload.paymentId as PaymentId, tx);
        if (found === null || found.payment.source !== 'NEXA') return null;
        const { payment, customer } = found;
        const values: Record<string, TemplateValue> = {
          channel: words.refundChannel(payload.channel),
          ...who(customer, words),
          reference: paymentTrackingCode(payment),
          amount: money(BigInt(payload.amountMinor), payload.currency as CurrencyCode),
          at: new Date(event.occurredAt),
        };
        await this.withOrderCode(scope, payment, values, tx);
        if (completed) {
          // A refund into the wallet: the wallet on either side of the credit THIS refund
          // wrote — found by its own reference, never as the payment's newest REFUND entry,
          // which after a second partial refund is the other refund's (money review of #301).
          if (payload.channel === 'WALLET_CREDIT') {
            const credit = await facts.ledgerEntryByReference(
              scope,
              `${payload.refundId}:refund`,
              tx,
            );
            if (credit !== null && credit.customerId === payment.customerId) {
              const balance = await facts.balanceAround(
                scope,
                payment.customerId,
                credit.amount.currency,
                [credit.id],
                tx,
              );
              if (balance !== null) {
                values['balanceBefore'] = balance.before;
                values['balanceAfter'] = balance.after;
              }
            }
          }
        } else {
          values['cause'] = words.refundFailure(
            EVENT_PAYLOAD_SCHEMAS.RefundFailed.parse(event.payload).cause,
          );
        }
        return {
          templateKey: (completed
            ? 'ops.financial.refund_completed'
            : 'ops.financial.refund_failed') as TemplateKey,
          values,
          logType: 'REFUND',
          buttons: [
            { kind: 'USER', ref: payment.customerId },
            { kind: 'PAYMENT', ref: payment.id },
          ],
        };
      }
      case 'ServiceRefundRequestResolved': {
        /*
         * A customer's refund request reached an outcome (WP19). A credit is logged by
         * `RefundCompleted` as well; this line says what was decided about the REQUEST —
         * a rejection, which moves nothing, and a failure, whose released reservation
         * writes no `RefundFailed` (that payload's cause is closed for rollback).
         */
        const payload = EVENT_PAYLOAD_SCHEMAS.ServiceRefundRequestResolved.parse(event.payload);
        const request = await this.deps.refundRequests.findById(scope, payload.requestId, tx);
        if (request === null) return null;
        const customer = await this.deps.customers.findById(scope, request.customerId, tx);
        const values: Record<string, TemplateValue> = {
          outcome: words.refundRequestOutcome(payload.outcome),
          ...who(customer, words),
          at: request.resolvedAt ?? new Date(event.occurredAt),
        };
        const service = await facts.service(scope, request.serviceId, tx);
        if (service?.code !== null && service?.code !== undefined)
          values['serviceCode'] = service.code;
        // R11 A7: the request is ABOUT this service — its panel account name, as the service stands.
        const requested = serviceUsernameValue(service?.providerUsername);
        if (requested !== null) values['serviceUsername'] = requested;
        const payment = await this.deps.payments.findById(
          scope,
          request.paymentId as PaymentId,
          tx,
        );
        if (payment !== null) values['reference'] = paymentTrackingCode(payment);
        // Absent for a rejection: the template drops the line rather than print a zero.
        if (request.approvedAmount !== null) values['amount'] = request.approvedAmount;
        if (request.decidedByAdminId !== null) {
          const admin = await facts.admin(scope, request.decidedByAdminId, tx);
          if (admin !== null) values['adminName'] = admin.displayName;
        }
        return {
          templateKey: 'ops.financial.service_refund_request' as TemplateKey,
          values,
          logType: 'REFUND',
          buttons: [{ kind: 'USER', ref: request.customerId }],
        };
      }
      /* istanbul ignore next -- `subscribesTo` is the list above; the relay routes by it. */
      default:
        return null;
    }
  }

  /** The order's public code, when the payment is for an order that has one. */
  private async withOrderCode(
    scope: TenantContext,
    payment: PaymentRecord,
    values: Record<string, TemplateValue>,
    tx: TransactionScope,
  ): Promise<void> {
    if (payment.orderId === null) return;
    const order = await this.deps.facts.order(scope, payment.orderId, tx);
    if (order?.code !== null && order?.code !== undefined) values['orderCode'] = order.code;
    // R11 A7: and, when that order is tied to a service, the service's panel account name.
    await this.withServiceUsername(scope, payment.orderId, values, tx);
  }

  /**
   * R11 A7: the panel account name of the service an order is tied to, as its own line. Absent
   * (the line is dropped) for an order with no service — a top-up, or a payment that never
   * settled into one.
   */
  private async withServiceUsername(
    scope: TenantContext,
    orderId: string,
    values: Record<string, TemplateValue>,
    tx: TransactionScope,
  ): Promise<void> {
    const name = serviceUsernameValue(
      await this.deps.facts.serviceUsernameOfOrder(scope, orderId, tx),
    );
    if (name !== null) values['serviceUsername'] = name;
  }

  /** The payment, its customer and (for a gateway payment) its invoice, as they stand. */
  private async facts(
    scope: TenantContext,
    paymentId: PaymentId,
    tx: TransactionScope,
  ): Promise<{
    readonly payment: PaymentRecord;
    readonly customer: CustomerRecord | null;
    readonly invoice: GatewayInvoiceRecord | null;
  } | null> {
    const payment = await this.deps.payments.findById(scope, paymentId, tx);
    if (payment === null) return null;
    const customer = await this.deps.customers.findById(scope, payment.customerId as UserId, tx);
    const invoice =
      payment.method === 'GATEWAY'
        ? await this.deps.invoices.findByPayment(scope, payment.id, tx)
        : null;
    return { payment, customer, invoice };
  }
}

/** Who paid: the three customer values, with a Persian word for each one that is unknown. */
function who(customer: CustomerRecord | null, words: OpsLogWords): TemplateValues {
  const fact: CustomerFact | null =
    customer === null
      ? null
      : {
          id: customer.id,
          telegramUserId: customer.telegramUserId,
          username: customer.username,
          firstName: customer.firstName,
          lastName: customer.lastName,
          phone: customer.phoneNumber,
          source: customer.source,
          status: customer.status,
          blockedReason: customer.blockedReason,
        };
  return { ...identityOf(fact, words) };
}

/**
 * The three amounts, from the payment's own snapshot. A non-gateway payment, or a gateway
 * attempt from before WP18, had no fee: its fee is zero and its payable is its principal.
 */
function amounts(payment: PaymentRecord): {
  readonly principal: Money;
  readonly fee: Money;
  readonly payable: Money;
} {
  const fee = payment.customerFee;
  return {
    principal: payment.amount,
    fee: fee?.fee ?? money(0n, payment.amount.currency),
    payable: fee?.payable ?? payment.amount,
  };
}

/** A provider's unit as the group reads it: never the ISO code the provider's API uses. */
const UNIT_WORDS: Readonly<Record<string, string>> = {
  IRT: 'تومان',
  IRR: 'ریال',
  USD: 'دلار',
  XTR: 'استارز',
};

/** A provider's unit in Persian (`تومان`), or its code when the log has no word for it. */
function providerUnitWord(unit: string): string {
  return UNIT_WORDS[unit] ?? unit;
}

/**
 * The provider's side of a gateway payment, for the group: its invoice id, and the final
 * amount it reported with the unit in Persian and the digits in Persian. A line the provider
 * gave nothing for is ABSENT — the template drops it — rather than a dash.
 */
function providerLines(invoice: GatewayInvoiceRecord | null): Record<string, TemplateValue> {
  const facts = gatewayProviderFacts(invoice);
  const out: Record<string, TemplateValue> = {};
  const id = facts['providerInvoiceId'];
  const amount = facts['providerFinalAmount'];
  if (typeof id === 'string' && id !== '—') out['providerInvoiceId'] = id;
  if (typeof amount === 'string' && amount !== '—') {
    out['providerFinalAmount'] = toPersianDigits(
      amount.replace(/\b(IRT|IRR|USD|XTR)\b/g, (code) => UNIT_WORDS[code] ?? code),
    );
  }
  return out;
}

/**
 * The extra lines of a crypto payment (L3) from what the invoice records: the dollar amount
 * the invoice was priced at, the provider's status and its payment id. The crypto amounts and
 * crypto amounts and deposit address the provider reported, shown only when the invoice carries them
 * so a line is never invented.
 */
function cryptoValues(
  base: Record<string, TemplateValue>,
  invoice: GatewayInvoiceRecord | null,
  words: OpsLogWords,
  topup: boolean,
): TemplateValues {
  const values: Record<string, TemplateValue> = {
    ...base,
    kindTitle: words.cryptoKindTitle(topup),
  };
  delete values['fee'];
  delete values['payable'];
  delete values['evidence'];
  delete values['providerFinalAmount'];
  if (invoice !== null) {
    if (invoice.providerUnit === 'USD') {
      const cents = invoice.requestAmount ?? invoice.sentAmount;
      values['fiatEquivalent'] = toPersianDigits(
        `${(cents / 100n).toString()}.${(cents % 100n).toString().padStart(2, '0')} ${UNIT_WORDS['USD'] as string}`,
      );
    }
    // R5C-2 C4: the coin side, from what the provider's own record reported. Each line is
    // present only when the provider reported it, and the template drops an absent one.
    const coin = invoice.cryptoPayCurrency === null ? '' : ` ${invoice.cryptoPayCurrency}`;
    if (invoice.cryptoRequested !== null) {
      values['cryptoRequested'] = `${toPersianDigits(invoice.cryptoRequested)}${coin}`;
    }
    if (invoice.cryptoPaid !== null) {
      values['cryptoPaid'] = `${toPersianDigits(invoice.cryptoPaid)}${coin}`;
    }
    if (invoice.cryptoReceived !== null) {
      // `outcome_amount` is in the provider's OUTCOME currency, which need not be the coin the
      // payer sent; the pay currency labels it only when the provider named no other.
      const receivedCoin = invoice.cryptoReceivedCurrency ?? invoice.cryptoPayCurrency;
      values['cryptoReceived'] =
        `${toPersianDigits(invoice.cryptoReceived)}${receivedCoin === null ? '' : ` ${receivedCoin}`}`;
    }
    if (invoice.cryptoPayAddress !== null) values['walletAddress'] = invoice.cryptoPayAddress;
    if (invoice.providerStatus !== null) values['providerStatus'] = invoice.providerStatus;
    if (invoice.hintedPaymentId !== null) values['providerPaymentId'] = invoice.hintedPaymentId;
  }
  return values;
}

/** A value the provider gave nothing for. Punctuation, not language. */
const NONE = '—';

/**
 * The provider's side, for a gateway payment: its invoice id and the final amount it
 * reported, in ITS unit. Diagnostic only — the template says so, and nothing reads it back.
 */
export function gatewayProviderFacts(invoice: GatewayInvoiceRecord | null): TemplateValues {
  if (invoice === null) return { providerInvoiceId: NONE, providerFinalAmount: NONE };
  /*
   * A rate-converted attempt (Telegram Stars, Package A): once paid, its provider id is
   * the CHARGE id — what an operator reconciles by, and what a manual Star refund would
   * need — and its amount is the Stars it asked for, which the record step proved equal to
   * what was charged. Never the payload or a token.
   */
  // Spec §8: Stars are now always CENTRAL_FX, with no fixed rate on the invoice, so the rate's
  // presence no longer says the attempt was converted. The PROVIDER does: NOWPayments is
  // CENTRAL_FX too, and its dollar figures are shown by the branch below, never as Stars.
  if (invoice.conversionRateMinor !== null || invoice.provider === 'TELEGRAM_STARS') {
    // A rate-converted attempt's only provider amount is the one it asked for (XTR).
    return {
      providerInvoiceId:
        invoice.providerChargeId !== null
          ? `charge:${invoice.providerChargeId}`
          : (invoice.providerInvoiceId ?? NONE),
      providerFinalAmount: `${invoice.sentAmount.toString()} ${invoice.providerUnit}`,
    };
  }
  /*
   * A dollar-priced attempt (NOWPayments, central FX). The provider's figure is the price the
   * provider's own last read REPORTED for the payment (`request_amount`, exact cents) — not
   * what Nexa invoiced: an operator must see a mismatch, never the expected price under the
   * provider's label (Codex review of #141). When the two differ, both are shown. Nothing
   * read yet is NONE. The crypto the customer chose is the provider's business.
   */
  if (invoice.providerUnit === 'USD') {
    const dollars = (cents: bigint) =>
      `${(cents / 100n).toString()}.${(cents % 100n).toString().padStart(2, '0')} USD`;
    const reported = invoice.requestAmount;
    return {
      providerInvoiceId:
        invoice.hintedPaymentId === null
          ? (invoice.providerInvoiceId ?? NONE)
          : `${invoice.providerInvoiceId ?? NONE}/${invoice.hintedPaymentId}`,
      providerFinalAmount:
        reported === null
          ? NONE
          : reported === invoice.sentAmount
            ? dollars(reported)
            : `${dollars(reported)} ≠ ${dollars(invoice.sentAmount)}`,
    };
  }
  /*
   * CentralPay (`docs/centralpay-gateway-audit.md` §5.4): the Toman the provider's own verify
   * REPORTED (`request_amount`) — never the invoiced figure under the provider's label — with
   * the invoiced one beside it when they differ; and the order id with the bound reference.
   * Nothing verified yet is NONE. The customer's card number is never read.
   */
  /*
   * TetraPay (`docs/tetrapay-gateway-audit.md` §5.4) reads the same way: the RIAL its own
   * verify REPORTED (`request_amount`) beside the invoiced figure when they differ, so a
   * mismatch is never hidden under the provider's label.
   */
  // Rialit (Round 9): the TOMAN its own status read REPORTED, the same way.
  if (
    invoice.provider === 'CENTRALPAY' ||
    invoice.provider === 'TETRAPAY' ||
    invoice.provider === 'RIALIT'
  ) {
    const toman = (amount: bigint) => `${amount.toString()} ${invoice.providerUnit}`;
    const reported = invoice.requestAmount;
    const orderId = invoice.providerInvoiceId ?? invoice.providerOrderId;
    return {
      providerInvoiceId:
        invoice.providerChargeId === null ? orderId : `${orderId}/ref:${invoice.providerChargeId}`,
      providerFinalAmount:
        reported === null
          ? NONE
          : reported === invoice.sentAmount
            ? toman(reported)
            : `${toman(reported)} ≠ ${toman(invoice.sentAmount)}`,
    };
  }
  /*
   * Round 10 C1, the custom gateway: the RIAL the bridge's own signed inquiry said it CAPTURED
   * (`amount_paid`, recorded as the final amount) beside the invoiced figure when they differ —
   * an underpayment or overpayment is never hidden under the route's label — and our invoice id
   * with the bridge's reference.
   */
  if (invoice.provider === 'CUSTOM') {
    const rial = (amount: bigint) => `${amount.toString()} ${invoice.providerUnit}`;
    const captured = invoice.finalAmount;
    return {
      providerInvoiceId:
        invoice.providerInvoiceId === null
          ? invoice.providerOrderId
          : `${invoice.providerOrderId}/ref:${invoice.providerInvoiceId}`,
      providerFinalAmount:
        captured === null
          ? NONE
          : captured === invoice.sentAmount
            ? rial(captured)
            : `${rial(captured)} ≠ ${rial(invoice.sentAmount)}`,
    };
  }
  return {
    providerInvoiceId: invoice.providerInvoiceId ?? invoice.hintedInvoiceId ?? NONE,
    providerFinalAmount:
      invoice.finalAmount === null
        ? NONE
        : `${invoice.finalAmount.toString()} ${invoice.providerUnit}`,
  };
}
