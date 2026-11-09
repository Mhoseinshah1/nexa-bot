/**
 * Phase 6B PR-3 (ADR-0039, "The open data export") — «خروجی داده».
 *
 * A hosted bot's data in plain, documented formats: a ZIP of CSV files (UTF-8 with a BOM, so a
 * spreadsheet shows Persian) and a `README.fa.md` describing every column. The request is a
 * row (`tenant_data_exports`); the work runs in the worker through the heavy-job queue (kind
 * `EXPORT`), and the finished file is downloadable for `DATA_EXPORT_TTL_MS`.
 */

/**
 * The life of one export. `REQUESTED` waits for the queue, `RUNNING` holds a heavy-job ticket,
 * `READY` has a file and a deadline, `EXPIRED` had its file removed once the deadline passed,
 * `FAILED` ended with a code.
 */
export const DATA_EXPORT_STATES = ['REQUESTED', 'RUNNING', 'READY', 'FAILED', 'EXPIRED'] as const;
export type DataExportState = (typeof DATA_EXPORT_STATES)[number];

/** The states of an export still being made: a tenant holds at most one at a time. */
export const DATA_EXPORT_ACTIVE_STATES: readonly DataExportState[] = ['REQUESTED', 'RUNNING'];

/** A finished export is downloadable for 24 hours, then its file is removed. */
export const DATA_EXPORT_TTL_MS = 24 * 60 * 60 * 1000;

/** The description of every column of every file in the ZIP. */
export const DATA_EXPORT_README_NAME = 'README.fa.md';

/** The download's file name's prefix; the tenant's slug and the date follow. */
export const DATA_EXPORT_FILE_PREFIX = 'nexa-data';
