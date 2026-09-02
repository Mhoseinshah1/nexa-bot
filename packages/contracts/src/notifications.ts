import { z } from 'zod';

/**
 * Notifications.
 *
 * A notification is an INTENT: something happened that somebody should be told
 * about. A delivery attempt is a FACT: on this date, over this transport, the
 * send succeeded or it did not. They are two records, and keeping them apart is
 * the point rather than a detail.
 *
 * The legacy system has one field that is quietly both, which is why
 * `UNK-LGR-015` — "whether the notification report records notifications that
 * were SENT or conditions that merely MATCHED" — cannot be answered from the
 * outside. There is no delivery-status field anywhere in it, no retry, no
 * per-recipient outcome. We are not resolving that question; we are declining to
 * inherit it.
 *
 * See docs/adr/0018-notifications.md.
 */

/**
 * What a notification is about.
 *
 * Registered per emitter. `UNK-GS-011` records that the legacy notification set
 * was never enumerated — eleven forum topics were sampled and the corpus warns
 * that any catalogue drawn from it is a lower bound — so this list is grown by
 * the code that sends, never harvested from the research.
 */
export const NOTIFICATION_KINDS = [
  /** An operational event at or above the configured severity. */
  'OPERATIONAL_EVENT',
  /** An explicit test of the operations destination. */
  'OPERATIONS_TEST',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/**
 * The intent's lifecycle.
 *
 * Deliberately short. There is no `SENDING`: a status that is only true while a
 * worker holds the row is a status that gets stuck when the worker dies, and
 * "which attempt is in flight" is answered by the attempt rows.
 */
export const NOTIFICATION_STATUSES = [
  'PENDING',
  'SENT',
  /** Every permitted attempt was used, or one failed permanently. */
  'FAILED',
] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/**
 * How one attempt ended.
 *
 * The distinction between the two failures is what stops a permanently wrong
 * destination from being retried forever — the slow-motion version of the
 * legacy log group posting the same error sixty times in one day (BUG-LGR-028).
 */
export const DELIVERY_OUTCOMES = ['SUCCEEDED', 'FAILED_RETRYABLE', 'FAILED_PERMANENT'] as const;
export type DeliveryOutcome = (typeof DELIVERY_OUTCOMES)[number];

export const NOTIFICATION_TRANSPORTS = ['TELEGRAM', 'RECORDING'] as const;
export type NotificationTransportKind = (typeof NOTIFICATION_TRANSPORTS)[number];

/**
 * Where a notification was addressed, snapshotted when the intent was created.
 *
 * A snapshot rather than a reference to the setting, following the same rule as
 * every other historical record here: an attempt from March must still say which
 * chat it was addressed to, even after somebody repointed the destination in
 * April. In the legacy system a deleted product collapses to "محصول حذف‌شده"
 * across every past report for precisely the opposite reason.
 */
export const notificationDestinationSchema = z.discriminatedUnion('transport', [
  z.object({
    transport: z.literal('TELEGRAM'),
    chatId: z.string().min(1),
    /** The forum topic, when the destination group uses them (UNK-GS-002). */
    topicId: z.number().int().positive().nullable(),
  }),
  z.object({
    transport: z.literal('RECORDING'),
  }),
]);
export type NotificationDestination = z.infer<typeof notificationDestinationSchema>;
