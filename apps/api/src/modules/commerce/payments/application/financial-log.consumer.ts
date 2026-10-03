import {
  EVENT_PAYLOAD_SCHEMAS,
  money,
  topupCashbackReference,
  type CurrencyCode,
  type DomainEvent,
  type EventType,
  type Money,
  type NotificationDestination,
  type NotificationKind,
  type PaymentId,
  type TemplateKey,
  type TemplateValues,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import type { EventConsumer } from '../../../platform/eventing/application/event-consumer.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { CustomerRecord, CustomerRepository } from '../../customers/application/ports.js';
import type { WalletRepository } from '../../wallet/application/ports.js';
import type { GatewayInvoiceRecord, GatewayInvoiceRepository } from './gateway-invoice-ports.js';
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
    },
    tx?: unknown,
  ): Promise<unknown>;
}

/** A value the log has no answer for. Punctuation, not language: a template renders it. */
const NONE = '—';

/**
 * The financial log (WP18 §1.3): one provider-neutral pipeline from a committed financial
 * fact to the log group's payments topic.
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
 * What it renders is named field by field — ids, amounts, a Telegram id, username and
 * display name, a provider invoice id and the provider's final amount labelled diagnostic.
 * Never a raw provider payload, an invoice or payment link, a subscription link, a key, a
 * token or an operator's free-text note.
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
    // TonPays Telegram (§9.6.4): a provider review that lapsed with no trustworthy answer.
    'PaymentOutcomeUnknown',
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
      readonly wallet: Pick<WalletRepository, 'findByReference'>;
      /** WP19: the request an outcome names, read as it stands. */
      readonly refundRequests: Pick<ServiceRefundRequestRepository, 'findById'>;
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
      },
      tx,
    );
  }

  private async render(
    scope: TenantContext,
    event: DomainEvent,
    tx: TransactionScope,
  ): Promise<{ readonly templateKey: TemplateKey; readonly values: TemplateValues } | null> {
    switch (event.eventType as EventType) {
      case 'PaymentConfirmed': {
        const payload = EVENT_PAYLOAD_SCHEMAS.PaymentConfirmed.parse(event.payload);
        const facts = await this.facts(scope, event.aggregateId as PaymentId, tx);
        if (facts === null) return null;
        const common = {
          method: facts.payment.method,
          route: facts.payment.gatewayProvider ?? NONE,
          ...who(facts.customer),
          reference: facts.payment.reference,
          paymentId: facts.payment.id,
          ...amounts(facts.payment),
          ...gatewayProviderFacts(facts.invoice),
          evidence: payload.evidenceKind,
          at: facts.payment.confirmedAt ?? new Date(event.occurredAt),
        };
        if (facts.payment.orderId === null) {
          // The gift actually CREDITED, read from the ledger — never recomputed here.
          const gift = await this.deps.wallet.findByReference(
            scope,
            topupCashbackReference(facts.payment.id),
            tx,
          );
          return {
            templateKey: 'ops.financial.topup_credited' as TemplateKey,
            values: {
              ...common,
              gift: gift?.amount ?? money(0n, facts.payment.amount.currency),
            },
          };
        }
        return {
          templateKey: 'ops.financial.order_paid' as TemplateKey,
          values: { ...common, orderId: facts.payment.orderId },
        };
      }
      case 'PaymentFailed': {
        const payload = EVENT_PAYLOAD_SCHEMAS.PaymentFailed.parse(event.payload);
        const facts = await this.facts(scope, event.aggregateId as PaymentId, tx);
        if (facts === null) return null;
        return {
          templateKey: 'ops.financial.payment_failed' as TemplateKey,
          values: {
            cause: payload.cause,
            method: facts.payment.method,
            route: facts.payment.gatewayProvider ?? NONE,
            ...who(facts.customer),
            reference: facts.payment.reference,
            paymentId: facts.payment.id,
            orderId: facts.payment.orderId ?? NONE,
            ...amounts(facts.payment),
            at: facts.payment.resolvedAt ?? new Date(event.occurredAt),
          },
        };
      }
      case 'PaymentLateCompletionObserved': {
        const payload = EVENT_PAYLOAD_SCHEMAS.PaymentLateCompletionObserved.parse(event.payload);
        const facts = await this.facts(scope, event.aggregateId as PaymentId, tx);
        if (facts === null) return null;
        return {
          templateKey: 'ops.financial.late_completion' as TemplateKey,
          values: {
            route: payload.provider,
            ...who(facts.customer),
            reference: facts.payment.reference,
            paymentId: facts.payment.id,
            orderId: facts.payment.orderId ?? NONE,
            ...amounts(facts.payment),
            ...gatewayProviderFacts(facts.invoice),
            at: new Date(event.occurredAt),
          },
        };
      }
      case 'PaymentOutcomeUnknown': {
        const facts = await this.facts(scope, event.aggregateId as PaymentId, tx);
        if (facts === null) return null;
        return {
          templateKey: 'ops.financial.outcome_unknown' as TemplateKey,
          values: {
            route: facts.payment.gatewayProvider ?? NONE,
            ...who(facts.customer),
            reference: facts.payment.reference,
            paymentId: facts.payment.id,
            orderId: facts.payment.orderId ?? NONE,
            ...amounts(facts.payment),
            ...gatewayProviderFacts(facts.invoice),
            at: new Date(event.occurredAt),
          },
        };
      }
      case 'RefundCompleted': {
        const payload = EVENT_PAYLOAD_SCHEMAS.RefundCompleted.parse(event.payload);
        const values = await this.refundValues(scope, event, payload, tx);
        if (values === null) return null;
        return { templateKey: 'ops.financial.refund_completed' as TemplateKey, values };
      }
      case 'RefundFailed': {
        const payload = EVENT_PAYLOAD_SCHEMAS.RefundFailed.parse(event.payload);
        const values = await this.refundValues(scope, event, payload, tx);
        if (values === null) return null;
        return {
          templateKey: 'ops.financial.refund_failed' as TemplateKey,
          values: { ...values, cause: payload.cause },
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
        return {
          templateKey: 'ops.financial.service_refund_request' as TemplateKey,
          values: {
            outcome: payload.outcome,
            requestId: request.id,
            serviceId: request.serviceId,
            ...who(customer),
            paymentId: request.paymentId,
            // Absent for a rejection: the template drops the line rather than print a zero.
            ...(request.approvedAmount === null ? {} : { amount: request.approvedAmount }),
            adminId: request.decidedByAdminId ?? NONE,
            at: request.resolvedAt ?? new Date(event.occurredAt),
          },
        };
      }
      /* istanbul ignore next -- `subscribesTo` is the list above; the relay routes by it. */
      default:
        return null;
    }
  }

  /** What both refund logs say: the refund, the payment it returns money from, and who. */
  private async refundValues(
    scope: TenantContext,
    event: DomainEvent,
    payload: {
      readonly refundId: string;
      readonly paymentId: string;
      readonly orderId: string | null;
      readonly channel: string;
      readonly amountMinor: string;
      readonly currency: string;
    },
    tx: TransactionScope,
  ): Promise<TemplateValues | null> {
    const facts = await this.facts(scope, payload.paymentId as PaymentId, tx);
    if (facts === null) return null;
    return {
      refundId: payload.refundId,
      channel: payload.channel,
      ...who(facts.customer),
      reference: facts.payment.reference,
      paymentId: facts.payment.id,
      orderId: payload.orderId ?? NONE,
      amount: money(BigInt(payload.amountMinor), payload.currency as CurrencyCode),
      at: new Date(event.occurredAt),
    };
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

/** Who paid, as Telegram knows them. A dash, never a guess, for what is not known. */
function who(customer: CustomerRecord | null): TemplateValues {
  if (customer === null) return { telegramId: NONE, username: NONE, displayName: NONE };
  const name = [customer.firstName, customer.lastName]
    .filter((part): part is string => part !== null && part.trim() !== '')
    .join(' ');
  return {
    telegramId: customer.telegramUserId,
    username: customer.username === null ? NONE : `@${customer.username}`,
    displayName: name === '' ? NONE : name,
  };
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
  return {
    providerInvoiceId: invoice.providerInvoiceId ?? invoice.hintedInvoiceId ?? NONE,
    providerFinalAmount:
      invoice.finalAmount === null
        ? NONE
        : `${invoice.finalAmount.toString()} ${invoice.providerUnit}`,
  };
}
