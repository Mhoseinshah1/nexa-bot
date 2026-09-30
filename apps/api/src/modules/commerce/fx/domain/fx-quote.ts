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
 * which another source may confirm (`chooseQuote`).
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

/**
 * The quote to store, from the candidates in source order (primary first), or null.
 *
 * The first ACCEPTED candidate wins: the primary is preferred by construction, and the
 * fallback only prices anything when the primary did not answer or was refused. When
 * no candidate is accepted but two OUTLIERS agree with each other within
 * `FX_SOURCE_AGREEMENT_BPS`, the market moved and the last-known-good is what is wrong:
 * the first of the agreeing pair wins. Two outliers that disagree, or one alone, are
 * refused — nothing prices an invoice on a figure only one source stands behind.
 */
export function chooseQuote(judged: readonly JudgedCandidate[]): FxCandidate | null {
  const accepted = judged.find((entry) => entry.verdict.kind === 'ACCEPT');
  if (accepted !== undefined) return accepted.candidate;
  const outliers = judged.filter((entry) => entry.verdict.kind === 'OUTLIER');
  for (let i = 0; i < outliers.length; i += 1) {
    for (let j = i + 1; j < outliers.length; j += 1) {
      const a = outliers[i]!.candidate;
      const b = outliers[j]!.candidate;
      const apart = rateDeviationBps(b.rate, a.rate);
      if (apart !== null && apart <= FX_SOURCE_AGREEMENT_BPS) return a;
    }
  }
  return null;
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
 * Every source whose figure stands behind the chosen quote: the chosen source itself and,
 * when it was chosen because outliers AGREED, each outlier within the agreement bound of
 * it. A corroborating source was right about the move too; recording it as an outlier
 * failure would open a condition against the source that confirmed the market
 * (Codex review of #122). Empty when nothing was chosen.
 */
export function sourcesBehind(
  judged: readonly JudgedCandidate[],
  chosen: FxCandidate | null,
): readonly FxSource[] {
  if (chosen === null) return [];
  const behind: FxSource[] = [chosen.source];
  for (const entry of judged) {
    if (entry.verdict.kind !== 'OUTLIER' || entry.candidate.source === chosen.source) continue;
    const apart = rateDeviationBps(entry.candidate.rate, chosen.rate);
    if (apart !== null && apart <= FX_SOURCE_AGREEMENT_BPS) behind.push(entry.candidate.source);
  }
  return behind;
}
