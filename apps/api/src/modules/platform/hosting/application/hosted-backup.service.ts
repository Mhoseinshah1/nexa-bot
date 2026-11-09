import {
  errors,
  HOSTED_BACKUP_DEFAULTS,
  hostedBackupDownloadRequestSchema,
  hostedBackupPasswordRequestSchema,
  hostedBackupRunRequestSchema,
  hostedBackupScheduleRequestSchema,
  HOSTING_ERROR_CODES,
  isSystemContext,
  PLATFORM_ERROR_CODES,
  uuidV7Schema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type HostedBackupArchiveView,
  type HostedBackupResponse,
  type HostedOwnBackupResponse,
  type IdempotencyStore,
  type IdGenerator,
  type PermissionKey,
  type ScopeContext,
  type SecretCipher,
  type TenantContext,
} from '@nexa/contracts';
import { hashRequest } from '../../idempotency/infrastructure/drizzle-idempotency-store.js';
import { rememberOnce } from '../../idempotency/application/remember-once.js';
import type { PermissionGuard } from '../../access/application/permission-guard.js';
import type { OwnerExportAlerts } from '../../owner-alerts/application/ports.js';
import type { BackupRunRow } from '../../backup/application/ports.js';
import { latestDailySlot } from '../../backup/application/backup-schedule.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { HostingSectionService } from './hosting-section.service.js';
import type { HostingOwnerGuard } from './hosting-owner-guard.js';
import type { HostingRepository } from './ports.js';
import type {
  HostedArchiveFiles,
  HostedArchiveRunner,
  HostedArchiveRuns,
  HostedBackupPolicyRow,
  HostedBackupPolicyStore,
} from './hosted-backup.ports.js';

/** How many archive runs of one bot its card lists. */
const ARCHIVES_SHOWN = 30;
/** The hosted owner's own page reads under the key every tenant's backup page reads under. */
const BACKUP_VIEW: PermissionKey = 'backup.view';

export interface HostedBackupServiceDeps {
  readonly section: Pick<
    HostingSectionService,
    'requireSection' | 'assertSectionIn' | 'withFreshProof'
  >;
  readonly owner: Pick<HostingOwnerGuard, 'check'>;
  readonly bots: Pick<HostingRepository, 'findHosted'>;
  readonly policies: HostedBackupPolicyStore;
  readonly runs: HostedArchiveRuns;
  readonly archives: HostedArchiveRunner;
  readonly files: HostedArchiveFiles;
  readonly cipher: SecretCipher;
  readonly guard: Pick<PermissionGuard, 'check'>;
  readonly idempotency: IdempotencyStore;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly installationTenantId: () => string | null;
  /** Phase 6A D0: every archive leaving the server is announced to the owner. */
  readonly ownerAlerts?: OwnerExportAlerts;
  readonly logger: {
    info(context: Record<string, unknown>, message: string): void;
    warn(context: Record<string, unknown>, message: string): void;
  };
}

/** One pass of the hosted schedule, for the log line and the tests. */
export interface HostedBackupPass {
  readonly ran: readonly string[];
  readonly failed: readonly string[];
  readonly pruned: number;
  /** The queue or the archive lock was taken: the rest wait for the next pass. */
  readonly deferred: boolean;
}

/**
 * Phase 6B PR-2 (ADR-0039 § 7): hosted-bot backups, the installation owner's in «میزبانی‌ها».
 *
 * Every read and write is behind the creator panel's owner guard and its section session;
 * every write and the download behind a FRESH code (`withFreshProof`), audited in the OWNER's
 * log — the hosted tenant's audit log receives nothing (D5). The password is sealed under
 * `hosting.archive_password` on the policy row in the INSTALLATION tenant: a hosted owner can
 * neither read nor set it (row-level security, and his own backup page answers
 * `backup.installation_only`).
 *
 * The archives themselves are taken by the WORKER (`runDue`), never in a request: «بکاپ الان»
 * records the press, and the next pass takes it through the heavy-job queue exactly like a
 * scheduled one, one bot at a time (the queue's exclusive BACKUP kind and the shared
 * single-active run index). Each bot keeps its newest N verified archives under
 * `BACKUP_WORK_DIR/hosted/<tenantId>/`; the installation's own retention never touches them.
 */
export class HostedBackupService {
  constructor(private readonly deps: HostedBackupServiceDeps) {}

