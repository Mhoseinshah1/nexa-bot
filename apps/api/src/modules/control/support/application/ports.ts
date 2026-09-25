import type { ScopeContext, SupportFaqInput, SupportFaqStatus } from '@nexa/contracts';

/** One FAQ entry as the operator maintains it. `version` is what an edit states it read. */
export interface SupportFaqRecord {
  readonly id: string;
  readonly question: string;
  readonly answer: string;
  readonly status: SupportFaqStatus;
  readonly sortOrder: number;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * The tenant's FAQ rows and the one-row-per-tenant seed marker.
 *
 * Every method is tenant-scoped through `requireTenantId(scope)`. The two conditional
 * writes — `update` and `setStatus` — name the version (and for a status change the
 * `from` status) in their predicate and answer `null` when nothing matched, so a stale
 * editor and a racing colleague both meet a refusal rather than a silent overwrite.
 */
export interface SupportFaqRepository {
  /** `(sort_order, created_at, id)`, the one ordering, matching the index. */
  list(
    scope: ScopeContext,
    options?: { readonly status?: SupportFaqStatus },
    tx?: unknown,
  ): Promise<readonly SupportFaqRecord[]>;
  find(scope: ScopeContext, id: string, tx?: unknown): Promise<SupportFaqRecord | null>;
  insert(
    scope: ScopeContext,
    input: SupportFaqInput & {
      readonly id: string;
      readonly status: SupportFaqStatus;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<SupportFaqRecord>;
  /** Conditional on `expectedVersion`; bumps the version. Null when the row moved or is absent. */
  update(
    scope: ScopeContext,
    id: string,
    input: SupportFaqInput & { readonly expectedVersion: number },
    now: Date,
    tx: unknown,
  ): Promise<SupportFaqRecord | null>;
  /** Conditional on `from` AND `expectedVersion`; bumps the version. Null when either failed. */
  setStatus(
    scope: ScopeContext,
    id: string,
    input: {
      readonly from: SupportFaqStatus;
      readonly to: SupportFaqStatus;
      readonly expectedVersion: number;
    },
    now: Date,
    tx: unknown,
  ): Promise<SupportFaqRecord | null>;
  /** Every row of the tenant, whatever its status: the bound `SUPPORT_FAQ_MAX_ENTRIES` is on. */
  count(scope: ScopeContext, tx?: unknown): Promise<number>;
  hasSeed(scope: ScopeContext, tx?: unknown): Promise<boolean>;
  /**
   * Claims the seed. TRUE when this caller wrote the marker and therefore owns the
   * insert of the defaults; FALSE when the marker already existed, which is the other
   * replica having won — the caller then reads what it wrote and inserts nothing.
   */
  markSeeded(scope: ScopeContext, now: Date, tx: unknown): Promise<boolean>;
}
