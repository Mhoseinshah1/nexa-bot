import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { OperationalScope, OperationalSeverity, ScopeContext } from '@nexa/contracts';

/** An operational event as an operator reads it. */
export interface OperationalEventRow {
  readonly id: string;
  readonly code: string;
  readonly severity: OperationalSeverity;
  readonly message: string;
  readonly context: Record<string, unknown> | null;
  readonly occurrenceCount: number;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly correlationId: string | null;
  readonly recoversCode: string | null;
  readonly resolvedAt: Date | null;
  readonly resolvedByEventId: string | null;
}

export interface OperationalEventQuery {
  readonly limit: number;
  /**
   * Keyset pagination on `firstSeenAt`, which is also the sort key.
   *
   * IMMUTABLE, by owner decision: `lastSeenAt` is rewritten by every repeat
   * occurrence of a deduped condition, so a row below an operator's cursor
   * that recurs jumps above it and is returned on no later page.
   */
  readonly before?: Date | undefined;
  readonly beforeId?: string | undefined;
  readonly severities?: readonly OperationalSeverity[] | undefined;
  /**
   * Restrict to the management-facing codes.
   *
   * Applied in SQL rather than by the caller, so that a page of `limit` rows is
   * a page of `limit` MATCHING rows and the cursor advances over the same set
   * the reader sees. Filtering after the fact would page over the whole log
   * while displaying a fraction of it.
   */
  readonly scope?: OperationalScope | undefined;
  readonly code?: string | undefined;
  readonly since?: Date | undefined;
  /** Half-open `[since, until)`, per the reporting-interval convention. */
  readonly until?: Date | undefined;
  /** True for open conditions only, false for resolved only, absent for both. */
  readonly open?: boolean | undefined;
}

export interface OperationalEventReader {
  list(scope: ScopeContext, query: OperationalEventQuery): Promise<OperationalEventRow[]>;
}

/**
 * Which conditions are OPEN right now, from the rows rather than from memory.
 *
 * A condition is a durable row and its recovery is a durable row. A process
 * that decides whether to record a recovery from a field it initialised on
 * startup cannot resolve anything it did not itself open: the monitor opened a
 * capacity warning, restarted, saw the population back under the bound, and
 * emitted nothing — the warning stayed open for ever, describing an overload
 * that had ended.
 *
 * Reading the open set instead also removes the multi-replica caveat that came
 * with the process-local version: any replica that observes the population back
 * under the bound resolves the condition, whichever one opened it.
 */
export interface OperationalConditionReader {
  /** Tenant ids with an unresolved condition of this code. */
  openTenantConditions(code: string): Promise<string[]>;
  /**
   * Whether ONE tenant's condition of this code is open.
   *
   * Takes the caller's transaction, because the answer decides whether to
   * write: read outside it, two concurrent callers both see the condition open
   * and both record the recovery, and the read is not covered by whatever the
   * caller has already refused or committed.
   */
  tenantConditionIsOpen(tenantId: string, code: string, tx?: TransactionScope): Promise<boolean>;
  /**
   * Which of these SUBJECTS' conditions are open, answered as codes.
   *
   * One query for a set of dedupe keys, because the caller asking it is
   * deciding what a single event should close and needs the answer before it
   * writes: a condition with three states and one `recoversCode` can only keep
   * at most one row open per subject if it knows which row the subject is
   * leaving. Keyed on `dedupe_key`, exactly as the recorder dedupes, so the
   * answer is about the rows a recovery would actually resolve — and taking the
   * caller's transaction is what stops two ticks both reading "nothing open"
   * and both opening one.
   */
  openConditions(
    scope: ScopeContext,
    dedupeKeys: readonly string[],
    tx?: TransactionScope,
  ): Promise<string[]>;
  /** Whether the installation-wide (tenant-less) condition of this code is open. */
  systemConditionIsOpen(code: string): Promise<boolean>;
}