  async view(
    scope: ScopeContext,
    actor: ActorContext,
    token: string | null,
    id: string,
  ): Promise<HostedBackupResponse> {
    const hostedTenantId = parseId(id);
    const installation = await this.deps.section.requireSection(
      scope,
      actor,
      token,
      'hosting.backup_view',
      hostedTenantId,
    );
    await this.requireBot(installation, hostedTenantId);
    return this.response(installation, hostedTenantId);
  }

  async setSchedule(
    scope: ScopeContext,
    actor: ActorContext,
    token: string | null,
    id: string,
    input: unknown,
  ): Promise<HostedBackupResponse> {
    const hostedTenantId = parseId(id);
    const installation = await this.deps.section.requireSection(
      scope,
      actor,
      token,
      'hosting.backup_schedule_set',
      hostedTenantId,
    );
    const command = hostedBackupScheduleRequestSchema.parse(input);
    const requestHash = hashRequest({
      action: 'hosting.backup_schedule_set',
      hostedTenantId,
      enabled: command.enabled,
      dailyTime: command.dailyTime,
      keep: command.keep,
    });
    if (await this.replayed(installation, actor, command.idempotencyKey, requestHash)) {
      return { ...(await this.response(installation, hostedTenantId)), replayed: true };
    }
    await this.deps.section.withFreshProof(
      installation,
      actor,
      command.proof,
      'hosting.backup_schedule_set',
      async (tx, now, method) => {
        await this.inTransaction(installation, actor, token, hostedTenantId, tx);
        const before = await this.ensure(installation, hostedTenantId, now, tx);
        await this.deps.policies.setSchedule(
          installation,
          {
            id: before.id,
            enabled: command.enabled,
            dailyTime: command.dailyTime,
            keep: command.keep,
            now,
          },
          tx,
        );
        await this.deps.audit.record(
          installation,
          actor,
          {
            action: 'hosting.backup_schedule_set',
            entityType: 'Tenant',
            entityId: hostedTenantId,
            before: { enabled: before.enabled, dailyTime: before.dailyTime, keep: before.keep },
            after: {
              enabled: command.enabled,
              dailyTime: command.dailyTime,
              keep: command.keep,
              proof: method,
            },
            result: 'SUCCESS',
          },
          tx,
        );
        await this.remember(installation, actor, command.idempotencyKey, requestHash, tx);
      },
    );
    return this.response(installation, hostedTenantId);
  }

  /**
   * The bot's backup password, set or changed by the installation owner only. Sealed under
   * `hosting.archive_password` with the policy row's id; never returned, never in the request
   * hash (a replay is recognised by its key and the bot alone), never in the audit row.
   * Changing it affects future archives only — earlier ones open with the password they were
   * sealed with.
   */
  async setPassword(
    scope: ScopeContext,
    actor: ActorContext,
    token: string | null,
    id: string,
    input: unknown,
  ): Promise<HostedBackupResponse> {
    const hostedTenantId = parseId(id);
    const installation = await this.deps.section.requireSection(
      scope,
      actor,
      token,
      'hosting.backup_password_set',
      hostedTenantId,
    );
    const command = hostedBackupPasswordRequestSchema.parse(input);
    if (hasControlCharacter(command.password)) {
      throw errors.validation(
        PLATFORM_ERROR_CODES.BACKUP_ARCHIVE_PASSWORD_INVALID,
        'A backup password cannot contain line breaks or other control characters.',
      );
    }
    const requestHash = hashRequest({ action: 'hosting.backup_password_set', hostedTenantId });
    if (await this.replayed(installation, actor, command.idempotencyKey, requestHash)) {
      return { ...(await this.response(installation, hostedTenantId)), replayed: true };
    }
    await this.deps.section.withFreshProof(
      installation,
      actor,
      command.proof,
      'hosting.backup_password_set',
      async (tx, now, method) => {
        await this.inTransaction(installation, actor, token, hostedTenantId, tx);
        const policy = await this.ensure(installation, hostedTenantId, now, tx);
        const sealed = this.deps.cipher.encrypt(command.password, {
          purpose: 'hosting.archive_password',
          tenantId: installation.tenantId,
          entityId: policy.id,
        });
        await this.deps.policies.setPassword(
          installation,
          { id: policy.id, ciphertext: sealed.ciphertext, keyId: sealed.keyId, now },
          tx,
        );
        // Who, when, and that one was replaced. Never the value, never a digest of it.
        await this.deps.audit.record(
          installation,
          actor,
          {
            action: 'hosting.backup_password_set',
            entityType: 'Tenant',
            entityId: hostedTenantId,
            before: { passwordSetAt: policy.passwordSetAt?.toISOString() ?? null },
            after: { passwordSetAt: now.toISOString(), proof: method },
            reason: 'The owner set the password that seals this hosted bot’s archives.',
            result: 'SUCCESS',
          },
          tx,
        );
        await this.remember(installation, actor, command.idempotencyKey, requestHash, tx);
      },
    );
    return this.response(installation, hostedTenantId);
  }

