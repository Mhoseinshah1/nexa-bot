import { sql, type SQL } from 'drizzle-orm';
import { featureFlagDefinition } from '@nexa/contracts';

/**
 * Round 11, B6: the send-time precondition that keeps a QUEUED service reminder from going
 * to a customer who turned the reminders off after it was raised.
 *
 * The reminder sweep already withholds a reminder from an opted-out customer when it raises
 * one (`ServiceReminderService`). This is the second half, for a message that was raised
 * earlier and is still waiting — held by quiet hours overnight, behind a rate limit, or in a
 * retry backoff: it is resolved SUPERSEDED when the dispatcher claims it, exactly as it would
 * be for a renewal that made it stale. Same rule, same flag: a stored opt-out is in force only
 * while `customer_reminder_opt_out` is on, so a message already queued when the installation
 * stops offering the choice is sent.
 *
 * Applies only to the service reminder kinds (the caller is `reminderHolds`); no other
 * notification reads it. `s` is the service the reminder names.
 */
export function customerRemindersOptedOutRefused(): SQL {
  return sql`(
    COALESCE((SELECT f.enabled FROM feature_flag_states f
              WHERE f.tenant_id = s.tenant_id AND f.flag_key = 'customer_reminder_opt_out'),
             ${featureFlagDefinition('customer_reminder_opt_out').defaultEnabled})
    AND EXISTS (SELECT 1 FROM customers cu
                WHERE cu.tenant_id = s.tenant_id
                  AND cu.id = s.customer_id
                  AND cu.reminders_opt_out_at IS NOT NULL)
  )`;
}
