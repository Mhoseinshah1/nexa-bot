import type { CustomerStatus, OrderId, ProductId, TenantContext, UserId } from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';

/**
 * A trial a customer took, as `trial_grants` records it.
 *
 * `releasedAt` non-null means the trial was given back because its service could not
 * be created, and it no longer counts against the customer's limit (ADR-0015, plan
 * §7.1). `docs/wp6-audit.md` A3, A4.
 */
export interface TrialGrantRecord {
  readonly id: string;
  readonly customerId: UserId;
  readonly orderId: OrderId;
  readonly productId: ProductId;
  readonly serviceId: string | null;
  readonly createdAt: Date;
  readonly releasedAt: Date | null;
}

export interface TrialGrantDraft {
  readonly id: string;
  readonly customerId: UserId;
  readonly orderId: OrderId;
  readonly productId: ProductId;
  readonly serviceId: string;
  readonly now: Date;
}

export interface TrialGrantRepository {
  /**
   * How many of this customer's trials still count — neither released nor reset
   * (`released_at` and `reset_at` both NULL; `docs/wp6-audit.md` B1).
   *
   * Meaningful for a DECISION only inside the transaction that holds the customer's
   * row lock; outside it, it is a display figure that may be stale by the time it is
   * read.
   */
  countCounting(scope: TenantContext, customerId: UserId, tx?: TransactionScope): Promise<number>;
  /** One per trial order; `trial_grants_order_key` makes a replay lose. */
  create(scope: TenantContext, draft: TrialGrantDraft, tx: TransactionScope): Promise<boolean>;
  findByOrder(
    scope: TenantContext,
    orderId: string,
    tx?: TransactionScope,
  ): Promise<TrialGrantRecord | null>;
  /**
   * Gives a trial back. Stamps only a grant not already released, and reports whether
   * it stamped one — so the undeliverable lane can run twice and count once.
   */
  release(scope: TenantContext, orderId: string, at: Date, tx: TransactionScope): Promise<boolean>;
}

/** A customer's persistent custom limit, as stored (ADR-0015). */
export interface TrialOverrideRecord {
  readonly customerId: UserId;
  readonly limit: number;
  readonly setAt: Date;
}

/** One row of "customers with custom trial limits". */
export interface TrialOverrideListRow {
  readonly customer: {
    readonly id: UserId;
    readonly telegramUserId: string;
    readonly username: string | null;
    readonly firstName: string | null;
    readonly status: CustomerStatus;
  };
  readonly limit: number;
  /** Counted outside any lock: a display figure, never a decision. */
  readonly used: number;
  readonly setAt: Date;
}

/** Newest first. `setAt` is PostgreSQL's microsecond text, as every cursor here is. */
export interface TrialOverrideCursor {
  readonly setAt: string;
  readonly customerId: string;
}

export interface TrialOverrideRepository {
  find(
    scope: TenantContext,
    customerId: UserId,
    tx?: TransactionScope,
  ): Promise<TrialOverrideRecord | null>;
  /** Insert or replace. The caller holds the customer's row lock. */
  upsert(
    scope: TenantContext,
    customerId: UserId,
    limit: number,
    now: Date,
    tx: TransactionScope,
  ): Promise<void>;
  /** Deletes the row. Reports whether there was one. */
  remove(scope: TenantContext, customerId: UserId, tx: TransactionScope): Promise<boolean>;
  list(
    scope: TenantContext,
    limit: number,
    cursor: TrialOverrideCursor | null,
  ): Promise<{
    readonly items: readonly TrialOverrideListRow[];
    readonly nextCursor: TrialOverrideCursor | null;
  }>;
}

/** A global reset, as `trial_resets` records it (ADR-0010 step 5). */
export interface TrialResetRecord {
  readonly id: string;
  readonly actorAdminId: string;
  readonly reason: string;
  readonly affectedGrants: number;
  readonly affectedCustomers: number;
  readonly createdAt: Date;
}

export interface TrialResetPreview {
  readonly affectedGrants: number;
  readonly affectedCustomers: number;
  /**
   * The identity of the counted SET: MD5 over the grant ids in id order (Codex, PR
   * #65). A count alone cannot tell "the grants I was shown" from "the same number of
   * other grants", and a reset confirmed against a count could stamp a set nobody saw.
   */
  readonly fingerprint: string;
  readonly sample: readonly {
    readonly customer: TrialOverrideListRow['customer'];
    readonly grants: number;
  }[];
}

export interface TrialResetCursor {
  readonly createdAt: string;
  readonly id: string;
}

export interface TrialResetRepository {
  /** The dry run: what a reset would stamp now. Writes nothing. */
  preview(scope: TenantContext, sampleSize: number): Promise<TrialResetPreview>;
  /**
   * Stamps every grant that still counts and records the reset, in ONE statement: the
   * record's counts are the rows that statement stamped, so the two cannot disagree.
   * Returns null, and writes nothing, when there was nothing to stamp.
   */
  execute(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly actorAdminId: string;
      readonly reason: string;
      readonly now: Date;
    },
    tx: TransactionScope,
  ): Promise<(TrialResetRecord & { readonly fingerprint: string }) | null>;
  findById(scope: TenantContext, id: string): Promise<TrialResetRecord | null>;
  list(
    scope: TenantContext,
    limit: number,
    cursor: TrialResetCursor | null,
  ): Promise<{
    readonly items: readonly TrialResetRecord[];
    readonly nextCursor: TrialResetCursor | null;
  }>;
}
