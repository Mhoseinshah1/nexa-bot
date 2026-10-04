import { describe, expect, it } from 'vitest';
import { SERVICE_REMINDER_DEFAULTS } from '@nexa/contracts';
import { passedReminderKinds } from '../../apps/api/src/modules/commerce/provisioning/application/service-reminder.service';

/**
 * Migration P6, Item 8 — the one decision the burst seed makes: which thresholds are
 * already behind a service NOW. Built from the sweep's own `expiryReminderDue` prefix and
 * `usageRemindersReached`, so "passed" and "due" cannot disagree.
 */
const DAY = 86_400_000;
const NOW = new Date('2026-10-04T12:00:00.000Z');
const LIMIT = 100n;

function facts(input: {
  readonly daysLeft: number | null;
  readonly used?: bigint;
  readonly limit?: bigint;
  readonly measured?: boolean;
  readonly dayStartsAt?: Date | null;
}) {
  return {
    expiresAt: input.daysLeft === null ? null : new Date(NOW.getTime() + input.daysLeft * DAY),
    expiryDayStartsAt: input.dayStartsAt ?? null,
    trafficLimitBytes: input.limit ?? LIMIT,
    trafficUsedBytes: input.used ?? 0n,
    usageMeasured: input.measured ?? true,
  };
}

describe('passedReminderKinds', () => {
  it('nothing for a healthy service', () => {
    expect(
      passedReminderKinds(facts({ daysLeft: 20, used: 10n }), NOW, SERVICE_REMINDER_DEFAULTS),
    ).toEqual({ expiry: [], usage: [] });
  });

  it('the expiry prefix up to the due rung, least urgent first', () => {
    expect(
      passedReminderKinds(facts({ daysLeft: 5 }), NOW, SERVICE_REMINDER_DEFAULTS).expiry,
    ).toEqual(['EXPIRY_EARLY']);
    expect(
      passedReminderKinds(facts({ daysLeft: 2 }), NOW, SERVICE_REMINDER_DEFAULTS).expiry,
    ).toEqual(['EXPIRY_EARLY', 'EXPIRY_FIRST']);
    expect(
      passedReminderKinds(facts({ daysLeft: 0.5 }), NOW, SERVICE_REMINDER_DEFAULTS).expiry,
    ).toEqual(['EXPIRY_EARLY', 'EXPIRY_FIRST', 'EXPIRY_SECOND']);
  });

  it('the day-of rung from the boundary the query computed', () => {
    const dayStartsAt = new Date(NOW.getTime() - 3_600_000);
    expect(
      passedReminderKinds(facts({ daysLeft: 0.3, dayStartsAt }), NOW, SERVICE_REMINDER_DEFAULTS)
        .expiry,
    ).toEqual(['EXPIRY_EARLY', 'EXPIRY_FIRST', 'EXPIRY_SECOND', 'EXPIRY_DAY']);
  });

  it('every expiry rung once the deadline has passed', () => {
    expect(
      passedReminderKinds(facts({ daysLeft: -1 }), NOW, SERVICE_REMINDER_DEFAULTS).expiry,
    ).toEqual(['EXPIRY_EARLY', 'EXPIRY_FIRST', 'EXPIRY_SECOND', 'EXPIRY_DAY', 'EXPIRED']);
  });

  it('no expiry rung for unlimited validity', () => {
    expect(
      passedReminderKinds(facts({ daysLeft: null }), NOW, SERVICE_REMINDER_DEFAULTS).expiry,
    ).toEqual([]);
  });

  it('every usage threshold reached, lowest first, at the exact boundary', () => {
    const at = (used: bigint) =>
      passedReminderKinds(facts({ daysLeft: null, used }), NOW, SERVICE_REMINDER_DEFAULTS).usage;
    expect(at(79n)).toEqual([]);
    expect(at(80n)).toEqual(['USAGE_FIRST']);
    expect(at(90n)).toEqual(['USAGE_FIRST', 'USAGE_SECOND']);
    expect(at(95n)).toEqual(['USAGE_FIRST', 'USAGE_SECOND', 'USAGE_FINAL']);
    expect(at(140n)).toEqual(['USAGE_FIRST', 'USAGE_SECOND', 'USAGE_FINAL']);
  });

  it('no usage threshold for an unlimited allowance or an unmeasured figure', () => {
    expect(
      passedReminderKinds(
        facts({ daysLeft: null, used: 999n, limit: 0n }),
        NOW,
        SERVICE_REMINDER_DEFAULTS,
      ).usage,
    ).toEqual([]);
    expect(
      passedReminderKinds(
        facts({ daysLeft: null, used: 99n, measured: false }),
        NOW,
        SERVICE_REMINDER_DEFAULTS,
      ).usage,
    ).toEqual([]);
  });

  it('follows the tenant’s configured thresholds, not the defaults', () => {
    const custom = {
      ...SERVICE_REMINDER_DEFAULTS,
      expiryEarlyDays: 0,
      expiryFirstDays: 10,
      expirySecondDays: 4,
      usageFirstPercent: 50,
      usageSecondPercent: 60,
      usageFinalPercent: 70,
    };
    expect(passedReminderKinds(facts({ daysLeft: 6, used: 65n }), NOW, custom)).toEqual({
      expiry: ['EXPIRY_EARLY', 'EXPIRY_FIRST'],
      usage: ['USAGE_FIRST', 'USAGE_SECOND'],
    });
  });

  it('ignores the family switches: a crossing before adoption is never owed later', () => {
    const off = {
      ...SERVICE_REMINDER_DEFAULTS,
      expiryEnabled: false,
      expiredNoticeEnabled: false,
      expiryDayEnabled: false,
      usageEnabled: false,
    };
    expect(passedReminderKinds(facts({ daysLeft: -1, used: 99n }), NOW, off)).toEqual({
      expiry: ['EXPIRY_EARLY', 'EXPIRY_FIRST', 'EXPIRY_SECOND', 'EXPIRY_DAY', 'EXPIRED'],
      usage: ['USAGE_FIRST', 'USAGE_SECOND', 'USAGE_FINAL'],
    });
  });
});
