import type { LegacyWalletDebtState, TenantContext } from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';

/**
 * Mirza migration PR4 — one `legacy_wallet_debts` row (owner decision 6): a negative legacy
 * balance held for review. NOT a wallet entry; nothing that computes a balance reads it.
 */
export interface LegacyWalletDebtRecord {
  readonly id: string;
  readonly customerId: string;
  /** The legacy `user.id` — the customer's Telegram id. */
  readonly legacyUserId: string;
  /** The magnitude owed, in minor units of `currency`. Always > 0. */
  readonly amountMinor: bigint;
  readonly currency: 'IRT';
  readonly sourceFingerprint: string;
  readonly rowChecksum: string;
  readonly runId: string;
  /** The source carried the synthetic-fixture marker: test data, never a real debt. */
  readonly synthetic: boolean;
  readonly state: LegacyWalletDebtState;
  readonly decisionReason: string | null;
  readonly decidedByAdminId: string | null;
  readonly decidedAt: Date | null;
  readonly version: number;
  readonly recordedAt: Date;
  readonly updatedAt: Date;
}

/** The decision columns — the only ones an UPDATE may set (0227 refuses the rest). */
export interface LegacyWalletDebtDecisionChange {
  readonly state: LegacyWalletDebtState;
  readonly decisionReason: string;
  readonly decidedByAdminId: string;
  readonly decidedAt: Date;
  readonly updatedAt: Date;
}

export interface LegacyWalletDebtListFilter {
  readonly state?: LegacyWalletDebtState;
  readonly legacyUserId?: string;
  /** Keyset: ids strictly after this one (uuid v7: record order). */
  readonly after?: string;
  readonly limit: number;
}

export interface LegacyWalletDebtAggregate {
  readonly count: number;
  readonly sumMinor: bigint;
}

export interface LegacyWalletDebtRepository {
  findById(
    scope: TenantContext,
    id: string,
    tx?: TransactionScope,
    options?: { readonly forUpdate?: boolean },
  ): Promise<LegacyWalletDebtRecord | null>;
  /** Conditional UPDATE of the decision: null when the row is not in `from` at `version`. */
  decide(
    scope: TenantContext,
    id: string,
    guard: { readonly from: readonly LegacyWalletDebtState[]; readonly version: number },
    change: LegacyWalletDebtDecisionChange,
    tx: TransactionScope,
  ): Promise<LegacyWalletDebtRecord | null>;
  list(
    scope: TenantContext,
    filter: LegacyWalletDebtListFilter,
  ): Promise<readonly LegacyWalletDebtRecord[]>;
  /** Count and Σ owed per state (states with no debt are absent). */
  aggregate(
    scope: TenantContext,
  ): Promise<Readonly<Partial<Record<LegacyWalletDebtState, LegacyWalletDebtAggregate>>>>;
}
