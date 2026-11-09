import { storedFailureMessage } from '../../backup/application/stored-failure.js';
import {
  errors,
  HOSTING_ERROR_CODES,
  NexaError,
  TENANT_ARCHIVE_ERROR_CODES,
  TENANT_RESTORE_DRY_RUN_TTL_MS,
  tenantRestoreCancelRequestSchema,
  tenantRestoreConfirmRequestSchema,
  tenantRestoreDryRunRequestSchema,
  uuidV7Schema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdempotencyStore,
  type IdGenerator,
  type ScopeContext,
  type SecretCipher,
  type TenantContext,
  type TenantRestoreStage,
  type TenantRestoreState,
  type TenantRestoreView,
  type TenantRestoresResponse,
} from '@nexa/contracts';
import { hashRequest } from '../../idempotency/infrastructure/drizzle-idempotency-store.js';
import { rememberOnce } from '../../idempotency/application/remember-once.js';
import type { TenantRestoreService } from '../../backup/application/tenant-archive.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { HostingSectionService } from './hosting-section.service.js';
import type { HostingOwnerGuard } from './hosting-owner-guard.js';

/** A `tenant_restores` row, as this service reads it. */
export interface TenantRestoreRecord {
  readonly id: string;
  readonly hostedTenantId: string;
  readonly state: string;
  readonly stage: string;
  readonly dryRun: unknown;
  readonly failureCode: string | null;
  readonly createdAt: Date;
  readonly confirmRequestedAt: Date | null;
  readonly finishedAt: Date | null;
}

export interface TenantRestoreRequests {
  byId(scope: TenantContext, id: string): Promise<TenantRestoreRecord | null>;
  recent(scope: TenantContext, limit: number): Promise<readonly TenantRestoreRecord[]>;
  requestConfirm(
    scope: TenantContext,
    input: { readonly id: string; readonly now: Date },
    tx?: unknown,
  ): Promise<boolean>;
  withdraw(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly failureCode: string;
      readonly failureMessage: string;
      readonly now: Date;
      /** The recovery role fails a CONFIRMED row its restore never claimed. */
      readonly includeConfirmed?: boolean;
    },
    tx?: unknown,
  ): Promise<boolean>;
  staleDryRuns(scope: TenantContext, before: Date): Promise<readonly string[]>;
  confirmedPending(scope: TenantContext): Promise<readonly TenantRestoreRecord[]>;
}

/**
 * Where an uploaded archive waits: `RECOVERY_WORK_DIR/tenant-restores/<restoreId>/`, shared by
 * the API (which receives it and runs the dry run) and the recovery role (which applies it).
 */
export interface TenantRestoreWorkspaces {
  create(restoreId: string): Promise<{ readonly archivePath: string }>;
  open(restoreId: string): {
    readonly archivePath: string;
    readonly scratchDirectory: string;
    exists(): Promise<boolean>;
    writeSealedPassword(sealed: string): Promise<void>;
    readSealedPassword(): Promise<string | null>;
    remove(): Promise<boolean>;
  };
  /** Every upload directory with its id and when anything in it was last written. */
  list(): Promise<readonly { readonly restoreId: string; readonly lastWrittenAt: Date }[]>;
}

export interface TenantRestoreAdminDeps {
  readonly section: Pick<
    HostingSectionService,
    'requireSection' | 'assertSectionIn' | 'withFreshProof'
  >;
  readonly owner: Pick<HostingOwnerGuard, 'check'>;
  readonly restores: Pick<TenantRestoreService, 'restore'>;
  readonly requests: TenantRestoreRequests;
  readonly workspaces: TenantRestoreWorkspaces;
  readonly cipher: SecretCipher;
  readonly idempotency: IdempotencyStore;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly installationTenantId: () => string | null;
  readonly logger: {
    info(context: Record<string, unknown>, message: string): void;
    warn(context: Record<string, unknown>, message: string): void;
  };
}

/**
 * Phase 6B PR-2 (ADR-0039 § 4): «بازیابی ربات از فایل» — a hosted archive from ANY Nexa
 * install, restored here as a NEW hosted bot (PR-1's engine), by the installation owner only.
 *
 *   upload  →  dry run (fresh code + the archive's password; the whole verification in a
 *              scratch database through the heavy-job queue; nothing written to the live
 *              database; the row left VERIFIED)
 *           →  confirm (fresh code; recorded on the row) → the RECOVERY ROLE applies it
 *           or «لغو» (fresh code) / a day with no confirmation: withdrawn, slot released.
 *
 * The restore never runs in the HTTP request (ADR-0028, per tenant). The password reaches the
 * recovery role sealed in the upload's directory under this server's active key (purpose
 * `hosting.archive_password`, entity = the restore id), and is removed with the upload.
 * Uploads follow SFR A3: removed once their request is finished, and orphans after a day.
 */
