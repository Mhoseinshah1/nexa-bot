import {
  FX_OUTLIER_MAX_DEVIATION_BPS,
  FX_SOURCE_AGREEMENT_BPS,
  convertQuoteCurrency,
  normaliseRate,
  rateDeviationBps,
  rateWithinRails,
  type FxBaseAsset,
  type FxRate,
  type FxSource,
  type SalesCurrencyCode,
} from '@nexa/contracts';

/**
 * The pure decisions of the central rate (package FX, `docs/fx-audit.md` §3.3). No I/O,
 * no clock, no `number` where a figure is decided: every input is a `bigint` rate and
 * every answer is a verdict a test can name.
 */

/** What one source answered, already read into a rate in the SOURCE's own currency. */
export interface FxSourceReading {
  readonly source: FxSource;
  readonly rate: FxRate;
  readonly currency: SalesCurrencyCode;
  /** The provider's own timestamp for the figure, when it supplies one. */
  readonly sourceAt: Date | null;
}

/** A reading brought into the installation's sales currency. */
export interface FxCandidate {
  readonly source: FxSource;
  readonly rate: FxRate;
  readonly sourceAt: Date | null;
}

export function toCandidate(
  reading: FxSourceReading,
  quoteCurrency: SalesCurrencyCode,
): FxCandidate {
  return {
    source: reading.source,
    rate: normaliseRate(convertQuoteCurrency(reading.rate, reading.currency, quoteCurrency)),
    sourceAt: reading.sourceAt,
  };
}

/** The last-known-good, as the judge sees it: its rate and whether it is still trusted. */
export interface LastKnownGood {
  readonly rate: FxRate;
  /** Whether the quote is young enough to compare against (inside the stale limit). */
  readonly trusted: boolean;
}

/**
 * Why a candidate was not accepted. `NOT_POSITIVE` and `OUT_OF_RAILS` are parse or unit
 * errors and are never accepted; `OUTLIER` is a figure too far from the last-known-good,
 * which another source may confirm (`decideQuote`).
 */
export type FxCandidateVerdict =
  | { readonly kind: 'ACCEPT' }
  | { readonly kind: 'NOT_POSITIVE' }
  | { readonly kind: 'OUT_OF_RAILS' }
  | { readonly kind: 'OUTLIER'; readonly deviationBps: bigint };

/**
 * One candidate against the rails and the last-known-good.
 *
 * The outlier check applies only while the last-known-good is TRUSTED: a quote older
 * than the stale limit is not a fact about the market any more, and comparing against
 * it would refuse every honest figure after a real move for as long as the feed was
 * down. That is the one way a guard against a wrong number becomes a guard against
 * every number.
 */
export function judgeCandidate(
  candidate: FxCandidate,
  baseAsset: FxBaseAsset,
  quoteCurrency: SalesCurrencyCode,
  lastKnownGood: LastKnownGood | null,
): FxCandidateVerdict {
  if (candidate.rate.mantissa <= 0n) return { kind: 'NOT_POSITIVE' };
  if (!rateWithinRails(candidate.rate, baseAsset, quoteCurrency)) return { kind: 'OUT_OF_RAILS' };
  if (lastKnownGood === null || !lastKnownGood.trusted) return { kind: 'ACCEPT' };
  const deviationBps = rateDeviationBps(candidate.rate, lastKnownGood.rate);
  if (deviationBps === null) return { kind: 'ACCEPT' };
  if (deviationBps > FX_OUTLIER_MAX_DEVIATION_BPS) return { kind: 'OUTLIER', deviationBps };
  return { kind: 'ACCEPT' };
}

export interface JudgedCandidate {
  readonly candidate: FxCandidate;
  readonly verdict: FxCandidateVerdict;
}

/** The machine code a refusal is recorded under. Never a body, never a URL. */
export function verdictCode(verdict: FxCandidateVerdict): string {
  switch (verdict.kind) {
    case 'ACCEPT':
      return 'accepted';
    case 'NOT_POSITIVE':
      return 'not_positive';
    case 'OUT_OF_RAILS':
      return 'out_of_rails';
    case 'OUTLIER':
      return 'outlier';
  }
}

