/**
 * Reseller-phase PR-6: the dedicated bot's billing calendar, pure.
 *
 * A subscription is `paidThrough` (the end of the last paid period) and `lastPeriod` (its
 * number). The next period is `lastPeriod + 1`; it falls due at `paidThrough`, and a short
 * wallet is carried for `graceDays` after that before the bot is stopped.
 *
 * A charge never buys time that is already over: while the bot is running the new period
 * continues the old one (`[paidThrough, paidThrough + 1 month)`), but once the bot was stopped
 * for its fee — or the old window plus a month is already behind us — the new period starts
 * NOW, so a reseller who pays after a stop gets a whole month of running bot. Periods missed
 * while stopped are never charged.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** `at` plus whole calendar months in UTC, the day clamped to the target month's last day. */
export function addMonthsUtc(at: Date, months: number): Date {
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(at.getUTCDate(), lastDay);
  return new Date(
    Date.UTC(
      year,
      month,
      day,
      at.getUTCHours(),
      at.getUTCMinutes(),
      at.getUTCSeconds(),
      at.getUTCMilliseconds(),
    ),
  );
}

/** The first month an approval buys: from the approval, one calendar month. */
export function firstPeriod(now: Date): { readonly start: Date; readonly end: Date } {
  return { start: now, end: addMonthsUtc(now, 1) };
}

export interface Subscription {
  readonly paidThrough: Date;
  readonly lastPeriod: number;
  readonly feeStoppedAt: Date | null;
}

export type RenewalDue =
  | { readonly kind: 'NOT_DUE' }
  | {
      readonly kind: 'DUE';
      readonly period: number;
      readonly start: Date;
      readonly end: Date;
      /** When a short wallet's grace ends and the bot is stopped. */
      readonly graceEndsAt: Date;
      /** The window restarts now (the bot was stopped, or the old window is long over). */
      readonly restarts: boolean;
    };

export function renewalDue(sub: Subscription, now: Date, graceDays: number): RenewalDue {
  if (now.getTime() < sub.paidThrough.getTime()) return { kind: 'NOT_DUE' };
  const continued = addMonthsUtc(sub.paidThrough, 1);
  const restarts = sub.feeStoppedAt !== null || continued.getTime() <= now.getTime();
  const start = restarts ? now : sub.paidThrough;
  return {
    kind: 'DUE',
    period: sub.lastPeriod + 1,
    start,
    end: restarts ? addMonthsUtc(now, 1) : continued,
    graceEndsAt: new Date(sub.paidThrough.getTime() + Math.max(0, graceDays) * DAY_MS),
    restarts,
  };
}

/** What a run does with a due period the wallet cannot cover. */
export function shortWalletAction(
  now: Date,
  graceEndsAt: Date,
  stopped: boolean,
): 'NOTICE' | 'STOP' | 'WAIT' {
  if (now.getTime() < graceEndsAt.getTime()) return 'NOTICE';
  return stopped ? 'WAIT' : 'STOP';
}

/** The UTC calendar day of an instant, `YYYY-MM-DD`: one short-wallet notice per day. */
export function noticeDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}
