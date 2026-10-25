import { z } from 'zod';

/**
 * Data compaction («فشرده‌سازی داده‌های قدیمی», Round 9 C3 — the round prompt's "R5D").
 *
 * No earlier record of R5D exists in this repository; this is built from the round prompt's
 * own description, BESIDE the two jobs that already bound growth and without repeating
 * either: the legacy-data compaction (`legacy-compaction.ts`, an owner one-shot over the
 * imported Mirza rows) and the E3 retention jobs (`data-retention.ts`: the outbox's
 * published history and the interactive idempotency keys).
 *
 * What this one removes is a CLOSED ALLOW-LIST of classes, each a set of rows whose life is
 * over and that nothing reads for money, reconciliation, history or dedupe once a retention
 * has passed. The allow-list, with the reason per table and the tables that are PROTECTED
 * and why, lives beside the code that deletes (`modules/platform/data-compaction`); a test
 * fails the moment a protected table is named there. Ledger entries, payments, orders,
 * services, receipts, refunds, audit rows, the consumers' dedupe ledger and every legacy
 * money record are protected and are never a class.
 *
 * DRY RUN IS THE DEFAULT. `retention.compaction_mode` starts at `DRY_RUN`: the worker counts
 * what it WOULD remove and deletes nothing until the owner changes the mode to `APPLY`.
 */

/** The classes, each removed as one unit (its tables in one batch transaction). */
export const DATA_COMPACTION_CLASSES = [
  /** Finished operator-lane notifications, with their delivery attempts and released claims. */
  'OPS_NOTIFICATIONS',
  /** Resolved customer notifications of the kinds a producer can never raise again. */
  'CUSTOMER_NOTIFICATIONS',
  /** Closed receipt windows of a payment attempt (manual transfer and provider receipts). */
  'RECEIPT_WINDOWS',
] as const;
export type DataCompactionClass = (typeof DATA_COMPACTION_CLASSES)[number];

/** The tables each class removes rows from, children first: the counts are reported per table. */
export const DATA_COMPACTION_CLASS_TABLES = {
  OPS_NOTIFICATIONS: [
    'notification_released_claims',
    'notification_delivery_attempts',
    'notifications',
  ],
  CUSTOMER_NOTIFICATIONS: ['customer_notifications'],
  RECEIPT_WINDOWS: ['receipt_captures', 'gateway_receipt_captures'],
} as const satisfies Record<DataCompactionClass, readonly string[]>;
export type DataCompactionTable =
  (typeof DATA_COMPACTION_CLASS_TABLES)[DataCompactionClass][number];

export const DATA_COMPACTION_MODES = ['DRY_RUN', 'APPLY'] as const;
export type DataCompactionMode = (typeof DATA_COMPACTION_MODES)[number];

export const DATA_COMPACTION_SETTING_KEYS = {
  mode: 'retention.compaction_mode',
  opsNotificationsDays: 'retention.ops_notifications_days',
  customerNotificationsDays: 'retention.customer_notifications_days',
  receiptWindowsDays: 'retention.receipt_windows_days',
} as const;

/** Which day setting each class reads. */
export const DATA_COMPACTION_CLASS_SETTING = {
  OPS_NOTIFICATIONS: DATA_COMPACTION_SETTING_KEYS.opsNotificationsDays,
  CUSTOMER_NOTIFICATIONS: DATA_COMPACTION_SETTING_KEYS.customerNotificationsDays,
  RECEIPT_WINDOWS: DATA_COMPACTION_SETTING_KEYS.receiptWindowsDays,
} as const satisfies Record<DataCompactionClass, string>;

export const DATA_COMPACTION_MODE_DEFAULT: DataCompactionMode = 'DRY_RUN';

/*
 * The days. Conservative defaults, and a MINIMUM of 30 for every class: far beyond any lease,
 * catch-up window or redelivery that could still touch a row — a notification claim's lease is
 * minutes, a nightly report looks back two days, Telegram redelivers an update for one day.
 */
