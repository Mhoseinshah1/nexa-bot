import { describe, expect, it } from 'vitest';
import {
  EXPIRY_REMINDER_KINDS,
  PENDING_PAYMENT_REMINDER_MIN_AGE_MINUTES,
  SERVICE_REMINDER_DEFAULTS,
  expiryReminderDue,
  minutesLeft,
  pendingReminderDue,
  refuseEarlyReminderDays,
  settingDefinition,
  featureFlagDefinition,
  usageRemainingPercent,
  usageRemindersReached,
} from '@nexa/contracts';
import { CustomerReminderLoop } from '../../apps/api/src/modules/commerce/messaging/application/customer-reminder-loop';

/**
 * WP-A9, the pure halves: the owner's defaults, the ladder's decision including the day of
 * expiry, the pending-reminder window, the week-out slot's own refusal, and the loop that
 * paces the two account reminders.
 */

const DAY = 86_400_000;
const at = new Date('2026-09-28T10:00:00.000Z');
const after = (ms: number) => new Date(at.getTime() + ms);

describe('the owner’s reminder defaults', () => {
  it('are 7, 3 and 1 days and the day itself, and 20/10/5 percent remaining', () => {
    expect(SERVICE_REMINDER_DEFAULTS).toMatchObject({
      expiryEarlyDays: 7,
      expiryFirstDays: 3,
      expirySecondDays: 1,
      expiryDayEnabled: true,
      usageFirstPercent: 80,
      usageSecondPercent: 90,
      usageFinalPercent: 95,
    });
    expect(
      [
        SERVICE_REMINDER_DEFAULTS.usageFirstPercent,
        SERVICE_REMINDER_DEFAULTS.usageSecondPercent,
        SERVICE_REMINDER_DEFAULTS.usageFinalPercent,
      ].map(usageRemainingPercent),
    ).toEqual([20, 10, 5]);
  });

  it('are what the registries default to', () => {
    expect(settingDefinition('reminders.expiry_early_days').defaultValue).toBe(7);
    expect(settingDefinition('reminders.expiry_first_days').defaultValue).toBe(3);
    expect(settingDefinition('reminders.expiry_second_days').defaultValue).toBe(1);
    expect(settingDefinition('reminders.usage_first_percent').defaultValue).toBe(80);
    expect(settingDefinition('reminders.usage_second_percent').defaultValue).toBe(90);
    expect(settingDefinition('reminders.usage_final_percent').defaultValue).toBe(95);
    expect(featureFlagDefinition('service_expiry_day_reminder').defaultEnabled).toBe(true);
    // Wallet low balance is OFF until an operator enables it, and zero sends nothing.
    expect(featureFlagDefinition('wallet_low_balance_reminders').defaultEnabled).toBe(false);
    expect(settingDefinition('wallet.low_balance.threshold').defaultValue).toEqual({
      amountMinor: '0',
      currency: 'IRT',
    });
    expect(settingDefinition('wallet.low_balance.threshold').zeroMeaning).toBe('DISABLES');
  });

  it('still accept every value a tenant could have stored before WP-A9', () => {
    // The old usage defaults, and the 1..30 day range of the two older slots.
    for (const value of [80, 95, 100]) {
      expect(
        settingDefinition('reminders.usage_final_percent').schema.safeParse(value).success,
      ).toBe(true);
    }
    expect(settingDefinition('reminders.expiry_first_days').schema.safeParse(30).success).toBe(
      true,
    );
    expect(settingDefinition('reminders.expiry_early_days').schema.safeParse(0).success).toBe(true);
    expect(settingDefinition('reminders.expiry_early_days').schema.safeParse(-1).success).toBe(
      false,
    );
  });
});

describe('expiryReminderDue', () => {
  const t = SERVICE_REMINDER_DEFAULTS;

  it('walks the five slots least urgent first', () => {
    expect(EXPIRY_REMINDER_KINDS).toEqual([
      'EXPIRY_EARLY',
      'EXPIRY_FIRST',
      'EXPIRY_SECOND',
      'EXPIRY_DAY',
      'EXPIRED',
    ]);
    const far = after(8 * DAY);
    expect(expiryReminderDue(far, at, t, after(7.5 * DAY))).toBeNull();
    expect(expiryReminderDue(after(6 * DAY), at, t, after(5.6 * DAY))).toBe('EXPIRY_EARLY');
    expect(expiryReminderDue(after(2 * DAY), at, t, after(1.6 * DAY))).toBe('EXPIRY_FIRST');
    expect(expiryReminderDue(after(0.9 * DAY), at, t, after(0.5 * DAY))).toBe('EXPIRY_SECOND');
    expect(expiryReminderDue(after(0.3 * DAY), at, t, after(-0.1 * DAY))).toBe('EXPIRY_DAY');
    expect(expiryReminderDue(after(-1), at, t, after(-DAY))).toBe('EXPIRED');
    expect(expiryReminderDue(null, at, t, null)).toBeNull();
  });

  it('treats the day of expiry as a calendar boundary, not as twenty-four hours', () => {
    // Twenty hours left, but the local day has not begun: the one-day warning.
    expect(expiryReminderDue(after(20 * 3_600_000), at, t, after(3_600_000))).toBe('EXPIRY_SECOND');
    // Two hours left and the day began an hour ago: today.
    expect(expiryReminderDue(after(2 * 3_600_000), at, t, after(-3_600_000))).toBe('EXPIRY_DAY');
  });

  it('never makes the week-out slot due when it is off or not further out than FIRST', () => {
    const off = { ...t, expiryEarlyDays: 0 };
    expect(expiryReminderDue(after(6 * DAY), at, off, after(5.6 * DAY))).toBeNull();
    // A tenant that stored a ten-day first warning: FIRST, never EARLY.
    const stored = { ...t, expiryEarlyDays: 7, expiryFirstDays: 10, expirySecondDays: 5 };
    expect(expiryReminderDue(after(6 * DAY), at, stored, after(5.6 * DAY))).toBe('EXPIRY_FIRST');
    expect(expiryReminderDue(after(9 * DAY), at, stored, after(8.6 * DAY))).toBe('EXPIRY_FIRST');
  });
});

