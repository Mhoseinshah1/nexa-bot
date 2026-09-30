import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_NOTIFICATION_KINDS,
  CUSTOMER_NOTIFICATION_PRECONDITIONS,
  CUSTOMER_NOTIFICATION_QUIET_HOURS,
  SERVICE_REMINDER_NOTIFICATION_KINDS,
  featureFlagDefinition,
  parseSettingValue,
  quietHoursContains,
  quietHoursMinuteOfDay,
  refuseQuietHours,
  settingDefinition,
} from '@nexa/contracts';
import { quietHoursEnd } from '../../apps/api/src/infrastructure/time/quiet-hours';

/**
 * HF-A9, the pure halves of quiet hours: the window arithmetic, the timezone conversion,
 * which kinds are held, and the registry entries that configure it.
 *
 * The dispatcher's deferral over real rows — held to the window's end, no duplicate, not
 * sent once stale, disabled means no deferral — is `tests/integration/reminder-quiet-hours`.
 */

const minute = (text: string): number => {
  const value = quietHoursMinuteOfDay(text);
  if (value === null) throw new Error(`not a time: ${text}`);
  return value;
};
const window = (start: string, end: string, timezone: string) => ({
  startMinute: minute(start),
  endMinute: minute(end),
  timezone,
});

describe('the quiet window', () => {
  it('parses HH:MM on a 24-hour clock and nothing else', () => {
    expect(quietHoursMinuteOfDay('00:00')).toBe(0);
    expect(quietHoursMinuteOfDay('08:30')).toBe(510);
    expect(quietHoursMinuteOfDay('23:59')).toBe(1439);
    for (const bad of ['8:00', '24:00', '23:60', '08:00:00', '', ' 08:00', '۰۸:۰۰']) {
      expect(quietHoursMinuteOfDay(bad), bad).toBeNull();
      expect(parseSettingValue('reminders.quiet_hours_start', bad).ok, bad).toBe(false);
    }
  });

  it('is half-open within one day: quiet at the start, not at the end', () => {
    const [start, end] = [minute('01:00'), minute('06:00')];
    expect(quietHoursContains(minute('00:59'), start, end)).toBe(false);
    expect(quietHoursContains(minute('01:00'), start, end)).toBe(true);
    expect(quietHoursContains(minute('05:59'), start, end)).toBe(true);
    expect(quietHoursContains(minute('06:00'), start, end)).toBe(false);
  });

  it('crosses midnight when the start is later than the end', () => {
    const [start, end] = [minute('23:00'), minute('08:00')];
    expect(quietHoursContains(minute('22:59'), start, end)).toBe(false);
    expect(quietHoursContains(minute('23:00'), start, end)).toBe(true);
    expect(quietHoursContains(minute('23:59'), start, end)).toBe(true);
    expect(quietHoursContains(minute('00:00'), start, end)).toBe(true);
    expect(quietHoursContains(minute('07:59'), start, end)).toBe(true);
    expect(quietHoursContains(minute('08:00'), start, end)).toBe(false);
    expect(quietHoursContains(minute('12:00'), start, end)).toBe(false);
  });

  it('is empty, never all day, when the start equals the end — and the write refuses it', () => {
    for (let at = 0; at < 1440; at += 7) {
      expect(quietHoursContains(at, minute('08:00'), minute('08:00'))).toBe(false);
    }
    expect(refuseQuietHours('08:00', '08:00')).toMatch(/یکسان/);
    expect(refuseQuietHours('23:00', '08:00')).toBeNull();
    expect(refuseQuietHours('01:00', '06:00')).toBeNull();
  });
});

