import type {
  ProviderAllowancePlan,
  ProviderFailureDetail,
  ProviderLastSeen,
  ProviderUsage,
} from '@nexa/contracts';

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
 *
 * `online_at` is read by `readLastSeen` ONLY when the caller says its provider's spelling
 * of it is evidenced (`lastSeen: 'ONLINE_AT'`); otherwise the record's `online_at` is not
 * looked at and the answer is UNSUPPORTED. Marzban passes `ONLINE_AT` (v0.8.4's source);
 * RickPanel passes `NOT_READ` until its real-panel A9 runs (OQ-LC-02). Either way it is
 * telemetry and never fails the usage read.
 */
export interface RecordUsageOptions {
  readonly lastSeen: 'ONLINE_AT' | 'NOT_READ';
}

/** Marzban v0.8.4: `online_at` is read (source-evidenced naive UTC; A9 NOT RUN). */
export const MARZBAN_USAGE: RecordUsageOptions = { lastSeen: 'ONLINE_AT' };

/**
 * RickPanel: `online_at` is NOT read (lead decision, C1 review). The document lists it only
 * in the modify body, untyped, and a panel writing naive TEHRAN time would put a time
 * three and a half hours in the future on the card. Flip to `ONLINE_AT` in the commit that
 * records a passing real-panel A9 (`docs/open-questions.md` OQ-LC-02).
 */
export const RICKPANEL_USAGE: RecordUsageOptions = { lastSeen: 'NOT_READ' };

export type RecordUsage =
  | { readonly ok: true; readonly usage: ProviderUsage }
  | { readonly ok: false; readonly detail: ProviderFailureDetail };

export function readRecordUsage(
  record: Readonly<Record<string, unknown>>,
  options: RecordUsageOptions,
): RecordUsage {
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
      lastSeen: options.lastSeen === 'ONLINE_AT' ? readLastSeen(record) : { kind: 'UNSUPPORTED' },
    },
  };
}

/**
 * A Marzban-shaped record's last connection: `online_at` (C1).
 *
 * The evidence, read from Gozargah/Marzban v0.8.4's source (`docs/providers/marzban.md`):
 * `UserResponse.online_at: Optional[datetime]` (`app/models/user.py`), a nullable
 * `DateTime` column (`app/db/models.py`) that `app/jobs/record_usages.py` sets to
 * `datetime.utcnow()` — a NAIVE UTC time — whenever xray reports traffic for the user. So
 * the panel emits it as `2026-10-06T08:30:00` or `2026-10-06T08:30:00.123456`, with no
 * offset, and never wrote one at all for an account nobody has used: `null`. Not yet read
 * off a real panel (`docs/real-panel-acceptance.md`, A9 NOT RUN). RickPanel's only
 * evidence is the owner's OpenAPI property list for the PUT (modify) BODY, every property
 * typed `"string"` — nothing about the GET response or its time zone — so RickPanel does
 * not call this yet (OQ-LC-02).
 *
 * A time later than the read is not refused here, because this layer has no clock: the
 * service repository refuses one more than five minutes after the Clock's read time
 * (`boundedLastSeen`).
 *
 * - key ABSENT → `UNSUPPORTED`: this panel does not say, which is a different fact from
 *   "never" and renders «در دسترس نیست»;
 * - `null` → `NEVER`: the panel saying the account has never connected;
 * - an ISO 8601 date-time → `AT`. No offset is UTC, as the panel wrote it; `Z` or an
 *   explicit `±hh:mm` is honoured, so a panel that does carry one is not shifted;
 * - anything else — a number, a date without a time, an impossible date, a year before
 *   2000 — is `UNSUPPORTED`. Never a guess, never another timestamp in its place, and
 *   never a failure of the usage read it travels with.
 */
const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})?$/;

/** No Marzban-lineage panel existed before this; an earlier "last connection" is not one. */
const EARLIEST_LAST_SEEN_YEAR = 2000;

export function readLastSeen(record: Readonly<Record<string, unknown>>): ProviderLastSeen {
  if (!Object.prototype.hasOwnProperty.call(record, 'online_at')) return { kind: 'UNSUPPORTED' };
  const raw = record['online_at'];
  if (raw === null) return { kind: 'NEVER' };
  const at = typeof raw === 'string' ? parseIsoDateTime(raw) : null;
  return at === null ? { kind: 'UNSUPPORTED' } : { kind: 'AT', at };
}

function parseIsoDateTime(value: string): Date | null {
  const match = ISO_DATE_TIME.exec(value);
  if (match === null) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (year < EARLIEST_LAST_SEEN_YEAR) return null;
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const millis = Number((match[7] ?? '').padEnd(3, '0').slice(0, 3));
  const wall = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  // `Date.UTC` rolls 31 February into March; a date the calendar does not have is garbage.
  const check = new Date(wall);
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  const zone = match[8];
  let offsetMinutes = 0;
  if (zone !== undefined && zone !== 'Z') {
    const hours = Number(zone.slice(1, 3));
    const minutes = Number(zone.slice(4, 6));
    if (hours > 14 || minutes > 59) return null;
    offsetMinutes = (zone.startsWith('-') ? -1 : 1) * (hours * 60 + minutes);
  }
  return new Date(wall - offsetMinutes * 60_000);
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
