import {
  OWNER_ROLE_KEY,
  REPORT_RANGES,
  REPORT_REFRESH_INTERVAL_MS,
  type ReportRange,
} from '@nexa/contracts';
import type { ReportRangeSelection } from './api/client';
import type { Route } from './router';
import type { WebKey } from './i18n/web.fa';

/**
 * The presentation rules of WP12's business reports, as pure functions a test can pin
 * (`docs/wp12-business-analytics-audit.md` §2, §3, §9).
 */

/** Business figures re-read every five minutes, never faster (spec §5.2). */
export const BUSINESS_REFRESH_MS = REPORT_REFRESH_INTERVAL_MS;

/**
 * Whether this session may SEE business reports.
 *
 * The owner role and the permission, the same two facts the server checks on every
 * request. This decides only what is drawn: the server refuses a non-owner regardless,
 * so a stale session that still draws a card gets a 403 on its first request, never data.
 */
export function isSuperAdmin(roleKeys: readonly string[], permissions: readonly string[]): boolean {
  return roleKeys.includes(OWNER_ROLE_KEY) && permissions.includes('reports.view');
}

export function mayExportReports(
  roleKeys: readonly string[],
  permissions: readonly string[],
): boolean {
  return isSuperAdmin(roleKeys, permissions) && permissions.includes('reports.export');
}

export const REPORT_RANGE_LABELS: Readonly<Record<ReportRange, WebKey>> = {
  TODAY: 'web.report_range_today',
  YESTERDAY: 'web.report_range_yesterday',
  LAST_7_DAYS: 'web.report_range_last_7',
  LAST_30_DAYS: 'web.report_range_last_30',
  THIS_MONTH: 'web.report_range_this_month',
  PREVIOUS_MONTH: 'web.report_range_previous_month',
  THIS_YEAR: 'web.report_range_this_year',
  CUSTOM: 'web.report_range_custom',
};

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * The range a page shows, read from its URL so a report is linkable and survives a reload.
 *
 * An unknown `range` falls back to the page's default rather than reaching the server as
 * a 400; a CUSTOM range with a malformed date keeps only what is well-formed, and the
 * server — which owns the calendar — decides whether the date exists.
 */
export function rangeFromRoute(route: Route, fallback: ReportRange): ReportRangeSelection {
  const raw = route.query.get('range');
  const range = (REPORT_RANGES as readonly string[]).includes(raw ?? '')
    ? (raw as ReportRange)
    : fallback;
  if (range !== 'CUSTOM') return { range };
  const from = route.query.get('from') ?? '';
  const to = route.query.get('to') ?? '';
  return {
    range,
    ...(LOCAL_DATE.test(from) ? { from } : {}),
    ...(LOCAL_DATE.test(to) ? { to } : {}),
  };
}

/** A CUSTOM range is asked for only once both of its dates are present. */
export function rangeIsComplete(selection: ReportRangeSelection): boolean {
  return (
    selection.range !== 'CUSTOM' || (selection.from !== undefined && selection.to !== undefined)
  );
}

export type Change =
  | { readonly kind: 'none' }
  | { readonly kind: 'new' }
  | { readonly kind: 'change'; readonly basisPoints: bigint };

/**
 * How a figure moved against the previous period, without percentage math that lies.
 *
 * Both zero is no movement to report (`—`). Nothing before and something now is "new",
 * never "+∞%". Otherwise the change is computed on the exact integers — money arrives as
 * minor-unit strings — in basis points, rounded toward zero.
 */
export function describeChange(current: bigint, previous: bigint): Change {
  if (previous === 0n) return current === 0n ? { kind: 'none' } : { kind: 'new' };
  return { kind: 'change', basisPoints: ((current - previous) * 10_000n) / previous };
}

/** `+12.5%`, `−40%`, `0%`: at most one decimal, Latin digits, the sign always shown. */
export function formatBasisPoints(basisPoints: bigint): string {
  const negative = basisPoints < 0n;
  const abs = negative ? -basisPoints : basisPoints;
  const whole = abs / 100n;
  const tenth = (abs % 100n) / 10n;
  const text = tenth === 0n ? `${whole}` : `${whole}.${tenth}`;
  if (abs === 0n) return '0%';
  return `${negative ? '−' : '+'}${text}%`;
}

/** A rate on the wire (basis points or null) as text; null is "—", never 0%. */
export function formatRate(basisPoints: number | null): string {
  if (basisPoints === null) return '—';
  const whole = Math.floor(basisPoints / 100);
  const tenth = Math.floor((basisPoints % 100) / 10);
  return tenth === 0 ? `${whole}%` : `${whole}.${tenth}%`;
}

/** The series values a chart plots, `null` for a bucket that has not begun. */
export function seriesValues(buckets: readonly { value: string | null }[]): (number | null)[] {
  return buckets.map((bucket) => (bucket.value === null ? null : Number(bucket.value)));
}
