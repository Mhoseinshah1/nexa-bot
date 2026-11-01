import {
  money,
  SUPPORT_CONTEXT_GUIDE_MAX_CHARS,
  SUPPORT_CONTEXT_KNOWLEDGE_RESERVE_BYTES,
  SUPPORT_CONTEXT_MAX_BYTES,
  SUPPORT_CONTEXT_TRUNCATION_ORDER,
  UNLIMITED_TRAFFIC_BYTES,
  type CurrencyCode,
  type SupportContextMoney,
  type SupportContextPayload,
} from '@nexa/contracts';
import { formatBytes, formatDateOnly, formatMoney, type TemplatePresentation } from '@nexa/i18n';

/**
 * TB3 — the pure half of the support context: aliases, the few derived numbers, the
 * string bounds and the byte budget. No I/O and no clock; the builder passes `now`.
 */

/**
 * `S1`, `O3`, `P2`: a per-payload name for a row, so the row's id never leaves the server.
 * `K1`…: a knowledge entry's name, which a decision cites in `knowledgeRefs`.
 */
export function aliasFor(prefix: 'S' | 'O' | 'P' | 'K' | 'C', index: number): string {
  return `${prefix}${String(index + 1)}`;
}

/**
 * Money as the payload carries it: decimal minor units and the currency, JSON-safe, and (Phase 4
 * PR-2) the amount as the bot's one money formatter renders it («150,000 تومان»).
 */
export function moneyOf(amountMinor: bigint, currency: CurrencyCode): SupportContextMoney {
  return {
    amountMinor: amountMinor.toString(),
    currency,
    formatted: formatMoney(money(amountMinor, currency)),
  };
}

/** Phase 4 PR-2: the few Persian words the precomputed account facts are written in. */
export const ACCOUNT_FACT_WORDS = {
  updated: 'به‌روزشده',
  ago: 'پیش',
  justNow: 'به‌روزشده همین الان',
  minute: 'دقیقه',
  hour: 'ساعت',
  day: 'روز',
} as const;

/**
 * Phase 4 PR-2 — the account facts a model must never compute itself, from the service row, the
 * clock and the tenant's presentation (zone and calendar):
 *
 * - `remainingTraffic`: what is left, in gigabytes (`formatBytes`), null exactly when
 *   `remainingTrafficBytes` is null (usage never read, or unlimited);
 * - `daysLeft`: whole days until the expiry, rounded UP (a service expiring in 3 hours has 1 day
 *   left), 0 once past it, null without an expiry;
 * - `expiresOn`: the expiry date in the tenant's calendar («1405/08/20»);
 * - `usageAge`: how old the usage figure is, «به‌روزشده 5 دقیقه پیش», null when never read.
 */
export function accountFacts(
  facts: {
    readonly trafficLimitBytes: bigint;
    readonly trafficUsedBytes: bigint;
    readonly usageSyncedAt: Date | null;
    readonly expiresAt: Date | null;
  },
  now: Date,
  presentation: TemplatePresentation,
): {
  readonly remainingTraffic: string | null;
  readonly daysLeft: number | null;
  readonly expiresOn: string | null;
  readonly usageAge: string | null;
} {
  const remaining = remainingTrafficBytes(facts);
  const left = facts.expiresAt === null ? null : facts.expiresAt.getTime() - now.getTime();
  return {
    remainingTraffic: remaining === null ? null : formatBytes(BigInt(remaining)),
    daysLeft: left === null ? null : left <= 0 ? 0 : Math.ceil(left / 86_400_000),
    expiresOn: facts.expiresAt === null ? null : formatDateOnly(facts.expiresAt, presentation),
    usageAge: facts.usageSyncedAt === null ? null : usageAgeText(facts.usageSyncedAt, now),
  };
}

/** «به‌روزشده 5 دقیقه پیش» / «… 3 ساعت پیش» / «… 2 روز پیش»; under a minute «… همین الان». */
export function usageAgeText(syncedAt: Date, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - syncedAt.getTime()) / 60_000));
  const w = ACCOUNT_FACT_WORDS;
  if (minutes < 1) return w.justNow;
  if (minutes < 60) return `${w.updated} ${String(minutes)} ${w.minute} ${w.ago}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${w.updated} ${String(hours)} ${w.hour} ${w.ago}`;
  return `${w.updated} ${String(Math.floor(hours / 24))} ${w.day} ${w.ago}`;
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

/** UTF-8 bytes of one family's JSON: how much of the budget it holds. */
function familyBytes(entries: readonly unknown[]): number {
  return new TextEncoder().encode(JSON.stringify(entries)).length;
}

/**
 * The payload cut to `maxBytes` by dropping whole entries from the TAIL of each family,
 * family by family in `SUPPORT_CONTEXT_TRUNCATION_ORDER` — never a field from inside an
 * entry, so nothing that remains is a half-fact. Flags, the customer and the support
 * accounts are never cut; every family can be emptied, so the result always fits.
 *
 * D2: knowledge, in its turn, is cut only down to `knowledgeReserve` bytes — and never below
 * its first entry, the most relevant one. What is left of it gives way only after every other
 * family is empty.
 */
export function fitPayload(
  payload: SupportContextPayload,
  maxBytes: number = SUPPORT_CONTEXT_MAX_BYTES,
  knowledgeReserve: number = SUPPORT_CONTEXT_KNOWLEDGE_RESERVE_BYTES,
): SupportContextPayload {
  let current = payload;
  const fits = () => payloadBytes(current) <= maxBytes;
  if (fits()) return current;
  /*
   * Phase 4 PR-2: an app's long guide text gives way before any app does — its official and
   * help links are never cut while the app is listed. From the tail, one guide at a time.
   */
  for (let index = current.clientApps.length - 1; index >= 0 && !fits(); index -= 1) {
    if (current.clientApps[index]?.guide === '') continue;
    current = {
      ...current,
      clientApps: current.clientApps.map((app, at) => (at === index ? { ...app, guide: '' } : app)),
    };
  }
  for (const family of SUPPORT_CONTEXT_TRUNCATION_ORDER) {
    const keep =
      family === 'knowledge'
        ? () => current.knowledge.length <= 1 || familyBytes(current.knowledge) <= knowledgeReserve
        : () => current[family].length === 0;
    while (!keep() && !fits()) {
      current = { ...current, [family]: current[family].slice(0, -1) };
    }
    if (fits()) return current;
  }
  // The last resort: the knowledge reserve itself.
  while (current.knowledge.length > 0 && !fits()) {
    current = { ...current, knowledge: current.knowledge.slice(0, -1) };
  }
  return current;
}
