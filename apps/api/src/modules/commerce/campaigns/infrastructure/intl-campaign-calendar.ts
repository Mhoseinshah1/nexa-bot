import type { Calendar, TenantContext } from '@nexa/contracts';
import {
  civilDateOf,
  formatLocalDate,
  localInstant,
  parseLocalDate,
  wallTimeOf,
} from '../../../../infrastructure/time/report-calendar.js';
import type { TenantPresentationReader } from '../../../control/templates/application/ports.js';
import type { CampaignCalendar } from '../application/ports.js';

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/u;

/**
 * A campaign window in the tenant's own calendar and zone (`docs/round-n-campaigns-audit.md`
 * D3), over the same ICU arithmetic the reports and the quiet hours use (`localInstant`),
 * so "1405/07/10 14:00" is one instant wherever the operator's browser happens to be.
 */
export class IntlCampaignCalendar implements CampaignCalendar {
  constructor(private readonly presentation: TenantPresentationReader) {}

  presentationFor(
    scope: TenantContext,
    tx?: unknown,
  ): Promise<{ readonly timezone: string; readonly calendar: Calendar }> {
    return this.presentation.presentationFor(scope, tx);
  }

  instantOf(
    date: string,
    time: string,
    presentation: { readonly timezone: string; readonly calendar: Calendar },
  ): Date | null {
    const clock = TIME.exec(time);
    if (clock === null) return null;
    try {
      const civil = parseLocalDate(date);
      const hour = Number(clock[1]);
      const minute = Number(clock[2]);
      const at = localInstant(civil, hour, presentation, minute);
      // A date ICU never names (the 31st of Mehr) must not be rounded into the next one,
      // and a wall time a spring-forward gap swallows (02:30 in Berlin on the last Sunday
      // of March) must not be shifted to the first instant after the gap: both are refused,
      // because the operator would otherwise schedule a moment they did not type.
      const back = civilDateOf(at, presentation);
      const wall = wallTimeOf(at, presentation.timezone);
      if (
        back.year !== civil.year ||
        back.month !== civil.month ||
        back.day !== civil.day ||
        wall.hour !== hour ||
        wall.minute !== minute
      ) {
        return null;
      }
      return at;
    } catch {
      return null;
    }
  }

  localOf(
    at: Date,
    presentation: { readonly timezone: string; readonly calendar: Calendar },
  ): { readonly date: string; readonly time: string } {
    const { hour, minute } = wallTimeOf(at, presentation.timezone);
    return {
      date: formatLocalDate(civilDateOf(at, presentation), '-'),
      time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    };
  }
}