  /** «بکاپ الان»: recorded here, taken by the worker's next pass through the queue. */
  async requestRun(
    scope: ScopeContext,
    actor: ActorContext,
    token: string | null,
    id: string,
    input: unknown,
  ): Promise<HostedBackupResponse> {
    const hostedTenantId = parseId(id);
    const installation = await this.deps.section.requireSection(
      scope,
      actor,
      token,
      'hosting.backup_run_requested',
      hostedTenantId,
    );
    const command = hostedBackupRunRequestSchema.parse(input);
    const requestHash = hashRequest({ action: 'hosting.backup_run_requested', hostedTenantId });
    if (await this.replayed(installation, actor, command.idempotencyKey, requestHash)) {
      return { ...(await this.response(installation, hostedTenantId)), replayed: true };
    }
    await this.deps.section.withFreshProof(
      installation,
      actor,
      command.proof,
      'hosting.backup_run_requested',
      async (tx, now, method) => {
        const bot = await this.inTransaction(installation, actor, token, hostedTenantId, tx);
        if (bot.state === 'PURGED') {
          throw errors.conflict(HOSTING_ERROR_CODES.STATE_CONFLICT, 'A purged bot is closed.', {
            state: bot.state,
          });
        }
        const policy = await this.ensure(installation, hostedTenantId, now, tx);
        if (policy.passwordCiphertext === null) {
          throw errors.preconditionFailed(
            HOSTING_ERROR_CODES.BACKUP_PASSWORD_REQUIRED,
            'Set this bot’s backup password first: an archive nobody can open is not a backup.',
          );
        }
        await this.deps.policies.requestRun(installation, { id: policy.id, now }, tx);
        await this.deps.audit.record(
          installation,
          actor,
          {
            action: 'hosting.backup_run_requested',
            entityType: 'Tenant',
            entityId: hostedTenantId,
            before: null,
            after: { requestedAt: now.toISOString(), proof: method },
            result: 'SUCCESS',
          },
          tx,
        );
        await this.remember(installation, actor, command.idempotencyKey, requestHash, tx);
      },
    );
    return this.response(installation, hostedTenantId);
  }

  /**
   * The path of one verified archive of this bot, for the owner to download (fresh code).
   * DERIVED from the validated ids and the work root, never accepted; audited in the owner's
   * log and announced like every export. A code spent on a missing archive stays spent.
   */
  async download(
    scope: ScopeContext,
    actor: ActorContext,
    token: string | null,
    id: string,
    runIdInput: string,
    input: unknown,
  ): Promise<{ path: string; filename: string; bytes: number }> {
    const hostedTenantId = parseId(id);
    const runId = parseRunId(runIdInput);
    const installation = await this.deps.section.requireSection(
      scope,
      actor,
      token,
      'hosting.archive_downloaded',
      hostedTenantId,
    );
    const command = hostedBackupDownloadRequestSchema.parse(input);
    await this.requireBot(installation, hostedTenantId);
    const { result } = await this.deps.section.withFreshProof(
      installation,
      actor,
      command.proof,
      'hosting.archive_downloaded',
      async (tx, _now, method) => {
        await this.inTransaction(installation, actor, token, hostedTenantId, tx);
        const run = await this.deps.runs.byId(hostedTenantId, runId);
        const file =
          run === null || run.state !== 'SUCCEEDED' || run.verifiedAt === null
            ? null
            : await this.deps.files.archive(hostedTenantId, runId);
        if (file === null) {
          throw errors.notFound(
            HOSTING_ERROR_CODES.ARCHIVE_NOT_FOUND,
            'This archive is not on this server.',
          );
        }
        await this.deps.audit.record(
          installation,
          actor,
          {
            action: 'hosting.archive_downloaded',
            entityType: 'Tenant',
            entityId: hostedTenantId,
            before: null,
            after: { runId, bytes: file.bytes, checksum: run?.checksum ?? null, proof: method },
            reason: 'The owner downloaded a hosted bot’s encrypted archive.',
            result: 'SUCCESS',
          },
          tx,
        );
        return file;
      },
    );
    await this.deps.ownerAlerts?.dataExported(installation, actor, {
      kind: 'BACKUP_ARCHIVE',
      rows: null,
      format: '7z',
    });
    return {
      path: result.path,
      // Built from two validated uuids: nothing stored reaches the header.
      filename: `nexa-hosted-${hostedTenantId}-${runId}.7z`,
      bytes: result.bytes,
    };
  }

