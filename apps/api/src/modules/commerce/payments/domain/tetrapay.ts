import {
  TETRAPAY_DAILY_LIMIT_TIME_ZONE,
  TETRAPAY_ORDER_ID_PATTERN,
  TETRAPAY_START_PARAM_PREFIX,
  type GatewayApprovalVerdict,
  type Money,
} from '@nexa/contracts';

/**
 * The TetraPay rules that decide anything, as pure functions (`docs/tetrapay-gateway-audit.md`).
 * `tests/unit/tetrapay-rules.test.ts` pins each, and the money ones are mutation-checked.
 */

// ---------------------------------------------------------------------------------------
// Rial and Toman — the ONE conversion.
// ---------------------------------------------------------------------------------------

/**
 * One Toman is ten Rial by definition: a unit, not an exchange rate. Every TetraPay amount is
 * in RIAL, Nexa sells in Toman, and this constant and the two functions below are the ONLY
 * place the factor appears. A second inline `* 10n` somewhere is a second answer to "how much
 * did we ask for", and the one that is wrong is invisible until a customer pays ten times too
 * little or too much.
 */
export const RIAL_PER_TOMAN = 10n;

/**
 * The rial a Toman figure is, or null for a figure that is not positive. Exact: x10.
 * `10000n` Toman is `100000n` rial.
 */
export function rialOfToman(toman: bigint): bigint | null {
  return toman > 0n ? toman * RIAL_PER_TOMAN : null;
}

/**
 * The Toman a rial figure is, or null. Exact: /10, and a rial figure that is not a multiple
 * of ten has no whole-Toman value and is REFUSED, never rounded — rounding would show or
 * credit a figure nobody was quoted.
 */
export function tomanOfRial(rial: bigint): bigint | null {
  return rial > 0n && rial % RIAL_PER_TOMAN === 0n ? rial / RIAL_PER_TOMAN : null;
}

/**
 * A payable in the sales currency, as the provider's RIAL amount, or null when it has no exact
 * one. `IRT` is Toman (x10); `IRR` is already rial, and one that is not a multiple of ten is
 * refused (the brief's rule: a rial figure TetraPay is sent is always a whole Toman).
 */
export function tetrapayAmountOf(amount: Money): bigint | null {
  switch (amount.currency) {
    case 'IRT':
      return rialOfToman(amount.amountMinor);
    case 'IRR':
      return tomanOfRial(amount.amountMinor) === null ? null : amount.amountMinor;
    default:
      return null;
  }
}

/** The wire form of a rial amount: a decimal numeric string, `100000n` → `"100000"`. */
export function rialWireString(rial: bigint): string {
  return rial.toString();
}

/**
 * A rial amount the provider sent, EXACTLY, or null: a decimal string of digits (a fractional
 * part of only zeros is accepted, `"100000.00"`), or a JSON integer. Anything else — a sign,
 * an exponent, a real fraction, a separator, an empty string, a float — is not an amount Nexa
 * can compare and is null, which is never read as a match.
 */
export function parseRialAmount(value: unknown): bigint | null {
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    text = String(value);
  } else {
    return null;
  }
  const match = /^(0|[1-9][0-9]{0,17})(?:\.0+)?$/u.exec(text);
  return match === null ? null : BigInt(match[1] ?? '0');
}

// ---------------------------------------------------------------------------------------
// The verdict — only verify decides.
// ---------------------------------------------------------------------------------------

/** What one verify answer says, reduced to what a verdict reads. Raw, judged here only. */
export interface TetraPayObservation {
  readonly status: unknown;
  readonly orderId: unknown;
  readonly amount: unknown;
  /** `payable_amount`: the order plus the fee share the payer bears (rial). */
  readonly payableAmount: unknown;
  /** `received_amount`: what was actually received; null until paid (rial). */
  readonly receivedAmount: unknown;
}

export interface TetraPayJudgement {
  readonly verdict: GatewayApprovalVerdict;
  /** Why a MISMATCH is one: a machine reason for the audit row and the operator's condition. */
  readonly mismatchReason: string | null;
}

/**
 * What a verify answer MEANS for Nexa (documentation §3.3, §6).
 *
 * `paid` is the ONE approval, and only when the answer names THIS attempt's `order_id`, EXACTLY
 * the rial `amount` Nexa asked for, and shows the money actually arrived: `received_amount`
 * present and not below `payable_amount` (a partial payment - `allow_partial` is never sent, but
 * the answer is checked, not assumed). Anything else about a `paid` answer is a MISMATCH: money
 * the provider says it holds that is not what this attempt invoiced - never settled, never
 * failed, held for an operator. What Nexa credits is always its own recorded principal, never a
 * provider figure. `created` and `pending` are still open; `expired` is the provider's definitive
 * "no"; a status the documentation does not name is recorded and treated as open.
 *
 * `verified_before` is deliberately not an input: whether this verify was the first is
 * informative only, and the exactly-once ledger key is what decides a repeat.
 */
