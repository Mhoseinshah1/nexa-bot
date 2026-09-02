import type { FeatureFlagKey, ScopeContext } from '@nexa/contracts';

export interface StoredFeatureFlag {
  readonly key: FeatureFlagKey;
  readonly enabled: boolean;
  readonly version: number;
  readonly updatedAt: Date;
  readonly updatedByAdminId: string | null;
  readonly reason: string | null;
}

export interface FeatureFlagRepository {
  findAll(scope: ScopeContext, tx?: unknown): Promise<StoredFeatureFlag[]>;
  find(scope: ScopeContext, key: FeatureFlagKey, tx?: unknown): Promise<StoredFeatureFlag | null>;
  /** Same contract as the settings repository: the check is in the statement. */
  upsert(
    scope: ScopeContext,
    input: {
      readonly id: string;
      readonly key: FeatureFlagKey;
      readonly enabled: boolean;
      readonly expectedVersion: number | null;
      readonly reason: string | null;
      readonly now: Date;
      readonly adminId: string | null;
    },
    tx?: unknown,
  ): Promise<StoredFeatureFlag | null>;
}