describe('the usage thresholds keep their stored meaning', () => {
  it('are percent USED, so a stored 100 is still the moment the allowance is gone', () => {
    const old = { usageFirstPercent: 80, usageSecondPercent: 95, usageFinalPercent: 100 };
    expect(usageRemindersReached(96n, 100n, old)).toEqual(['USAGE_SECOND', 'USAGE_FIRST']);
    expect(usageRemindersReached(96n, 100n, SERVICE_REMINDER_DEFAULTS)[0]).toBe('USAGE_FINAL');
  });
});

describe('refuseEarlyReminderDays', () => {
  it('accepts zero and anything further out than the first warning', () => {
    expect(refuseEarlyReminderDays(0, 3)).toBeNull();
    expect(refuseEarlyReminderDays(7, 3)).toBeNull();
    expect(refuseEarlyReminderDays(3, 3)).toMatch(/یادآور هفتگی/);
    expect(refuseEarlyReminderDays(2, 3)).toMatch(/یادآور هفتگی/);
  });
});

describe('pendingReminderDue', () => {
  const MIN = 60_000;
  const opened = after(-20 * MIN);

  it('is due inside the lead, before the deadline, for an attempt old enough', () => {
    expect(pendingReminderDue(opened, after(8 * MIN), at, 10)).toBe(true);
    expect(pendingReminderDue(opened, after(11 * MIN), at, 10)).toBe(false);
    // The deadline is half-open: at or past it, it is expired, never reminded.
    expect(pendingReminderDue(opened, at, at, 10)).toBe(false);
    expect(pendingReminderDue(opened, after(-MIN), at, 10)).toBe(false);
  });

  it('is never due for an attempt younger than the floor', () => {
    const young = after(-(PENDING_PAYMENT_REMINDER_MIN_AGE_MINUTES - 1) * MIN);
    expect(pendingReminderDue(young, after(3 * MIN), at, 10)).toBe(false);
  });

  it('rounds the minutes left up and never shows zero', () => {
    expect(minutesLeft(after(7.2 * MIN), at)).toBe(8);
    expect(minutesLeft(after(10), at)).toBe(1);
  });
});

describe('CustomerReminderLoop', () => {
  const logger = { info: () => {}, error: () => {} };
  const scope = { tenantId: 'tenant' as never, botInstanceId: null };

  it('runs each sweep at most once per its own interval', async () => {
    let clock = 0;
    const runs: string[] = [];
    const loop = new CustomerReminderLoop(
      [
        { name: 'fast', everyMs: 0, runOnce: async () => (runs.push('fast'), 0) },
        { name: 'slow', everyMs: 900_000, runOnce: async () => (runs.push('slow'), 0) },
      ],
      { scope: () => scope, intervalMs: 60_000, now: () => clock, logger },
    );
    await loop.tick();
    clock = 60_000;
    await loop.tick();
    clock = 900_000;
    await loop.tick();
    expect(runs).toEqual(['fast', 'slow', 'fast', 'fast', 'slow']);
  });

  it('keeps running the other sweep when one throws, and records no progress for it', async () => {
    let clock = 1_000;
    const runs: string[] = [];
    const loop = new CustomerReminderLoop(
      [
        {
          name: 'broken',
          everyMs: 0,
          runOnce: async () => {
            throw new Error('down');
          },
        },
        { name: 'fine', everyMs: 0, runOnce: async () => (runs.push('fine'), 1) },
      ],
      { scope: () => scope, intervalMs: 60_000, now: () => clock, logger },
    );
    loop.start();
    await loop.tick();
    expect(runs).toEqual(['fine']);
    clock = 1_000 + 10 * 60_000;
    expect(loop.isFresh(clock), 'a failing sweep turns readiness stale').toBe(false);
    await loop.stop();
  });
});
