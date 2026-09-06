import type { OperationalSeverity, ScopeContext } from '@nexa/contracts';

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
  /** Keyset pagination on `lastSeenAt`, which is also the sort key. */
  readonly before?: Date | undefined;
  readonly beforeId?: string | undefined;
  readonly severities?: readonly OperationalSeverity[] | undefined;
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
  /** Whether the installation-wide (tenant-less) condition of this code is open. */
  systemConditionIsOpen(code: string): Promise<boolean>;
}
