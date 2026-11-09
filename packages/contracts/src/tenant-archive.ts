import { z } from 'zod';

/**
 * Phase 6B (ADR-0039): the tenant archive — ONE hosted tenant's rows, exported logically,
 * sealed in a 7z with the hosted bot's backup password, restorable on another Nexa install
 * with only the archive and its password.
 *
 * Declarations only. The export and restore engines live in
 * `apps/api/src/modules/platform/backup/`.
 */

/** `manifest.json`'s `format`. A reader refuses any other. */
export const TENANT_ARCHIVE_FORMAT = 'nexa.tenant-archive';
/** Bumped only with a reader for both versions. */
export const TENANT_ARCHIVE_FORMAT_VERSION = 1;

/**
 * How a restore lands (ADR-0039 § 4): a NEW hosted child of the target installation keeping
 * every id, or a REPLACE of the same tenant id's rows — a hosted bot of this installation in
 * any state but PURGED — under the tenant rewrite allowance (§ 10): its rows are archived
 * first (PRE_REPLACE), then deleted and the archive's inserted in ONE transaction that is
 * compared with the verified scratch before it commits.
 */
export const TENANT_RESTORE_MODES = ['NEW', 'REPLACE'] as const;
export type TenantRestoreMode = (typeof TENANT_RESTORE_MODES)[number];

/**
 * A `tenant_restores` request row's life. `VERIFIED` is the dry run's end: the archive opened,
 * restored into scratch, matched its manifest and passed every refusal check; nothing has been
 * written to the live database. `APPLYING` copies into it in ONE transaction; a failure there
 * rolls back and ends `FAILED`.
 */
export const TENANT_RESTORE_STATES = [
  'REQUESTED',
  'VERIFYING',
  'VERIFIED',
  'APPLYING',
  'SUCCEEDED',
  'FAILED',
] as const;
export type TenantRestoreState = (typeof TENANT_RESTORE_STATES)[number];
/** The states that hold the installation's one restore slot. */
export const TENANT_RESTORE_ACTIVE_STATES: readonly TenantRestoreState[] = [
  'REQUESTED',
  'VERIFYING',
  'VERIFIED',
  'APPLYING',
];

/** Where a restore is, for the row and its failure report. */
export const TENANT_RESTORE_STAGES = [
  'OPEN',
  'SCHEMA',
  'SCRATCH_LOAD',
  'SCRATCH_VERIFY',
  'MIGRATE_SCRATCH',
  'PREFLIGHT',
  'APPLY',
  'DONE',
] as const;
export type TenantRestoreStage = (typeof TENANT_RESTORE_STAGES)[number];

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const tableName = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/);

/**
 * `manifest.json` (ADR-0039 § 2). Inside the encrypted container: it names a domain and a bot.
 * Never a key, a credential or a secret value — `secrets` carries counts per purpose only.
 */
export const tenantArchiveManifestSchema = z
  .object({
    format: z.literal(TENANT_ARCHIVE_FORMAT),
    formatVersion: z.literal(TENANT_ARCHIVE_FORMAT_VERSION),
    /** The run id; also the key bundle's `backupId`. */
    archiveId: z.string().min(1).max(128),
    /** The snapshot's start, UTC. */
    createdAt: z.iso.datetime(),
    source: z.object({
      installationId: z.string().min(1),
      release: z.string().min(1),
      postgresVersion: z.string().min(1),
    }),
    /** The source's migration head, as `migration-state.ts` reads the applied ledger. */
    migrations: z.object({
      count: z.number().int().positive(),
      lastTag: z.string().min(1),
      lastHash: sha256,
      lastWhen: z.number().int().positive(),
    }),
    tenant: z.object({
      id: z.uuid(),
      kind: z.literal('HOSTED'),
      slug: z.string().min(1),
      displayName: z.string().min(1),
      locale: z.string().min(1),
      timezone: z.string().min(1),
      calendar: z.string().min(1),
      currency: z.string().min(1),
    }),
    /** The host facts, from the INSTALLATION register (never DNS/TLS/webhook marks). */
    host: z.object({
      state: z.string().min(1),
      expiresAt: z.iso.datetime().nullable(),
      ownerAdminId: z.uuid(),
      domain: z.string().nullable(),
      botInstanceId: z.uuid().nullable(),
      botUsername: z.string().nullable(),
      telegramBotId: z.string().nullable(),
      /** The host's `tenant_capacity_limits` rows for this tenant (its policy, not its data). */
      capacityLimits: z.array(
        z.object({
          resource: z.string().min(1),
          mode: z.string().min(1),
          value: z.number().int().nullable(),
        }),
      ),
    }),
    /** In load order (parents first). */
    tables: z.array(
      z.object({
        name: tableName,
        file: z.string().regex(/^data\/[0-9]{4}-[a-z_][a-z0-9_]*\.copy$/),
        columns: z.array(z.object({ name: z.string().min(1), type: z.string().min(1) })),
        rows: z.number().int().nonnegative(),
        bytes: z.number().int().nonnegative(),
        sha256,
      }),
    ),
    notExported: z.array(
      z.object({ name: tableName, rows: z.number().int().positive(), reason: z.string().min(1) }),
    ),
    secrets: z.object({
      archiveKeyId: z.string().min(1),
      perPurpose: z.record(z.string(), z.number().int().nonnegative()),
    }),
    exclusions: z.array(z.object({ object: z.string(), reason: z.string() })),
  })
  .strict();
export type TenantArchiveManifest = z.infer<typeof tenantArchiveManifestSchema>;
