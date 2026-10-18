import {
  PANEL_SETTING_KEYS,
  settingDefinition,
  settingScope,
  type OperationalEventRecorder,
  type PanelSettingSource,
  type ScopeContext,
  type SettingKey,
} from '@nexa/contracts';
import type { PanelSettingRepository, StoredSetting } from './ports.js';
import { INVALID_STORED_SETTING_CODE, type ResolvedSetting } from './settings-resolver.js';

/** One PANEL-scoped key as one panel holds it: the tenant shape, with the panel named. */
export interface ResolvedPanelSetting extends Omit<ResolvedSetting, 'source'> {
  readonly panelId: string;
  readonly source: PanelSettingSource;
}

/** The dedupe key of one panel's invalid stored value, and of the recovery that closes it. */
export function invalidPanelSettingDedupeKey(panelId: string, key: SettingKey): string {
  return `${INVALID_STORED_SETTING_CODE}:${panelId}:${key}`;
}

/**
 * Track 3 §2: resolves PANEL-scoped settings for the code that behaves by them — the
 * connection-file caption at send time — and for the guarded panel settings surface.
 *
 * Unguarded for the reason `SettingsResolver` gives (a send has no actor to authorize),
 * and tenant-isolated in full through the repository's `ScopeContext`. The rules are the
 * tenant resolver's: no row is the registry default; a row that no longer parses is the
 * default AND reports its own version (so a repair can overwrite it) AND opens
 * `settings.stored_value_invalid`, keyed to this panel and key.
 */
export class PanelSettingsResolver {
  constructor(
    private readonly settings: PanelSettingRepository,
    private readonly opsLog: OperationalEventRecorder,
  ) {}

  async resolveAll(
    scope: ScopeContext,
    panelId: string,
    tx?: unknown,
  ): Promise<ResolvedPanelSetting[]> {
    const stored = new Map(
      (await this.settings.findAll(scope, panelId, tx)).map((row) => [row.key, row]),
    );
    const resolved: ResolvedPanelSetting[] = [];
    for (const key of PANEL_SETTING_KEYS) {
      resolved.push(await this.resolveOne(scope, panelId, key, stored.get(key) ?? null, tx));
    }
    return resolved;
  }

  async resolve(
    scope: ScopeContext,
    panelId: string,
    key: SettingKey,
    tx?: unknown,
  ): Promise<ResolvedPanelSetting> {
    return this.resolveOne(
      scope,
      panelId,
      key,
      await this.settings.find(scope, panelId, key, tx),
      tx,
    );
  }

  /** The parsed values of every panel key, for code that only needs to behave correctly. */
  async valuesOf(
    scope: ScopeContext,
    panelId: string,
    tx?: unknown,
  ): Promise<ReadonlyMap<SettingKey, unknown>> {
    const all = await this.resolveAll(scope, panelId, tx);
    return new Map(all.map((setting) => [setting.key, setting.value]));
  }

  private async resolveOne(
    scope: ScopeContext,
    panelId: string,
    key: SettingKey,
    row: StoredSetting | null,
    tx?: unknown,
  ): Promise<ResolvedPanelSetting> {
    if (settingScope(key) !== 'PANEL') {
      // A programming error, not a request: the surfaces refuse a tenant key before here.
      throw new Error(`${key} is not a PANEL-scoped setting.`);
    }
    const definition = settingDefinition(key);
    const base = {
      key,
      panelId,
      description: definition.description,
      zeroMeaning: definition.zeroMeaning,
      mutability: definition.mutability,
      classification: definition.classification,
      configures: definition.configures,
      consumer: definition.consumer,
    } as const;
    if (row === null) {
      return {
        ...base,
        value: definition.defaultValue,
        source: 'DEFAULT',
        version: null,
        updatedAt: null,
        updatedByAdminId: null,
        storedValueInvalid: false,
      };
    }
    const parsed = definition.schema.safeParse(row.value);
    if (!parsed.success) {
      // In the caller's transaction, for the reason the tenant resolver gives.
      await this.opsLog.record(
        scope,
        {
          code: INVALID_STORED_SETTING_CODE,
          severity: 'WARN',
          message: `The stored value for ${key} on panel ${panelId} does not match its declaration; the default is in force.`,
          context: { key, panelId, issues: parsed.error.issues.map((issue) => issue.message) },
          dedupeKey: invalidPanelSettingDedupeKey(panelId, key),
        },
        tx,
      );
      return {
        ...base,
        value: definition.defaultValue,
        source: 'DEFAULT',
        version: row.version,
        updatedAt: row.updatedAt,
        updatedByAdminId: row.updatedByAdminId,
        storedValueInvalid: true,
      };
    }
    return {
      ...base,
      value: parsed.data,
      source: 'PANEL',
      version: row.version,
      updatedAt: row.updatedAt,
      updatedByAdminId: row.updatedByAdminId,
      storedValueInvalid: false,
    };
  }
}
