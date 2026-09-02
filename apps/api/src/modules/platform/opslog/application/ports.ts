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
