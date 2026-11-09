import { z } from 'zod';
import { BACKUP_ARCHIVE_PASSWORD_MIN_LENGTH, BACKUP_DAILY_TIME_PATTERN } from './backup.js';
import { hostedBotSlugSchema, hostingProofSchema } from './hosting.js';
import type { TenantRestoreStage, TenantRestoreState } from './tenant-archive.js';

/**
 * Phase 6B PR-2 (ADR-0039 § 7): hosted-bot backups in «میزبانی‌ها» — every hosted bot's
 * schedule, password and archives, set and taken by the installation owner only, each action
 * behind a fresh code; and «بازیابی ربات از فایل», a hosted archive from any Nexa install
 * restored here as a new hosted bot.
 *
 * Declarations only; the services live in `apps/api/src/modules/platform/hosting/`.
 */

/** The schedule a hosted bot gets when the owner has set none (the owner's decision). */
export const HOSTED_BACKUP_DEFAULTS = { enabled: true, dailyTime: '04:30', keep: 7 } as const;
/** How many verified archives of one bot the owner may keep on the server. */
export const HOSTED_BACKUP_KEEP_MIN = 1;
export const HOSTED_BACKUP_KEEP_MAX = 60;
/**
 * A verified dry run nobody confirmed is withdrawn after this long: it holds the
 * installation's one restore slot (`tenant_restores_single_active_idx`).
 */
export const TENANT_RESTORE_DRY_RUN_TTL_MS = 24 * 60 * 60 * 1000;
/** The largest hosted archive the restore page accepts in one upload. */
export const TENANT_RESTORE_UPLOAD_MAX_BYTES = 4 * 1024 * 1024 * 1024;

export const HOSTED_BACKUP_ROUTES = {
  /** One bot's policy and archives. */
  bot: '/hosting/bots/:tenantId/backup',
  schedule: '/hosting/bots/:tenantId/backup/schedule',
  password: '/hosting/bots/:tenantId/backup/password',
  run: '/hosting/bots/:tenantId/backup/run',
  download: '/hosting/bots/:tenantId/backup/archives/:runId/download',
  /** «بازیابی ربات از فایل». */
  restores: '/hosting/restores',
  upload: '/hosting/restores/upload',
  dryRun: '/hosting/restores/:restoreId/dry-run',
  confirm: '/hosting/restores/:restoreId/confirm',
  cancel: '/hosting/restores/:restoreId/cancel',
  /** The hosted bot's OWN Web Admin: «managed by the host» and the last backup's time. */
  own: '/backup/hosted',
} as const;

const idempotencyKey = z.string().min(8).max(255);

export const hostedBackupScheduleRequestSchema = z.object({
  idempotencyKey,
  proof: hostingProofSchema,
  enabled: z.boolean(),
  /** HH:MM, the installation's zone (Asia/Tehran), entered with `TimeField24`. */
  dailyTime: z.string().regex(BACKUP_DAILY_TIME_PATTERN),
  keep: z.number().int().min(HOSTED_BACKUP_KEEP_MIN).max(HOSTED_BACKUP_KEEP_MAX),
});
export type HostedBackupScheduleRequest = z.infer<typeof hostedBackupScheduleRequestSchema>;

export const hostedBackupPasswordRequestSchema = z.object({
  idempotencyKey,
  proof: hostingProofSchema,
  /** Never returned, never in a request hash or an audit row. */
  password: z.string().min(BACKUP_ARCHIVE_PASSWORD_MIN_LENGTH).max(1024),
});

export const hostedBackupRunRequestSchema = z.object({
  idempotencyKey,
  proof: hostingProofSchema,
});

export const hostedBackupDownloadRequestSchema = z.object({ proof: hostingProofSchema });

export interface HostedBackupArchiveView {
  readonly id: string;
  readonly state: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  readonly trigger: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly verifiedAt: string | null;
  /** Bytes as a decimal string (bigint on the server). */
  readonly archiveBytes: string | null;
  readonly deliveryState: string;
  readonly failureCode: string | null;
  /** The archive file is on this server and can be downloaded. */
  readonly available: boolean;
}

export interface HostedBackupPolicyView {
  readonly enabled: boolean;
  readonly dailyTime: string;
  readonly keep: number;
  /** When the owner last set the password; null = none set, so no archive is taken. */
  readonly passwordSetAt: string | null;
  /** «بکاپ الان» pressed and not yet taken by the worker. */
  readonly runRequestedAt: string | null;
}

export interface HostedBackupResponse {
  readonly tenantId: string;
  readonly policy: HostedBackupPolicyView;
  /** Newest first. */
  readonly archives: readonly HostedBackupArchiveView[];
  readonly replayed?: boolean;
}

/** The hosted bot's own backup page: no list, no password, no download, no restore. */
export interface HostedOwnBackupResponse {
  readonly managedByHost: true;
  readonly enabled: boolean;
  readonly lastBackupAt: string | null;
}

// --- «بازیابی ربات از فایل» -----------------------------------------------------------

export const tenantRestoreDryRunRequestSchema = z.object({
  proof: hostingProofSchema,
  /** The archive's password; used for this dry run and its confirmation, never stored plain. */
  password: z.string().min(1).max(1024),
  /** A new slug, when the archive's is taken here by another tenant. */
  slug: hostedBotSlugSchema.optional(),
});

export const tenantRestoreConfirmRequestSchema = z.object({
  idempotencyKey,
  proof: hostingProofSchema,
});

export const tenantRestoreCancelRequestSchema = z.object({ proof: hostingProofSchema });

export interface TenantRestoreView {
  readonly id: string;
  readonly state: TenantRestoreState;
  readonly stage: TenantRestoreStage;
  readonly hostedTenantId: string;
  readonly slug: string | null;
  readonly head: 'EQUAL' | 'OLDER' | null;
  /** Rows per table, from the verified scratch (dry run) or the live copy (applied). */
  readonly counts: Readonly<Record<string, number>>;
  readonly failureCode: string | null;
  readonly createdAt: string;
  readonly confirmRequestedAt: string | null;
  readonly finishedAt: string | null;
}

export interface TenantRestoreUploadResponse {
  /** The upload's id: also the restore request's id once its dry run opens the archive. */
  readonly restoreId: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface TenantRestoresResponse {
  readonly restores: readonly TenantRestoreView[];
}
