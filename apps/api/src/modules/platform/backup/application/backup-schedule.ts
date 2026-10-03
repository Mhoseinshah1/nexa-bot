import type { BackupScheduleSource, ScopeContext } from '@nexa/contracts';

/** The schedule the scheduler obeys right now, and where each half came from. */
export interface EffectiveBackupSchedule {
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly source: {
    readonly enabled: BackupScheduleSource;
    readonly interval: BackupScheduleSource;
  };
}

/**
 * The two registry values, as stored on the installation tenant. Null is "not set here":
 * the environment value applies. A port, so this module does not depend on the settings
 * module — the composition root adapts `SettingsResolver` to it.
 */
export interface BackupScheduleSettings {
  read(scope: ScopeContext): Promise<{
    readonly enabled: boolean | null;
    readonly intervalMinutes: number | null;
  }>;
}

export interface BackupSchedulePolicyDeps {
  readonly settings: BackupScheduleSettings;
  /** The installation's tenant; null before provisioning, when only the environment exists. */
  readonly scope: () => ScopeContext | null;
  /**
   * `BACKUP_SCHEDULE_ENABLED` and `BACKUP_INTERVAL_MS`: the compatible DEFAULT, never
   * removed (spec §13.2, §14). An installation that set them and never opens the backup
   * page keeps exactly the schedule it had.
   */
  readonly environment: { readonly enabled: boolean; readonly intervalMs: number };
}

/**
 * The ONE answer to "is the automatic backup on, and how often" (spec §13.2).
 *
 * Read on every scheduler tick and by the backup status card, so the Web Admin's switch
 * applies within one tick and the card shows what the scheduler is actually obeying —
 * a second derivation would be a second answer. Per half: a value an operator stored
 * from the Web Admin wins; otherwise the environment's.
 *
 * The bounds are the registry schema's (15 minutes to 30 days), so a stored value is
 * already inside them; the environment's are its own schema's, which reads the same
 * constants.
 */
export class BackupSchedulePolicy {
  constructor(private readonly deps: BackupSchedulePolicyDeps) {}

  async effective(): Promise<EffectiveBackupSchedule> {
    const { environment } = this.deps;
    const scope = this.deps.scope();
    const stored =
      scope === null
        ? { enabled: null, intervalMinutes: null }
        : await this.deps.settings.read(scope);
    return {
      enabled: stored.enabled ?? environment.enabled,
      intervalMs:
        stored.intervalMinutes === null ? environment.intervalMs : stored.intervalMinutes * 60_000,
      source: {
        enabled: stored.enabled === null ? 'ENVIRONMENT' : 'SETTING',
        interval: stored.intervalMinutes === null ? 'ENVIRONMENT' : 'SETTING',
      },
    };
  }
}