export function tetrapayJudgement(
  observation: TetraPayObservation,
  expected: { readonly orderId: string; readonly sentAmount: bigint },
): TetraPayJudgement {
  switch (observation.status) {
    case 'paid': {
      if (typeof observation.orderId !== 'string') {
        return { verdict: 'MISMATCH', mismatchReason: 'PROVIDER_ORDER_ID_MISSING' };
      }
      if (observation.orderId !== expected.orderId) {
        return { verdict: 'MISMATCH', mismatchReason: 'PROVIDER_ORDER_ID_MISMATCH' };
      }
      const amount = parseRialAmount(observation.amount);
      if (amount === null) {
        return { verdict: 'MISMATCH', mismatchReason: 'PROVIDER_AMOUNT_UNREADABLE' };
      }
      if (amount !== expected.sentAmount) {
        return { verdict: 'MISMATCH', mismatchReason: 'PROVIDER_AMOUNT_MISMATCH' };
      }
      const received = parseRialAmount(observation.receivedAmount);
      const payable = parseRialAmount(observation.payableAmount);
      // The payer must have paid at least what the link asked of them (the order, plus the fee
      // share when the provider states one); a short or unstated receipt is held, not credited.
      if (received === null || received < (payable ?? amount) || received < amount) {
        return { verdict: 'MISMATCH', mismatchReason: 'PROVIDER_RECEIVED_SHORT' };
      }
      return { verdict: 'APPROVED', mismatchReason: null };
    }
    case 'expired':
      return { verdict: 'UNSUCCESSFUL', mismatchReason: null };
    default:
      return { verdict: 'OPEN', mismatchReason: null };
  }
}

// ---------------------------------------------------------------------------------------
// Identifiers.
// ---------------------------------------------------------------------------------------

/** Crockford base32, without the letters a person misreads. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SUFFIX_LENGTH = 6;
/** Bytes enough for the suffix at five bits each. */
export const TETRAPAY_ORDER_ID_RANDOM_BYTES = Math.ceil((SUFFIX_LENGTH * 5) / 8);

/**
 * A fresh provider `order_id` for ONE attempt: the payment's 8-character public code (what an
 * operator and a customer already quote) and a six-character random suffix — thirty random
 * bits, so two attempts of one code (tenants that share a TetraPay account share its order
 * namespace, `ORDER_CONFLICT`) never collide. 1-64 characters of `[A-Za-z0-9_.:-]`: the code
 * is cleaned to that alphabet, and a payment with no code yet gets `TP` in its place.
 * Generated ONCE per attempt, persisted before any call and never regenerated for it.
 */
export function tetrapayOrderId(paymentCode: string | null, random: Uint8Array): string {
  if (random.length < TETRAPAY_ORDER_ID_RANDOM_BYTES) {
    throw new Error(`tetrapayOrderId needs ${TETRAPAY_ORDER_ID_RANDOM_BYTES} random bytes`);
  }
  let bits = 0;
  let value = 0;
  let suffix = '';
  for (const byte of random) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && suffix.length < SUFFIX_LENGTH) {
      suffix += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
    if (suffix.length >= SUFFIX_LENGTH) break;
  }
  const code = (paymentCode ?? '').replace(/[^A-Za-z0-9]/gu, '').slice(0, 16);
  const id = `${code === '' ? 'TP' : code}-${suffix}`;
  if (!TETRAPAY_ORDER_ID_PATTERN.test(id)) throw new Error('a TetraPay order id has its shape');
  return id;
}

/** The `start` parameter the bot is returned with: `tp-<payment id>`, 40 of Telegram's 64. */
export function tetrapayStartParam(paymentId: string): string {
  return `${TETRAPAY_START_PARAM_PREFIX}${paymentId}`;
}

/** The payment id a `tp-<uuid>` start parameter names, or null. Nothing else in it is read. */
export function paymentIdOfTetrapayStart(payload: string): string | null {
  const match = new RegExp(
    `^${TETRAPAY_START_PARAM_PREFIX}([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$`,
    'u',
  ).exec(payload);
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * `https://t.me/<bot>?start=tp-<payment>` from the bot's link (`https://t.me/<bot>`). The
 * only `callback_url` Telegram attempts send; null when the bot has no link, which the
 * adapter refuses as the installation's configuration rather than sending a URL that returns
 * nobody to the bot.
 */
export function tetrapayCallbackUrl(botLink: string | null, paymentId: string): string | null {
  if (botLink === null) return null;
  return `${botLink}?start=${tetrapayStartParam(paymentId)}`;
}

// ---------------------------------------------------------------------------------------
// The daily limit — hidden until 00:00 Tehran.
// ---------------------------------------------------------------------------------------

/** The offset of Tehran from UTC at `at`, in ms, from the zone database (not a constant). */
function tehranOffsetMs(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TETRAPAY_DAILY_LIMIT_TIME_ZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const part = (type: string): number => Number(parts.find((one) => one.type === type)?.value);
  const local = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );
  return local - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The next 00:00 in Tehran strictly after `now` — when a daily limit stops hiding the route.
 * Computed from the zone, so a midnight is the right instant whatever the offset is.
 */
export function nextTehranMidnight(now: Date): Date {
  const offset = tehranOffsetMs(now);
  const local = new Date(now.getTime() + offset);
  const nextLocalMidnight = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() + 1,
  );
  // The offset AT that instant, in case the zone changes between now and then.
  const guess = nextLocalMidnight - offset;
  return new Date(nextLocalMidnight - tehranOffsetMs(new Date(guess)));
}
