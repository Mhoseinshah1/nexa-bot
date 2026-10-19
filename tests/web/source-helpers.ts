import { within } from '@testing-library/react';
import { t } from '../../apps/web/src/i18n/web.fa';
import { openFilterPanel } from './ui-helpers';

/**
 * Drivers for the «منتقل‌شده از ربات قبلی» badge and the absent «منبع» filter, shared by the eight lists' tests
 * so each file asserts the same thing the same way.
 */

/** Whether the row that holds `text` carries the badge. */
export function rowHasBadge(text: string): boolean {
  const row = Array.from(document.querySelectorAll('tr')).find((one) =>
    (one.textContent ?? '').includes(text),
  );
  if (row === undefined) throw new Error(`no row holds "${text}"`);
  return within(row).queryByText(t('web.source_badge_mirza')) !== null;
}

/**
 * Round 4 B2: the «منبع» filter is gone from every list. Opens the filter panel and reports
 * whether no «منبع» group (and no «ربات قبلی» chip) is in it.
 */
export function sourceFilterAbsent(): boolean {
  const panel = openFilterPanel();
  return (
    within(panel).queryByText('منبع') === null &&
    within(panel).queryByRole('button', { name: 'ربات قبلی' }) === null
  );
}
