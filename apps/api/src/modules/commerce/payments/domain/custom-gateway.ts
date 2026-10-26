import {
  CUSTOM_AMOUNT_UNIT,
  CUSTOM_GATEWAY_SIGNING_PREFIXES,
  CUSTOM_GATEWAY_STATUSES,
  CUSTOM_MONEY_VALUE_PATTERN,
  CUSTOM_ORDER_ID_PATTERN,
  CUSTOM_ORDER_ID_PREFIX,
  CUSTOM_REFERENCE_PATTERN,
  MAX_MONEY_AMOUNT_MINOR,
  type CustomGatewayStatus,
  type GatewayApprovalVerdict,
  type Money,
} from '@nexa/contracts';
import { rialOfToman } from './tetrapay.js';

/**
 * The custom-gateway rules that decide anything, as pure functions
 * (`docs/protocols/custom-gateway.md`). `tests/unit/custom-gateway-rules.test.ts` pins each, and
 * the money ones are mutation-checked (`docs/custom-gateway-falsification.md`).
 */

// ---------------------------------------------------------------------------------------
// Rial — the wire unit (protocol §2.2).
// ---------------------------------------------------------------------------------------

/**
 * A payable in the sales currency as the RIAL amount a bridge is sent, or null when it has no
 * exact one. `IRT` is Toman: x10 by TetraPay's `rialOfToman`, the ONE place the factor lives.
 * `IRR` is already rial and is sent as it is — the protocol puts divisibility by ten on the
 * bridge (`AMOUNT_NOT_PAYABLE`), never on a rounding here. Anything else is not priceable.
 */
export function customAmountOf(amount: Money): bigint | null {
  switch (amount.currency) {
    case 'IRT':
      return rialOfToman(amount.amountMinor);
    case 'IRR':
      return amount.amountMinor > 0n ? amount.amountMinor : null;
    default:
      return null;
  }
}

/** The wire form of a rial amount (§2.2): a decimal STRING in a Money object. */
export function customMoneyWire(rial: bigint): { value: string; currency: 'IRR' } {
  return { value: rial.toString(), currency: CUSTOM_AMOUNT_UNIT };
}

/**
 * A protocol Money object read EXACTLY, or null: `{ value: "<digits>", currency: "IRR" }`. A JSON
 * number, a sign, a decimal point, an exponent, a separator, a figure above the money column's
 * ceiling or any currency but IRR is not an amount Nexa can compare — null, never a match.
 */
export function parseCustomMoney(value: unknown): bigint | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const text = record['value'];
  if (record['currency'] !== CUSTOM_AMOUNT_UNIT) return null;
  if (typeof text !== 'string' || !CUSTOM_MONEY_VALUE_PATTERN.test(text)) return null;
  const parsed = BigInt(text);
  return parsed <= MAX_MONEY_AMOUNT_MINOR ? parsed : null;
}

// ---------------------------------------------------------------------------------------
// The verdict — only the inquiry decides (protocol §6).
// ---------------------------------------------------------------------------------------

/** One signed inquiry answer, reduced to what a verdict reads. Raw, judged here only. */
export interface CustomObservation {
  readonly invoiceId: unknown;
  readonly reference: unknown;
  readonly status: unknown;
  readonly amount: unknown;
  readonly amountPaid: unknown;
}

export interface CustomJudgement {
  readonly verdict: GatewayApprovalVerdict;
  /** Why a MISMATCH is one: a machine reason for the audit row and the operator's condition. */
  readonly mismatchReason: string | null;
}

/** Whether a bridge status is one of the six the protocol names. */
export function isCustomStatus(status: unknown): status is CustomGatewayStatus {
  return (
    typeof status === 'string' && (CUSTOM_GATEWAY_STATUSES as readonly string[]).includes(status)
  );
}

/**
 * What a signed inquiry answer MEANS for Nexa (protocol §6; lead decisions of Round 10).
 *
 * - `PAID` is the ONE approval, and only when the answer names THIS attempt's `invoice_id`, the
 *   bridge reference Nexa recorded (when it has one), and EXACTLY the rial amount Nexa asked for
 *   as both `amount` and `amount_paid`. Any other `PAID` is a MISMATCH: money the bridge says it
 *   holds that is not what this attempt invoiced — never settled, never failed, held for an
 *   operator (the payment goes UNKNOWN).
 * - `UNDERPAID` and `OVERPAID` are MISMATCHES too: money was captured and it is not the figure
 *   asked. An operator reconciles; nothing is credited automatically (`OQ-CG-03` for OVERPAID).
 * - `FAILED` and `EXPIRED` are the bridge's final "no" (§6: a terminal status never changes), so
 *   the attempt fails — unless the same answer says money WAS captured, which contradicts the
 *   status: held as a MISMATCH rather than failed, since failing it would lose track of money.
 * - `PENDING` and any status the protocol does not name are still OPEN; the deadline decides.
 *
 * What Nexa credits is always its own recorded principal, never a figure from the bridge.
 */
