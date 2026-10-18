import { fireEvent, waitFor, within } from '@testing-library/react';
import { expect } from 'vitest';
import { t } from '../../apps/web/src/i18n/web.fa';
import { openFilterPanel } from './ui-helpers';

/**
 * Drivers for the «از میرزا» badge and the «منبع» filter, shared by the eight lists' tests
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

/** Opens the filter panel and presses the «ربات قبلی» chip of the «منبع» filter. */
export function pickMirzaSource(): void {
  const panel = openFilterPanel();
  fireEvent.click(within(panel).getByRole('button', { name: t('web.source_mirza') }));
}

/** The `source` parameter the page wrote to the address bar. */
export async function sourceInUrl(): Promise<string | null> {
  let seen: string | null = null;
  await waitFor(() => {
    seen = new URLSearchParams(window.location.search).get('source');
    expect(seen).not.toBeNull();
  });
  return seen;
}

/** The list requests that carried `source=<value>`. */
export function requestsWithSource(
  calls: readonly { url: string; method: string }[],
  path: string,
  value: string,
): number {
  return calls.filter(
    (call) =>
      call.method === 'GET' &&
      call.url.includes(path) &&
      new URL(call.url, 'http://x').searchParams.get('source') === value,
  ).length;
}
