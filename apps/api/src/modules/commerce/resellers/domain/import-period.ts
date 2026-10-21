import type { RecordSource } from '@nexa/contracts';

/**
 * Round 5A-2 item 4: whether a month may count against, or be told to, a reseller.
 *
 * A reseller the one-time Mirza import wrote (`source <> 'NEXA'`) was selling under the
 * previous bot for any month that began before the import completed: its sales so far this
 * month are partly invisible here, so "behind the minimum" would be a claim about a period
 * Nexa did not observe. The month counts from the LATER of the import and the reseller's
 * activation in Nexa; `created_at` is both — the import writes the row at the moment the
 * reseller exists here, and a native reseller's row is its activation. So:
 *
 *   - a native reseller: every month counts, exactly as before;
 *   - an imported reseller: the month counts only if it began at or after the row's creation.
 *
 * Shared by the sweep (creation), the dispatcher's precondition (send time, in SQL beside
 * `resellerMinimumReminderHolds`) and the queued-notice cleanup, which spell the same
 * comparison: `period_start >= created_at`. Nothing here demotes, fees or suspends anyone —
 * the minimum is tracking only.
 */
export function monthCountsForReseller(
  reseller: { readonly source: RecordSource; readonly createdAt: Date },
  periodStart: Date,
): boolean {
  return reseller.source === 'NEXA' || periodStart.getTime() >= reseller.createdAt.getTime();
}
