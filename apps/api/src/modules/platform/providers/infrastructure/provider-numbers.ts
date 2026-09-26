import type { ProviderAllowancePlan, ProviderFailureDetail, ProviderUsage } from '@nexa/contracts';

/**
 * A panel's numeric field, read once at the adapter boundary (WP15 G2, G5).
 *
 * RickPanel's document does not pin whether `expire`, `data_limit` and `used_traffic` are
 * JSON numbers or numeric strings, and the domain must never have to care. So every adapter
 * reads such a field through here, and what leaves is a `bigint` or a statement that the
 * field could not be read — never a raw `unknown` for a later layer to coerce.
 *
 * Accepted: a JSON number that is a safe, non-negative integer, or a string that is the
 * canonical decimal spelling of one (`0`, or no leading zero, no sign, no exponent, no
 * whitespace). Everything else is `MALFORMED`: a fraction, a negative, NaN or an infinity
 * (which JSON cannot carry but a lenient parser upstream might), `"1e9"`, `" 12"`, `"012"`,
 * and any integer past `Number.MAX_SAFE_INTEGER` or the caller's own bound. A value past
 * the safe range is refused rather than rounded: the whole reason for reading this field
 * is to compare it with a target exactly.
 *
 * `null` and a missing key are `ABSENT`, which is a different fact — whether an absent
 * field means "unlimited" or "the record is incomplete" is the caller's decision, per field.
 */
export type ProviderNumber =
  | { readonly kind: 'VALUE'; readonly value: bigint }
  | { readonly kind: 'ABSENT' }
  | { readonly kind: 'MALFORMED' };

const CANONICAL = /^(0|[1-9][0-9]{0,15})$/;
const SAFE_MAX = BigInt(Number.MAX_SAFE_INTEGER);

/** The last second of 9999-12-31 UTC; an `expire` past it is not a date anyone set. */
export const MAX_EPOCH_SECONDS = 253_402_300_799n;

export function readProviderNumber(value: unknown, max: bigint = SAFE_MAX): ProviderNumber {
  if (value === undefined || value === null) return { kind: 'ABSENT' };
  let parsed: bigint;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return { kind: 'MALFORMED' };
    parsed = BigInt(value);
  } else if (typeof value === 'string') {
    if (!CANONICAL.test(value)) return { kind: 'MALFORMED' };
    parsed = BigInt(value);
  } else {
    return { kind: 'MALFORMED' };
  }
  const bound = max < SAFE_MAX ? max : SAFE_MAX;
  return parsed > bound ? { kind: 'MALFORMED' } : { kind: 'VALUE', value: parsed };
}

/**
 * A Marzban-shaped user record's usage: `used_traffic`, `data_limit`, `expire` (G5).
 *
 * Marzban and RickPanel (Marzban-derived) both answer with these three fields, so both
 * adapters read them here and nowhere else.
 *
 * `used_traffic` ABSENT is `USAGE_FIELD_MISSING`, never zero: zero bytes used is what a
 * brand-new account looks like, so inventing it would hide a divergence, and the caller
 * reports "the record is there, its usage figure is not" — a different fact from "the
 * account is not there". `data_limit` and `expire` absent or zero are "no limit", as the
 * panels themselves fold them. `expire` is epoch SECONDS.
 */
export type RecordUsage =
  | { readonly ok: true; readonly usage: ProviderUsage }
  | { readonly ok: false; readonly detail: ProviderFailureDetail };

export function readRecordUsage(record: Readonly<Record<string, unknown>>): RecordUsage {
  const used = readProviderNumber(record['used_traffic']);
  if (used.kind === 'ABSENT') return { ok: false, detail: 'USAGE_FIELD_MISSING' };
  if (used.kind === 'MALFORMED') return { ok: false, detail: 'VALUE_MALFORMED' };
  const limit = readProviderNumber(record['data_limit']);
  const expire = readProviderNumber(record['expire'], MAX_EPOCH_SECONDS);
  if (limit.kind === 'MALFORMED' || expire.kind === 'MALFORMED') {
    return { ok: false, detail: 'VALUE_MALFORMED' };
  }
  return {
    ok: true,
    usage: {
      usedBytes: used.value,
      totalBytes: limit.kind === 'VALUE' && limit.value > 0n ? limit.value : null,
      expiresAt:
        expire.kind === 'VALUE' && expire.value > 0n ? new Date(Number(expire.value) * 1000) : null,
      lastSeen: { kind: 'UNSUPPORTED' },
    },
  };
}

/**
 * Did a Marzban-shaped record come back carrying what an allowance plan asked for?
 *
 * `MALFORMED` when a field the plan set cannot be read at all — a different answer from
 * `DIFFERENT`, which is a readable value that is not the target. Both sentinels fold as
 * the panel folds them: absent and zero are both "no limit". A field the plan did not set
 * is not checked, because the adapter did not send it.
 */
export function planApplied(
  record: Readonly<Record<string, unknown>>,
  plan: ProviderAllowancePlan,
): 'APPLIED' | 'DIFFERENT' | 'MALFORMED' {
  if (plan.expiresAt !== null) {
    const got = readProviderNumber(record['expire'], MAX_EPOCH_SECONDS);
    if (got.kind === 'MALFORMED') return 'MALFORMED';
    const wanted = BigInt(Math.floor(plan.expiresAt.getTime() / 1000));
    if ((got.kind === 'VALUE' ? got.value : 0n) !== wanted) return 'DIFFERENT';
  }
  if (plan.trafficLimitBytes !== null) {
    const got = readProviderNumber(record['data_limit']);
    if (got.kind === 'MALFORMED') return 'MALFORMED';
    if ((got.kind === 'VALUE' ? got.value : 0n) !== plan.trafficLimitBytes) return 'DIFFERENT';
  }
  return 'APPLIED';
}