  /**
   * The hosted bot's OWN Web Admin: backups are managed by the host; the last verified
   * archive's time and whether the host left them on. No list, password, download or restore.
   */
  async ownView(scope: ScopeContext, actor: ActorContext): Promise<HostedOwnBackupResponse> {
    const installation = this.deps.installationTenantId();
    if (
      isSystemContext(scope) ||
      installation === null ||
      scope.tenantId.toLowerCase() === installation.toLowerCase()
    ) {
      throw errors.notFound(
        PLATFORM_ERROR_CODES.TENANT_NOT_FOUND,
        'This installation manages its own backups.',
      );
    }
    await this.deps.guard.check(scope, actor, BACKUP_VIEW);
    const [enabled, last] = await Promise.all([
      this.deps.policies.enabledFor(scope),
      this.deps.runs.lastVerifiedAt(scope.tenantId),
    ]);
    return {
      managedByHost: true,
      enabled: enabled ?? HOSTED_BACKUP_DEFAULTS.enabled,
      lastBackupAt: last?.toISOString() ?? null,
    };
  }

  // --- The worker's pass -----------------------------------------------------------------

  /**
   * Takes every DUE hosted archive, one at a time, through the heavy-job queue, then applies
   * each bot's retention. Due: «بکاپ الان» was pressed, or the schedule is on and the bot's
   * last attempt is older than today's slot (a worker that was down at the slot takes it on
   * restart). A bot with no password is never due. A busy queue or a held archive lock ends
   * the pass; the rest are due again next pass.
   */
  async runDue(): Promise<HostedBackupPass> {
    const installationId = this.deps.installationTenantId();
    const ran: string[] = [];
    const failed: string[] = [];
    let pruned = 0;
    if (installationId === null) return { ran, failed, pruned, deferred: false };
    const installation = { tenantId: installationId, botInstanceId: null } as TenantContext;
    for (const policy of await this.deps.policies.withPassword(installation)) {
      const bot = await this.deps.bots.findHosted(installation, policy.hostedTenantId);
      if (bot === null || bot.state === 'PURGED') continue;
      const now = this.deps.clock.now();
      const requested = policy.runRequestedAt;
      if (requested === null) {
        if (!policy.enabled) continue;
        const last = await this.deps.runs.lastAttemptAt(policy.hostedTenantId);
        if (last !== null && last.getTime() >= latestDailySlot(now, policy.dailyTime).getTime()) {
          continue;
        }
      }
      let password: string;
      try {
        password = this.deps.cipher.decrypt(
          { ciphertext: policy.passwordCiphertext ?? '', keyId: policy.passwordKeyId ?? '' },
          { purpose: 'hosting.archive_password', tenantId: installationId, entityId: policy.id },
        );
      } catch {
        this.deps.logger.warn(
          { hostedTenantId: policy.hostedTenantId },
          'a hosted bot’s backup password does not open; its archive is skipped',
        );
        failed.push(policy.hostedTenantId);
        continue;
      }
      const outcome = await this.deps.archives.run({
        tenantId: policy.hostedTenantId,
        trigger: requested === null ? 'SCHEDULED' : 'MANUAL',
        password,
      });
      if (outcome.kind !== 'COMPLETED') {
        return { ran, failed, pruned, deferred: true };
      }
      if (requested !== null) {
        await this.deps.policies.clearRunRequest(installation, {
          id: policy.id,
          requestedAt: requested,
        });
      }
      (outcome.run.state === 'SUCCEEDED' ? ran : failed).push(policy.hostedTenantId);
      pruned += await this.prune(policy);
    }
    return { ran, failed, pruned, deferred: false };
  }

  /** This bot's archives beyond its newest `keep` verified ones; never the newest verified. */
  private async prune(policy: HostedBackupPolicyRow): Promise<number> {
    let removed = 0;
    for (const run of await this.deps.runs.pruneCandidates(policy.hostedTenantId, policy.keep)) {
      if (!(await this.deps.files.remove(policy.hostedTenantId, run.id))) continue;
      if (await this.deps.runs.markPruned(policy.hostedTenantId, run.id, this.deps.clock.now())) {
        removed += 1;
      }
    }
    return removed;
  }

