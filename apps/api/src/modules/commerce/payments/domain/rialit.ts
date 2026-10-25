import {
  RIALIT_AMOUNT_MAX_TOMAN,
  RIALIT_AMOUNT_MIN_TOMAN,
  RIALIT_AMOUNT_OUT_OF_RANGE_STORED,
  RIALIT_LINK_LIFETIME_MINUTES,
  RIALIT_ORDER_ID_MAX_BYTES,
  RIALIT_ORDER_ID_PATTERN,
  RIALIT_PAY_PAGE_BASE,
  RIALIT_TOKEN_PATTERN,
  type GatewayApprovalVerdict,
  type Money,
} from '@nexa/contracts';
import { tomanAmountOf } from './tonpays.js';

/**
 * The Rialit rules that decide anything, as pure functions (`docs/rialit-gateway-audit.md`).
 * `tests/unit/rialit-rules.test.ts` pins each, and the money ones are mutation-checked.
 */

// ---------------------------------------------------------------------------------------
// Toman — Rialit's unit.
// ---------------------------------------------------------------------------------------

/**
 * A payable in the sales currency as Rialit's TOMAN, or null when it has none: `IRT` as is,
 * `IRR` only when it is a whole number of Toman (refused, never rounded). The one conversion,
 * TonPays' rule, so the two Toman routes can never disagree about a figure.
 */
export function rialitAmountOf(amount: Money): bigint | null {
  return tomanAmountOf(amount);
}

/**
 * The stored refusal for a Toman amount outside Rialit's documented range, or null when it is
 * inside: `rialit.AMOUNT_OUT_OF_RANGE:<min>:<max>`. Applied to what Nexa SENDS — the payable,
 * principal plus Nexa's customer fee — so a principal inside the range whose fee pushes it out
 * is refused here, before any call, rather than by Rialit after the attempt exists there.
 */
export function rialitAmountRefusal(toman: bigint): string | null {
  if (toman >= RIALIT_AMOUNT_MIN_TOMAN && toman <= RIALIT_AMOUNT_MAX_TOMAN) return null;
  return `${RIALIT_AMOUNT_OUT_OF_RANGE_STORED}:${RIALIT_AMOUNT_MIN_TOMAN.toString()}:${RIALIT_AMOUNT_MAX_TOMAN.toString()}`;
}

/**
 * A Toman amount Rialit sent, EXACTLY, or null: a JSON integer (the documented type), or a
 * string of decimal digits. A sign, a fraction, an exponent, a float, an empty string or a
 * value past 18 digits is not an amount Nexa can compare and is null, never read as a match.
 */
export function parseTomanAmount(value: unknown): bigint | null {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    text = String(value);
  } else if (typeof value === 'string') {
    text = value;
  } else {
    return null;
  }
  return /^(0|[1-9][0-9]{0,17})$/u.test(text) ? BigInt(text) : null;
}

// ---------------------------------------------------------------------------------------
// The fee — only ONE side charges the customer, never both.
// ---------------------------------------------------------------------------------------

/** What the create's payer figures allow (see `rialitPayerCheck`). */
export type RialitPayerCheck =
  | { readonly kind: 'OK'; readonly payerFee: bigint; readonly payerAmount: bigint }
  | { readonly kind: 'DOUBLE_FEE' }
  | { readonly kind: 'MISMATCH' }
  | { readonly kind: 'UNREADABLE' };

/**
 * Whether a create answer may be handed to the customer, by its payer figures (owner rule,
 * Round 9: only ONE side may charge a fee, never both).
 *
 * Nexa sends `amount` = the payable it quoted (principal plus its OWN gateway customer fee).
 * Rialit adds the merchant's payer fee from its dashboard, and the payer pays `payer_amount`.
 *
 * - `payer_amount` must be exactly `amount + payer_fee`, and `amount` exactly what Nexa sent;
 *   otherwise what the customer would pay is not a figure Nexa can show: `MISMATCH`.
 * - Nexa's fee above zero AND a payer fee above zero: the customer would pay two fees:
 *   `DOUBLE_FEE`. The link is never shown; the owner zeroes one of them.
 * - Nexa's fee zero and a payer fee above zero: only Rialit charges. Allowed, and the
 *   customer is shown `payer_amount` (display only — Nexa settles and credits its principal,
 *   and a provider's fee is never credited or refunded).
 * - No payer fee: the normal case.
 *
 * Figures that cannot be read are refused (`UNREADABLE`): what the customer would pay is unknown.
 */
export function rialitPayerCheck(
  answer: { readonly amount: unknown; readonly payerAmount: unknown; readonly payerFee: unknown },
  sentAmount: bigint,
  nexaFeeCharged: boolean,
): RialitPayerCheck {
  const payerFee = parseTomanAmount(answer.payerFee);
  const payerAmount = parseTomanAmount(answer.payerAmount);
  const amount = parseTomanAmount(answer.amount);
  if (payerFee === null || payerAmount === null || amount === null) return { kind: 'UNREADABLE' };
  if (amount !== sentAmount || payerAmount !== amount + payerFee) return { kind: 'MISMATCH' };
  if (nexaFeeCharged && payerFee > 0n) return { kind: 'DOUBLE_FEE' };
  return { kind: 'OK', payerFee, payerAmount };
}

// ---------------------------------------------------------------------------------------
// The verdict — only `GET /status/{token}` decides.
// ---------------------------------------------------------------------------------------

/** What one status answer says, reduced to what a verdict reads. Raw, judged here only. */
export interface RialitObservation {
  readonly status: unknown;
  readonly orderId: unknown;
  readonly amount: unknown;
  readonly payerAmount: unknown;
  readonly payerFee: unknown;
}

