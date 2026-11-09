import {
  type AuditWriter,
  type Clock,
  type IdempotencyStore,
  type IdGenerator,
  type SecretCipher,
  type SettingKey,
  type TemplateKey,
  type TemplateValues,
  type TenantContext,
} from '@nexa/contracts';
import type { DatabaseHandle } from '../../../../infrastructure/persistence/database.js';
import { migrationsFolder } from '../../../../infrastructure/persistence/migration-state.js';
import type { KdfProfile } from '../../../../infrastructure/crypto/kek.js';
import type { PermissionGuard } from '../../access/application/permission-guard.js';
import type { OwnerExportAlerts } from '../../owner-alerts/application/ports.js';
import type { BackupDeliveryChannel, BackupRunRepository } from '../../backup/application/ports.js';
import type { OpsGroupBackupTopic } from '../../backup/application/routed-backup-delivery.js';
import { HostedGroupArchiveDelivery } from '../../backup/application/hosted-group-delivery.js';
import {
  TenantArchiveService,
  TenantRestoreService,
  type HeavyJobRunner,
} from '../../backup/application/tenant-archive.service.js';
import {
  PostgresTenantArchiveEngine,
  type ScratchDatabases,
} from '../../backup/infrastructure/tenant-archive-engine.js';
import type { SevenZipOptions } from '../../backup/infrastructure/seven-zip.js';
import { DrizzleTenantRestoreRepository } from '../../backup/infrastructure/drizzle-tenant-restore.repository.js';
import { DrizzleHostedArchiveRuns } from '../../backup/infrastructure/drizzle-hosted-archive-runs.js';
import { DrizzleTenantReplaceHold } from '../../backup/infrastructure/tenant-replace-hold.js';
import { replaceSnapshot } from '../../backup/infrastructure/tenant-archive-replace.js';
import { HostedBackupService } from '../application/hosted-backup.service.js';
import { HOSTED_BACKUP_TICK_MS, HostedBackupLoop } from '../application/hosted-backup-loop.js';
import type { HostingSectionService } from '../application/hosting-section.service.js';
import type { HostingOwnerGuard } from '../application/hosting-owner-guard.js';
import type { HostingRepository } from '../application/ports.js';
import { TenantRestoreAdminService } from '../application/tenant-restore-admin.service.js';
import { hostedPreReplaceArchive } from '../application/hosted-pre-replace.js';
import { DrizzleHostedBackupPolicies } from './drizzle-hosted-backup-policies.js';
import { FilesystemTenantRestoreWorkspaces } from './tenant-restore-workspaces.js';
import { FilesystemHostedArchiveFiles } from './hosted-archive-files.js';

/** How long a hosted archive waits for the heavy-job queue before the pass defers it. */
const HOSTED_ARCHIVE_QUEUE = { pollMs: 2_000, maxWaitMs: 30 * 60_000 } as const;

/**
 * Phase 6B PR-2 (ADR-0039 § 7): the hosted-bot backups, assembled in one place so
 * `container.ts` gains a call rather than another page — PR-1's tenant archive engine and
 * its two services, wired for the first time, and the owner's per-bot schedule over them.
 */
