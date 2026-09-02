import {
  SETTINGS,
  settingDefinition,
  type OperationalEventRecorder,
  type ScopeContext,
  type SettingClassification,
  type SettingKey,
  type SettingMutability,
  type SettingSource,
  type ZeroMeaning,
} from '@nexa/contracts';
import type { SettingRepository } from './ports.js';

/**
 * Resolves settings for the code that has to behave according to them.
 *
 * Deliberately NOT guarded, and that is a distinction rather than an omission.
 * The permission guard governs what an ACTOR may do through a surface. A worker
 * reading its own retry ceiling has no actor: there is nobody to authorize, and
 * a job asking itself for permission to read its own configuration would be
 * theatre — the kind that ends with `settings.view` added to
 * `SYSTEM_JOB_PERMISSIONS` and background work quietly holding a surface's
 * powers.
 *
 * Tenant scoping still applies in full: every read goes through the repository
 * with a `ScopeContext`, so this cannot see across tenants any more than a
 * guarded read can. What it skips is the permission check, not the isolation.
 *
 * `SettingsService` is the surface-facing half. It checks `settings.view` and
 * then calls this. A boundary check asserts no surface imports this file.
 */
export interface ResolvedSetting {
  readonly key: SettingKey;
  readonly value: unknown;
  readonly source: SettingSource;
  /** Null when the value is the default: there is no row, so there is no version. */
  readonly version: number | null;
  readonly updatedAt: Date | null;
  readonly updatedByAdminId: string | null;
  readonly description: string;
  /** What `0`, empty or absent means for this key. Returned with every read. */
  readonly zeroMeaning: ZeroMeaning;
  readonly mutability: SettingMutability;
  readonly classification: SettingClassification;
  readonly configures: string | null;
}

/** A stored value that no longer parses against its declaration. */
export const INVALID_STORED_SETTING_CODE = 'settings.stored_value_invalid';

export class SettingsResolver {
  constructor(
    private readonly settings: SettingRepository,
    private readonly opsLog: OperationalEventRecorder,
  ) {}

  async resolveAll(scope: ScopeContext, tx?: unknown): Promise<ResolvedSetting[]> {
    const stored = new Map((await this.settings.findAll(scope, tx)).map((row) => [row.key, row]));

    const resolved: ResolvedSetting[] = [];
    for (const definition of SETTINGS) {
      const key = definition.key as SettingKey;
      const row = stored.get(key);
      resolved.push(await this.resolveOne(scope, key, row ?? null, tx));
    }
    return resolved;
  }

  async resolve(scope: ScopeContext, key: SettingKey, tx?: unknown): Promise<ResolvedSetting> {
    return this.resolveOne(scope, key, await this.settings.find(scope, key, tx), tx);
  }

  /** The parsed value alone, for code that only needs to behave correctly. */
  async valueOf<T>(scope: ScopeContext, key: SettingKey, tx?: unknown): Promise<T> {
    return (await this.resolve(scope, key, tx)).value as T;
  }

  private async resolveOne(
    scope: ScopeContext,
    key: SettingKey,
    row: {
      value: unknown;
      version: number;
      updatedAt: Date;
      updatedByAdminId: string | null;
    } | null,
    tx?: unknown,
  ): Promise<ResolvedSetting> {
    const definition = settingDefinition(key);
    const base = {
      key,
      description: definition.description,
      zeroMeaning: definition.zeroMeaning,
      mutability: definition.mutability,
      classification: definition.classification,
      configures: definition.configures,
    } as const;

    const asDefault = (): ResolvedSetting => ({
      ...base,
      value: definition.defaultValue,
      source: 'DEFAULT',
      version: null,
      updatedAt: null,
      updatedByAdminId: null,
    });

    if (row === null) return asDefault();

    const parsed = definition.schema.safeParse(row.value);
    if (!parsed.success) {
      // A value that was valid when it was written and is not valid now: the
      // registry tightened a bound, or a migration wrote something by hand.
      //
      // Falling back to the default is the safe half. Saying so out loud is the
      // other half — a stored value that is silently ignored is exactly the
      // legacy failure where a screen reports success and the system behaves as
      // though nothing was set.
      // In the CALLER'S transaction when there is one. This is a write from a
      // read path, and on a second connection it would survive the caller's
      // rollback — an operational event, and via the projector a notification,
      // recording a state that was never committed. It also holds a second pool
      // connection while the first is open.
      await this.opsLog.record(
        scope,
        {
          code: INVALID_STORED_SETTING_CODE,
          severity: 'WARN',
          message: `The stored value for ${key} does not match its declaration; the default is in force.`,
          context: { key, issues: parsed.error.issues.map((issue) => issue.message) },
          dedupeKey: `${INVALID_STORED_SETTING_CODE}:${key}`,
        },
        tx,
      );
      return asDefault();
    }

    return {
      ...base,
      value: parsed.data,
      source: 'TENANT',
      version: row.version,
      updatedAt: row.updatedAt,
      updatedByAdminId: row.updatedByAdminId,
    };
  }
}
