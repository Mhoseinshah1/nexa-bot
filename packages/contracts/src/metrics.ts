/**
 * The metric registry.
 *
 * Every reported number is a registry entry with one name, one formula, one
 * filter set and one interval semantic, served by one query service that both
 * surfaces call.
 *
 * The legacy system's reporting defects are definition failures, not query
 * failures: "sales" excludes renewals and add-ons (a 38% understatement against
 * the web's own revenue figure), "buyer" means two different things inside one
 * feature (56,792 vs 27,732), and no metric states which timestamp it filters
 * on. No amount of query correctness fixes a metric that means two things.
 *
 * Phase 0 ships the registry type and the CI gate that rejects a metric name
 * with no entry. The metric catalog itself is filled in as modules land.
 */

import type { NamedPeriod } from './time.js';

export const METRIC_KINDS = ['COUNT', 'SUM_MONEY', 'RATIO', 'AVERAGE', 'GAUGE'] as const;
export type MetricKind = (typeof METRIC_KINDS)[number];

/**
 * Which timestamp a metric filters on. The legacy system records none of this,
 * which is why its all-time and grouped renewal totals disagree by 6.5%.
 */
export const TIMESTAMP_BASES = [
  'CREATED_AT',
  'PAID_AT',
  'COMPLETED_AT',
  'RENEWED_AT',
  'OCCURRED_AT',
] as const;
export type TimestampBasis = (typeof TIMESTAMP_BASES)[number];

export interface MetricDefinition {
  /** Stable machine name. This, not a display label, is the identifier. */
  readonly name: string;
  readonly kind: MetricKind;
  /** Prose formula, precise enough to reimplement from. */
  readonly formula: string;
  /** Which timestamp column the period filter applies to. */
  readonly timestampBasis: TimestampBasis;
  /** Named filters applied before aggregation, e.g. 'excludes test orders'. */
  readonly filters: readonly string[];
  /** Periods this metric is defined over. Intervals are always half-open. */
  readonly supportedPeriods: readonly NamedPeriod[];
  readonly description: string;
}

/**
 * Phase 0 registers only what it can actually compute. An empty catalog is
 * honest; a catalog of aspirational metrics is not.
 */
export const METRIC_DEFINITIONS: readonly MetricDefinition[] = [];

const METRIC_BY_NAME = new Map(METRIC_DEFINITIONS.map((m) => [m.name, m]));

export function isRegisteredMetric(name: string): boolean {
  return METRIC_BY_NAME.has(name);
}

export function metricDefinition(name: string): MetricDefinition {
  const found = METRIC_BY_NAME.get(name);
  if (!found) {
    throw new Error(
      `Metric "${name}" has no registry entry. Every reported number must be defined once, in @nexa/contracts.`,
    );
  }
  return found;
}
