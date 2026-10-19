import { describe, expect, it } from 'vitest';
import {
  REMINDER_BURST_CLEARED_CODE,
  REMINDER_BURST_CODE,
  REMINDER_RATE_SETTING_KEYS,
  SERVICE_REMINDER_DEFAULTS,
  opsLogTopicForCode,
  settingDefinition,
} from '@nexa/contracts';
import { importedReminderKinds } from '../../apps/api/src/modules/commerce/provisioning/application/service-reminder.service';
import {
  REMINDER_RATE_HOUR_MS,
  REMINDER_RATE_MINUTE_MS,
  decideReminderBurst,
  reminderAllowance,
  reminderBurstEvent,
  reminderIsFresh,
  rollReminderWindow,
} from '../../apps/api/src/modules/commerce/messaging/application/reminder-rate';

/**
 * Round 4 PR-H — the pure decisions behind post-import safety: which kinds an import
 * baseline makes history, and the reminder ceiling's window and alarm.
 */

const DAY = 86_400_000;
const IMPORT = new Date('2026-10-04T08:00:00.000Z');
const LIMIT = 100n;

function candidate(input: {
  readonly daysLeftAtImport: number | null;
  readonly usedAtImport?: bigint | null;
  readonly baseline?: boolean;
}) {
  return {
    expiresAt:
      input.daysLeftAtImport === null
        ? null
        : new Date(IMPORT.getTime() + input.daysLeftAtImport * DAY),
    expiryDayStartsAt: null,
    trafficLimitBytes: LIMIT,
    importBaseline:
      input.baseline === false
        ? null
        : { at: IMPORT, usedBytes: input.usedAtImport === undefined ? 0n : input.usedAtImport },
  };
}

describe('importedReminderKinds — what was already behind a service at its import', () => {
  it('nothing for a native service (no baseline)', () => {
    expect(
      importedReminderKinds(
        candidate({ daysLeftAtImport: -3, usedAtImport: 100n, baseline: false }),
        SERVICE_REMINDER_DEFAULTS,
      ),
    ).toEqual({ expiry: [], usage: [] });
  });

  it('every expiry rung of a service that was expired at the import', () => {
    expect(
      importedReminderKinds(candidate({ daysLeftAtImport: -1 }), SERVICE_REMINDER_DEFAULTS).expiry,
    ).toEqual(['EXPIRY_EARLY', 'EXPIRY_FIRST', 'EXPIRY_SECOND', 'EXPIRY_DAY', 'EXPIRED']);
  });

  it('judges under the thresholds in force NOW, not those of the import', () => {
    // Eight days left at the import: nothing behind it under the defaults (a week)...
    expect(
      importedReminderKinds(candidate({ daysLeftAtImport: 8 }), SERVICE_REMINDER_DEFAULTS).expiry,
    ).toEqual([]);
    // ...and the week-out rung once an operator moves it to ten days.
    expect(
      importedReminderKinds(candidate({ daysLeftAtImport: 8 }), {
        ...SERVICE_REMINDER_DEFAULTS,
        expiryEarlyDays: 10,
      }).expiry,
    ).toEqual(['EXPIRY_EARLY']);
  });

  it('a usage kind the imported figure had reached, and none it had not', () => {
    expect(
      importedReminderKinds(
        candidate({ daysLeftAtImport: 20, usedAtImport: 92n }),
        SERVICE_REMINDER_DEFAULTS,
      ).usage,
    ).toEqual(['USAGE_FIRST', 'USAGE_SECOND']);
    expect(
      importedReminderKinds(
        candidate({ daysLeftAtImport: 20, usedAtImport: 92n }),
        SERVICE_REMINDER_DEFAULTS,
      ).usage,
    ).not.toContain('USAGE_FINAL');
  });

  it('no usage kind when the import measured nothing (or the allowance has moved)', () => {
    expect(
      importedReminderKinds(
        candidate({ daysLeftAtImport: 20, usedAtImport: null }),
        SERVICE_REMINDER_DEFAULTS,
      ).usage,
    ).toEqual([]);
  });
});

