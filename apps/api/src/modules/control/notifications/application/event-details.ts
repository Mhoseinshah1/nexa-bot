import { redactSecrets, redactSecretText } from '../../../../infrastructure/redaction.js';

/**
 * The detail an operational event may carry into the operations log group (WP-A4).
 *
 * An ALLOW-LIST, not a deny-list. An event's `context` is whatever its recorder chose to
 * put there, and the log group is a Telegram chat that several people read and that
 * Telegram keeps for ever — so the question asked here is "is this a field we know to be
 * safe to print", never "does this look like a secret". A new context key is not shown
 * until somebody adds it to this list, which is the cheap direction to be wrong in.
 *
 * What is allowed is what an operator needs to investigate: which tenant, bot, customer,
 * service, order, payment, panel or operation; which state it moved between; and why.
 * What never is: a token, a credential, a subscription link, a card number, a provider
 * payload — none of those is a key here, and every VALUE is still passed through both
 * redactors, so a reason string that happens to quote a URL with a token in it is
 * redacted rather than posted.
 */
const DETAIL_KEYS: readonly string[] = [
  // Who and what.
  'userId',
  'customerId',
  'telegramUserId',
  'adminId',
  'serviceId',
  'orderId',
  'paymentId',
  'refundId',
  'requestId',
  'invoiceId',
  'providerInvoiceId',
  'panelId',
  'operationId',
  'notificationId',
  'backupRunId',
  'recoveryId',
  'updateId',
  'provider',
  'method',
  'kind',
  // The transition.
  'from',
  'to',
  'fromState',
  'toState',
  'state',
  'status',
  // Why.
  'reason',
  'cause',
  'errorCode',
  'error',
  'outcome',
  'attempt',
  'attemptNumber',
  'httpStatus',
];

/** How much of any one value is printed. An id is 36 characters; a reason, a sentence. */
const VALUE_MAX = 160;

/**
 * `name: value` lines for the allowed keys the context carries, in the allow-list's
 * order, or undefined when there are none (so the template drops the line).
 *
 * Only strings, finite numbers and booleans are printed. An object or an array is a
 * structure somebody built from a provider or a request, which is exactly what must not
 * be copied into a chat, so it is skipped rather than serialised.
 */
export function operationalEventDetails(
  context: Record<string, unknown> | undefined,
): string | undefined {
  if (context === undefined || context === null) return undefined;
  // The key rule first, over the whole record, so a value nested under a sensitive key
  // can never be reached below even by a future change to the allow-list.
  const redacted = redactSecrets(context) as Record<string, unknown>;
  const lines: string[] = [];
  for (const key of DETAIL_KEYS) {
    const value = redacted[key];
    let text: string | null = null;
    if (typeof value === 'string') text = value;
    else if (typeof value === 'number' && Number.isFinite(value)) text = String(value);
    else if (typeof value === 'boolean') text = value ? 'true' : 'false';
    if (text === null) continue;
    const cleaned = redactSecretText(text).replace(/\s+/g, ' ').trim().slice(0, VALUE_MAX);
    if (cleaned === '') continue;
    lines.push(`${key}: ${cleaned}`);
  }
  return lines.length === 0 ? undefined : lines.join('\n');
}

/** A context's bot instance id, when it names one as a plain string. */
export function contextBotInstanceId(
  context: Record<string, unknown> | undefined,
): string | undefined {
  const value = context?.['botInstanceId'];
  return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value : undefined;
}