export interface RialitJudgement {
  readonly verdict: GatewayApprovalVerdict;
  /** Why a MISMATCH is one: a machine reason for the audit row and the operator's condition. */
  readonly mismatchReason: string | null;
}

/**
 * What a status answer MEANS for Nexa (document: "Payment statuses", "Status rules").
 *
 * `paid` is the ONE approval, and only when the answer names THIS attempt's `order_id`,
 * EXACTLY the Toman `amount` Nexa asked for, and a `payer_amount` that is exactly `amount +
 * payer_fee` (a fee Rialit alone charged was checked against Nexa's at create; it is the
 * payer's cost and is never credited). Anything else about a `paid` answer is a MISMATCH — money Rialit says it holds
 * that is not what this attempt invoiced — never settled, never failed, held for an operator.
 * What Nexa credits is always its own recorded principal, never a provider figure.
 *
 * `expired` and `cancelled` are NOT failures: the document says Rialit support can still mark
 * either `paid` later and that the merchant must accept it. Read as OPEN, the attempt stays
 * open until Nexa's OWN deadline expires it — and an EXPIRED payment is one the late-credit
 * path may still credit, where a FAILED one is closed for good. `pending` (which can outlive
 * the link) and a status the document does not name are open too.
 */
export function rialitJudgement(
  observation: RialitObservation,
  expected: { readonly orderId: string; readonly sentAmount: bigint },
): RialitJudgement {
  if (observation.status !== 'paid') return { verdict: 'OPEN', mismatchReason: null };
  if (typeof observation.orderId !== 'string') {
    return { verdict: 'MISMATCH', mismatchReason: 'PROVIDER_ORDER_ID_MISSING' };
  }
  if (observation.orderId !== expected.orderId) {
    return { verdict: 'MISMATCH', mismatchReason: 'PROVIDER_ORDER_ID_MISMATCH' };
  }
  const amount = parseTomanAmount(observation.amount);
  if (amount === null) {
    return { verdict: 'MISMATCH', mismatchReason: 'PROVIDER_AMOUNT_UNREADABLE' };
  }
  if (amount !== expected.sentAmount) {
    return { verdict: 'MISMATCH', mismatchReason: 'PROVIDER_AMOUNT_MISMATCH' };
  }
  const payerFee = parseTomanAmount(observation.payerFee);
  const payerAmount = parseTomanAmount(observation.payerAmount);
  if (payerFee === null || payerAmount === null) {
    return { verdict: 'MISMATCH', mismatchReason: 'PROVIDER_PAYER_AMOUNT_UNREADABLE' };
  }
  if (payerAmount !== amount + payerFee) {
    return { verdict: 'MISMATCH', mismatchReason: 'PROVIDER_PAYER_AMOUNT_MISMATCH' };
  }
  return { verdict: 'APPROVED', mismatchReason: null };
}

// ---------------------------------------------------------------------------------------
// Identifiers and the link.
// ---------------------------------------------------------------------------------------

/** Crockford base32, without the letters a person misreads. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SUFFIX_LENGTH = 8;
/** Bytes enough for the suffix at five bits each. */
export const RIALIT_ORDER_ID_RANDOM_BYTES = Math.ceil((SUFFIX_LENGTH * 5) / 8);

/**
 * A fresh Rialit `order_id` for ONE attempt: the payment's public code (what an operator and a
 * customer already quote) and an eight-character random suffix — forty random bits, so two
 * attempts of one code, or two tenants sharing a Rialit merchant (one `order_id` namespace,
 * `409`), never collide. Only `[A-Za-z0-9_.:-]`, at most 64 bytes. Generated ONCE per attempt,
 * persisted before any call and never regenerated: it is the create's idempotency key at
 * Rialit, and a lost answer is never re-keyed.
 */
export function rialitOrderId(paymentCode: string | null, random: Uint8Array): string {
  if (random.length < RIALIT_ORDER_ID_RANDOM_BYTES) {
    throw new Error(`rialitOrderId needs ${String(RIALIT_ORDER_ID_RANDOM_BYTES)} random bytes`);
  }
  let suffix = '';
  let value = 0;
  let bits = 0;
  for (const byte of random) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5 && suffix.length < SUFFIX_LENGTH) {
      suffix += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (suffix.length >= SUFFIX_LENGTH) break;
  }
  const code = (paymentCode ?? '').replace(/[^A-Za-z0-9]/gu, '').slice(0, 16);
  const id = `${code === '' ? 'RL' : code}-${suffix}`;
  // ASCII only, so the length IS the byte count Rialit bounds.
  if (!RIALIT_ORDER_ID_PATTERN.test(id) || id.length > RIALIT_ORDER_ID_MAX_BYTES) {
    throw new Error('a Rialit order id has its shape');
  }
  return id;
}

/** The payment page of a token (`https://pay.rialit.io/v1/{token}`), or null for an unsafe token. */
export function rialitPayPageUrl(token: string): string | null {
  return RIALIT_TOKEN_PATTERN.test(token) ? `${RIALIT_PAY_PAGE_BASE}${token}` : null;
}

/**
 * Until when the customer can pay on the link: thirty minutes after Rialit created it, never
 * after the attempt's own deadline. What the invoice screen shows as the deadline to pay, so
 * the customer is never told seventy minutes for a link that lives thirty.
 */
export function rialitLinkDeadline(createdAt: Date, attemptDeadline: Date | null): Date {
  const link = new Date(createdAt.getTime() + RIALIT_LINK_LIFETIME_MINUTES * 60_000);
  return attemptDeadline !== null && attemptDeadline.getTime() < link.getTime()
    ? attemptDeadline
    : link;
}