describe('quietHoursEnd — the window in the tenant’s timezone', () => {
  // Asia/Tehran is UTC+03:30 all year (no daylight saving since 2022).
  const tehran = window('23:00', '08:00', 'Asia/Tehran');

  it('holds a reminder due at 23:30 Tehran until 08:00 Tehran the next morning', () => {
    // 20:00Z = 23:30 in Tehran on 29 September.
    expect(quietHoursEnd(new Date('2026-09-29T20:00:00.000Z'), tehran)?.toISOString()).toBe(
      '2026-09-30T04:30:00.000Z',
    );
  });

  it('holds one due after midnight until 08:00 of the SAME local day', () => {
    // 01:00Z on 30 September = 04:30 in Tehran.
    expect(quietHoursEnd(new Date('2026-09-30T01:00:00.000Z'), tehran)?.toISOString()).toBe(
      '2026-09-30T04:30:00.000Z',
    );
  });

  it('starts the window at the start minute and ends it at the end minute, exactly', () => {
    // 19:29:59Z = 22:59:59 Tehran: not yet quiet.
    expect(quietHoursEnd(new Date('2026-09-29T19:29:59.000Z'), tehran)).toBeNull();
    // 19:30Z = 23:00 Tehran: quiet.
    expect(quietHoursEnd(new Date('2026-09-29T19:30:00.000Z'), tehran)?.toISOString()).toBe(
      '2026-09-30T04:30:00.000Z',
    );
    // 04:29:30Z = 07:59:30 Tehran: still quiet, thirty seconds to go.
    expect(quietHoursEnd(new Date('2026-09-30T04:29:30.000Z'), tehran)?.toISOString()).toBe(
      '2026-09-30T04:30:00.000Z',
    );
    // 04:30Z = 08:00 Tehran: the window is over.
    expect(quietHoursEnd(new Date('2026-09-30T04:30:00.000Z'), tehran)).toBeNull();
  });

  it('reads the window in the tenant’s zone, not in UTC', () => {
    const at = new Date('2026-09-29T20:00:00.000Z');
    // 23:30 in Tehran is quiet; 20:00 in UTC is not.
    expect(quietHoursEnd(at, tehran)).not.toBeNull();
    expect(quietHoursEnd(at, window('23:00', '08:00', 'UTC'))).toBeNull();
    // And the same wall-clock end is a different instant in each zone.
    const late = new Date('2026-09-29T23:30:00.000Z');
    expect(quietHoursEnd(late, window('23:00', '08:00', 'UTC'))?.toISOString()).toBe(
      '2026-09-30T08:00:00.000Z',
    );
    expect(quietHoursEnd(late, tehran)?.toISOString()).toBe('2026-09-30T04:30:00.000Z');
  });

  it('ends a same-day window on the same day, at a minute that is not on the hour', () => {
    const early = window('01:00', '06:45', 'Asia/Tehran');
    // 23:00Z on 29 September = 02:30 Tehran on 30 September.
    expect(quietHoursEnd(new Date('2026-09-29T23:00:00.000Z'), early)?.toISOString()).toBe(
      '2026-09-30T03:15:00.000Z',
    );
    // 12:00 Tehran is outside it.
    expect(quietHoursEnd(new Date('2026-09-30T08:30:00.000Z'), early)).toBeNull();
  });

  /*
   * Codex review of PR #107: on a fall-back night the end time can occur twice. Inside the
   * repeated hour the clock has already read it once, so the end is the SECOND reading —
   * never the first, which is in the past and would send inside a quiet minute.
   */
  it('ends at the second 01:30 when New York falls back inside the window', () => {
    const newYork = window('00:00', '01:30', 'America/New_York');
    // 06:15Z on 1 November 2026 is the SECOND 01:15 (EST); 01:30 EST is 06:30Z.
    expect(quietHoursEnd(new Date('2026-11-01T06:15:00.000Z'), newYork)?.toISOString()).toBe(
      '2026-11-01T06:30:00.000Z',
    );
    // During the FIRST 01:15 (EDT, 05:15Z) the first 01:30 is still ahead: 05:30Z.
    expect(quietHoursEnd(new Date('2026-11-01T05:15:00.000Z'), newYork)?.toISOString()).toBe(
      '2026-11-01T05:30:00.000Z',
    );
  });

  it('ends at the second 02:30 when Berlin falls back inside the window', () => {
    const berlin = window('01:00', '02:30', 'Europe/Berlin');
    // 01:10Z on 25 October 2026 is the SECOND 02:10 (CET); 02:30 CET is 01:30Z.
    expect(quietHoursEnd(new Date('2026-10-25T01:10:00.000Z'), berlin)?.toISOString()).toBe(
      '2026-10-25T01:30:00.000Z',
    );
  });

  it('keeps resolving a wall time the spring-forward gap swallows as the report calendar does', () => {
    // 02:30 does not exist in Berlin on 29 March 2026 (02:00 CET jumps to 03:00 CEST). It
    // resolves as `localInstant` resolves it — 02:30 read at the pre-change offset, 01:30Z,
    // which is 03:30 CEST — unchanged by the fall-back fix.
    const berlin = window('01:00', '02:30', 'Europe/Berlin');
    expect(quietHoursEnd(new Date('2026-03-29T00:45:00.000Z'), berlin)?.toISOString()).toBe(
      '2026-03-29T01:30:00.000Z',
    );
  });

  it('ends at the local wall time across a daylight-saving change', () => {
    // Berlin leaves summer time at 03:00 CEST on 25 October 2026 (to 02:00 CET). At
    // midnight CEST (22:00Z on the 24th) the window ends at 08:00 CET, which is 07:00Z —
    // not 06:00Z, which the offset in force at the start of the night would give.
    const berlin = window('23:00', '08:00', 'Europe/Berlin');
    expect(quietHoursEnd(new Date('2026-10-24T22:00:00.000Z'), berlin)?.toISOString()).toBe(
      '2026-10-25T07:00:00.000Z',
    );
  });
});

