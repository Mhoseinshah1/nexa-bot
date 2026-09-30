import { describe, expect, it } from 'vitest';
import { IntlCampaignCalendar } from '../../apps/api/src/modules/commerce/campaigns/infrastructure/intl-campaign-calendar';

/**
 * A campaign window is entered in the TENANT's calendar and zone
 * (`docs/round-n-campaigns-audit.md` D3), never the operator's browser's. These pin the
 * conversion both ways, and that a date the calendar does not have is refused rather
 * than rolled into the next month.
 */
describe('campaign calendar', () => {
  const calendar = new IntlCampaignCalendar({
    presentationFor: () => Promise.resolve({ timezone: 'Asia/Tehran', calendar: 'jalali' }),
  });
  const tehranJalali = { timezone: 'Asia/Tehran', calendar: 'jalali' } as const;

  it('reads a Jalali date and a Tehran wall time as one UTC instant', () => {
    // 10 Mehr 1405 is 2 October 2026; Tehran is UTC+03:30 all year since 2022.
    expect(calendar.instantOf('1405-07-10', '14:00', tehranJalali)?.toISOString()).toBe(
      '2026-10-02T10:30:00.000Z',
    );
  });

  it('reads a Gregorian tenant in its own zone', () => {
    expect(
      calendar
        .instantOf('2026-10-02', '09:15', { timezone: 'Europe/Berlin', calendar: 'gregorian' })
        ?.toISOString(),
    ).toBe('2026-10-02T07:15:00.000Z');
  });

  it('writes a stored instant back in the same form', () => {
    expect(calendar.localOf(new Date('2026-10-02T10:30:00.000Z'), tehranJalali)).toEqual({
      date: '1405-07-10',
      time: '14:00',
    });
  });

  it('refuses a date the calendar does not have, and an unreadable time', () => {
    // Mehr has 30 days: the 31st must not become 1 Aban.
    expect(calendar.instantOf('1405-07-31', '10:00', tehranJalali)).toBeNull();
    expect(calendar.instantOf('1405-13-01', '10:00', tehranJalali)).toBeNull();
    expect(calendar.instantOf('1405-07-10', '24:00', tehranJalali)).toBeNull();
    expect(calendar.instantOf('1405-07-10', '9:00', tehranJalali)).toBeNull();
    expect(calendar.instantOf('10/07/1405', '10:00', tehranJalali)).toBeNull();
  });

  it('refuses a wall time a spring-forward gap swallows, rather than shifting it', () => {
    const berlin = { timezone: 'Europe/Berlin', calendar: 'gregorian' } as const;
    // 29 March 2026: Berlin's clocks go from 02:00 to 03:00. 02:30 never happens.
    expect(calendar.instantOf('2026-03-29', '02:30', berlin)).toBeNull();
    // Either side of the gap is an ordinary time.
    expect(calendar.instantOf('2026-03-29', '01:30', berlin)?.toISOString()).toBe(
      '2026-03-29T00:30:00.000Z',
    );
    expect(calendar.instantOf('2026-03-29', '03:30', berlin)?.toISOString()).toBe(
      '2026-03-29T01:30:00.000Z',
    );
  });
});
