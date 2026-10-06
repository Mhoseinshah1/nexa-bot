import {
  SUPPORT_CONTEXT_GUIDE_MAX_CHARS,
  SUPPORT_CONTEXT_MAX_BYTES,
  SUPPORT_CONTEXT_TRUNCATION_ORDER,
  UNLIMITED_TRAFFIC_BYTES,
  type CurrencyCode,
  type SupportContextMoney,
  type SupportContextPayload,
} from '@nexa/contracts';

/**
 * TB3 — the pure half of the support context: aliases, the few derived numbers, the
 * string bounds and the byte budget. No I/O and no clock; the builder passes `now`.
 */

/**
 * `S1`, `O3`, `P2`: a per-payload name for a row, so the row's id never leaves the server.
 * `K1`…: a knowledge entry's name, which a decision cites in `knowledgeRefs`.
 */
export function aliasFor(prefix: 'S' | 'O' | 'P' | 'K', index: number): string {
  return `${prefix}${String(index + 1)}`;
}

/** Money as the payload carries it: decimal minor units and the currency, JSON-safe. */
export function moneyOf(amountMinor: bigint, currency: CurrencyCode): SupportContextMoney {
  return { amountMinor: amountMinor.toString(), currency };
}

/**
 * What is left of a finite allowance, as decimal bytes — or null when that is not a fact:
 * usage never read (`usageSyncedAt` null: unknown, never zero) or an unlimited allowance
 * (`UNLIMITED_TRAFFIC_BYTES`, stored as 0). Never below zero.
 */
export function remainingTrafficBytes(facts: {
  readonly trafficLimitBytes: bigint;
  readonly trafficUsedBytes: bigint;
  readonly usageSyncedAt: Date | null;
}): string | null {
  if (facts.usageSyncedAt === null) return null;
  if (facts.trafficLimitBytes === UNLIMITED_TRAFFIC_BYTES) return null;
  const left = facts.trafficLimitBytes - facts.trafficUsedBytes;
  return (left > 0n ? left : 0n).toString();
}

/**
 * A string cut to at most `max` UTF-16 units — the unit the schema's `.max()` counts —
 * never inside a surrogate pair, the cut marked with an ellipsis.
 */
export function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  let kept = '';
  for (const point of value) {
    if (kept.length + point.length > max - 1) break;
    kept += point;
  }
  return `${kept}…`;
}

export function clipGuide(guide: string): string {
  return clip(guide, SUPPORT_CONTEXT_GUIDE_MAX_CHARS);
}

/** The payload's size as it will be sent: UTF-8 bytes of its JSON. */
export function payloadBytes(payload: SupportContextPayload): number {
  return new TextEncoder().encode(JSON.stringify(payload)).length;
}

/**
 * The payload cut to `maxBytes` by dropping whole entries from the TAIL of each family,
 * family by family in `SUPPORT_CONTEXT_TRUNCATION_ORDER` — never a field from inside an
 * entry, so nothing that remains is a half-fact. Flags, the customer and the support
 * accounts are never cut; every family can be emptied, so the result always fits.
 */
export function fitPayload(
  payload: SupportContextPayload,
  maxBytes: number = SUPPORT_CONTEXT_MAX_BYTES,
): SupportContextPayload {
  let current = payload;
  for (const family of SUPPORT_CONTEXT_TRUNCATION_ORDER) {
    while (current[family].length > 0 && payloadBytes(current) > maxBytes) {
      current = { ...current, [family]: current[family].slice(0, -1) };
    }
    if (payloadBytes(current) <= maxBytes) return current;
  }
  return current;
}
