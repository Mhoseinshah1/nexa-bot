import {
  OPS_ERROR_CLASS_POLICY,
  PAYMENT_LINK_CREATE_FAILED_CODE,
  PAYMENT_LINK_FAILURE_KINDS,
  opsAggregationKey,
  type OperationalEventInput,
  type OpsFailureClassification,
  type PaymentGatewayProvider,
  type PaymentLinkFailureKind,
} from '@nexa/contracts';
import {
  httpStatusOfCode,
  safeHttpStatus,
  safeIdentifier,
  safeTelegramUserId,
  sanitizedErrorCode,
} from '../../../platform/opslog/application/error-events.js';
import type { GatewayCreateOutcome } from './gateway-invoice-ports.js';

/**
 * FIX-04: why a gateway's create-invoice / payment-link request produced no link a customer
 * can use, decided ONCE from the adapter's classified outcome — the one boundary every
 * provider's create passes through (`GatewayPaymentService.processCreation`).
 *
 * Pure: no clock, no I/O. The adapter has already reduced the provider's answer to a
 * machine code (never a body, a URL or the key); this reduces that to the closed
 * vocabulary the operations log group prints, and keeps the code beside it.
 */

/** The note a CREATED link attempt carries when the provider's link was refused as unsafe. */
export const PAYMENT_LINK_REJECTED_CODE = 'nexa.payment_link_rejected';

export interface PaymentLinkFailure {
  readonly kind: PaymentLinkFailureKind;
  /** The sanitized machine code: the adapter's, or Nexa's own `nexa.*` note. */
  readonly errorCode: string;
  readonly httpStatus: number | null;
  readonly retryable: boolean;
  readonly classification: OpsFailureClassification;
  /** The attempt's creation state once this outcome is recorded. */
  readonly creationState: 'CREATE_FAILED' | 'CREATE_UNKNOWN' | 'CREATED';
}

const failureOf = (
  kind: PaymentLinkFailureKind,
  code: string,
  httpStatus: number | null,
  classification: OpsFailureClassification,
  creationState: PaymentLinkFailure['creationState'],
): PaymentLinkFailure => ({
  kind,
  errorCode: sanitizedErrorCode(code),
  httpStatus,
  retryable: PAYMENT_LINK_FAILURE_KINDS[kind].retryable,
  classification,
  creationState,
});

/** A status the provider answered with, by HTTP class, for a refusal. */
function refusalKindOf(status: number | null, configuration: boolean): PaymentLinkFailureKind {
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 429) return 'RATE_LIMITED';
  return configuration ? 'CONFIGURATION' : 'BAD_REQUEST';
}

/** What an UNKNOWN answer's machine code says about the transport or the answer. */
function unknownKindOf(code: string, status: number | null): PaymentLinkFailureKind {
  if (code === 'http.timeout') return 'TIMEOUT';
  if (code === 'http.redirect' || code === 'http.network' || code.startsWith('http.network.')) {
    return 'UNREACHABLE';
  }
  if (status !== null) {
    if (status >= 500) return 'PROVIDER_ERROR';
    if (/\.(unreadable|unexpected_body|validation)/.test(code) || status < 300) {
      return 'BAD_RESPONSE';
    }
    return refusalKindOf(status, false);
  }
  return 'UNKNOWN';
}

/**
 * The failure a create outcome represents, or null when the customer got a usable
 * invoice. `invoiceForm` is the route descriptor's: a LINK route needs a link, a
 * CARD_TRANSFER route a card; a bot-sent invoice (Stars) needs neither.
 *
 * `final` says whether a RATE_LIMITED answer ends the attempt; a deferred one will be
 * asked again and is not a failure yet (it is never reported: a retry in progress is not
 * an error an operator can act on).
 */
export function paymentLinkFailureOf(
  outcome: GatewayCreateOutcome,
  invoiceForm: 'NONE' | 'LINK' | 'BOT_INVOICE' | 'CARD_TRANSFER',
  options: { readonly rateLimitIsFinal: boolean },
): PaymentLinkFailure | null {
  switch (outcome.kind) {
    case 'CREATED': {
      if (invoiceForm === 'LINK' && outcome.invoiceUrl === null && outcome.webInvoiceUrl === null) {
        return outcome.linkRejected === true
          ? failureOf('MALFORMED_LINK', PAYMENT_LINK_REJECTED_CODE, null, 'FINAL', 'CREATED')
          : failureOf('NO_LINK', 'nexa.no_payment_link', null, 'FINAL', 'CREATED');
      }
      if (invoiceForm === 'CARD_TRANSFER' && (outcome.instructions ?? null) === null) {
        return failureOf('NO_CARD', 'nexa.no_payment_card', null, 'FINAL', 'CREATED');
      }
      return null;
    }
    case 'REFUSED': {
      const status = safeHttpStatus(outcome.httpStatus) ?? httpStatusOfCode(outcome.code);
      return failureOf(
        refusalKindOf(status, outcome.configuration),
        outcome.code,
        status,
        'FINAL',
        'CREATE_FAILED',
      );
    }
    case 'RATE_LIMITED': {
      if (!options.rateLimitIsFinal) return null;
      const status = safeHttpStatus(outcome.httpStatus) ?? httpStatusOfCode(outcome.code);
      return failureOf('RATE_LIMITED', outcome.code, status, 'FINAL', 'CREATE_FAILED');
    }
    case 'AMBIGUOUS': {
      const status = safeHttpStatus(outcome.httpStatus) ?? httpStatusOfCode(outcome.code);
      return failureOf('UNKNOWN', outcome.code, status, 'UNKNOWN', 'CREATE_UNKNOWN');
    }
    case 'UNKNOWN': {
      const status = safeHttpStatus(outcome.httpStatus) ?? httpStatusOfCode(outcome.code);
      return failureOf(
        unknownKindOf(outcome.code, status),
        outcome.code,
        status,
        'UNKNOWN',
        'CREATE_UNKNOWN',
      );
    }
  }
}

