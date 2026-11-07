import type { AutoDeleteCause, AutoDeleteRunState, TenantContext, UserId } from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';

/**
 * NEXA-OWNER-BATCH-1 PR-3 — what the automatic deletion reads and writes. See
 * `service-auto-delete.service.ts` for the rules and `auto-delete.ts` in the contracts for the
 * vocabulary.
 */

/** The day count per cause; `0` is off. */
export interface AutoDeleteDays {
  readonly traffic: number;
  readonly time: number;
  readonly suspended: number;
}

/** A service whose current cycle is due by `horizon` and has no run yet. */
export interface AutoDeleteCandidate {
  readonly serviceId: string;
  readonly customerId: UserId;
  readonly panelId: string;
  readonly cycleState: 'EXPIRED' | 'SUSPENDED';
  readonly cause: AutoDeleteCause;
  readonly days: number;
  readonly serviceLabel: string;
  /** `state_since + days`: when the cycle becomes due. */
  readonly dueAt: Date;
}

export interface AutoDeleteRun {
  readonly id: string;
  readonly serviceId: string;
  readonly customerId: UserId;
  readonly panelId: string;
  readonly cycleState: 'EXPIRED' | 'SUSPENDED';
  readonly cycleSince: Date;
  readonly cause: AutoDeleteCause;
  readonly days: number;
  readonly serviceLabel: string;
  readonly deleteAfter: Date;
  readonly warnedAt: Date | null;
  readonly state: AutoDeleteRunState;
}

export interface AutoDeletePreviewCounts {
  readonly traffic: number;
  readonly time: number;
  readonly suspended: number;
}

export interface AutoDeleteRepository {
  /**
   * Gives an EXPIRED or SUSPENDED service with no known clock (`state_since` NULL: a row from
   * before the column, or one an import wrote) the moment it is first seen, `now`. Never a
   * guessed earlier moment. Bounded; returns how many were stamped.
   */
  stampUnknownClocks(
    scope: TenantContext,
    now: Date,
    limit: number,
    tx: TransactionScope,
  ): Promise<number>;

  /** Services due by `horizon` with no run for their current cycle and nothing blocking them. */
  listToSchedule(
    scope: TenantContext,
    input: { readonly horizon: Date; readonly days: AutoDeleteDays },
    limit: number,
    tx: TransactionScope,
  ): Promise<readonly AutoDeleteCandidate[]>;

  /**
   * One cycle scheduled, by its unique insert; null when another pass got there first or the
   * service has since left the cycle (both re-read in the INSERT's own SELECT).
   */
  schedule(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly candidate: AutoDeleteCandidate;
      readonly deleteAfter: Date;
      readonly warnedAt: Date | null;
      readonly now: Date;
    },
    tx: TransactionScope,
  ): Promise<AutoDeleteRun | null>;

  /**
   * SCHEDULED runs whose `delete_after` has passed and whose service is STILL in the run's
   * cycle — the same state since the same moment. A renewed or resumed service is never listed.
   */
  listDeletable(
    scope: TenantContext,
    input: { readonly now: Date; readonly days: AutoDeleteDays; readonly panelId: string },
    limit: number,
    tx: TransactionScope,
  ): Promise<readonly AutoDeleteRun[]>;

  /** The panels that have at least one cycle `listDeletable` would return. */
  deletablePanels(
    scope: TenantContext,
    input: { readonly now: Date; readonly days: AutoDeleteDays },
    tx: TransactionScope,
  ): Promise<readonly string[]>;

  /** Serialises the rate limit's count-then-plan for one panel, for this transaction. */
  lockPanelRate(scope: TenantContext, panelId: string, tx: TransactionScope): Promise<void>;

  /** The run, re-read under the service's row lock: still SCHEDULED and still its cycle. */
  stillDeletable(scope: TenantContext, runId: string, tx: TransactionScope): Promise<boolean>;

  /** How many deletions were planned on this panel since `since` (the rate limit's count). */
  plannedOnPanelSince(
    scope: TenantContext,
    panelId: string,
    since: Date,
    tx: TransactionScope,
  ): Promise<number>;

  /** An open order, an undecided payment, an open operation or refund request for it. */
  isBlocked(scope: TenantContext, serviceId: string, tx: TransactionScope): Promise<boolean>;

  /** SCHEDULED → PLANNED with the operation, conditionally; false when it was not SCHEDULED. */
  markPlanned(
    scope: TenantContext,
    input: { readonly runId: string; readonly operationId: string; readonly now: Date },
    tx: TransactionScope,
  ): Promise<boolean>;

  /** What the warning renders, from the run's own snapshot. */
  noticeFacts(
    scope: TenantContext,
    runId: string,
  ): Promise<{
    readonly serviceId: string;
    readonly serviceLabel: string;
    readonly deleteAfter: Date;
  } | null>;

  /** The preview: services that become deletable before `windowEnd`, per cause. */
  preview(
    scope: TenantContext,
    input: {
      readonly now: Date;
      readonly windowEnd: Date;
      readonly days: AutoDeleteDays;
      readonly warnHours: number;
    },
  ): Promise<AutoDeletePreviewCounts>;
}
