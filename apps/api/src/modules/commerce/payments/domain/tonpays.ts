import {
  TONPAYS_CONFIGURATION_ERROR_CODES,
  TONPAYS_ERROR_CODES,
  TONPAYS_ORDER_ID_MAX_LENGTH,
  type GatewayApprovalVerdict,
  type Money,
  type TonPaysErrorCode,
} from '@nexa/contracts';

/**
 * The TonPays rules that decide anything, as pure functions (WP11A,
 * `docs/tonpays-gateway-audit.md`).
 *
 * Pure for the reason `gateway-eligibility.ts` gives: these decide whether a person's
 * money counts, and a rule that can only be exercised through a network and a database
 * is a rule whose corners never get tested. `tests/unit/tonpays-rules.test.ts` pins each.
 */

/**
 * What an inquiry's `status` and `paid` MEAN for Nexa.
 *
 * `completed` AND `paid === true` is the one approval (brief §2). `paid` must be the
 * boolean `true` — not a truthy string, not `1` — because the only documented shape is a
 * JSON boolean, and a looser reading is a way to settle an order on a field nobody
 * documented.
 *
 * - `pending`, `processing`, `need_action` are still open (brief §4): no effect, keep
 *   asking until the attempt's deadline.
 * - `completed` without `paid === true` is NOT approved and stays open: the provider has
 *   not said the money arrived, and it may yet.
 * - `rejected`, `expired`, `canceled` are the provider's definitive "no".
 * - Anything else is a status the documentation does not name. It is recorded and
 *   treated as open, never guessed into an approval or a failure.
 */
export function tonpaysVerdict(status: string, paid: unknown): GatewayApprovalVerdict {
  switch (status) {
    case 'completed':
      return paid === true ? 'APPROVED' : 'OPEN';
    case 'rejected':
    case 'expired':
    case 'canceled':
      return 'UNSUCCESSFUL';
    default:
      return 'OPEN';
  }
}

/**
 * The payment's amount in TOMAN, or null when it has no exact Toman value.
 *
 * TonPays documents `amount` as an integer number of Toman. `IRT` is Toman in whole
 * units here; `IRR` is Rial, and one Toman is ten Rial by definition — a unit, not an
 * exchange rate — so an IRR amount converts only when it divides exactly. Rounding
 * would invoice a figure the customer was never quoted; any other currency has no
 * Toman value at all, and converting one would be the FX guess the money model refuses.
 */
export function tomanAmountOf(amount: Money): bigint | null {
  if (amount.amountMinor <= 0n) return null;
  switch (amount.currency) {
    case 'IRT':
      return amount.amountMinor;
    case 'IRR':
      return amount.amountMinor % 10n === 0n ? amount.amountMinor / 10n : null;
    default:
      return null;
  }
}

/** Crockford base32, without the letters a person misreads. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ORDER_ID_PREFIX = 'NX';
const ORDER_ID_RANDOM_CHARS = TONPAYS_ORDER_ID_MAX_LENGTH - ORDER_ID_PREFIX.length;
/** Bytes enough for the random characters at five bits each. */
export const TONPAYS_ORDER_ID_RANDOM_BYTES = Math.ceil((ORDER_ID_RANDOM_CHARS * 5) / 8);

/**
 * A fresh TonPays `order_id` for ONE attempt, from caller-supplied random bytes.
 *
 * Exactly twenty characters (the documented maximum): `NX` and eighteen Crockford
 * base32 characters, ninety random bits. Not derived from the payment id, the order id,
 * the customer or anything the customer typed — so it discloses nothing and cannot be
 * steered — and generated ONCE per attempt, persisted with the attempt before any call,
 * and never regenerated for it (brief §9: a `DUPLICATE_ORDER_ID` is not a reason to
 * re-key an attempt).
 */
export function tonpaysOrderId(random: Uint8Array): string {
  if (random.length < TONPAYS_ORDER_ID_RANDOM_BYTES) {
    throw new Error(`tonpaysOrderId needs ${TONPAYS_ORDER_ID_RANDOM_BYTES} random bytes`);
  }
  let bits = 0;
  let value = 0;
  let out = ORDER_ID_PREFIX;
  for (const byte of random) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < TONPAYS_ORDER_ID_MAX_LENGTH) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
    if (out.length >= TONPAYS_ORDER_ID_MAX_LENGTH) break;
  }
  return out;
}

/** How a documented TonPays error code is handled. `docs/tonpays-gateway-audit.md` §6. */
export type TonPaysErrorClass =
  /** The merchant's own configuration; never presented as the customer's payment. */
  | 'CONFIGURATION'
  /** Definitely not processed; may be asked again later, bounded. */
  | 'RATE_LIMITED'
  /** An invoice may already exist under this order id. Never re-keyed. */
  | 'AMBIGUOUS'
  /** The invoice id is not known to the provider. Recorded, never read as paid or failed. */
  | 'NOT_FOUND'
  /** The provider refused this invoice. */
  | 'REFUSED';

export function isTonPaysErrorCode(code: string): code is TonPaysErrorCode {
  return (TONPAYS_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * The class of a code the provider returned in `detail.code`.
 *
 * An UNDOCUMENTED code is `REFUSED` — a readable refusal the provider chose to send —
 * and is stored verbatim (bounded) for the operator, never mapped onto a documented one.
 */
export function classifyTonPaysError(code: string): TonPaysErrorClass {
  if ((TONPAYS_CONFIGURATION_ERROR_CODES as readonly string[]).includes(code)) {
    return 'CONFIGURATION';
  }
  switch (code) {
    case 'RATE_LIMIT_EXCEEDED':
      return 'RATE_LIMITED';
    case 'DUPLICATE_ORDER_ID':
      return 'AMBIGUOUS';
    case 'INVOICE_NOT_FOUND':
      return 'NOT_FOUND';
    default:
      return 'REFUSED';
  }
}

/**
 * When the NEXT background inquiry is due, after `attempts` completed ones.
 *
 * 20 s, 40 s, 80 s, 160 s, then every five minutes. Early answers matter most — a
 * customer who has just paid is waiting — and a lost webhook costs at most five minutes
 * after that. Over a seventy-minute attempt that is at most about seventeen calls, well
 * inside the documented sixty a minute even with many attempts open; a webhook or the
 * customer's check tap brings one forward, and the call budget bounds the total.
 */
export function inquiryBackoffMs(attempts: number): number {
  const base = 20_000;
  const cap = 300_000;
  if (attempts <= 0) return base;
  if (attempts >= 5) return cap;
  return Math.min(cap, base * 2 ** attempts);
}

/** The first inquiry after an invoice is created: long enough for a customer to open it. */
export const FIRST_INQUIRY_DELAY_MS = 20_000;

/** A rate-limited create is retried with the SAME order id, at most this many times. */
export const TONPAYS_CREATE_MAX_ATTEMPTS = 3;
export const TONPAYS_CREATE_RETRY_MS = 15_000;

/** A webhook or a customer tap brings an inquiry forward no sooner than this after the last. */
export const INQUIRY_MIN_SPACING_MS = 5_000;

/** Diagnostic inquiries after the deadline, each triggered by a webhook, never more. */
export const POST_DEADLINE_INQUIRY_MAX = 3;
