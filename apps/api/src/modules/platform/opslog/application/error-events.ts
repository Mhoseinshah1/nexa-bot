import type {
  OperationalEventInput,
  OperationalEventRecorder,
  RecordedOperationalEvent,
  ScopeContext,
} from '@nexa/contracts';
import { redactOperatorText } from '../../../../infrastructure/redaction.js';

/**
 * FIX-04/05: the helpers every reporting site shares, so no site writes its own catch, its
 * own sanitiser or its own idea of what may reach the operations log group.
 *
 * The taxonomy — which code, which class, which dedupe — is the contract's
 * (`OPS_ERROR_EVENTS`); this file is the runtime half: making a value safe to print and
 * recording without ever failing the business operation that observed the failure.
 */

/** The longest machine code an event carries; `boundedCode` in the adapters uses the same. */
export const OPS_ERROR_CODE_MAX = 120;

/**
 * A machine error code as it may be printed: its first token only, through the
 * operator-text redactor (a secret, a URL or a card number that somehow reached a code is
 * redacted, not posted), then the adapters' own vocabulary (`[A-Za-z0-9_.:-]`) with
 * everything else replaced.
 */
export function sanitizedErrorCode(code: string): string {
  // A machine code is ONE token. Whatever follows whitespace is prose — possibly quoting
  // the request, and an unlabelled key in prose is the one thing no redactor can find —
  // so it is dropped before anything else looks at it.
  const token = code.trim().split(/\s/u, 1)[0] ?? '';
  const cleaned = redactOperatorText(token)
    .replace(/[^A-Za-z0-9_.:\-[\]]/g, '_')
    .slice(0, OPS_ERROR_CODE_MAX);
  return cleaned === '' ? 'unknown' : cleaned;
}

/**
 * An identifier as it may be printed, or null. Ids, references and order ids are drawn
 * from a small alphabet; anything outside it is not an id this code minted, so it is
 * dropped rather than cleaned up into something that looks like one.
 */
export function safeIdentifier(value: unknown, max = 100): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value);
  if (text.length === 0 || text.length > max) return null;
  if (!/^[A-Za-z0-9._:@-]+$/.test(text)) return null;
  // A digit run that is a card number is never an id we print.
  return redactOperatorText(text) === text ? text : null;
}

/** A Telegram numeric id, or null. Never a name, a username or a phone number. */
export function safeTelegramUserId(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value);
  return /^[0-9]{1,20}$/.test(text) ? text : null;
}

/** An HTTP status a provider actually answered with, or null. */
export function safeHttpStatus(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : null;
}

/** The HTTP status an adapter's machine code carries (`http.502`, `http.403.unreadable.html`). */
export function httpStatusOfCode(code: string): number | null {
  const match = /^http\.([1-5][0-9]{2})(?:$|[.:])/.exec(code);
  return match === null ? null : Number(match[1]);
}

/**
 * For a service built without a logger — a unit test of rules that never reach the log.
 * The composition root always passes the real one; this exists so an optional dependency
 * has one named default rather than a scattered `() => undefined` at each call site.
 */
export const UNWIRED_LOGGER: { warn: (context: Record<string, unknown>, message: string) => void } =
  { warn: () => undefined };

/**
 * Records an operational event and NEVER throws.
 *
 * The event reports a failure the caller has already handled; the caller's own outcome —
 * a payment failed, a customer blocked, a loop judged stalled — must not become a second
 * failure because the log could not be written. A failure here is logged with the code and
 * nothing else (the context may be what failed to serialise), and the caller carries on.
 * The projector behind the recorder already keeps the event when only its notification
 * fails; this covers the recorder itself failing.
 *
 * Never inside a caller's transaction, by signature: swallowing a failed statement there
 * would leave the caller holding an aborted transaction while this reported success.
 */
export async function recordQuietly(
  recorder: Pick<OperationalEventRecorder, 'record'>,
  scope: ScopeContext,
  event: OperationalEventInput,
  logger: { warn: (context: Record<string, unknown>, message: string) => void },
): Promise<RecordedOperationalEvent | null> {
  try {
    return await recorder.record(scope, event);
  } catch (error: unknown) {
    logger.warn(
      { code: event.code, error: error instanceof Error ? error.name : 'unknown' },
      'operational event could not be recorded; the operation it reports is unaffected',
    );
    return null;
  }
}
