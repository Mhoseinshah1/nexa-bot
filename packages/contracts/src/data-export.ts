import { z } from 'zod';
import { secondFactorProofSchema } from './admin-security.js';

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

/**
 * Every refusal of the data export. «آماده نیست» and «منقضی شد» are the two the ADR names; the
 * others are what a request and a download can meet.
 */
export const DATA_EXPORT_ERROR_CODES = {
  /** The file is not made yet (still queued or running), or the export failed. */
  NOT_READY: 'data_export.not_ready',
  /** The 24 h deadline passed; the file is gone. Ask for a new export. */
  EXPIRED: 'data_export.expired',
  /** No such export in this tenant (or it is another requester's). */
  NOT_FOUND: 'data_export.not_found',
  /** Only a hosted bot's data is exported; the installation's own tenant is not. */
  NOT_HOSTED: 'data_export.not_hosted',
  /** An export of this tenant is already being made. */
  IN_PROGRESS: 'data_export.in_progress',
} as const;
export type DataExportErrorCode =
  (typeof DATA_EXPORT_ERROR_CODES)[keyof typeof DATA_EXPORT_ERROR_CODES];

// ---------------------------------------------------------------------------
// Over HTTP
// ---------------------------------------------------------------------------

/**
 * Routes, relative to `API_PREFIX`. The first three are a hosted bot's own owner in their own
 * Web Admin (`data.export`); the last three are the installation owner's, from «میزبانی‌ها»
 * (the section session and a fresh code on the request).
 */
export const DATA_EXPORT_ROUTES = {
  own: '/data-exports',
  ownDownload: '/data-exports/:id/download',
  hosted: '/hosting/bots/:tenantId/data-exports',
  hostedDownload: '/hosting/bots/:tenantId/data-exports/:id/download',
} as const;

const idempotencyKey = z.string().min(8).max(255);

/** A hosted bot's owner asks for an export of their own tenant. */
export const dataExportRequestSchema = z.object({ idempotencyKey });
export type DataExportRequest = z.infer<typeof dataExportRequestSchema>;

/** The installation owner asks for one of a hosted bot, with a fresh second-factor proof. */
export const dataExportHostRequestSchema = z.object({
  idempotencyKey,
  proof: secondFactorProofSchema,
});
export type DataExportHostRequest = z.infer<typeof dataExportHostRequestSchema>;

export interface DataExportView {
  readonly id: string;
  readonly state: DataExportState;
  readonly requestedAt: string;
  /** Asked for by the installation owner from «میزبانی‌ها», not by the bot's own owner. */
  readonly requestedByHost: boolean;
  /** When the file was finished (READY, EXPIRED), else null. */
  readonly readyAt: string | null;
  /** The download deadline (READY, EXPIRED), else null. */
  readonly expiresAt: string | null;
  /** The ZIP's size in bytes once made. */
  readonly bytes: number | null;
  /** The stable reason of a FAILED export. */
  readonly failureCode: string | null;
  /** Whether the file can be downloaded now (READY and before the deadline). */
  readonly downloadable: boolean;
}

export interface DataExportsResponse {
  readonly exports: readonly DataExportView[];
}

export interface DataExportRequestResponse {
  readonly export: DataExportView;
  /** The same key was used before: the first result. */
  readonly replayed: boolean;
}