export class TenantRestoreAdminService {
  constructor(private readonly deps: TenantRestoreAdminDeps) {}

  async list(
    scope: ScopeContext,
    actor: ActorContext,
    token: string | null,
  ): Promise<TenantRestoresResponse> {
    const installation = await this.deps.section.requireSection(
      scope,
      actor,
      token,
      'hosting.tenant_restore_list',
    );
    const rows = await this.deps.requests.recent(installation, 20);
    return { restores: rows.map(toView) };
  }

  /** A fresh upload directory; the controller streams the file into it. */
  async beginUpload(
    scope: ScopeContext,
    actor: ActorContext,
    token: string | null,
  ): Promise<{ readonly restoreId: string; readonly archivePath: string }> {
    await this.deps.section.requireSection(scope, actor, token, 'hosting.tenant_restore_upload');
    const restoreId = this.deps.ids.uuid();
    const { archivePath } = await this.deps.workspaces.create(restoreId);
    return { restoreId, archivePath };
  }

  /** An upload that failed or arrived empty: its directory goes at once. */
  async discardUpload(restoreId: string): Promise<void> {
    await this.deps.workspaces.open(parseId(restoreId)).remove();
  }

  async dryRun(
    scope: ScopeContext,
    actor: ActorContext,
    token: string | null,
    id: string,
    input: unknown,
  ): Promise<TenantRestoreView> {
    const restoreId = parseId(id);
    const installation = await this.deps.section.requireSection(
      scope,
      actor,
      token,
      'hosting.tenant_restore_dry_run',
      restoreId,
    );
    const command = tenantRestoreDryRunRequestSchema.parse(input);
    const workspace = this.deps.workspaces.open(restoreId);
    if (!(await workspace.exists()) || (await this.deps.requests.byId(installation, restoreId))) {
      throw errors.notFound(HOSTING_ERROR_CODES.ARCHIVE_NOT_FOUND, 'No such uploaded archive.');
    }
    await this.deps.section.withFreshProof(
      installation,
      actor,
      command.proof,
      'hosting.tenant_restore_dry_run',
      async (tx) => this.inTransaction(installation, actor, token, tx),
    );
    try {
      const outcome = await this.deps.restores.restore({
        installationTenantId: installation.tenantId,
        actorAdminId: actor.id as string,
        archivePath: workspace.archivePath,
        password: command.password,
        directory: workspace.scratchDirectory,
        mode: 'NEW',
        requestId: restoreId,
        ...(command.slug === undefined ? {} : { slug: command.slug }),
      });
      if (outcome === null) {
        throw errors.conflict(
          TENANT_ARCHIVE_ERROR_CODES.VERIFICATION_FAILED,
          'Another heavy job holds the server; try the dry run again shortly.',
        );
      }
      // Verified: the password waits for the recovery role, sealed under this server's key.
      const sealed = this.deps.cipher.encrypt(command.password, {
        purpose: 'hosting.archive_password',
        tenantId: installation.tenantId,
        entityId: restoreId,
      });
      await workspace.writeSealedPassword(JSON.stringify(sealed));
    } catch (error) {
      // A refused archive is not kept (A3): its row, if the archive opened, is FAILED.
      await workspace.remove();
      await this.audit(
        installation,
        actor,
        'hosting.tenant_restore_dry_run',
        restoreId,
        {
          failureCode:
            error instanceof NexaError ? error.code : 'tenant_archive.verification_failed',
        },
        'DENIED',
      );
      throw error;
    }
    await this.audit(installation, actor, 'hosting.tenant_restore_dry_run', restoreId, {
      verified: true,
    });
    return this.view(installation, restoreId);
  }

  async confirm(
    scope: ScopeContext,
    actor: ActorContext,
    token: string | null,
    id: string,
    input: unknown,
  ): Promise<TenantRestoreView> {
    const restoreId = parseId(id);
    const installation = await this.deps.section.requireSection(
      scope,
      actor,
      token,
      'hosting.tenant_restore_confirm',
      restoreId,
    );
    const command = tenantRestoreConfirmRequestSchema.parse(input);
    const requestHash = hashRequest({ action: 'hosting.tenant_restore_confirm', restoreId });
    const replay = await this.deps.idempotency.find(
      installation,
      actor.surface,
      command.idempotencyKey,
      requestHash,
    );
    if (replay !== null) return this.view(installation, restoreId);
    await this.deps.section.withFreshProof(
      installation,
      actor,
      command.proof,
      'hosting.tenant_restore_confirm',
      async (tx, now, method) => {
        await this.inTransaction(installation, actor, token, tx);
        if (!(await this.deps.requests.requestConfirm(installation, { id: restoreId, now }, tx))) {
          throw errors.conflict(
            TENANT_ARCHIVE_ERROR_CODES.VERIFICATION_FAILED,
            'There is no verified dry run of this archive to confirm.',
          );
        }
        await this.audit(
          installation,
          actor,
          'hosting.tenant_restore_confirm',
          restoreId,
          { proof: method },
          'SUCCESS',
          tx,
        );
        await rememberOnce(
          this.deps.idempotency,
          installation,
          actor.surface,
          command.idempotencyKey,
          requestHash,
          {},
          tx,
        );
      },
    );
    return this.view(installation, restoreId);
  }

