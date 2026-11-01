import type { Money } from '@nexa/contracts';
import {
  formatBytes,
  formatDateOnly,
  formatDurationDays,
  formatMoney,
  formatTrafficLimit,
} from '@nexa/i18n';
import type {
  SupportFactFormatter,
  SupportPresentation,
} from '../domain/support-context-payload.js';

/**
 * Phase 4 PR-2 — the support context's figures written by the bot's own formatters, so a price
 * reads «150,000 تومان» and a traffic figure «12.5 گیگابایت» exactly as the bot shows them.
 */
export class I18nSupportFactFormatter implements SupportFactFormatter {
  money(value: Money): string {
    return formatMoney(value);
  }

  bytes(bytes: bigint): string {
    return formatBytes(bytes);
  }

  trafficLimit(bytes: bigint): string {
    return formatTrafficLimit(bytes);
  }

  durationDays(days: number): string {
    return formatDurationDays(days);
  }

  date(at: Date, presentation: SupportPresentation): string {
    return formatDateOnly(at, presentation);
  }
}
