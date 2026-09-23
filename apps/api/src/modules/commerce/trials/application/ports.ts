import type { OrderId, ProductId, TenantContext, UserId } from '@nexa/contracts';
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
   * How many of this customer's trials still count — `released_at` NULL.
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
