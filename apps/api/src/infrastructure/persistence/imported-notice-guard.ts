import { sql, type SQL } from 'drizzle-orm';
import { importedUnmeasuredUsageNotice } from './imported-usage-notice.js';

/**
 * Round 5A-2 items 1-4: the ONE send-time precondition for a customer notice derived from the
 * state of a service an import created, and the one definition the queued-notice cleanup
 * shares with it (so a row the cleanup moves is exactly a row the dispatcher would refuse).
 *
 * ## The rule
 *
 * A notice about an imported service is legitimate only for a transition OBSERVED AFTER the
 * import was completed. What proves "observed after" is the service's baseline row
 * (`service_reminder_baselines`): the state the lane held at the moment it took the service
 * over. A reminder is therefore refused when the service is not native and there is no
 * baseline that predates the reminder's own `raised_at` — either no baseline at all (the
 * service was imported before the baseline existed and has not been reconciled), or a
 * baseline written after the reminder (so the reminder was raised from state nobody had
 * recorded as the import's).
 *
 * "Written" is `GREATEST(baseline_at, created_at)`: the import's own seed writes both at one
 * instant, whereas a baseline recorded late (the reconcile, or the first usage sync of a
 * service imported before the seed) has `created_at` after the `baseline_at` it carries, and
 * what it proves starts then. Equal instants refuse: when in doubt, no message.
 *
 * The usage kinds keep the earlier, narrower rule beside it (`importedUnmeasuredUsageNotice`):
 * a baseline with no figure for the period the service is still in.
 *
 * A native service (`source = 'NEXA'`) is never refused by any of this.
 *
 * `s` is the service, `r` the `service_reminders` row the notice names.
 */
export function importedServiceNoticeRefused(family: 'EXPIRY' | 'USAGE'): SQL {
  const unproven = sql`(
    s.source <> 'NEXA'
    AND NOT EXISTS (
      SELECT 1 FROM service_reminder_baselines pb
      WHERE pb.tenant_id = s.tenant_id
        AND pb.service_id = s.id
        AND GREATEST(pb.baseline_at, pb.created_at) < r.raised_at
    )
  )`;
  return family === 'USAGE' ? sql`(${unproven} OR ${importedUnmeasuredUsageNotice()})` : unproven;
}