describe('which kinds quiet hours hold', () => {
  const held = CUSTOMER_NOTIFICATION_KINDS.filter(
    (kind) => CUSTOMER_NOTIFICATION_QUIET_HOURS[kind],
  );

  it('is exactly the reminders: every service reminder slot, the wallet alert, the pending two', () => {
    expect([...held].sort()).toEqual(
      [
        ...Object.values(SERVICE_REMINDER_NOTIFICATION_KINDS),
        'WALLET_LOW_BALANCE',
        'PAYMENT_PENDING_REMINDER',
        'ORDER_PENDING_REMINDER',
        // Round N, package D: the reseller month-end reminder (never the achievement).
        'RESELLER_MINIMUM_REMINDER',
      ].sort(),
    );
  });

  it('never holds a reply or a payment or order outcome', () => {
    for (const kind of [
      'PAYMENT_TRANSFER_RECORDED',
      'ORDER_CANCELLED',
      'TICKET_REPLY',
      'PAYMENT_REJECTED',
      'PAYMENT_EXPIRED',
      'ORDER_EXPIRED',
      'ORDER_REFUNDED_TO_WALLET',
      'WALLET_TOPUP_CREDITED',
      'GATEWAY_PAYMENT_FAILED',
      'REFUND_COMPLETED',
      'SERVICE_ACTION_SUCCEEDED',
      'SERVICE_ACTION_FAILED',
    ] as const) {
      expect(CUSTOMER_NOTIFICATION_QUIET_HOURS[kind], kind).toBe(false);
    }
  });

  it('holds only kinds that are re-checked at send time', () => {
    // A held reminder leaves hours after it was raised, and must not leave at all once
    // what it reminds about stopped being true. That is the precondition's job.
    for (const kind of held) {
      expect(CUSTOMER_NOTIFICATION_PRECONDITIONS[kind], kind).toBe(true);
    }
  });
});

describe('the quiet-hours registry entries', () => {
  it('are a switch that is off by default, and two times that configure it', () => {
    const flag = featureFlagDefinition('reminder_quiet_hours');
    expect(flag.defaultEnabled).toBe(false);
    expect([...flag.configuredBy].sort()).toEqual([
      'reminders.quiet_hours_end',
      'reminders.quiet_hours_start',
    ]);
    expect(settingDefinition('reminders.quiet_hours_start').defaultValue).toBe('23:00');
    expect(settingDefinition('reminders.quiet_hours_end').defaultValue).toBe('08:00');
    expect(parseSettingValue('reminders.quiet_hours_end', '07:30').ok).toBe(true);
  });
});
