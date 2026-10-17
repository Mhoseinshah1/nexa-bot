import { describe, expect, it } from 'vitest';
import {
  refuseEarlyReminderDays,
  refuseQuietHours,
  refuseReminderThresholds,
  type TenantContext,
} from '@nexa/contracts';
import {
  QUIET_HOURS_KEYS,
  QuietHoursGuard,
} from '../../apps/api/src/modules/control/settings/application/quiet-hours.guard';
import {
  EarlyReminderDaysGuard,
  REMINDER_THRESHOLD_KEYS,
  ReminderThresholdsGuard,
} from '../../apps/api/src/modules/control/settings/application/reminder-thresholds.guard';
import { MainMenuSettingGuard } from '../../apps/api/src/modules/control/bot-menu-builder/application/main-menu-setting-guard';
import { TrialProductGuard } from '../../apps/api/src/modules/commerce/trials/application/trial-product.guard';
import {
  StarsPerUsdtGuard,
  StarsPricingModeGuard,
} from '../../apps/api/src/modules/commerce/fx/application/stars-pricing.guards';
import { SalesCurrencyChangeGuard } from '../../apps/api/src/modules/commerce/payments/application/sales-currency-change.guard';
import type { SettingChangeGuard } from '../../apps/api/src/modules/control/settings/application/settings.service';
import { PERSIAN_GUARD_SETTING_KEYS, guardSentenceShown } from '../../apps/web/src/setting-checks';

/**
 * C5: the Web Admin shows a settings change guard's 409 sentence as written only for the keys
 * on `PERSIAN_GUARD_SETTING_KEYS`. This pins that list to the API's own guards: the Persian
 * ones are exactly the keys listed, and every English guard's real sentence is refused.
 */

const scope = { tenantId: 't', botInstanceId: null } as unknown as TenantContext;
const tx = {} as never;
const unused = {} as never;

describe('the settings guard allow-list', () => {
  it('is exactly the keys of the guards that write Persian', () => {
    expect([...PERSIAN_GUARD_SETTING_KEYS].sort()).toEqual(
      [
        ...QUIET_HOURS_KEYS,
        ...REMINDER_THRESHOLD_KEYS,
        new EarlyReminderDaysGuard(unused).key,
      ].sort(),
    );
  });

  it('shows every sentence the Persian guards actually write', async () => {
    const guards: SettingChangeGuard[] = [
      ...QuietHoursGuard.all(unused, unused),
      ...ReminderThresholdsGuard.all(unused),
      new EarlyReminderDaysGuard(unused),
    ];
    for (const guard of guards) {
      // A value of the wrong type: each guard's own type refusal, before any read.
      const refusal = await guard.refuseChange(scope, { from: 1, to: { wrong: true } }, tx);
      expect(refusal, guard.key).not.toBeNull();
      expect(guardSentenceShown(guard.key, refusal ?? ''), guard.key).toBe(true);
    }
    const contractRefusals: [string, string | null][] = [
      ['reminders.quiet_hours_start', refuseQuietHours('07:00', '07:00')],
      [
        'reminders.expiry_first_days',
        refuseReminderThresholds({
          expiryFirstDays: 1,
          expirySecondDays: 3,
          usageFirstPercent: 50,
          usageSecondPercent: 80,
          usageFinalPercent: 95,
        }),
      ],
      [
        'reminders.usage_second_percent',
        refuseReminderThresholds({
          expiryFirstDays: 5,
          expirySecondDays: 3,
          usageFirstPercent: 80,
          usageSecondPercent: 50,
          usageFinalPercent: 95,
        }),
      ],
      ['reminders.expiry_early_days', refuseEarlyReminderDays(3, 5)],
    ];
    for (const [key, refusal] of contractRefusals) {
      expect(refusal, key).not.toBeNull();
      expect(guardSentenceShown(key, refusal ?? ''), key).toBe(true);
    }
  });

  it('never shows what the English guards write, and lists none of their keys', async () => {
    const english: [SettingChangeGuard, { from: unknown; to: unknown }][] = [
      [
        new MainMenuSettingGuard({
          findLayout: () => Promise.resolve({ publishedRevision: 1 } as never),
        }),
        { from: null, to: [] },
      ],
      [new TrialProductGuard({ findById: () => Promise.resolve(null) }), { from: null, to: 42 }],
      [new StarsPricingModeGuard(), { from: 'AUTO', to: 'MANUAL' }],
      [
        new StarsPerUsdtGuard({
          lockForUpdate: () => Promise.resolve({ status: 'ACTIVE' } as never),
        }),
        { from: '100', to: '' },
      ],
      [
        new SalesCurrencyChangeGuard({ refundableExposureIn: () => Promise.resolve(2) }),
        { from: 'IRT', to: 'USDT' },
      ],
    ];
    for (const [guard, change] of english) {
      const refusal = await guard.refuseChange(scope, change, tx);
      expect(refusal, guard.key).not.toBeNull();
      expect(PERSIAN_GUARD_SETTING_KEYS.has(guard.key), guard.key).toBe(false);
      expect(guardSentenceShown(guard.key, refusal ?? ''), guard.key).toBe(false);
    }
  });

  it('refuses a Latin letter even on an allow-listed key', () => {
    expect(guardSentenceShown('reminders.expiry_first_days', 'یادآور اول')).toBe(true);
    expect(guardSentenceShown('reminders.expiry_first_days', 'یادآور اول must be earlier')).toBe(
      false,
    );
    expect(guardSentenceShown('reminders.expiry_first_days', 'Only English here.')).toBe(false);
    expect(guardSentenceShown('trial.product_id', 'یادآور اول')).toBe(false);
  });
});
