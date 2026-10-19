import { z } from 'zod';
import { LEGACY_HISTORY_RECORD_TYPES, type LegacyHistoryRecordType } from './legacy-nxpkg.js';

/**
 * «فشرده‌سازی داده‌های ربات قبلی» — compacting the imported legacy data (Round 4 PR-E, E1).
 *
 * An OWNER action, irreversible, available only once the import has completed and while no
 * import is in flight. It is executed by the WORKER, never inside an HTTP request, through
 * these stages, each resumable from its recorded cursor:
 *
 *   ARCHIVING   a full, verified backup titled «آرشیو ربات قبلی», delivered to the BACKUPS
 *               topic in parts. Nothing is deleted unless EVERY part has a Telegram
 *               message id; otherwise the run FAILS here with nothing changed.
 *   MEASURING   sizes and row counts before.
 *   DROPPING    deletes the record types no reader reads (`LEGACY_COMPACTION_DROP_TYPES`,
 *               the read map in `docs/legacy-migration/compaction.md`), in keyset batches.
 *   DEDUPING    deletes `archive_row` records of the invoice table that have a twin in
 *               `legacy_invoice_archive` (which every invoice reader reads).
 *   STRIPPING   removes the top-level live-state flags (all false) from the kept payloads.
 *   VACUUMING   VACUUM FULL of the compacted tables — the maintenance window.
 *   COMPLETED   sizes and row counts after, beside the before.
 *
 * One audit row per BATCH, never per row.
 */
export const LEGACY_COMPACTION_STATES = [
  'REQUESTED',
  'ARCHIVING',
  'MEASURING',
  'DROPPING',
  'DEDUPING',
  'STRIPPING',
  'VACUUMING',
  'COMPLETED',
  'FAILED',
] as const;
export type LegacyCompactionState = (typeof LEGACY_COMPACTION_STATES)[number];

/** The states a run is still working in; at most one per tenant (a partial unique index). */
export const LEGACY_COMPACTION_ACTIVE_STATES = [
  'REQUESTED',
  'ARCHIVING',
  'MEASURING',
  'DROPPING',
  'DEDUPING',
  'STRIPPING',
  'VACUUMING',
] as const;

/** Why a run failed. A code, never a message. */
export const LEGACY_COMPACTION_FAILURE_CODES = [
  'legacy_compaction.archive_failed',
  'legacy_compaction.archive_not_delivered',
  'legacy_compaction.import_not_completed',
  'legacy_compaction.step_failed',
] as const;
export type LegacyCompactionFailureCode = (typeof LEGACY_COMPACTION_FAILURE_CODES)[number];

/**
 * The record types the compaction deletes: the owner's import-decision types that NO code
 * reads by type, plus the other types the read map found unread. Every type a page, a bot
 * flow, the money reconciliation, the service history or a materialize step reads is KEPT,
 * even where the owner listed it (`service_ownership`, `wallet_history_check`,
 * `wallet_difference`, `product_mapping_proposal`, `panel_registry`, `category_catalogue`,
 * `agent_state` are all read and therefore kept). `tests/unit/legacy-compaction-read-map.test.ts`
 * fails the day a reader of any of these appears.
 */
export const LEGACY_COMPACTION_DROP_TYPES = [
  'panel_target',
  'panel_mapping_template',
  'configuration_row',
  'manual_config_inventory',
  'agent_invoice',
  'agent_log',
  'agent_usage',
  'agent_request',
  'ad_campaign',
  'program_setting',
  'support_department',
] as const satisfies readonly LegacyHistoryRecordType[];

/** The typed confirmation, ASCII so it types the same on every keyboard. */
export const LEGACY_COMPACTION_CONFIRMATION_PHRASE = 'COMPACT LEGACY DATA';

/** The title the one-time archive backup is delivered under. */
export const LEGACY_COMPACTION_ARCHIVE_TITLE = 'آرشیو ربات قبلی';

export const LEGACY_COMPACTION_ROUTES = {
  status: '/legacy-compaction',
  request: '/legacy-compaction/request',
} as const;

export const requestLegacyCompactionSchema = z.object({
  idempotencyKey: z.string().min(8).max(255),
  phrase: z.string().max(64),
});
export type RequestLegacyCompaction = z.infer<typeof requestLegacyCompactionSchema>;

const sizesSchema = z.object({
  /** Total relation size per table, in bytes, as strings (bigint). */
  tables: z.record(z.string(), z.string()),
  /** Rows per record type in `legacy_history_records`. */
  recordTypes: z.partialRecord(z.enum(LEGACY_HISTORY_RECORD_TYPES), z.number().int().nonnegative()),
});

export const legacyCompactionRunSchema = z.object({
  id: z.string(),
  state: z.enum(LEGACY_COMPACTION_STATES),
  requestedAt: z.iso.datetime(),
  requestedBy: z.string().nullable(),
  updatedAt: z.iso.datetime(),
  /** The «آرشیو ربات قبلی» backup run, once taken. */
  archiveBackupId: z.string().nullable(),
  deleted: z.number().int().nonnegative(),
  deduplicated: z.number().int().nonnegative(),
  stripped: z.number().int().nonnegative(),
  before: sizesSchema.nullable(),
  after: sizesSchema.nullable(),
  failureCode: z.enum(LEGACY_COMPACTION_FAILURE_CODES).nullable(),
  finishedAt: z.iso.datetime().nullable(),
});
export type LegacyCompactionRun = z.infer<typeof legacyCompactionRunSchema>;

export const legacyCompactionStatusResponseSchema = z.object({
  /** Whether an import has completed and none is in flight: the action's precondition. */
  available: z.boolean(),
  run: legacyCompactionRunSchema.nullable(),
});
export type LegacyCompactionStatusResponse = z.infer<typeof legacyCompactionStatusResponseSchema>;
