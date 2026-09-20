import { refuseReminderThresholds, type ScopeContext, type SettingKey } from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { SettingsResolver } from './settings-resolver.js';
import type { SettingChangeGuard } from './settings.service.js';

/** The five keys whose values have to agree with one another. */
export const REMINDER_THRESHOLD_KEYS = [
  'reminders.expiry_first_days',
  'reminders.expiry_second_days',
  'reminders.usage_first_percent',
  'reminders.usage_second_percent',
  'reminders.usage_final_percent',
] as const satisfies readonly SettingKey[];

export type ReminderThresholdKey = (typeof REMINDER_THRESHOLD_KEYS)[number];

/**
 * The veto that keeps the five reminder thresholds in a sane order.
 *
 * ## Why a guard and not a schema
 *
 * A `SettingDefinition.schema` sees one value. It can say that a percentage is between
 * one and a hundred; it cannot say that the second threshold must be above the first,
 * because the first is a different row written at a different time. Spreading that rule
 * across five schemas would be five copies of it, and five copies disagree the first
 * time one of them is edited.
 *
 * `SettingChangeGuard` already exists for exactly this shape — `SalesCurrencyChangeGuard`
 * is the other one — and it has the two properties the rule needs: it runs INSIDE the
 * write's own transaction, so it reads the other four values as they will be when this
 * one commits rather than as they were when the request arrived; and it is asked only
 * when the value is really changing, so a replay and a no-op write are not refused by a
 * condition that has nothing to do with them.
 *
 * ## Atomic, in the sense that matters
 *
 * One key moves per request, and the combination is judged as a whole each time. An
 * administrator going from 3/1 to 10/5 therefore passes through 10/1, which is valid,
 * and never through an invalid pair — because a step that would produce one is REFUSED
 * rather than stored and corrected afterwards. There is no window in which the worker
 * could read a combination this guard would have rejected.
 *
 * ## Why the reason is Persian
 *
 * It reaches an administrator verbatim, on the Web Admin settings row and in the
 * Telegram admin section, and it names which of the five is wrong and why. Mirza's
 * answer to the same situation was `⭕️ ورودی نا معتبر` (BC-SB-004) — "invalid input",
 * fired even by button presses — which tells an operator nothing at all.
 */
export class ReminderThresholdsGuard implements SettingChangeGuard {
  constructor(
    readonly key: ReminderThresholdKey,
    private readonly resolver: SettingsResolver,
  ) {}

  /** One guard per key, built from the one list, so none can be forgotten. */
  static all(resolver: SettingsResolver): readonly ReminderThresholdsGuard[] {
    return REMINDER_THRESHOLD_KEYS.map((key) => new ReminderThresholdsGuard(key, resolver));
  }

  async refuseChange(
    scope: ScopeContext,
    change: { readonly from: unknown; readonly to: unknown },
    tx: TransactionScope,
  ): Promise<string | null> {
    /*
     * The proposed value is not trusted to be a number here.
     *
     * The schema has already validated it by the time a guard is asked, and this is the
     * second lock rather than the first: a guard that coerced `undefined` to `NaN` would
     * turn every comparison false and let anything through, silently, which is worse
     * than refusing a value that cannot have reached it.
     */
    if (typeof change.to !== 'number') return 'مقدار باید یک عدد صحیح باشد.';

    const current = await this.resolve(scope, tx);
    return refuseReminderThresholds({ ...current, [this.camel()]: change.to });
  }

  private async resolve(
    scope: ScopeContext,
    tx: TransactionScope,
  ): Promise<{
    expiryFirstDays: number;
    expirySecondDays: number;
    usageFirstPercent: number;
    usageSecondPercent: number;
    usageFinalPercent: number;
  }> {
    const [
      expiryFirstDays,
      expirySecondDays,
      usageFirstPercent,
      usageSecondPercent,
      usageFinalPercent,
    ] = await Promise.all([
      this.resolver.valueOf<number>(scope, 'reminders.expiry_first_days', tx),
      this.resolver.valueOf<number>(scope, 'reminders.expiry_second_days', tx),
      this.resolver.valueOf<number>(scope, 'reminders.usage_first_percent', tx),
      this.resolver.valueOf<number>(scope, 'reminders.usage_second_percent', tx),
      this.resolver.valueOf<number>(scope, 'reminders.usage_final_percent', tx),
    ]);
    return {
      expiryFirstDays,
      expirySecondDays,
      usageFirstPercent,
      usageSecondPercent,
      usageFinalPercent,
    };
  }

  /**
   * This guard's key as the field `refuseReminderThresholds` names it.
   *
   * A MAP rather than a string transform, so adding a sixth key is a compile error here
   * rather than a field name that silently matches nothing and a rule that silently
   * stops applying to it.
   */
  private camel(): keyof Awaited<ReturnType<ReminderThresholdsGuard['resolve']>> {
    const fields = {
      'reminders.expiry_first_days': 'expiryFirstDays',
      'reminders.expiry_second_days': 'expirySecondDays',
      'reminders.usage_first_percent': 'usageFirstPercent',
      'reminders.usage_second_percent': 'usageSecondPercent',
      'reminders.usage_final_percent': 'usageFinalPercent',
    } as const satisfies Record<
      ReminderThresholdKey,
      keyof Awaited<ReturnType<ReminderThresholdsGuard['resolve']>>
    >;
    return fields[this.key];
  }
}
