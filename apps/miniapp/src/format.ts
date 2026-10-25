import {
  DEFAULT_TEMPLATE_PRESENTATION,
  formatDateTime,
  formatMoney,
  formatTrafficLimit,
  formatBytes,
} from '@nexa/i18n';
import { fromWire, type MoneyWire } from '@nexa/contracts';

/**
 * Figures as the bot shows them — the same `@nexa/i18n` formatters, so a price, a traffic
 * figure and a date read the same in the chat and in the mini app. Missing data is drawn as
 * an em dash, never as zero.
 */
export const DASH = '—';

export function money(value: MoneyWire | null | undefined): string {
  return value === null || value === undefined ? DASH : formatMoney(fromWire(value));
}

/** A traffic allowance (unlimited is the word, never «0»). */
export function trafficLimit(bytes: string | null | undefined): string {
  return bytes === null || bytes === undefined ? DASH : formatTrafficLimit(BigInt(bytes));
}

/** A traffic quantity (used, left). */
export function traffic(bytes: string | bigint | null | undefined): string {
  if (bytes === null || bytes === undefined) return DASH;
  return formatBytes(typeof bytes === 'bigint' ? bytes : BigInt(bytes));
}

export function dateTime(iso: string | null | undefined): string {
  return iso === null || iso === undefined
    ? DASH
    : formatDateTime(new Date(iso), DEFAULT_TEMPLATE_PRESENTATION);
}

/** Whole days from `now` to `iso`, never below zero. */
export function daysUntil(iso: string, now: Date): number {
  const ms = new Date(iso).getTime() - now.getTime();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

/** The used share of an allowance, 0..1, for the usage bar; null when unlimited or unknown. */
export function usedShare(used: string, limit: string): number | null {
  const total = BigInt(limit);
  if (total <= 0n) return null;
  const part = BigInt(used);
  // Thousandths in bigint, then a number: never a float of a byte count.
  const permille = (part * 1000n) / total;
  return Math.min(1, Number(permille) / 1000);
}