/** A create Nexa itself could not make: no adapter, or no credential stored. */
export function paymentLinkConfigurationFailure(code: string): PaymentLinkFailure {
  return failureOf('CONFIGURATION', code, null, 'FINAL', 'CREATE_FAILED');
}

/** A create whose send was stamped and never answered (a worker died mid-call). */
export function paymentLinkInterruptedFailure(code: string): PaymentLinkFailure {
  return failureOf('UNKNOWN', code, null, 'UNKNOWN', 'CREATE_UNKNOWN');
}

/** The facts the event names beside the failure. Ids only; never a link, a key or a body. */
export interface PaymentLinkFailureFacts {
  readonly provider: PaymentGatewayProvider;
  readonly paymentId: string;
  readonly orderId: string | null;
  readonly providerOrderId: string;
  readonly providerInvoiceId: string | null;
  /**
   * The public tracking code, `paymentTrackingCode` of the payment's `reference` (FIX-02),
   * read through ONE call site (`GatewayPaymentService.reportLinkFailure`).
   */
  readonly trackingCode: string | null;
  readonly telegramUserId: string | null;
  readonly botInstanceId: string | null;
  readonly elapsedMs: number | null;
  readonly at: Date;
}

/** `payments.gateway_create_unknown`, kept for an UNKNOWN outcome: an operator's filter. */
export const GATEWAY_CREATE_UNKNOWN_EVENT_CODE = 'payments.gateway_create_unknown';

/**
 * The ONE event a payment-link failure produces.
 *
 * - UNKNOWN: `payments.gateway_create_unknown`, one row per payment, exactly as before —
 *   each such attempt may hold a provider invoice an operator may have to reconcile.
 * - FINAL: `payments.gateway_link_create_failed`, one row per gateway and failure kind per
 *   aggregation window: a storm (a gateway down, a key revoked) is one message an hour
 *   with its counter; each attempt's own audit row and `creation_error_code` keep every
 *   occurrence's evidence.
 */
export function paymentLinkFailureEvent(
  failure: PaymentLinkFailure,
  facts: PaymentLinkFailureFacts,
): OperationalEventInput {
  const unknown = failure.classification === 'UNKNOWN';
  const code = unknown ? GATEWAY_CREATE_UNKNOWN_EVENT_CODE : PAYMENT_LINK_CREATE_FAILED_CODE;
  const context: Record<string, unknown> = {
    phase: 'PAYMENT_LINK_CREATE',
    category: 'PAYMENTS',
    provider: facts.provider,
    method: 'GATEWAY',
    paymentId: facts.paymentId,
    providerOrderId: safeIdentifier(facts.providerOrderId),
    failureKind: failure.kind,
    // `reason` is the key the UNKNOWN event has always carried; kept for its readers.
    reason: failure.errorCode,
    errorCode: failure.errorCode,
    retryable: failure.retryable,
    classification: failure.classification,
    creationState: failure.creationState,
  };
  const orderId = safeIdentifier(facts.orderId);
  if (orderId !== null) context['orderId'] = orderId;
  const invoiceId = safeIdentifier(facts.providerInvoiceId);
  if (invoiceId !== null) context['providerInvoiceId'] = invoiceId;
  const trackingCode = safeIdentifier(facts.trackingCode, 64);
  if (trackingCode !== null) context['trackingCode'] = trackingCode;
  const telegramUserId = safeTelegramUserId(facts.telegramUserId);
  if (telegramUserId !== null) context['telegramUserId'] = telegramUserId;
  const botInstanceId = safeIdentifier(facts.botInstanceId);
  if (botInstanceId !== null) context['botInstanceId'] = botInstanceId;
  if (failure.httpStatus !== null) context['httpStatus'] = failure.httpStatus;
  if (facts.elapsedMs !== null) context['elapsedMs'] = facts.elapsedMs;

  return {
    code,
    severity: unknown ? 'WARN' : OPS_ERROR_CLASS_POLICY.ERROR.storedSeverity,
    message: unknown
      ? 'A payment gateway invoice may or may not have been created; nothing was charged ' +
        'through it by this installation, and it expires at its deadline.'
      : `A payment link could not be created (${facts.provider}, ${failure.kind}).`,
    dedupeKey: unknown
      ? `${code}:${facts.paymentId}`
      : opsAggregationKey(`${code}:${facts.provider}:${failure.kind}`, facts.at),
    context,
  };
}
