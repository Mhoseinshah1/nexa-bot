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
 * Serialises the two boundaries' writes for one tenant, inside the write's transaction
 * (Codex review of PR #107). The infrastructure holds it as a transaction-scoped advisory
 * lock; the guard only says WHEN it is taken.
 */
export interface QuietHoursPairLock {
  lock(scope: ScopeContext, tx: TransactionScope): Promise<void>;
}

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
 *
 * ## Why it takes a lock first
 *
 * Under READ COMMITTED, two concurrent writes — the start moving onto 07:00 while the end
 * moves onto 07:00 — each read the OTHER boundary's old value, each pass, and both commit
 * an equal pair neither would have been allowed to write alone (Codex review of PR #107).
 * The per-key rows share no lock, so this guard takes one of its own, keyed by tenant,
 * BEFORE it reads: the second write waits for the first to commit, and its read then sees
 * what the first wrote.
 */
export class QuietHoursGuard implements SettingChangeGuard {
  constructor(
    readonly key: QuietHoursKey,
    private readonly resolver: SettingsResolver,
    private readonly pair: QuietHoursPairLock,
  ) {}

  /** One guard per boundary, built from the one list, so neither can be forgotten. */
  static all(resolver: SettingsResolver, pair: QuietHoursPairLock): readonly QuietHoursGuard[] {
    return QUIET_HOURS_KEYS.map((key) => new QuietHoursGuard(key, resolver, pair));
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
    // The lock FIRST: the read below must be a statement that starts after any concurrent
    // write of the other boundary has committed.
    await this.pair.lock(scope, tx);
    const other = await this.resolver.valueOf<string>(scope, otherKey, tx);
    return this.key === 'reminders.quiet_hours_start'
      ? refuseQuietHours(change.to, other)
      : refuseQuietHours(other, change.to);
  }
}
