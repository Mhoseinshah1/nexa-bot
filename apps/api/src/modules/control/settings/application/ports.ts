import type { ScopeContext, SettingKey } from '@nexa/contracts';

/**
 * Stored setting values.
 *
 * Absence of a row IS the answer "this tenant uses the default". There is no
 * `isDefault` flag, because a flag beside a value can disagree with it.
 */
export interface StoredSetting {
  readonly key: SettingKey;
  readonly value: unknown;
  readonly version: number;
  readonly updatedAt: Date;
  readonly updatedByAdminId: string | null;
}

export interface SettingRepository {
  /** Every stored value for this tenant. Keys with no row are simply absent. */
  findAll(scope: ScopeContext, tx?: unknown): Promise<StoredSetting[]>;
  find(scope: ScopeContext, key: SettingKey, tx?: unknown): Promise<StoredSetting | null>;

  /**
   * Writes a value, refusing to clobber a concurrent change.
   *
   * `expectedVersion` is null for a first write. The check IS the write: the
   * predicate lives in the statement, so there is no window between deciding
   * that a write is safe and performing it. Returns the persisted row, or null
   * when the expectation did not hold — which the caller reports as a conflict
   * rather than retrying, because a conflict means somebody built a change on
   * state that has since moved.
   */
  upsert(
    scope: ScopeContext,
    input: {
      readonly id: string;
      readonly key: SettingKey;
      readonly value: unknown;
      readonly expectedVersion: number | null;
      readonly now: Date;
      readonly adminId: string | null;
    },
    tx?: unknown,
  ): Promise<StoredSetting | null>;
}

/**
 * Track 3 §2: stored values of PANEL-scoped keys, one row per (tenant, panel, key).
 *
 * The tenant repository's contract with a panel named: absence is the default, and the
 * write's version check lives in its own statement.
 */
export interface PanelSettingRepository {
  /** Every stored value of this panel. Keys with no row are simply absent. */
  findAll(scope: ScopeContext, panelId: string, tx?: unknown): Promise<StoredSetting[]>;
  find(
    scope: ScopeContext,
    panelId: string,
    key: SettingKey,
    tx?: unknown,
  ): Promise<StoredSetting | null>;
  upsert(
    scope: ScopeContext,
    input: {
      readonly id: string;
      readonly panelId: string;
      readonly key: SettingKey;
      readonly value: unknown;
      readonly expectedVersion: number | null;
      readonly now: Date;
      readonly adminId: string | null;
    },
    tx?: unknown,
  ): Promise<StoredSetting | null>;
}
