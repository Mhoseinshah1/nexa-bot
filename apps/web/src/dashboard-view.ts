import {
  CURRENCY_EXPONENT,
  type CurrencyCode,
  type ReportGranularity,
  type ReportRange,
} from '@nexa/contracts';
import type { ReportRangeSelection } from './api/client';
import { formatMoney } from './format';
import { t, type WebKey } from './i18n/web.fa';
import { describeChange, formatBasisPoints, rangeFromRoute } from './report-view';
import type { Route } from './router';
import type { PeriodPreset, StatDelta } from './ui/kit';

/**
 * The dashboard's presentation rules, as pure functions a test can pin
 * (`docs/web-redesign/dashboard.md` §2 and §6).
 *
 * Nothing here computes a figure. Every number arrives from the server; these
 * functions decide only which period is ASKED for, how a movement against the
 * previous period is WORDED and COLOURED, and how an exact minor-unit string
 * becomes a point on a chart.
 */

/**
 * What each preset of the period control means: one of the reports' own ranges,
 * resolved by the server's one resolver in the tenant's timezone and calendar.
 * The browser does no calendar arithmetic.
 */
export const DASHBOARD_PRESET_RANGES: Readonly<Record<PeriodPreset, ReportRange>> = {
  today: 'TODAY',
  '7d': 'LAST_7_DAYS',
  '30d': 'LAST_30_DAYS',
  month: 'THIS_MONTH',
  custom: 'CUSTOM',
};

/** Thirty days, as the reference opens: daily buckets, and a month's shape at a glance. */
export const DASHBOARD_DEFAULT_RANGE: ReportRange = 'LAST_30_DAYS';

/**
 * The period the dashboard asks for, read from its URL (`?range=`, and `from`/`to`
 * for CUSTOM) so it survives a reload and can be linked.
 *
 * Only the five ranges the control offers. A report range the control has no
 * button for (yesterday, last month, this year) falls back to the default rather
 * than drawing figures for a period no pressed button names; those ranges stay
 * one click away on `/reports`.
 */
export function dashboardSelection(route: Route): ReportRangeSelection {
  const selection = rangeFromRoute(route, DASHBOARD_DEFAULT_RANGE);
  const offered = Object.values(DASHBOARD_PRESET_RANGES) as readonly ReportRange[];
  return offered.includes(selection.range) ? selection : { range: DASHBOARD_DEFAULT_RANGE };
}

export function presetOf(range: ReportRange): PeriodPreset {
  const entry = (Object.entries(DASHBOARD_PRESET_RANGES) as [PeriodPreset, ReportRange][]).find(
    ([, candidate]) => candidate === range,
  );
  return entry === undefined ? '30d' : entry[0];
}

/** Comparison is on unless the URL turned it off (`?compare=0`). */
export function compareFromRoute(route: Route): boolean {
  return route.query.get('compare') !== '0';
}

/**
 * Which way is good for a figure.
 *
 * `neutral` is the default and the honest one: colour is a claim about the
 * business, and the dashboard makes it only for the figures listed in
 * `dashboard.md` §2 — revenue, sales, renewals and new customers up is good,
 * failed payments up is bad. A gauge has no previous value and gets no delta at
 * all.
 */
export type DeltaSense = 'up-good' | 'up-bad' | 'neutral';

/**
 * The movement of a figure against the previous period, worded by the reports'
 * one rule (`describeChange`): both zero is `—`, nothing before and something
 * now is «جدید», otherwise a signed percentage from integer arithmetic on the
 * exact values.
 */
export function kpiDelta(
  current: bigint,
  previous: bigint,
  sense: DeltaSense,
  caption?: string,
): StatDelta {
  const change = describeChange(current, previous);
  const withCaption = caption === undefined ? {} : { caption };
  if (change.kind === 'none') return { text: '—', direction: 'neutral', ...withCaption };
  const trend: 'up' | 'down' | undefined =
    change.kind === 'new'
      ? 'up'
      : change.basisPoints > 0n
        ? 'up'
        : change.basisPoints < 0n
          ? 'down'
          : undefined;
  const text =
    change.kind === 'new' ? t('web.report_change_new') : formatBasisPoints(change.basisPoints);
  return {
    text,
    direction: directionOf(trend, sense),
    ...(trend === undefined ? {} : { trend }),
    ...withCaption,
  };
}

function directionOf(trend: 'up' | 'down' | undefined, sense: DeltaSense): StatDelta['direction'] {
  if (trend === undefined || sense === 'neutral') return 'neutral';
  const up = trend === 'up';
  if (sense === 'up-good') return up ? 'good' : 'bad';
  return up ? 'bad' : 'good';
}

/** One currency's row of a per-currency comparison; absent means nothing was taken. */
export function moneyRow(
  rows: readonly { currency: CurrencyCode; current: string; previous: string }[],
  currency: CurrencyCode,
): { current: string; previous: string } {
  const row = rows.find((candidate) => candidate.currency === currency);
  return row === undefined ? { current: '0', previous: '0' } : row;
}

/**
 * A minor-unit string as a chart coordinate in MAJOR units.
 *
 * Geometry only: a coordinate may round, the figure never does. Every number a
 * reader is shown — the readout, the hidden table, the axis — goes back through
 * `chartMoneyText`, and every headline figure is `<Money>` over the exact
 * string.
 */
export function chartMoneyValue(minor: string | null, currency: CurrencyCode): number | null {
  if (minor === null) return null;
  return Number(minor) / 10 ** CURRENCY_EXPONENT[currency];
}

/** A chart coordinate back as grouped money text, never abbreviated. */
export function chartMoneyText(value: number, currency: CurrencyCode): string {
  const minor = Math.round(value * 10 ** CURRENCY_EXPONENT[currency]);
  return formatMoney({ amountMinor: String(minor), currency }).amount;
}

/** A count series for a sparkline or a bar; `null` stays a gap. */
export function countValues(values: readonly (string | number | null)[]): (number | null)[] {
  return values.map((value) => (value === null ? null : Number(value)));
}

/** What the revenue chart is called, by the bucket the server chose. */
export const REVENUE_TITLES: Readonly<Record<ReportGranularity, WebKey>> = {
  HOUR: 'web.dashboard_revenue_hourly',
  DAY: 'web.dashboard_revenue_daily',
  WEEK: 'web.dashboard_revenue_weekly',
  MONTH: 'web.dashboard_revenue_monthly',
};

/**
 * A bucket's label as a chart axis draws it: the server's local date without its
 * year (`1405/06/15` → `06/15`, a week `06/01–06/07`). Thirty full dates do not
 * fit under a card-wide axis, and the year is already in the period the page
 * names. An hour (`08:00`) or a month label passes unchanged.
 */
export function axisLabel(label: string): string {
  return label.replace(/\b\d{4}\/(?=\d{2}\/\d{2})/gu, '');
}