  /** «لغو»: a VERIFIED dry run the owner no longer wants. Its upload goes with it. */
  async cancel(
    scope: ScopeContext,
    actor: ActorContext,
    token: string | null,
    id: string,
    input: unknown,
  ): Promise<TenantRestoreView> {
    const restoreId = parseId(id);
    const installation = await this.deps.section.requireSection(
      scope,
      actor,
      token,
      'hosting.tenant_restore_cancel',
      restoreId,
    );
    const command = tenantRestoreCancelRequestSchema.parse(input);
    await this.deps.section.withFreshProof(
      installation,
      actor,
      command.proof,
      'hosting.tenant_restore_cancel',
      async (tx, now, method) => {
        await this.inTransaction(installation, actor, token, tx);
        const withdrawn = await this.deps.requests.withdraw(
          installation,
          {
            id: restoreId,
            failureCode: TENANT_ARCHIVE_ERROR_CODES.RESTORE_CANCELLED,
            failureMessage: 'The owner cancelled the verified dry run.',
            now,
          },
          tx,
        );
        if (!withdrawn) {
          throw errors.conflict(
            TENANT_ARCHIVE_ERROR_CODES.VERIFICATION_FAILED,
            'Only a verified dry run that is not confirmed can be cancelled.',
          );
        }
        await this.audit(
          installation,
          actor,
          'hosting.tenant_restore_cancel',
          restoreId,
          { proof: method },
          'SUCCESS',
          tx,
        );
      },
    );
    await this.deps.workspaces.open(restoreId).remove();
    return this.view(installation, restoreId);
  }

  // --- The recovery role ------------------------------------------------------------------

  /**
   * One pass of the recovery role: expire stale dry runs, apply a confirmed one, and remove
   * the uploads nothing needs any more (A3). Never in an HTTP request.
   */
  async tick(): Promise<{ applied: number; expired: number; removed: number }> {
    const installationId = this.deps.installationTenantId();
    if (installationId === null) return { applied: 0, expired: 0, removed: 0 };
    const installation = { tenantId: installationId, botInstanceId: null } as TenantContext;
    const now = this.deps.clock.now();
    let expired = 0;
    for (const id of await this.deps.requests.staleDryRuns(
      installation,
      new Date(now.getTime() - TENANT_RESTORE_DRY_RUN_TTL_MS),
    )) {
      const withdrawn = await this.deps.requests.withdraw(installation, {
        id,
        failureCode: TENANT_ARCHIVE_ERROR_CODES.DRY_RUN_EXPIRED,
        failureMessage: 'The verified dry run was not confirmed within a day.',
        now,
      });
      if (withdrawn) expired += 1;
    }
    let applied = 0;
    for (const row of await this.deps.requests.confirmedPending(installation)) {
      await this.apply(installation, row);
      applied += 1;
    }
    const removed = await this.sweep(installation, now);
    return { applied, expired, removed };
  }