/**
 * Why nothing was stored, when sources DID answer (Round 6). Closed, because each is a
 * machine code an operator reads beside the source in Web Admin.
 *
 * - `sources_disagree` — healthy sources answered and not enough of them are within
 *   `FX_SOURCE_AGREEMENT_BPS` of each other. Nobody can say which is right, so none is
 *   stored; the last stored rate keeps pricing inside its stale window.
 * - `too_few_sources` — one healthy source, and the owner has not accepted a single one.
 * - `single_source_outlier` — one healthy source, accepted, but its figure is too far
 *   from the last good one for a lone source to move it.
 */
export type NotStoredReason = 'sources_disagree' | 'too_few_sources' | 'single_source_outlier';

export type QuoteDecision =
  | {
      readonly kind: 'STORE';
      readonly chosen: FxCandidate;
      /** Every source that agreed with the chosen figure (including it). */
      readonly agreeing: readonly FxSource[];
      /** True when one source alone was stored under `fx.accept_single_source`. */
      readonly single: boolean;
      /** Healthy sources that answered, whether or not they agreed. */
      readonly healthy: readonly FxSource[];
    }
  | {
      readonly kind: 'NONE';
      readonly reason: NotStoredReason | null;
      /** Healthy sources that answered, whether or not they could be used. */
      readonly healthy: readonly FxSource[];
    };

/**
 * THE agreement rule (Round 6): which figure, if any, is stored.
 *
 * `judged` is in the operator's preference order. A source is HEALTHY when it answered a
 * positive figure inside the pair's sanity rails (`ACCEPT` or `OUTLIER` against the
 * last-known-good — an outlier is a figure that may be a market move, not a broken source).
 *
 * - At least `minAgreeing` healthy sources within `FX_SOURCE_AGREEMENT_BPS` of one another:
 *   store the first of them in preference order. Agreement overrides the outlier test, as it
 *   always has: two independent books moving together are a market, not a mistake.
 * - Exactly one healthy source: stored only when `acceptSingle`, and only if it is not an
 *   outlier — a lone source has nobody to confirm a 15 % jump.
 * - Anything else stores nothing, and never a figure picked from disagreeing sources.
 */
export function decideQuote(
  judged: readonly JudgedCandidate[],
  options: { readonly minAgreeing: number; readonly acceptSingle: boolean },
): QuoteDecision {
  const healthy = judged.filter(
    (entry) => entry.verdict.kind === 'ACCEPT' || entry.verdict.kind === 'OUTLIER',
  );
  const healthySources = healthy.map((entry) => entry.candidate.source);
  let best: JudgedCandidate[] = [];
  for (const anchor of healthy) {
    const cluster = healthy.filter((entry) => {
      const apart = rateDeviationBps(entry.candidate.rate, anchor.candidate.rate);
      return apart !== null && apart <= FX_SOURCE_AGREEMENT_BPS;
    });
    if (cluster.length > best.length) best = cluster;
  }
  if (best.length >= Math.max(2, options.minAgreeing)) {
    return {
      kind: 'STORE',
      chosen: best[0]!.candidate,
      agreeing: best.map((entry) => entry.candidate.source),
      single: false,
      healthy: healthySources,
    };
  }
  if (healthy.length === 1) {
    const only = healthy[0]!;
    if (!options.acceptSingle) {
      return { kind: 'NONE', reason: 'too_few_sources', healthy: healthySources };
    }
    if (only.verdict.kind !== 'ACCEPT') {
      return { kind: 'NONE', reason: 'single_source_outlier', healthy: healthySources };
    }
    return {
      kind: 'STORE',
      chosen: only.candidate,
      agreeing: [only.candidate.source],
      single: true,
      healthy: healthySources,
    };
  }
  if (healthy.length >= 2) {
    return { kind: 'NONE', reason: 'sources_disagree', healthy: healthySources };
  }
  return { kind: 'NONE', reason: null, healthy: healthySources };
}