  // --- Shared ---------------------------------------------------------------------------

  private async response(
    installation: TenantContext,
    hostedTenantId: string,
  ): Promise<HostedBackupResponse> {
    const [policy, runs] = await Promise.all([
      this.deps.policies.find(installation, hostedTenantId),
      this.deps.runs.recent(hostedTenantId, ARCHIVES_SHOWN),
    ]);
    return {
      tenantId: hostedTenantId,
      policy: {
        enabled: policy?.enabled ?? HOSTED_BACKUP_DEFAULTS.enabled,
        dailyTime: policy?.dailyTime ?? HOSTED_BACKUP_DEFAULTS.dailyTime,
        keep: policy?.keep ?? HOSTED_BACKUP_DEFAULTS.keep,
        passwordSetAt: policy?.passwordSetAt?.toISOString() ?? null,
        runRequestedAt: policy?.runRequestedAt?.toISOString() ?? null,
      },
      archives: await Promise.all(runs.map((run) => this.archiveView(hostedTenantId, run))),
    };
  }

  private async archiveView(
    hostedTenantId: string,
    run: BackupRunRow,
  ): Promise<HostedBackupArchiveView> {
    const file =
      run.state === 'SUCCEEDED' && run.verifiedAt !== null && run.archivePrunedAt === null
        ? await this.deps.files.archive(hostedTenantId, run.id)
        : null;
    return {
      id: run.id,
      state: run.state,
      trigger: run.trigger,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      verifiedAt: run.verifiedAt?.toISOString() ?? null,
      archiveBytes: run.archiveBytes === null ? null : run.archiveBytes.toString(),
      deliveryState: run.deliveryState,
      failureCode: run.failureCode,
      available: file !== null,
    };
  }

  private async ensure(
    installation: TenantContext,
    hostedTenantId: string,
    now: Date,
    tx: TransactionScope,
  ): Promise<HostedBackupPolicyRow> {
    return this.deps.policies.ensure(
      installation,
      {
        id: this.deps.ids.uuid(),
        hostedTenantId,
        enabled: HOSTED_BACKUP_DEFAULTS.enabled,
        dailyTime: HOSTED_BACKUP_DEFAULTS.dailyTime,
        keep: HOSTED_BACKUP_DEFAULTS.keep,
        now,
      },
      tx,
    );
  }

  /** What every write transaction re-checks first, on its own connection. */
  private async inTransaction(
    installation: TenantContext,
    actor: ActorContext,
    token: string | null,
    hostedTenantId: string,
    tx: TransactionScope,
  ) {
    await this.deps.owner.check(installation, actor, tx);
    await this.deps.section.assertSectionIn(installation, actor, token, tx);
    return this.requireBot(installation, hostedTenantId, tx);
  }

  private async requireBot(installation: TenantContext, hostedTenantId: string, tx?: unknown) {
    const row = await this.deps.bots.findHosted(installation, hostedTenantId, tx);
    if (row === null) {
      throw errors.notFound(HOSTING_ERROR_CODES.BOT_NOT_FOUND, 'No such hosted bot.');
    }
    return row;
  }

  private async replayed(
    installation: TenantContext,
    actor: ActorContext,
    key: string,
    requestHash: string,
  ): Promise<boolean> {
    return (
      (await this.deps.idempotency.find(installation, actor.surface, key, requestHash)) !== null
    );
  }

  private async remember(
    installation: TenantContext,
    actor: ActorContext,
    key: string,
    requestHash: string,
    tx: TransactionScope,
  ): Promise<void> {
    await rememberOnce(
      this.deps.idempotency,
      installation,
      actor.surface,
      key,
      requestHash,
      {},
      tx,
    );
  }
}

function parseId(id: string): string {
  if (!uuidV7Schema.safeParse(id).success) {
    throw errors.notFound(HOSTING_ERROR_CODES.BOT_NOT_FOUND, 'No such hosted bot.');
  }
  return id.toLowerCase();
}

function parseRunId(id: string): string {
  if (!uuidV7Schema.safeParse(id).success) {
    throw errors.notFound(HOSTING_ERROR_CODES.ARCHIVE_NOT_FOUND, 'No such archive.');
  }
  return id.toLowerCase();
}

/** Characters 7-Zip's one-line stdin read would cut or mangle. */
function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
