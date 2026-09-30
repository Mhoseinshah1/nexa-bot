import type {
  FxBaseAsset,
  FxQuote,
  FxRate,
  FxSource,
  SalesCurrencyCode,
  TenantContext,
} from '@nexa/contracts';
import type { FxSourceReading } from '../domain/fx-quote.js';

/**
 * The ports of the central rate (package FX). Application code declares them; the
 * infrastructure implements them; nothing here names an HTTP library or a table.
 */

/**
 * What one read of a source produced.
 *
 * - `READ` — a figure, in the source's own currency, with its timestamp when supplied.
 * - `RATE_LIMITED` — the source said in so many words it did not answer (an HTTP 429).
 *   It is not asked again before a cooldown, whichever replica asks.
 * - `UNAVAILABLE` — no usable answer: a timeout, a network or TLS failure, a 5xx, a
 *   refused target, a body that is not the documented shape, a market reported closed.
 *   `code` is a machine word for the operator and never a body.
 */
export type FxSourceOutcome =
  | { readonly kind: 'READ'; readonly reading: FxSourceReading }
  | { readonly kind: 'RATE_LIMITED'; readonly code: string }
  | { readonly kind: 'UNAVAILABLE'; readonly code: string };

/**
 * One public source, as code. The ONLY thing that speaks its HTTP, through the
 * installation's `SafeHttpClient` and never `fetch`. Reads and never writes anything.
 */
export interface FxSourceAdapter {
  readonly source: FxSource;
  /** The best BID for the base asset against the source's own fiat (the side `FX_QUOTE_SIDE` fixes). */
  read(baseAsset: FxBaseAsset): Promise<FxSourceOutcome>;
}

/** The pair a quote is for. */
export interface FxPair {
  readonly baseAsset: FxBaseAsset;
  readonly quoteCurrency: SalesCurrencyCode;
}

/** The stored quote row: the last-known-good and the refresh bookkeeping around it. */
export interface FxQuoteRow {
  readonly baseAsset: FxBaseAsset;
  readonly quoteCurrency: SalesCurrencyCode;
  /** Null as a group before the first successful fetch. */
  readonly quote: {
    readonly rate: FxRate;
    readonly source: FxSource;
    readonly sourceAt: Date | null;
    readonly fetchedAt: Date;
    readonly quoteId: string;
    readonly policyVersion: number;
  } | null;
  readonly refreshClaimedUntil: Date | null;
  /** Who holds the lease: the token the claimer minted. Null when unclaimed. */
  readonly refreshClaimToken: string | null;
  readonly lastAttemptAt: Date | null;
  readonly lastErrorCode: string | null;
}

export interface FxSourceStateRow {
  readonly source: FxSource;
  readonly lastSuccessAt: Date | null;
  readonly lastFailureAt: Date | null;
  readonly lastFailureCode: string | null;
  readonly retryAfter: Date | null;
  readonly consecutiveFailures: number;
}

/** A quote to store, as the service decided it. */
export interface FxStoredQuote {
  readonly rate: FxRate;
  readonly source: FxSource;
  readonly sourceAt: Date | null;
  readonly fetchedAt: Date;
  readonly quoteId: string;
  readonly policyVersion: number;
}

export interface FxQuoteRepository {
  find(scope: TenantContext, pair: FxPair, tx?: unknown): Promise<FxQuoteRow | null>;
  /**
   * Takes the refresh lease for one pair, as ONE conditional write: the row is created
   * if it does not exist, and claimed only when no other replica holds an unexpired
   * lease and — when `dueBefore` is given — the stored quote was fetched at or before it
   * (or never). The claim is stamped with `claimToken`, the claimer's own; the store and
   * the release below are conditioned on it, so a refresher that stalled past its lease
   * cannot clear or overwrite a newer replica's claim. False means somebody else is
   * refreshing, or nothing is due.
   */
  claimRefresh(
    scope: TenantContext,
    pair: FxPair,
    input: {
      readonly now: Date;
      readonly leaseUntil: Date;
      readonly dueBefore: Date | null;
      readonly claimToken: string;
    },
    tx: unknown,
  ): Promise<boolean>;
  /**
   * Stores a quote and releases the lease, only when the caller still holds the lease
   * (`claimToken`) and the quote is NEWER than the stored one: two replicas cannot move
   * the quote backwards, and a stalled one cannot write over a live claim. Returns
   * whether it was stored.
   */
  storeQuote(
    scope: TenantContext,
    pair: FxPair,
    quote: FxStoredQuote,
    now: Date,
    claimToken: string,
    tx: unknown,
  ): Promise<boolean>;
  /**
   * Releases the lease after a refresh that stored nothing, recording the failure's code
   * — only when the caller still holds it. A lease another replica has since taken is
   * left exactly as it is.
   */
  releaseRefresh(
    scope: TenantContext,
    pair: FxPair,
    input: { readonly now: Date; readonly errorCode: string | null; readonly claimToken: string },
    tx: unknown,
  ): Promise<void>;
  sourceStates(scope: TenantContext, tx?: unknown): Promise<FxSourceStateRow[]>;
  recordSourceSuccess(
    scope: TenantContext,
    source: FxSource,
    now: Date,
    tx: unknown,
  ): Promise<void>;
  recordSourceFailure(
    scope: TenantContext,
    source: FxSource,
    input: { readonly now: Date; readonly code: string; readonly retryAfter: Date | null },
    tx: unknown,
  ): Promise<void>;
}

/** The quote a caller receives: the domain shape, or why there is none. */
export type FxQuoteAnswer =
  | { readonly kind: 'QUOTE'; readonly quote: FxQuote }
  | {
      readonly kind: 'UNAVAILABLE';
      readonly reason: 'DISABLED' | 'NEVER_FETCHED' | 'TOO_STALE';
      /** The stale quote, when there is one, for a diagnostic — never for pricing. */
      readonly stale: FxQuote | null;
    };