export function buildHostedBackups(deps: {
  /** The application's handle, as `nexa_app`: the export is bound by row-level security. */
  readonly database: DatabaseHandle;
  readonly scratch: ScratchDatabases;
  readonly sevenZip: SevenZipOptions;
  readonly workRoot: string;
  /** `RECOVERY_WORK_DIR`: uploads of «بازیابی ربات از فایل», shared with the recovery role. */
  readonly recoveryWorkRoot: string;
  readonly cipher: SecretCipher;
  readonly kdf: KdfProfile;
  readonly release: string;
  readonly installationTenantId: () => string | null;
  readonly runs: BackupRunRepository;
  readonly heavyJobs: HeavyJobRunner;
  readonly leaseOwner: string;
  readonly section: HostingSectionService;
  readonly owner: HostingOwnerGuard;
  readonly bots: Pick<HostingRepository, 'findHosted'>;
  readonly guard: PermissionGuard;
  readonly idempotency: IdempotencyStore;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly ownerAlerts?: OwnerExportAlerts;
  /** The ops group's backups topic, asked in the HOSTED tenant's scope (its own group). */
  readonly opsGroup: Pick<OpsGroupBackupTopic, 'route' | 'delivered'>;
  readonly channelFor: (target: {
    readonly token: string;
    readonly chatId: string;
    readonly threadId: number;
  }) => Pick<BackupDeliveryChannel, 'sendDocument'>;
  readonly settings: { valueOf<T>(scope: TenantContext, key: SettingKey): Promise<T> };
  readonly render: (
    scope: TenantContext,
    key: TemplateKey,
    values: TemplateValues,
  ) => Promise<string>;
  readonly quiesced: () => Promise<boolean>;
  readonly logger: {
    info(context: Record<string, unknown>, message: string): void;
    warn(context: Record<string, unknown>, message: string): void;
    error(context: Record<string, unknown>, message: string): void;
  };
}): {
  readonly tenantArchiveEngine: PostgresTenantArchiveEngine;
  readonly tenantArchives: TenantArchiveService;
  readonly tenantRestores: TenantRestoreService;
  readonly tenantRestoreRequests: DrizzleTenantRestoreRepository;
  readonly hostedBackups: HostedBackupService;
  readonly hostedBackupLoop: HostedBackupLoop;
  readonly tenantRestoreAdmin: TenantRestoreAdminService;
} {
  const installation = (): string => {
    const id = deps.installationTenantId();
    if (id === null) throw new Error('the installation tenant is not resolved');
    return id;
  };
  const engine = new PostgresTenantArchiveEngine({
    app: deps.database,
    scratch: deps.scratch,
    sevenZip: deps.sevenZip,
    root: deps.workRoot,
    cipher: deps.cipher,
    kdf: deps.kdf,
    installationTenantId: installation,
    installationId: installation,
    release: deps.release,
    migrationsFolder: migrationsFolder(),
    now: () => deps.clock.now(),
  });
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const queue = { ...HOSTED_ARCHIVE_QUEUE, sleep };
  const tenantArchives = new TenantArchiveService({
    runs: deps.runs,
    engine,
    heavyJobs: deps.heavyJobs,
    clock: deps.clock,
    ids: deps.ids,
    leaseOwner: deps.leaseOwner,
    queue,
    logger: deps.logger,
    delivery: new HostedGroupArchiveDelivery({
      opsGroup: deps.opsGroup,
      channelFor: deps.channelFor,
      settings: deps.settings,
      render: deps.render,
      clock: deps.clock,
    }),
  });
  const tenantRestoreRequests = new DrizzleTenantRestoreRepository(deps.database.db);
  const policies = new DrizzleHostedBackupPolicies(deps.database.db);
  const hold = new DrizzleTenantReplaceHold(deps.database, () => deps.clock.now());
  const tenantRestores = new TenantRestoreService({
    engine,
    requests: tenantRestoreRequests,
    replace: {
      hold: (installationTenantId, hostedTenantId) =>
        hold.hold(installationTenantId, hostedTenantId),
      release: (installationTenantId, hostedTenantId) =>
        hold.release(installationTenantId, hostedTenantId),
      snapshot: (hostedTenantId, state) =>
        replaceSnapshot(deps.database, hostedTenantId, state, deps.cipher),
      preReplace: hostedPreReplaceArchive({
        policies,
        cipher: deps.cipher,
        archives: tenantArchives,
        installationTenantId: installation,
      }),
    },
    heavyJobs: deps.heavyJobs,
    clock: deps.clock,
    ids: deps.ids,
    leaseOwner: deps.leaseOwner,
    queue,
  });
  const hostedRuns = new DrizzleHostedArchiveRuns(deps.database.db);
  const hostedFiles = new FilesystemHostedArchiveFiles(deps.workRoot);
  const hostedBackups = new HostedBackupService({
    section: deps.section,
    owner: deps.owner,
    bots: deps.bots,
    policies,
    runs: hostedRuns,
    archives: tenantArchives,
    files: hostedFiles,
    cipher: deps.cipher,
    guard: deps.guard,
    idempotency: deps.idempotency,
    audit: deps.audit,
    clock: deps.clock,
    ids: deps.ids,
    installationTenantId: deps.installationTenantId,
    ...(deps.ownerAlerts === undefined ? {} : { ownerAlerts: deps.ownerAlerts }),
    logger: deps.logger,
  });
  const hostedBackupLoop = new HostedBackupLoop(hostedBackups, {
    intervalMs: HOSTED_BACKUP_TICK_MS,
    now: () => deps.clock.now().getTime(),
    quiesced: deps.quiesced,
    logger: deps.logger,
  });
  const tenantRestoreAdmin = new TenantRestoreAdminService({
    section: deps.section,
    owner: deps.owner,
    restores: tenantRestores,
    requests: tenantRestoreRequests,
    workspaces: new FilesystemTenantRestoreWorkspaces(deps.recoveryWorkRoot),
    cipher: deps.cipher,
    // The path is DERIVED from two validated ids and the work root, never accepted (as the
    // download's), and only for a verified, unpruned run of a hosted bot of this installation.
    hostedArchive: async (installation, hostedTenantId, runId) => {
      if ((await deps.bots.findHosted(installation, hostedTenantId)) === null) return null;
      const run = await hostedRuns.byId(hostedTenantId, runId);
      if (run === null || run.state !== 'SUCCEEDED' || run.verifiedAt === null) return null;
      if (run.archivePrunedAt !== null) return null;
      return (await hostedFiles.archive(hostedTenantId, runId))?.path ?? null;
    },
    idempotency: deps.idempotency,
    audit: deps.audit,
    clock: deps.clock,
    ids: deps.ids,
    installationTenantId: deps.installationTenantId,
    logger: deps.logger,
  });
  return {
    tenantRestoreAdmin,
    tenantArchiveEngine: engine,
    tenantArchives,
    tenantRestores,
    tenantRestoreRequests,
    hostedBackups,
    hostedBackupLoop,
  };
}
