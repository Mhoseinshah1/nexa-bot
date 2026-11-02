import type {
  AutoRenewPreferenceSource,
  AutoRenewRefusal,
  AutoRenewRunState,
  CurrencyCode,
  Money,
  TenantContext,
  UserId,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';

/** A customer's consent for one service, as stored (Round 10, D1). */
export interface AutoRenewPreference {
  readonly serviceId: string;
  /** The customer who gave it. A run renews only while this is still the service's owner. */
  readonly customerId: UserId;
  readonly enabled: boolean;
  /** The renewal total agreed to when it was switched on; null while it is off. */
  readonly consented: Money | null;
  readonly source: AutoRenewPreferenceSource;
  readonly updatedAt: Date;
}

/** One period of one service, as the sweep holds it. */
export interface AutoRenewRun {
  readonly id: string;
  readonly serviceId: string;
  readonly customerId: UserId;
  readonly attempt: number;
  readonly state: AutoRenewRunState;
  readonly consented: Money;
  readonly quoted: Money | null;
  readonly serviceLabel: string;
  /** The deadline this run renews, millisecond-truncated; for the notice only. */
  readonly basisExpiresAt: Date;
}

/**
 * A service the sweep may renew now, as the candidate query read it.
 *
 * Re-decided by every command it runs: this is a courtesy filter that keeps a pass finite,
 * not an authority. The claim (a unique insert or a conditional update) is what decides who
 * renews a period, and the renewal's own commands decide whether it is renewable.
 */
export interface AutoRenewCandidate {
  /** Where the next page starts: this row's place in the candidate order. */
  readonly cursor: AutoRenewCursor;
  readonly serviceId: string;
  readonly customerId: UserId;
  readonly serviceLabel: string;
  readonly consented: Money;
  /** The period's run, when one exists (a short wallet re-tried, or a lapsed claim). */
  readonly run: {
    readonly id: string;
    readonly state: 'CLAIMED' | 'FUNDS_SHORT';
    readonly attempt: number;
    readonly quoted: Money | null;
  } | null;
}

/**
 * A place in the candidate order `(deadline, service)`. The deadline is PostgreSQL's own text
 * rendering of `services.expires_at`, handed back as it came: a JavaScript `Date` would drop
 * its microseconds.
 */
export interface AutoRenewCursor {
  readonly expiresAt: string;
  readonly serviceId: string;
}

/** The figures a notice renders, read back by the run's id at send time. */
export interface AutoRenewNoticeFacts {
  readonly runId: string;
  readonly serviceId: string;
  readonly serviceLabel: string;
  readonly state: AutoRenewRunState;
  readonly refusal: AutoRenewRefusal | null;
  readonly consented: Money;
  readonly quoted: Money | null;
  readonly basisExpiresAt: Date;
}

export interface AutoRenewRepository {
  /** The consent row of one service, whoever gave it; null when none was ever recorded. */
  preferenceOf(
    scope: TenantContext,
    serviceId: string,
    tx?: unknown,
  ): Promise<AutoRenewPreference | null>;

  /**
   * Records the customer's choice. Answers whether anything changed: switching on what is on
   * at the same total, or off what is off, changes nothing.
   */
  savePreference(
    scope: TenantContext,
    input: {
      readonly serviceId: string;
      readonly customerId: UserId;
      readonly enabled: boolean;
      readonly consented: Money | null;
      readonly source: AutoRenewPreferenceSource;
      readonly now: Date;
    },
    tx: TransactionScope,
  ): Promise<boolean>;

  /**
   * Due services: an enabled consent given by the service's CURRENT owner, an ACTIVE native
   * (non-imported) service with a product and a deadline in `(now, dueBefore]`, no renewal
   * order awaiting payment and no undecided operation on it, and no run for this deadline in
   * a final state — or one `CLAIMED` whose lease lapsed, or one `FUNDS_SHORT`. Oldest
   * deadline first, at most `limit`, strictly after `after` when one is given (the sweep pages
   * past candidates it skips, such as a short wallet still short). An unpaid renewal order
   * this lane placed for the same owner does not exclude a service: the run it belongs to is
   * taken over and withdraws it.
   */
  listDue(
    scope: TenantContext,
    bounds: {
      readonly now: Date;
      readonly dueBefore: Date;
      readonly after?: AutoRenewCursor | null;
    },
    limit: number,
    tx: TransactionScope,
  ): Promise<readonly AutoRenewCandidate[]>;

  /**
   * Claims a period that has no run yet: one INSERT, `ON CONFLICT DO NOTHING` on (service,
   * deadline). The deadline is copied from `services.expires_at` in SQL, never through a
   * JavaScript `Date` (the microsecond reason `ServiceReminderBasis` gives). Null when another
   * pass claimed it first, or when the service's deadline is no longer inside the window.
   */
  claimNew(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly serviceId: string;
      readonly customerId: UserId;
      readonly serviceLabel: string;
      readonly consented: Money;
      readonly now: Date;
      readonly dueBefore: Date;
      readonly leaseUntil: Date;
    },
    tx: TransactionScope,
  ): Promise<AutoRenewRun | null>;

  /**
   * Takes over an existing run — a `CLAIMED` one whose lease lapsed, or a `FUNDS_SHORT` one —
   * as its NEXT attempt, with keys of its own. Conditional on the state and attempt read; null
   * when another pass moved it first.
   */
  reclaim(
    scope: TenantContext,
    input: {
      readonly runId: string;
      readonly from: 'CLAIMED' | 'FUNDS_SHORT';
      readonly attempt: number;
      readonly consented: Money;
      readonly now: Date;
      readonly leaseUntil: Date;
    },
    tx: TransactionScope,
  ): Promise<AutoRenewRun | null>;

  /**
   * Whether the service's deadline is still the one this run renews (`basis_expires_at`),
   * compared in SQL. Asked inside the settling transaction, after the settlement's lifecycle
   * lock: false once any renewal has moved the deadline since the claim — and (R12 F1 item 4)
   * false unless the service, read with its row LOCKED, is still `ACTIVE` and still the run's
   * owner's. A service terminated, suspended or transferred since the claim is never debited.
   * The renewal asks it FIRST in the settling transaction (row before the lifecycle lock, the
   * order every planner takes them in) and again after the debit.
   */
  periodCurrent(scope: TenantContext, runId: string, tx: TransactionScope): Promise<boolean>;

  /**
   * The renewal orders this lane placed (`source_surface = 'SCHEDULER'`) for this service and
   * owner that still await payment — left behind by a pass that stopped between confirming
   * and settling. Every one is withdrawn before a run drafts anything.
   */
  unpaidLaneOrders(
    scope: TenantContext,
    input: { readonly serviceId: string; readonly customerId: UserId },
    tx?: unknown,
  ): Promise<readonly string[]>;

  /**
   * `CLAIMED -> RENEWED` for this attempt, naming the paid order. Run inside the settling
   * transaction; false means the run was not this attempt's claim any more.
   */
  markRenewed(
    scope: TenantContext,
    input: {
      readonly runId: string;
      readonly attempt: number;
      readonly orderId: string;
      readonly quoted: Money;
      readonly now: Date;
    },
    tx: TransactionScope,
  ): Promise<boolean>;

  /** `CLAIMED -> FUNDS_SHORT | REFUSED` for this attempt. False when it was not this claim. */
  markUnrenewed(
    scope: TenantContext,
    input: {
      readonly runId: string;
      readonly attempt: number;
      readonly to: 'FUNDS_SHORT' | 'REFUSED';
      readonly refusal: AutoRenewRefusal | null;
      readonly quoted: Money | null;
      readonly now: Date;
    },
    tx: TransactionScope,
  ): Promise<boolean>;

  /**
   * Stamps the period's one notice. True only for the call that stamped it: a period already
   * noticed (of either kind) answers false and nothing more is sent.
   */
  markNotified(
    scope: TenantContext,
    runId: string,
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean>;

  /** What a notice about this run renders; null when the run is not this tenant's. */
  noticeFacts(scope: TenantContext, runId: string): Promise<AutoRenewNoticeFacts | null>;

  /** Whether this order paid an automatic renewal (the operations log's «منبع»). */
  renewedOrder(scope: TenantContext, orderId: string, tx?: unknown): Promise<boolean>;
}

/** A balance in one currency, as the sweep's pre-check reads it. */
export interface AutoRenewWalletReader {
  balanceOf(
    scope: TenantContext,
    customerId: UserId,
    currency: CurrencyCode,
    tx?: unknown,
  ): Promise<{ readonly amountMinor: bigint; readonly currency: CurrencyCode }>;
}