export const DATA_COMPACTION_DAYS_MIN = 30;
export const DATA_COMPACTION_DAYS_MAX = 3650;
export const OPS_NOTIFICATIONS_RETENTION_DAYS_DEFAULT = 90;
export const CUSTOMER_NOTIFICATIONS_RETENTION_DAYS_DEFAULT = 180;
export const RECEIPT_WINDOWS_RETENTION_DAYS_DEFAULT = 90;

export const DATA_COMPACTION_DAYS_DEFAULTS = {
  OPS_NOTIFICATIONS: OPS_NOTIFICATIONS_RETENTION_DAYS_DEFAULT,
  CUSTOMER_NOTIFICATIONS: CUSTOMER_NOTIFICATIONS_RETENTION_DAYS_DEFAULT,
  RECEIPT_WINDOWS: RECEIPT_WINDOWS_RETENTION_DAYS_DEFAULT,
} as const satisfies Record<DataCompactionClass, number>;

/** One batch: rows of a class's PARENT table per transaction. */
export const DATA_COMPACTION_BATCH_SIZE = 5000;

/** Who started a pass. A web request only previews; it never starts one. */
export const DATA_COMPACTION_TRIGGERS = ['WORKER', 'CLI'] as const;
export type DataCompactionTrigger = (typeof DATA_COMPACTION_TRIGGERS)[number];

export const DATA_COMPACTION_RUN_STATES = ['RUNNING', 'COMPLETED', 'STOPPED', 'FAILED'] as const;
export type DataCompactionRunState = (typeof DATA_COMPACTION_RUN_STATES)[number];

/**
 * Why a pass stopped before the end, or did not start. A recovery or a backup in flight is a
 * reason to wait, never to race: the restore decides what the database holds, and a backup
 * is the file a restore will read.
 */
export const DATA_COMPACTION_STOP_REASONS = [
  'RECOVERY_IN_FLIGHT',
  'BACKUP_IN_FLIGHT',
  'SCOPE_INACTIVE',
  'BATCH_CEILING',
  /** A RUNNING row whose heartbeat went stale: failed by the next pass, never adopted. */
  'ABANDONED',
  'ERROR',
] as const;
export type DataCompactionStopReason = (typeof DATA_COMPACTION_STOP_REASONS)[number];

export const DATA_COMPACTION_ROUTES = {
  preview: '/data-compaction/preview',
} as const;

const tableCountsSchema = z.record(z.string(), z.number().int().nonnegative());

export const dataCompactionRunSchema = z.object({
  id: z.string(),
  trigger: z.enum(DATA_COMPACTION_TRIGGERS),
  mode: z.enum(DATA_COMPACTION_MODES),
  state: z.enum(DATA_COMPACTION_RUN_STATES),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  /** Rows per table: what WOULD go in a dry run, what went in an applied one. */
  counts: tableCountsSchema,
  stopReason: z.enum(DATA_COMPACTION_STOP_REASONS).nullable(),
});
export type DataCompactionRun = z.infer<typeof dataCompactionRunSchema>;

export const dataCompactionPreviewSchema = z.object({
  mode: z.enum(DATA_COMPACTION_MODES),
  /** Null when a pass may run now; otherwise why the worker is waiting. */
  blockedBy: z.enum(DATA_COMPACTION_STOP_REASONS).nullable(),
  classes: z.array(
    z.object({
      class: z.enum(DATA_COMPACTION_CLASSES),
      retentionDays: z.number().int().positive(),
      /** Rows strictly older than this instant are eligible: `[−∞, cutoff)`. */
      cutoff: z.iso.datetime(),
      counts: tableCountsSchema,
    }),
  ),
  lastRun: dataCompactionRunSchema.nullable(),
});
export type DataCompactionPreview = z.infer<typeof dataCompactionPreviewSchema>;
