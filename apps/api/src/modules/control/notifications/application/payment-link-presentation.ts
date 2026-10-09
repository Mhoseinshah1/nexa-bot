import {
  PAYMENT_LINK_CAUSE_TOKENS,
  PAYMENT_LINK_FAILURE_KINDS,
  type PaymentLinkFailureKind,
  type TemplateValue,
} from '@nexa/contracts';
import {
  safeHttpStatus,
  safeIdentifier,
  safeTelegramUserId,
  sanitizedErrorCode,
} from '../../../platform/opslog/application/error-events.js';

/**
 * FIX-04: the values of `ops.notification.payment_link_failed`, from the event's context.
 *
 * Only an event the FIX-04 mapping built (`phase: PAYMENT_LINK_CREATE` and a known failure
 * kind) is laid out this way; anything else answers null and keeps the generic layout.
 *
 * An ALLOW-LIST again, like `operationalEventDetails`: every value is read from a named key
 * and re-checked here — an id against the id alphabet, the Telegram id as digits, the error
 * code through the operator-text redactor — so a context that somehow carried a link, a key
 * or a card number has nowhere to put it. Nothing the context holds is printed by default.
 */
export function paymentLinkFailureValues(
  context: Record<string, unknown> | undefined,
  frame: {
    readonly eventId: string;
    readonly at: Date;
    readonly tenantId: string;
    readonly botInstanceId?: string;
    readonly correlationId?: string;
  },
): Record<string, TemplateValue> | null {
  if (context === undefined || context === null) return null;
  if (context['phase'] !== 'PAYMENT_LINK_CREATE') return null;
  const kind = context['failureKind'];
  if (typeof kind !== 'string' || !(kind in PAYMENT_LINK_FAILURE_KINDS)) return null;
  const failureKind = kind as PaymentLinkFailureKind;
  const gateway = safeIdentifier(context['provider'], 40);
  if (gateway === null) return null;

  const values: Record<string, TemplateValue> = {
    gateway,
    phase: 'PAYMENT_LINK_CREATE',
    eventId: frame.eventId,
    // No counter (Codex P2 on #251): this is queued at the FIRST occurrence and never
    // updated, so a count here would read 1 for ever. The template says it is the first
    // and points at the notification centre, which reads the live `occurrence_count`.
    at: frame.at,
    tenantId: frame.tenantId,
  };
  const put = (token: string, value: string | null) => {
    if (value !== null) values[token] = value;
  };
  put('method', safeIdentifier(context['method'], 40));
  put('telegramUserId', safeTelegramUserId(context['telegramUserId']));
  put('trackingCode', safeIdentifier(context['trackingCode'], 64));
  put('paymentId', safeIdentifier(context['paymentId']));
  put('orderId', safeIdentifier(context['orderId']));
  put('providerOrderId', safeIdentifier(context['providerOrderId']));
  put('providerInvoiceId', safeIdentifier(context['providerInvoiceId']));
  put('botInstanceId', frame.botInstanceId ?? safeIdentifier(context['botInstanceId']));
  if (frame.correlationId !== undefined) values['correlationId'] = frame.correlationId;

  const errorCode = context['errorCode'] ?? context['reason'];
  values[PAYMENT_LINK_CAUSE_TOKENS[failureKind]] =
    typeof errorCode === 'string' ? sanitizedErrorCode(errorCode) : failureKind;
  const status = safeHttpStatus(context['httpStatus']);
  if (status !== null) values['httpStatus'] = String(status);

  // Flags: the empty string keeps the line; the renderer drops the other.
  const retryable =
    typeof context['retryable'] === 'boolean'
      ? context['retryable']
      : PAYMENT_LINK_FAILURE_KINDS[failureKind].retryable;
  values[retryable ? 'retryable' : 'notRetryable'] = '';

  const state = safeIdentifier(context['creationState'], 40) ?? 'UNKNOWN';
  values[context['classification'] === 'UNKNOWN' ? 'unknownState' : 'finalState'] = state;
  return values;
}