  private async apply(installation: TenantContext, row: TenantRestoreRecord): Promise<void> {
    const workspace = this.deps.workspaces.open(row.id);
    let password: string | null = null;
    try {
      const sealed = await workspace.readSealedPassword();
      if (sealed !== null) {
        password = this.deps.cipher.decrypt(JSON.parse(sealed) as never, {
          purpose: 'hosting.archive_password',
          tenantId: installation.tenantId,
          entityId: row.id,
        });
      }
    } catch {
      password = null;
    }
    const requestedBy = await this.requestedBy(installation, row.id);
    try {
      if (password === null || requestedBy === null) {
        throw new NexaError({
          kind: 'PRECONDITION_FAILED',
          code: TENANT_ARCHIVE_ERROR_CODES.VERIFICATION_FAILED,
          message: 'The confirmed restore has no readable upload or password on this server.',
        });
      }
      const outcome = await this.deps.restores.restore({
        installationTenantId: installation.tenantId,
        actorAdminId: requestedBy,
        archivePath: workspace.archivePath,
        password,
        directory: workspace.scratchDirectory,
        mode: 'NEW',
        confirmRequestId: row.id,
        // The slug the owner chose at the dry run: the apply must not fall back to the archive's.
        ...(typeof (row.dryRun as { slug?: unknown } | null)?.slug === 'string'
          ? { slug: (row.dryRun as { slug: string }).slug }
          : {}),
      });
      if (outcome === null) return; // the queue is busy: the row stays confirmed, next pass
      this.deps.logger.info(
        { restoreId: row.id, hostedTenantId: row.hostedTenantId },
        'a hosted bot was restored from an uploaded archive',
      );
    } catch (error) {
      // The restore service FAILs a row it moved; a row it never claimed is withdrawn here.
      const failed = await this.deps.requests
        .withdraw(installation, {
          id: row.id,
          includeConfirmed: true,
          failureCode:
            error instanceof NexaError ? error.code : 'tenant_archive.verification_failed',
          // A NexaError's own sentence, else the sanitised cause chain: never a raw message
          // (a drizzle query error carries the SQL and its bound row values).
          failureMessage: storedFailureMessage(error),
          now: this.deps.clock.now(),
        })
        .catch(() => false);
      this.deps.logger.warn(
        { restoreId: row.id, code: error instanceof NexaError ? error.code : null },
        'a confirmed hosted restore failed',
      );
      // The upload goes only once the row is failed; otherwise the next pass retries it (the
      // sweep removes the files of a row that finished some other way).
      if (failed) await workspace.remove();
      return;
    }
    await workspace.remove();
  }

  /** The admin who asked for the dry run (the restored register names him). */
  private async requestedBy(installation: TenantContext, id: string): Promise<string | null> {
    const row = (await this.deps.requests.byId(installation, id)) as
      (TenantRestoreRecord & { requestedByAdminId?: string }) | null;
    return row?.requestedByAdminId ?? null;
  }

  /** A3: an upload whose request finished, or an orphan nobody wrote to for a day. */
  private async sweep(installation: TenantContext, now: Date): Promise<number> {
    let removed = 0;
    for (const entry of await this.deps.workspaces.list()) {
      if (!uuidV7Schema.safeParse(entry.restoreId).success) continue;
      const row = await this.deps.requests.byId(installation, entry.restoreId);
      const finished = row !== null && (row.state === 'SUCCEEDED' || row.state === 'FAILED');
      const orphan =
        row === null &&
        now.getTime() - entry.lastWrittenAt.getTime() >= TENANT_RESTORE_DRY_RUN_TTL_MS;
      if (!finished && !orphan) continue;
      if (await this.deps.workspaces.open(entry.restoreId).remove()) removed += 1;
    }
    return removed;
  }

  private async view(installation: TenantContext, restoreId: string): Promise<TenantRestoreView> {
    const row = await this.deps.requests.byId(installation, restoreId);
    if (row === null) {
      throw errors.notFound(HOSTING_ERROR_CODES.ARCHIVE_NOT_FOUND, 'No such restore.');
    }
    return toView(row);
  }

  private async inTransaction(
    installation: TenantContext,
    actor: ActorContext,
    token: string | null,
    tx: TransactionScope,
  ): Promise<void> {
    await this.deps.owner.check(installation, actor, tx);
    await this.deps.section.assertSectionIn(installation, actor, token, tx);
  }

  private async audit(
    installation: TenantContext,
    actor: ActorContext,
    action: string,
    restoreId: string,
    after: Record<string, unknown>,
    result: 'SUCCESS' | 'DENIED' = 'SUCCESS',
    tx?: TransactionScope,
  ): Promise<void> {
    await this.deps.audit.record(
      installation,
      actor,
      { action, entityType: 'TenantRestore', entityId: restoreId, before: null, after, result },
      tx,
    );
  }
}

function toView(row: TenantRestoreRecord): TenantRestoreView {
  const dryRun = (row.dryRun ?? {}) as {
    head?: 'EQUAL' | 'OLDER';
    slug?: string;
    counts?: Record<string, number>;
  };
  return {
    id: row.id,
    state: row.state as TenantRestoreState,
    stage: row.stage as TenantRestoreStage,
    hostedTenantId: row.hostedTenantId,
    slug: dryRun.slug ?? null,
    head: dryRun.head ?? null,
    counts: dryRun.counts ?? {},
    failureCode: row.failureCode,
    createdAt: row.createdAt.toISOString(),
    confirmRequestedAt: row.confirmRequestedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

function parseId(id: string): string {
  if (!uuidV7Schema.safeParse(id).success) {
    throw errors.notFound(HOSTING_ERROR_CODES.ARCHIVE_NOT_FOUND, 'No such restore.');
  }
  return id.toLowerCase();
}
