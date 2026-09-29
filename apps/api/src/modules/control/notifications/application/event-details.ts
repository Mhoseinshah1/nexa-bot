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
export const DETAIL_KEYS: readonly string[] = [
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
 * The whole message's bound, and its parts (Codex review #1 of PR #99).
 *
 * Telegram refuses a message over 4096 characters, and a refusal is PERMANENT — the
 * event would be preserved unsent for ever for being too detailed. Thirty-odd keys at
 * 160 characters each could pass that alone, so the detail block and the event's own
 * message each get a budget, measured in HTML-ESCAPED characters (`&` is five on the
 * wire), leaving the rest of the template — code, severity, tenant, bot, correlation
 * id, times — well inside the limit. A line that would cross the budget is dropped and
 * a marker says how many were.
 */
export const TELEGRAM_MESSAGE_MAX = 4096;
export const OPERATIONAL_DETAILS_BUDGET = 1600;
export const OPERATIONAL_MESSAGE_BUDGET = 1500;
/** An id-like value printed beside the detail (correlation, tenant, bot). */
export const OPERATIONAL_ID_MAX = 100;

/**
 * The length `text` takes once the renderer HTML-escapes it — the five substitutions
 * `escapeTelegramHtml` in `@nexa/i18n` makes. Counted here rather than imported, because
 * application code does not import the text package (the boundary check says so); the
 * unit test renders through the real escaper and holds the two to one answer.
 */
const ESCAPED_WIDTH: Readonly<Record<string, number>> = {
  '&': 5,
  '<': 4,
  '>': 4,
  '"': 6,
  "'": 5,
};
const escapedLength = (text: string): number => {
  let length = 0;
  for (const character of text) length += ESCAPED_WIDTH[character] ?? character.length;
  return length;
};

/**
 * `text` cut so its HTML-escaped form fits `budget`, with `…` when anything was cut.
 * Never splits an escape: it cuts the raw text, one character at a time from the end.
 */
export function boundedForTelegram(text: string, budget: number): string {
  if (escapedLength(text) <= budget) return text;
  let end = Math.min(text.length, budget);
  while (end > 0 && escapedLength(text.slice(0, end)) + 1 > budget) end -= 1;
  return `${text.slice(0, end)}…`;
}

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
  if (lines.length === 0) return undefined;

  // Within the budget, in the allow-list's order — ids first, then the transition, then
  // the reason — with room kept for the marker.
  const marker = (dropped: number) => `… (+${String(dropped)} more)`;
  const kept: string[] = [];
  let used = 0;
  for (const [index, line] of lines.entries()) {
    const cost = escapedLength(line) + 1;
    const reserve = index < lines.length - 1 ? escapedLength(marker(lines.length)) + 1 : 0;
    if (used + cost + reserve > OPERATIONAL_DETAILS_BUDGET) {
      kept.push(marker(lines.length - index));
      break;
    }
    kept.push(line);
    used += cost;
  }
  return kept.join('\n');
}

/** A context's bot instance id, when it names one as a plain string. */
export function contextBotInstanceId(
  context: Record<string, unknown> | undefined,
): string | undefined {
  const value = context?.['botInstanceId'];
  return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value : undefined;
}