export function customJudgement(
  observation: CustomObservation,
  expected: {
    readonly orderId: string;
    /** The bridge's reference Nexa recorded, or null after a lost create (asked by order id). */
    readonly reference: string | null;
    readonly sentAmount: bigint;
  },
): CustomJudgement {
  const status = observation.status;
  if (!isCustomStatus(status) || status === 'PENDING') {
    return { verdict: 'OPEN', mismatchReason: null };
  }
  const amountPaid = parseCustomMoney(observation.amountPaid);
  if (status === 'FAILED' || status === 'EXPIRED') {
    return amountPaid !== null && amountPaid > 0n
      ? { verdict: 'MISMATCH', mismatchReason: 'PROVIDER_STATUS_CONTRADICTS_AMOUNT_PAID' }
      : { verdict: 'UNSUCCESSFUL', mismatchReason: null };
  }
  if (status === 'UNDERPAID') return { verdict: 'MISMATCH', mismatchReason: 'PROVIDER_UNDERPAID' };
  if (status === 'OVERPAID') return { verdict: 'MISMATCH', mismatchReason: 'PROVIDER_OVERPAID' };
  // PAID: every identity and both figures, exactly.
  if (observation.invoiceId !== expected.orderId) {
    return { verdict: 'MISMATCH', mismatchReason: 'PROVIDER_ORDER_ID_MISMATCH' };
  }
  if (!isSafeReference(observation.reference)) {
    return { verdict: 'MISMATCH', mismatchReason: 'PROVIDER_REFERENCE_MISSING' };
  }
  if (expected.reference !== null && observation.reference !== expected.reference) {
    return { verdict: 'MISMATCH', mismatchReason: 'PROVIDER_REFERENCE_MISMATCH' };
  }
  const amount = parseCustomMoney(observation.amount);
  if (amount === null || amount !== expected.sentAmount) {
    return { verdict: 'MISMATCH', mismatchReason: 'PROVIDER_AMOUNT_MISMATCH' };
  }
  if (amountPaid === null || amountPaid !== expected.sentAmount) {
    return { verdict: 'MISMATCH', mismatchReason: 'PROVIDER_AMOUNT_PAID_MISMATCH' };
  }
  return { verdict: 'APPROVED', mismatchReason: null };
}

// ---------------------------------------------------------------------------------------
// Identifiers.
// ---------------------------------------------------------------------------------------

/** Crockford base32, without the letters a person misreads. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ORDER_ID_CHARS = 26;
/** Bytes enough for 26 characters at five bits each (130 bits). */
export const CUSTOM_ORDER_ID_RANDOM_BYTES = 17;

/**
 * A fresh `invoice_id` for ONE attempt: `cg_` and 26 Crockford base32 characters of caller-given
 * randomness (130 bits), so attempts of tenants that share a bridge never collide. Generated
 * once per attempt, persisted before any call and never regenerated for it.
 */
export function customOrderId(random: Uint8Array): string {
  if (random.length < CUSTOM_ORDER_ID_RANDOM_BYTES) {
    throw new Error(`customOrderId needs ${CUSTOM_ORDER_ID_RANDOM_BYTES} random bytes`);
  }
  let value = 0n;
  for (let index = 0; index < CUSTOM_ORDER_ID_RANDOM_BYTES; index += 1) {
    value = (value << 8n) | BigInt(random[index] ?? 0);
  }
  let suffix = '';
  for (let index = 0; index < ORDER_ID_CHARS; index += 1) {
    suffix = (CROCKFORD[Number(value & 31n)] ?? '0') + suffix;
    value >>= 5n;
  }
  const id = `${CUSTOM_ORDER_ID_PREFIX}${suffix}`;
  if (!CUSTOM_ORDER_ID_PATTERN.test(id)) throw new Error('a custom invoice id has its shape');
  return id;
}

/** Whether a bridge reference is one Nexa may store and send back (§2.3). */
export function isSafeReference(value: unknown): value is string {
  return typeof value === 'string' && CUSTOM_REFERENCE_PATTERN.test(value);
}

// ---------------------------------------------------------------------------------------
// The signed strings (protocol §4, §5) — one secret, three prefixes.
// ---------------------------------------------------------------------------------------

/**
 * What Nexa signs for one request (§4): six lines joined by `\n`, no trailing newline. `path`
 * is the PROTOCOL path (`/v1/payments`), never the base URL's own prefix, so a bridge behind a
 * path prefix and one at the root verify the same string.
 */
export function customRequestStringToSign(input: {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly timestamp: string;
  readonly nonce: string;
  /** Lower-case hex SHA-256 of the raw body bytes (of the empty string for a GET). */
  readonly bodySha256: string;
}): string {
  return [
    CUSTOM_GATEWAY_SIGNING_PREFIXES.request,
    input.method,
    input.path,
    input.timestamp,
    input.nonce,
    input.bodySha256,
  ].join('\n');
}

/**
 * The text that precedes a bridge's raw body in what it signs (§5): its direction's prefix,
 * the header's `t`, and — for a RESPONSE — the nonce of the request it answers, so a recorded
 * answer can never be replayed as the answer to another request.
 */
export function customBridgeSignedPrefix(
  direction: 'response' | 'callback',
  t: string,
  requestNonce: string | null,
): string {
  return direction === 'response'
    ? `${CUSTOM_GATEWAY_SIGNING_PREFIXES.response}\n${t}\n${requestNonce ?? ''}\n`
    : `${CUSTOM_GATEWAY_SIGNING_PREFIXES.callback}\n${t}\n`;
}