describe('the reminder ceiling', () => {
  const T = new Date('2026-10-19T10:00:00.000Z');
  const later = (ms: number) => new Date(T.getTime() + ms);
  const stored = {
    minuteStartedAt: T,
    minuteClaimed: 4,
    hourStartedAt: T,
    hourFresh: 40,
    burstOpen: false,
  };

  it('starts both windows empty the first time', () => {
    expect(rollReminderWindow(null, T)).toEqual({
      minuteStartedAt: T,
      minuteClaimed: 0,
      hourStartedAt: T,
      hourFresh: 0,
      burstOpen: false,
      endedHourFresh: null,
    });
  });

  it('keeps a running minute, and starts a new one once it has run its length', () => {
    expect(rollReminderWindow(stored, later(REMINDER_RATE_MINUTE_MS - 1))).toMatchObject({
      minuteClaimed: 4,
      hourFresh: 40,
      endedHourFresh: null,
    });
    expect(rollReminderWindow(stored, later(REMINDER_RATE_MINUTE_MS))).toMatchObject({
      minuteStartedAt: later(REMINDER_RATE_MINUTE_MS),
      minuteClaimed: 0,
      hourFresh: 40,
    });
  });

  it('ends an hour and reports what it counted', () => {
    expect(rollReminderWindow(stored, later(REMINDER_RATE_HOUR_MS))).toMatchObject({
      hourFresh: 0,
      endedHourFresh: 40,
      minuteClaimed: 0,
    });
  });

  it('allows what the minute leaves, within the pass', () => {
    expect(reminderAllowance({ minuteClaimed: 4 }, 5, 200)).toBe(1);
    expect(reminderAllowance({ minuteClaimed: 5 }, 5, 200)).toBe(0);
    expect(reminderAllowance({ minuteClaimed: 9 }, 5, 200)).toBe(0);
    expect(reminderAllowance({ minuteClaimed: 0 }, 300, 120)).toBe(120);
  });

  it('a reminder is fresh for an hour after it was raised', () => {
    expect(reminderIsFresh(T, later(REMINDER_RATE_HOUR_MS - 1))).toBe(true);
    expect(reminderIsFresh(T, later(REMINDER_RATE_HOUR_MS))).toBe(false);
  });
});

describe('the burst alarm', () => {
  it('opens once above the threshold, never while already open', () => {
    expect(
      decideReminderBurst({ hourFresh: 1001, burstOpen: false, endedHourFresh: null }, 1000),
    ).toBe('OPEN');
    expect(
      decideReminderBurst({ hourFresh: 1000, burstOpen: false, endedHourFresh: null }, 1000),
    ).toBe('NONE');
    expect(
      decideReminderBurst({ hourFresh: 5000, burstOpen: true, endedHourFresh: null }, 1000),
    ).toBe('NONE');
  });

  it('closes only when a whole hour has ENDED at or below it', () => {
    expect(decideReminderBurst({ hourFresh: 0, burstOpen: true, endedHourFresh: 1000 }, 1000)).toBe(
      'CLOSE',
    );
    // The hour that ended was still a burst.
    expect(decideReminderBurst({ hourFresh: 0, burstOpen: true, endedHourFresh: 1001 }, 1000)).toBe(
      'NONE',
    );
    // A quiet moment mid-hour is not an hour.
    expect(decideReminderBurst({ hourFresh: 0, burstOpen: true, endedHourFresh: null }, 1000)).toBe(
      'NONE',
    );
  });

  it('switched off (zero): never opens, and closes one left open', () => {
    expect(
      decideReminderBurst({ hourFresh: 99_999, burstOpen: false, endedHourFresh: null }, 0),
    ).toBe('NONE');
    expect(decideReminderBurst({ hourFresh: 0, burstOpen: true, endedHourFresh: null }, 0)).toBe(
      'CLOSE',
    );
  });

  it('records the condition and its recovery under one dedupe key, in the ERRORS topic', () => {
    const facts = { hourFresh: 1200, burstPerHour: 1000, perMinute: 300 };
    const open = reminderBurstEvent('OPEN', facts);
    const close = reminderBurstEvent('CLOSE', facts);
    expect(open).toMatchObject({ code: REMINDER_BURST_CODE, severity: 'ERROR' });
    expect(close).toMatchObject({
      code: REMINDER_BURST_CLEARED_CODE,
      recoversCode: REMINDER_BURST_CODE,
      recoversDedupeKey: open.dedupeKey,
    });
    expect(opsLogTopicForCode(open.code)).toBe('ERRORS');
    expect(opsLogTopicForCode(close.code)).toBe('ERRORS');
    // The owner's rule for every UI string and log: never the previous bot's name.
    expect(`${open.message} ${close.message}`).not.toMatch(/mirza|میرزا/i);
  });

  it('the two settings are declared, with the defaults the docs name', () => {
    expect(settingDefinition(REMINDER_RATE_SETTING_KEYS.maxPerMinute).defaultValue).toBe(300);
    expect(settingDefinition(REMINDER_RATE_SETTING_KEYS.burstAlarmPerHour)).toMatchObject({
      defaultValue: 1000,
      zeroMeaning: 'DISABLES',
    });
  });
});
