import {
  BACKUP_DAILY_TIME_ZONE,
  type BackupScheduleSource,
  type ScopeContext,
} from '@nexa/contracts';

/** The schedule the scheduler obeys right now, and where each half came from. */
export interface EffectiveBackupSchedule {
  readonly enabled: boolean;
  /**
   * How long after the last verified backup the next is due. With a daily time in force it
   * is 24 hours — what the overdue check and the status card measure against — while the
   * scheduler itself obeys `dailyTime`.
   */
  readonly intervalMs: number;
  /** `HH:MM` in `BACKUP_DAILY_TIME_ZONE` when a once-a-day time governs; else null. */
  readonly dailyTime: string | null;
  readonly source: {
    readonly enabled: BackupScheduleSource;
    readonly interval: BackupScheduleSource;
    readonly dailyTime: BackupScheduleSource;
  };
}

const DAY_MS = 24 * 3_600_000;

/**
 * The latest instant at or before `now` whose wall clock in `timeZone` reads `hhmm`.
 *
 * A once-a-day backup is DUE when this instant is later than the last verified backup (or
 * there is none), so a worker that was down at 04:00 takes it on restart rather than waiting
 * a day, and a backup taken at 03:50 by hand does not suppress the 04:00 one but one taken at
 * 04:10 does. Computed from the zone's own offset at `now`; Asia/Tehran has no DST.
 */
export function latestDailySlot(
  now: Date,
  hhmm: string,
  timeZone: string = BACKUP_DAILY_TIME_ZONE,
): Date {
  const [hour, minute] = hhmm.split(':').map(Number) as [number, number];
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(now);
  const field = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  const localNow = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    field('hour'),
    field('minute'),
    field('second'),
  );
  const offsetMs = localNow - Math.floor(now.getTime() / 1000) * 1000;
  const localSlot = Date.UTC(field('year'), field('month') - 1, field('day'), hour, minute);
  let slot = localSlot - offsetMs;
  if (slot > now.getTime()) slot -= DAY_MS;
  return new Date(slot);
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
    /** `HH:MM`, or null. Optional so a reader written before the daily time keeps working. */
    readonly dailyTime?: string | null;
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
  readonly environment: {
    readonly enabled: boolean;
    readonly intervalMs: number;
    /** `BACKUP_DAILY_TIME`; empty or absent: none. */
    readonly dailyTime?: string;
  };
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
        ? { enabled: null, intervalMinutes: null, dailyTime: null }
        : await this.deps.settings.read(scope);
    const storedDaily = stored.dailyTime ?? null;
    const envDaily = (environment.dailyTime ?? '') === '' ? null : (environment.dailyTime ?? null);
    // An interval the operator stored is a choice of interval: it beats the environment's daily
    // default, or a new install's 04:00 could never be changed to "every 6 hours".
    const dailyTime = storedDaily ?? (stored.intervalMinutes === null ? envDaily : null);
    return {
      enabled: stored.enabled ?? environment.enabled,
      intervalMs:
        dailyTime !== null
          ? DAY_MS
          : stored.intervalMinutes === null
            ? environment.intervalMs
            : stored.intervalMinutes * 60_000,
      dailyTime,
      source: {
        enabled: stored.enabled === null ? 'ENVIRONMENT' : 'SETTING',
        interval: stored.intervalMinutes === null ? 'ENVIRONMENT' : 'SETTING',
        dailyTime: storedDaily === null ? 'ENVIRONMENT' : 'SETTING',
      },
    };
  }
}
