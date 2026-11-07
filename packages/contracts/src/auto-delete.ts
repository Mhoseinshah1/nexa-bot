import { z } from 'zod';

/**
 * NEXA-OWNER-BATCH-1 PR-3 — automatic deletion of finished services (Mirza «کرون حذف»).
 *
 * Until this, an EXPIRED or SUSPENDED service stayed on its panel for ever and only an
 * operator's «پایان سرویس» removed it. With `service_auto_delete` on, the worker deletes such
 * a service once it has been in that state for the configured number of days, through the
 * SAME provisioning `TERMINATE` an operator's terminate plans — no second deletion path.
 *
 * The rules this file names, stated once:
 *
 * - Off by default (`service_auto_delete`). Every day count defaults to `0`, which switches
 *   its cause off, so turning the flag on with nothing configured deletes nothing.
 * - The clock of a service is `services.state_since`: the moment THIS installation moved it
 *   into its current state (written by the transition itself, from the Clock), or, for a row
 *   that predates the column or was written by an import, the moment the worker first saw it
 *   in that state. It is never back-dated and never guessed from an expiry date, so nothing
 *   imported or already lying expired is due the moment the feature is switched on.
 * - The cause of an EXPIRED service is stored when it expires (`services.expiry_cause`): its
 *   traffic used had reached a finite limit → `TRAFFIC`, otherwise `TIME`. A row expired
 *   before the column existed derives it the same way from the same columns.
 * - One due cycle per (service, `state_since`): a renewal or a resume moves the state and so
 *   starts a new cycle; the warning and the deletion are each made at most once per cycle and
 *   owner (a transfer cancels the scheduled run and the new owner is warned anew), and every
 *   key the deletion takes derives from the cycle's run row.
 * - Never deleted: a service no longer in the cycle's state (renewed, resumed), one with an
 *   open order, a payment not yet decided (a receipt under review is one) or an open
 *   operation, and any service of a tenant that has stopped accepting work. Trials and
 *   reseller services are included.
 * - The deletion is rate-limited per panel (`service.auto_delete.max_per_minute`) at the
 *   moment it is planned into the provisioning queue, so a switch-on with a large backlog
 *   drains at that rate and never in a burst. No refund and no wallet change.
 */

export const SERVICE_AUTO_DELETE_FEATURE = 'service_auto_delete' as const;

export const SERVICE_AUTO_DELETE_SETTING_KEYS = {
  afterTrafficDays: 'service.auto_delete.after_traffic_days',
  afterTimeDays: 'service.auto_delete.after_time_days',
  afterSuspendDays: 'service.auto_delete.after_suspend_days',
  warnHours: 'service.auto_delete.warn_hours',
  maxPerMinute: 'service.auto_delete.max_per_minute',
} as const;

/** A day count: `0` is off; at most ten years. */
export const AUTO_DELETE_DAYS_MIN = 0;
export const AUTO_DELETE_DAYS_MAX = 3650;
/** The warning's lead: `0` is no warning; at most a week. */
export const AUTO_DELETE_WARN_HOURS_MIN = 0;
export const AUTO_DELETE_WARN_HOURS_MAX = 168;
export const AUTO_DELETE_WARN_HOURS_DEFAULT = 24;
/** Deletions planned per minute per panel. */
export const AUTO_DELETE_MAX_PER_MINUTE_MIN = 1;
export const AUTO_DELETE_MAX_PER_MINUTE_MAX = 600;
export const AUTO_DELETE_MAX_PER_MINUTE_DEFAULT = 30;

/** Why an EXPIRED service expired, stored on the service when it expires. */
export const SERVICE_EXPIRY_CAUSES = ['TRAFFIC', 'TIME'] as const;
export type ServiceExpiryCause = (typeof SERVICE_EXPIRY_CAUSES)[number];

/** Which day count a due cycle is measured by. */
export const AUTO_DELETE_CAUSES = ['TRAFFIC', 'TIME', 'SUSPENDED'] as const;
export type AutoDeleteCause = (typeof AUTO_DELETE_CAUSES)[number];
export const autoDeleteCauseSchema = z.enum(AUTO_DELETE_CAUSES);

/**
 * Where one due cycle of one service is.
 *
 * - `SCHEDULED` — the cycle is due (or within the warning's lead): its warning, if any, was
 *   raised with this row, and `delete_after` is the earliest moment it may be deleted.
 * - `PLANNED` — the deletion was planned as a provisioning `TERMINATE` (`operation_id`). Final:
 *   a cycle is never planned twice, whatever the operation's outcome.
 * - `CANCELLED` — the service changed owner while the cycle was SCHEDULED: the warning went to
 *   somebody who no longer holds it. Final; the cycle is scheduled again for the new owner, who
 *   is warned in their turn and never deleted sooner than `warn_hours` after that warning. The
 *   clock (`state_since`) is NOT moved, so a transfer never postpones the deletion beyond
 *   max(its due moment, the last warning + `warn_hours`).
 *
 * A cycle the service left (renewed, resumed) is simply never selected again: its row stays
 * as the record of the warning that was sent.
 */
export const AUTO_DELETE_RUN_STATES = ['SCHEDULED', 'PLANNED', 'CANCELLED'] as const;
export type AutoDeleteRunState = (typeof AUTO_DELETE_RUN_STATES)[number];

/** The states a due cycle is measured in. */
export const AUTO_DELETE_SERVICE_STATES = ['EXPIRED', 'SUSPENDED'] as const;

/**
 * The reason an automatic deletion's TERMINATE carries: on its request audit row, its run row
 * and its event, beside an operator's terminate (`OPERATOR`) and an approved refund request's.
 */
export const SERVICE_TERMINATE_REASON_AUTO_DELETE = 'AUTO_DELETE' as const;

/** The preview's window: what the next day would delete with these settings. */
export const AUTO_DELETE_PREVIEW_WINDOW_HOURS = 24;

const daysSchema = z.coerce.number().int().min(AUTO_DELETE_DAYS_MIN).max(AUTO_DELETE_DAYS_MAX);

/**
 * The Web Admin's live preview: the day counts being edited, before they are saved. Each one
 * absent is the stored setting.
 */
export const serviceAutoDeletePreviewQuerySchema = z
  .object({
    afterTrafficDays: daysSchema.optional(),
    afterTimeDays: daysSchema.optional(),
    afterSuspendDays: daysSchema.optional(),
    warnHours: z.coerce
      .number()
      .int()
      .min(AUTO_DELETE_WARN_HOURS_MIN)
      .max(AUTO_DELETE_WARN_HOURS_MAX)
      .optional(),
  })
  .strict();
export type ServiceAutoDeletePreviewQuery = z.infer<typeof serviceAutoDeletePreviewQuerySchema>;

/**
 * «با این تنظیمات، N سرویس در ۲۴ ساعت آینده حذف می‌شود», per cause. A server count of the
 * services that would become deletable within the window, whether or not the flag is on; the
 * rate limit may spread their deletion further.
 */
export const serviceAutoDeletePreviewResponseSchema = z.object({
  windowHours: z.number().int(),
  traffic: z.number().int().nonnegative(),
  time: z.number().int().nonnegative(),
  suspended: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  enabled: z.boolean(),
});
export type ServiceAutoDeletePreviewResponse = z.infer<
  typeof serviceAutoDeletePreviewResponseSchema
>;

/** The Web Admin's preview route (under the admin API base), served by the services controller. */
export const SERVICE_AUTO_DELETE_PREVIEW_ROUTE = '/services/auto-delete/preview' as const;
