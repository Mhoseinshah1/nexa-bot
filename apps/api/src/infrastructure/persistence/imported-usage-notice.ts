import { sql, type SQL } from 'drizzle-orm';

/**
 * Round 5A item 1: the one definition of "this usage notice describes a state that already
 * existed when the service was imported", shared by the two places that must agree on it —
 * the reconcile that supersedes what an earlier release queued, and the send-time
 * precondition of the usage kinds.
 *
 * ## The rule
 *
 * An imported service's FIRST measurement after the import is silent (written by
 * `DrizzleServiceRepository.recordUsage` as the baseline's `used_bytes`; the sweep then
 * records every threshold that figure already reached and announces none). So a usage
 * notice on an imported service is legitimate only when its baseline says a figure was
 * measured and the period is still the imported one — the sweep's own decision.
 *
 * A usage notice is therefore a leftover of the first sync (and is not to be sent) when the
 * service is not native and either
 *   - it has no baseline row at all: it was synced before the baseline was written by the
 *     sync, or never baselined, or
 *   - its baseline row carries no figure for the period the service is still in.
 *
 * A baseline with a figure, and a baseline of an earlier period (a renewal or added
 * traffic moved it), are the sweep's to judge and are left alone.
 *
 * `s` is the service, `r` the reminder row the notice names.
 */
export function importedUnmeasuredUsageNotice(): SQL {
  return sql`(
    s.source <> 'NEXA'
    AND NOT EXISTS (
      SELECT 1 FROM service_reminder_baselines b
      WHERE b.tenant_id = s.tenant_id
        AND b.service_id = s.id
        AND (
          b.used_bytes IS NOT NULL
          OR NOT (b.basis_expires_at IS NOT DISTINCT FROM s.expires_at
                  AND b.basis_traffic_limit_bytes = s.traffic_limit_bytes)
        )
    )
  )`;
}
