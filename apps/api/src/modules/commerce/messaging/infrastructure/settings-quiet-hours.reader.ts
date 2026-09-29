import {
  quietHoursMinuteOfDay,
  type FeatureFlagKey,
  type ScopeContext,
  type SettingKey,
  type TenantContext,
} from '@nexa/contracts';
import { quietHoursEnd } from '../../../../infrastructure/time/quiet-hours.js';
import type {
  QuietHoursReader,
  QuietHoursSchedule,
} from '../application/customer-notification.service.js';

/**
 * HF-A9: the tenant's quiet window, from the flag, its two settings and the tenant's
 * display timezone.
 *
 * READERS only, narrowed to one method each, for the reason `ServiceReminderService` gives:
 * a background loop holding a settings or flags SERVICE could write one, and the write paths
 * are where the permission check, the audit and the combination guard live. Read per pass
 * and never cached across one, so an operator's edit applies from the next minute — the
 * `RUNTIME` mutability both settings declare. The timezone is the one every rendered date
 * uses (`tenants.display_timezone`, through the cached presentation reader), so the quiet
 * window and "expires today" agree about what local midnight is.
 *
 * `null` — no quiet hours — when the flag is off, and also when the two stored boundaries
 * do not describe a window: a value the schema would refuse, or a start equal to its end.
 * Neither can be written (the schema and `QuietHoursGuard` refuse both); a row that reached
 * the database some other way must fail OPEN here, sending reminders as before, rather than
 * hold every reminder for ever.
 */
export class SettingsQuietHoursReader implements QuietHoursReader {
  constructor(
    private readonly deps: {
      readonly settings: {
        valueOf<T>(scope: ScopeContext, key: SettingKey, tx?: unknown): Promise<T>;
      };
      readonly features: {
        isEnabled(scope: ScopeContext, key: FeatureFlagKey, tx?: unknown): Promise<boolean>;
      };
      readonly presentation: {
        presentationFor(scope: ScopeContext): Promise<{ readonly timezone: string }>;
      };
    },
  ) {}

  async scheduleFor(scope: TenantContext): Promise<QuietHoursSchedule | null> {
    if (!(await this.deps.features.isEnabled(scope, 'reminder_quiet_hours'))) return null;
    const [start, end] = await Promise.all([
      this.deps.settings.valueOf<string>(scope, 'reminders.quiet_hours_start'),
      this.deps.settings.valueOf<string>(scope, 'reminders.quiet_hours_end'),
    ]);
    const startMinute = quietHoursMinuteOfDay(start);
    const endMinute = quietHoursMinuteOfDay(end);
    if (startMinute === null || endMinute === null || startMinute === endMinute) return null;
    const { timezone } = await this.deps.presentation.presentationFor(scope);
    const window = { startMinute, endMinute, timezone };
    return { quietUntil: (at) => quietHoursEnd(at, window) };
  }
}
