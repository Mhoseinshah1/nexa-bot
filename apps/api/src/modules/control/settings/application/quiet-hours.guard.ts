import { refuseQuietHours, type ScopeContext, type SettingKey } from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { SettingsResolver } from './settings-resolver.js';
import type { SettingChangeGuard } from './settings.service.js';

/** The quiet window's two boundaries, each checked against the other (HF-A9). */
export const QUIET_HOURS_KEYS = [
  'reminders.quiet_hours_start',
  'reminders.quiet_hours_end',
] as const satisfies readonly SettingKey[];

type QuietHoursKey = (typeof QUIET_HOURS_KEYS)[number];

/**
 * The veto that keeps the quiet window a window: its start and end may not be equal.
 *
 * A guard and not a schema for `ReminderThresholdsGuard`'s reason — each schema sees one
 * value, and this rule is about two rows written at different times. It runs inside the
 * write's own transaction, so it reads the other boundary as it will be when this one
 * commits, and it is asked only when the value really changes.
 *
 * Only equality is refused. Any other pair is a window, including one that crosses
 * midnight, and moving from 23:00–08:00 to 22:00–07:00 passes through 22:00–08:00, which is
 * valid; the one step that could be refused on the way is a boundary typed onto the other,
 * and an operator is told so in Persian.
 */
export class QuietHoursGuard implements SettingChangeGuard {
  constructor(
    readonly key: QuietHoursKey,
    private readonly resolver: SettingsResolver,
  ) {}

  /** One guard per boundary, built from the one list, so neither can be forgotten. */
  static all(resolver: SettingsResolver): readonly QuietHoursGuard[] {
    return QUIET_HOURS_KEYS.map((key) => new QuietHoursGuard(key, resolver));
  }

  async refuseChange(
    scope: ScopeContext,
    change: { readonly from: unknown; readonly to: unknown },
    tx: TransactionScope,
  ): Promise<string | null> {
    // The schema has validated it already; this is the second lock, never a coercion.
    if (typeof change.to !== 'string') return 'ساعت باید به شکل ساعت:دقیقه باشد.';
    const otherKey: QuietHoursKey =
      this.key === 'reminders.quiet_hours_start'
        ? 'reminders.quiet_hours_end'
        : 'reminders.quiet_hours_start';
    const other = await this.resolver.valueOf<string>(scope, otherKey, tx);
    return this.key === 'reminders.quiet_hours_start'
      ? refuseQuietHours(change.to, other)
      : refuseQuietHours(other, change.to);
  }
}
