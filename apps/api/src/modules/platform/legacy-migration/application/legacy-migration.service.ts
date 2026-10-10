import {
  errors,
  LEGACY_MIGRATION_APPROVAL_PHRASE,
  LEGACY_MIGRATION_DECISIONS_MAX_BYTES,
  LEGACY_MIGRATION_HTTP_ERROR_CODES,
  LEGACY_MIGRATION_PAGE_MAX,
  LEGACY_NXPKG_AUDIT_ACTIONS,
  legacyMigrationApplyReportSchema,
  legacyMigrationApproveRequestSchema,
  legacyMigrationCommandRequestSchema,
  legacyMigrationDryRunReportSchema,
  legacyMigrationKeyRequestSchema,
  legacyMigrationPanelBindingsRequestSchema,
  legacyMigrationVerifyReportSchema,
  uuidV7Schema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type LegacyMigrationCapabilitiesResponse,
  type LegacyMigrationImportListResponse,
  type LegacyMigrationImportView,
  type LegacyMigrationListQuery,
  type LegacyNxpkgImportStatus,
  type LegacyNxpkgKeyKind,
  type OperationalEventRecorder,
  type PermissionKey,
  type SecretCipher,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
} from '../../access/application/authorized-mutation.js';
import { rememberOnce } from '../../idempotency/application/remember-once.js';
import { hashRequest } from '../../idempotency/infrastructure/drizzle-idempotency-store.js';
import type { SessionRepository } from '../../identity/application/ports.js';
import type { ScopeActivityReader } from '../../system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import { sanitiseFilename } from '../../recovery/application/recovery.service.js';
import {
  digestsEqual,
  errorKind,
  LEGACY_MIGRATION_COMMAND_FROM,
} from '../domain/import-lifecycle.js';
import type {
  LegacyNxpkgImportPatch,
  LegacyNxpkgImportRepository,
  LegacyNxpkgImportRow,
  MigrationWorkspaces,
} from './ports.js';

export const LEGACY_MIGRATION_VIEW_PERMISSION = 'legacy.migration.view' satisfies PermissionKey;
export const LEGACY_MIGRATION_MANAGE_PERMISSION = 'legacy.migration.manage' satisfies PermissionKey;
export const LEGACY_MIGRATION_APPLY_PERMISSION = 'legacy.migration.apply' satisfies PermissionKey;

/** The purpose the package key is sealed under; the entity is the import row's id. */
export const LEGACY_MIGRATION_KEY_PURPOSE = 'legacy_migration.package_key' as const;

const ENTITY = 'LegacyNxpkgImport';
const CODES = LEGACY_MIGRATION_HTTP_ERROR_CODES;

export interface LegacyMigrationServiceDeps {
  readonly repository: LegacyNxpkgImportRepository;
  readonly workspaces: MigrationWorkspaces;
  readonly cipher: SecretCipher;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** `LEGACY_MIGRATION_ENABLED`. Off refuses every method, reads included. */
  readonly enabled: boolean;
  readonly maxUploadBytes: number;
  /** The importer's production guard, applied to this installation's own database. */
  readonly productionLikeTarget: boolean;
  /**
   * Production-like only: the target acknowledgement the `migration` process's environment
   * must carry for this tenant (a digest the guard itself prints; not a secret). Null otherwise.
   */
  readonly targetAcknowledgement: (tenantId: string) => string | null;
  readonly logger: {
    info(context: Record<string, unknown>, message: string): void;
    warn(context: Record<string, unknown>, message: string): void;
    error(context: Record<string, unknown>, message: string): void;
  };
}

/** An upload in flight: the directory exists, the row does not yet. */
export interface PendingPackageUpload {
  readonly importId: string;
  readonly packagePath: string;
  readonly fileName: string;
}

/** A decisions upload in flight. */
export interface PendingDecisionsUpload {
  readonly importId: string;
  readonly uploadPath: string;
}

/**
 * Mirza `.nxpkg` importer — the operator's half (`docs/legacy-migration/nxpkg-importer.md` §4,
 * §8). The Web Admin's only door to `legacy_nxpkg_imports`.
 *
 * NOTHING HERE OPENS A PACKAGE. Upload, key, panel bindings, decisions file, the dry-run
 * request, the approval and the cancel are rows and files; verification, the dry run and the
 * import are the `migration` process role's (`LegacyMigrationExecutor`), which polls this table
 * under a lease. No HTTP request decrypts, verifies or writes a customer — the recovery rule
 * (ADR-0028), for the same reason: a long, destructive job does not belong to a request.
 *
 * Permissions, each checked by the guard and, for a write, again INSIDE its transaction
 * (`runAuthorizedMutation`): `legacy.migration.view` to read, `legacy.migration.manage` (HIGH)
 * for every command but one, and the CRITICAL `legacy.migration.apply` for the approval, which
 * binds ONE dry run's digest. Every write reads scope activity inside its transaction, takes
 * an idempotency key (the uploads excepted: a raw body, and a re-upload is a new import or the
 * same content-addressed decisions file), and is audited with `LEGACY_NXPKG_AUDIT_ACTIONS` —
 * never with the key, a path or package content.
 *
 * THE KEY travels once: sealed with the installation keyring under
 * `legacy_migration.package_key` bound to the row, never logged, never returned, never audited,
 * never hashed into the idempotency store (the request hash covers the KIND only), and erased
 * by the repository in the same statement that makes the import terminal.
 */
export class LegacyMigrationService {
  constructor(private readonly deps: LegacyMigrationServiceDeps) {}

  // --- reads (legacy.migration.view) -------------------------------------------------------

  async capabilities(
    scope: TenantContext,
    actor: ActorContext,
  ): Promise<LegacyMigrationCapabilitiesResponse> {
    // Not refused when the flag is off: this is the document that SAYS it is off.
    await this.deps.guard.check(scope, actor, LEGACY_MIGRATION_VIEW_PERMISSION);
    return {
      enabled: this.deps.enabled,
      maxUploadBytes: this.deps.maxUploadBytes,
      maxDecisionsBytes: LEGACY_MIGRATION_DECISIONS_MAX_BYTES,
      approvalPhrase: LEGACY_MIGRATION_APPROVAL_PHRASE,
      productionLikeTarget: this.deps.productionLikeTarget,
      targetAcknowledgement: this.deps.targetAcknowledgement(scope.tenantId),
    };
  }

  async list(
    scope: TenantContext,
    actor: ActorContext,
    query: LegacyMigrationListQuery,
  ): Promise<LegacyMigrationImportListResponse> {
    this.assertEnabled();
    await this.deps.guard.check(scope, actor, LEGACY_MIGRATION_VIEW_PERMISSION);
    const limit = query.limit ?? LEGACY_MIGRATION_PAGE_MAX;
    const rows = await this.deps.repository.page({
      tenantId: scope.tenantId,
      limit,
      before: query.after ?? null,
    });
    const page = rows.slice(0, limit);
    const now = this.deps.clock.now();
    return {
      imports: page.map((row) => legacyMigrationView(row, now)),
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async detail(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
  ): Promise<LegacyMigrationImportView> {
    this.assertEnabled();
    await this.deps.guard.check(scope, actor, LEGACY_MIGRATION_VIEW_PERMISSION);
    return legacyMigrationView(await this.require(scope, id), this.deps.clock.now());
  }

  // --- the package upload (legacy.migration.manage) ----------------------------------------

  /**
   * Makes the private directory the bytes will be streamed into. Called BEFORE the stream is
   * read. The row is written by `completeUpload`, because the row's own CHECKs need the
   * server's digest and byte count, which do not exist until the bytes have arrived.
   */
  async beginUpload(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly fileName: string },
  ): Promise<PendingPackageUpload> {
    this.assertEnabled();
    await this.requirePermission(scope, actor, LEGACY_MIGRATION_MANAGE_PERMISSION, {
      action: LEGACY_NXPKG_AUDIT_ACTIONS.upload,
      entityId: null,
    });
    // An early refusal only, so a second package is not streamed for nothing; the partial
    // unique index decides at the insert.
    if ((await this.deps.repository.active(scope.tenantId)) !== null) {
      throw alreadyActive();
    }
    const importId = this.deps.ids.uuid();
    const files = await this.deps.workspaces.create(importId);
    return { importId, packagePath: files.packagePath, fileName: sanitiseFilename(input.fileName) };
  }

  /** Records what arrived: the SERVER's digest and count, never a client's. */
  async completeUpload(
    scope: TenantContext,
    actor: ActorContext,
    upload: PendingPackageUpload,
    input: { readonly bytes: number; readonly sha256: string },
  ): Promise<LegacyMigrationImportView> {
    const action = LEGACY_NXPKG_AUDIT_ACTIONS.upload;
    try {
      const row = await runAuthorizedMutation(
        this.mutationDeps(),
        scope,
        actor,
        LEGACY_MIGRATION_MANAGE_PERMISSION,
        { action, entityType: ENTITY, entityId: upload.importId },
        async (tx) => {
          await this.assertScopeActive(scope, tx);
          const created = await this.deps.repository.insert(
            {
              id: upload.importId,
              tenantId: scope.tenantId,
              fileName: upload.fileName,
              filePath: upload.packagePath,
              fileSha256: input.sha256,
              fileBytes: BigInt(input.bytes),
              requestedByAdminId: adminIdOf(actor),
              now: this.deps.clock.now(),
            },
            tx,
          );
          await this.deps.audit.record(
            scope,
            actor,
            {
              action,
              entityType: ENTITY,
              entityId: created.id,
              before: null,
              after: {
                status: created.status,
                fileSha256: created.fileSha256,
                fileBytes: String(created.fileBytes),
              },
              result: 'SUCCESS',
            },
            tx,
          );
          return created;
        },
      );
      return legacyMigrationView(row, this.deps.clock.now());
    } catch (error) {
      await this.failUpload(upload);
      throw error;
    }
  }

  /** Removes an upload's directory: a row never written leaves no file behind. */
  async failUpload(upload: PendingPackageUpload): Promise<void> {
    await this.deps.workspaces.discard(upload.importId).catch((error: unknown) => {
      this.deps.logger.error(
        // The type and code only: a filesystem error's message names the upload's path (L3).
        { importId: upload.importId, err: errorKind(error) },
        'an abandoned legacy migration upload could not be removed',
      );
    });
  }

  // --- configuration (legacy.migration.manage) ---------------------------------------------

  /**
   * The package key or passphrase, sealed. UPLOADED, before the worker takes it; or VERIFIED /
   * DRY_RUN_DONE while the import holds NO key — the `migration` role erased an idle one
   * (`LEGACY_MIGRATION_KEY_IDLE_MS`). A key held there is never replaced.
   */
  async setKey(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    body: unknown,
  ): Promise<LegacyMigrationImportView> {
    const action = LEGACY_NXPKG_AUDIT_ACTIONS.configure;
    this.assertEnabled();
    await this.requirePermission(scope, actor, LEGACY_MIGRATION_MANAGE_PERMISSION, {
      action,
      entityId: id,
    });
    const parsed = legacyMigrationKeyRequestSchema.safeParse(body);
    // The refusal names no value: a schema message can echo what it refused.
    if (!parsed.success) {
      throw errors.validation(
        CODES.REQUEST_INVALID,
        'Give exactly one of a key file or a passphrase.',
      );
    }
    const command = parsed.data;
    const kind: LegacyNxpkgKeyKind = 'keyFileText' in command ? 'KEY_FILE' : 'PASSPHRASE';
    const secret = 'keyFileText' in command ? command.keyFileText : command.passphrase;
    // The KIND and the import, never the secret: no digest of a passphrase is stored.
    const requestHash = hashRequest({ action, item: 'key', importId: id, kind });
    return this.idempotent(
      scope,
      actor,
      { idempotencyKey: command.idempotencyKey, requestHash, id, action },
      async (tx) => {
        const row = await this.lockFor(scope, id, LEGACY_MIGRATION_COMMAND_FROM.setKey, tx);
        if (row.status !== 'UPLOADED' && row.keyCiphertext !== null) throw invalidState(row.status);
        const sealed = this.deps.cipher.encrypt(secret, {
          purpose: LEGACY_MIGRATION_KEY_PURPOSE,
          tenantId: scope.tenantId,
          entityId: row.id,
        });
        await this.mustPatch(
          {
            id: row.id,
            tenantId: scope.tenantId,
            from: LEGACY_MIGRATION_COMMAND_FROM.setKey,
            unowned: true,
            now: this.deps.clock.now(),
            patch: { keyCiphertext: sealed.ciphertext, keyKeyId: sealed.keyId, keyKind: kind },
          },
          tx,
        );
        await this.auditConfigure(scope, actor, row, { item: 'key', keyKind: kind }, tx);
      },
    );
  }

  /**
   * Package panel target → NEXA panel. Recorded as given; the `migration` role validates each
   * against the tenant's ACTIVE `rickpanel` panels at the dry run and again at the apply.
   * After a dry run, a change returns the import to VERIFIED and clears that dry run.
   */
  async setPanelBindings(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    body: unknown,
  ): Promise<LegacyMigrationImportView> {
    const action = LEGACY_NXPKG_AUDIT_ACTIONS.configure;
    this.assertEnabled();
    await this.requirePermission(scope, actor, LEGACY_MIGRATION_MANAGE_PERMISSION, {
      action,
      entityId: id,
    });
    const command = legacyMigrationPanelBindingsRequestSchema.parse(body);
    const bindings = command.bindings.map((binding) => ({
      codePanel: binding.codePanel,
      panelId: binding.panelId.toLowerCase(),
    }));
    const requestHash = hashRequest({ action, item: 'panel_bindings', importId: id, bindings });
    return this.idempotent(
      scope,
      actor,
      { idempotencyKey: command.idempotencyKey, requestHash, id, action },
      async (tx) => {
        const row = await this.lockFor(
          scope,
          id,
          LEGACY_MIGRATION_COMMAND_FROM.setPanelBindings,
          tx,
        );
        await this.reconfigure(scope, row, { panelBindings: bindings }, tx);
        await this.auditConfigure(
          scope,
          actor,
          row,
          { item: 'panel_bindings', bindings: bindings.length },
          tx,
        );
      },
    );
  }

  /** A path for the incoming decisions file. Refused early when the import cannot take one. */
  async beginDecisionsUpload(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
  ): Promise<PendingDecisionsUpload> {
    this.assertEnabled();
    await this.requirePermission(scope, actor, LEGACY_MIGRATION_MANAGE_PERMISSION, {
      action: LEGACY_NXPKG_AUDIT_ACTIONS.configure,
      entityId: id,
    });
    const row = await this.require(scope, id);
    if (!acceptsCommand(row, LEGACY_MIGRATION_COMMAND_FROM.uploadDecisions)) {
      throw invalidState(row.status);
    }
    return { importId: row.id, uploadPath: this.deps.workspaces.decisionsUploadPath(row.id) };
  }

  /**
   * Records the converter's `ownership-decisions.json` (design §7). Stored content-addressed
   * and verified by the `migration` role, never here: nothing in a request reads it.
   */
  async completeDecisionsUpload(
    scope: TenantContext,
    actor: ActorContext,
    upload: PendingDecisionsUpload,
    input: { readonly bytes: number; readonly sha256: string },
  ): Promise<LegacyMigrationImportView> {
    const action = LEGACY_NXPKG_AUDIT_ACTIONS.configure;
    const finalPath = this.deps.workspaces.decisionsPath(upload.importId, input.sha256);
    let previous: string | null = null;
    try {
      await runAuthorizedMutation(
        this.mutationDeps(),
        scope,
        actor,
        LEGACY_MIGRATION_MANAGE_PERMISSION,
        { action, entityType: ENTITY, entityId: upload.importId },
        async (tx) => {
          await this.assertScopeActive(scope, tx);
          const row = await this.lockFor(
            scope,
            upload.importId,
            LEGACY_MIGRATION_COMMAND_FROM.uploadDecisions,
            tx,
          );
          // Content-addressed, so moving it into place before the commit is harmless: a
          // rolled-back write leaves a file no row names, never a row naming other bytes.
          await this.deps.workspaces.promote(upload.uploadPath, finalPath);
          previous = row.decisionsFilePath === finalPath ? null : row.decisionsFilePath;
          await this.reconfigure(
            scope,
            row,
            {
              decisionsFilePath: finalPath,
              decisionsSummary: { sha256: input.sha256, bytes: input.bytes },
            },
            tx,
          );
          await this.auditConfigure(
            scope,
            actor,
            row,
            { item: 'decisions', sha256: input.sha256, bytes: input.bytes },
            tx,
          );
        },
      );
    } catch (error) {
      await this.deps.workspaces.removeFile(upload.uploadPath).catch(() => undefined);
      throw error;
    }
    if (previous !== null) {
      await this.deps.workspaces.removeFile(previous).catch(() => undefined);
    }
    return this.detailUnchecked(scope, upload.importId);
  }

  /** Abandons a decisions upload's partial file. */
  async failDecisionsUpload(upload: PendingDecisionsUpload): Promise<void> {
    await this.deps.workspaces.removeFile(upload.uploadPath).catch(() => undefined);
  }

  // --- the dry run, the approval, the cancel -------------------------------------------------

  async requestDryRun(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    body: unknown,
  ): Promise<LegacyMigrationImportView> {
    const action = LEGACY_NXPKG_AUDIT_ACTIONS.requestDryRun;
    this.assertEnabled();
    await this.requirePermission(scope, actor, LEGACY_MIGRATION_MANAGE_PERMISSION, {
      action,
      entityId: id,
    });
    const command = legacyMigrationCommandRequestSchema.parse(body);
    const requestHash = hashRequest({ action, importId: id });
    return this.idempotent(
      scope,
      actor,
      { idempotencyKey: command.idempotencyKey, requestHash, id, action },
      async (tx) => {
        const row = await this.lockFor(scope, id, LEGACY_MIGRATION_COMMAND_FROM.requestDryRun, tx);
        // An idle key was erased (L4): the dry run would wait for it unseen. Say so now.
        if (row.keyCiphertext === null) {
          throw errors.conflict(
            CODES.INVALID_STATE,
            'Give the package key again before a dry run: the idle one was erased.',
            { status: row.status, reason: 'PACKAGE_KEY_MISSING' },
          );
        }
        if (row.panelBindings === null || row.panelBindings.length === 0) {
          throw errors.conflict(
            CODES.INVALID_STATE,
            'Choose a NEXA panel for the package panels before a dry run.',
            { status: row.status, reason: 'PANEL_BINDINGS_MISSING' },
          );
        }
        const moved = await this.deps.repository.transition(
          {
            id: row.id,
            tenantId: scope.tenantId,
            from: LEGACY_MIGRATION_COMMAND_FROM.requestDryRun,
            to: 'DRY_RUN_REQUESTED',
            unowned: true,
            now: this.deps.clock.now(),
            patch: CLEAR_DRY_RUN,
          },
          tx,
        );
        if (!moved) throw invalidState(row.status);
        await this.deps.audit.record(
          scope,
          actor,
          {
            action,
            entityType: ENTITY,
            entityId: row.id,
            before: { status: row.status },
            after: { status: 'DRY_RUN_REQUESTED', fileSha256: row.fileSha256 },
            result: 'SUCCESS',
          },
          tx,
        );
      },
    );
  }

  /**
   * The owner approves ONE dry run, by its digest, and the import starts.
   *
   * Three things, each required on top of the others: the CRITICAL `legacy.migration.apply`;
   * the typed phrase (a misclick defence, nothing more); and `dryRunSha256` equal to the
   * import's CURRENT `dry_run_sha256`, in the transaction AND in the UPDATE's predicate — so an
   * approval read off one report can never start an import computed from another. The
   * executor re-checks the binding and the package's SHA-256 before it writes anything.
   */
  async approve(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    body: unknown,
  ): Promise<LegacyMigrationImportView> {
    const action = LEGACY_NXPKG_AUDIT_ACTIONS.approve;
    this.assertEnabled();
    // The permission FIRST: a caller without it is audited DENIED and learns nothing else.
    await this.requirePermission(scope, actor, LEGACY_MIGRATION_APPLY_PERMISSION, {
      action,
      entityId: id,
    });
    const command = legacyMigrationApproveRequestSchema.parse(body);
    if (command.confirmation !== LEGACY_MIGRATION_APPROVAL_PHRASE) {
      throw errors.validation(
        CODES.CONFIRMATION_INVALID,
        'The confirmation phrase does not match. Nothing was approved.',
      );
    }
    const requestHash = hashRequest({ action, importId: id, dryRunSha256: command.dryRunSha256 });
    return this.idempotent(
      scope,
      actor,
      {
        idempotencyKey: command.idempotencyKey,
        requestHash,
        id,
        action,
        permission: LEGACY_MIGRATION_APPLY_PERMISSION,
      },
      async (tx) => {
        const row = await this.lockFor(scope, id, LEGACY_MIGRATION_COMMAND_FROM.approve, tx);
        if (row.dryRunSha256 === null || !digestsEqual(row.dryRunSha256, command.dryRunSha256)) {
          throw errors.conflict(
            CODES.DIGEST_MISMATCH,
            'This approval names a dry run that is not the import’s current one. Nothing was approved.',
          );
        }
        if (row.keyCiphertext === null) throw invalidState(row.status);
        const now = this.deps.clock.now();
        const moved = await this.deps.repository.transition(
          {
            id: row.id,
            tenantId: scope.tenantId,
            from: LEGACY_MIGRATION_COMMAND_FROM.approve,
            to: 'APPROVED',
            unowned: true,
            expectDryRunSha256: command.dryRunSha256,
            now,
            patch: {
              approvedDryRunSha256: command.dryRunSha256,
              approvedByAdminId: adminIdOf(actor),
              approvedAt: now,
            },
          },
          tx,
        );
        if (!moved) throw invalidState(row.status);
        await this.deps.audit.record(
          scope,
          actor,
          {
            action,
            entityType: ENTITY,
            entityId: row.id,
            before: { status: row.status },
            after: {
              status: 'APPROVED',
              fileSha256: row.fileSha256,
              dryRunSha256: command.dryRunSha256,
              packageSourceFingerprint: row.packageSourceFingerprint,
            },
            reason: 'The owner approved a Mirza package dry run and started its import.',
            result: 'SUCCESS',
          },
          tx,
        );
      },
    );
  }

  /** Any non-terminal state but APPLYING (an apply in progress is finished, never abandoned). */
  async cancel(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    body: unknown,
  ): Promise<LegacyMigrationImportView> {
    const action = LEGACY_NXPKG_AUDIT_ACTIONS.cancel;
    this.assertEnabled();
    await this.requirePermission(scope, actor, LEGACY_MIGRATION_MANAGE_PERMISSION, {
      action,
      entityId: id,
    });
    const command = legacyMigrationCommandRequestSchema.parse(body);
    const requestHash = hashRequest({ action, importId: id });
    return this.idempotent(
      scope,
      actor,
      { idempotencyKey: command.idempotencyKey, requestHash, id, action },
      async (tx) => {
        const row = await this.lockFor(scope, id, LEGACY_MIGRATION_COMMAND_FROM.cancel, tx, {
          // A cancel does not wait for the worker: the worker's next lease-guarded write
          // matches nothing, and it stops (its heartbeat is refused, its step aborted).
          allowOwned: true,
        });
        const moved = await this.deps.repository.transition(
          {
            id: row.id,
            tenantId: scope.tenantId,
            from: LEGACY_MIGRATION_COMMAND_FROM.cancel,
            to: 'CANCELLED',
            now: this.deps.clock.now(),
            patch: { errorCode: 'CANCELLED' },
          },
          tx,
        );
        if (!moved) throw invalidState(row.status);
        await this.deps.audit.record(
          scope,
          actor,
          {
            action,
            entityType: ENTITY,
            entityId: row.id,
            before: { status: row.status },
            after: { status: 'CANCELLED', fileSha256: row.fileSha256 },
            result: 'SUCCESS',
          },
          tx,
        );
      },
    );
  }

  // --- internals --------------------------------------------------------------------------

  /**
   * One command: replay its stored answer if this key already ran, else run it inside an
   * authorized transaction that reads scope activity, then remember the key. The stored
   * result is the import id; the answer is the import as it stands.
   */
  private async idempotent(
    scope: TenantContext,
    actor: ActorContext,
    command: {
      readonly idempotencyKey: string;
      readonly requestHash: string;
      readonly id: string;
      readonly action: string;
      readonly permission?: PermissionKey;
    },
    fn: (tx: TransactionScope) => Promise<void>,
  ): Promise<LegacyMigrationImportView> {
    const { idempotencyKey, requestHash, id } = command;
    const replay = () =>
      this.deps.idempotency.find<{ importId: string }>(
        scope,
        actor.surface,
        idempotencyKey,
        requestHash,
      );
    const found = await replay();
    if (found !== null) return this.detailUnchecked(scope, found.result.importId);
    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      command.permission ?? LEGACY_MIGRATION_MANAGE_PERMISSION,
      { action: command.action, entityType: ENTITY, entityId: id },
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        // Asked again inside: a concurrent request with this key that committed while this
        // one waited is a replay, not a second command.
        if ((await replay()) !== null) return;
        await fn(tx);
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          idempotencyKey,
          requestHash,
          { importId: id },
          tx,
        );
      },
    );
    return this.detailUnchecked(scope, id);
  }

  /** Locks the row and checks it accepts a command from these states, with no live worker. */
  private async lockFor(
    scope: TenantContext,
    id: string,
    from: readonly LegacyNxpkgImportStatus[],
    tx: TransactionScope,
    options: { readonly allowOwned?: boolean } = {},
  ): Promise<LegacyNxpkgImportRow> {
    const row = await this.deps.repository.byId(scope.tenantId, validId(id), { tx, lock: true });
    if (row === null) throw notFound();
    if (!from.includes(row.status)) throw invalidState(row.status);
    if (options.allowOwned !== true && row.claimedBy !== null) throw invalidState(row.status);
    return row;
  }

  /**
   * Writes a configuration change. From DRY_RUN_DONE it is also a transition back to
   * VERIFIED that clears the dry run, so no approval can bind a report computed from inputs
   * the import no longer has.
   */
  private async reconfigure(
    scope: TenantContext,
    row: LegacyNxpkgImportRow,
    patch: LegacyNxpkgImportPatch,
    tx: TransactionScope,
  ): Promise<void> {
    const now = this.deps.clock.now();
    if (row.status === 'DRY_RUN_DONE') {
      const moved = await this.deps.repository.transition(
        {
          id: row.id,
          tenantId: scope.tenantId,
          from: ['DRY_RUN_DONE'],
          to: 'VERIFIED',
          unowned: true,
          now,
          patch: { ...patch, ...CLEAR_DRY_RUN },
        },
        tx,
      );
      if (!moved) throw invalidState(row.status);
      return;
    }
    await this.mustPatch(
      {
        id: row.id,
        tenantId: scope.tenantId,
        from: [row.status],
        unowned: true,
        now,
        patch,
      },
      tx,
    );
  }

  private async mustPatch(
    input: Parameters<LegacyNxpkgImportRepository['patch']>[0],
    tx: TransactionScope,
  ): Promise<void> {
    if (!(await this.deps.repository.patch(input, tx))) throw invalidState(null);
  }

  private async auditConfigure(
    scope: TenantContext,
    actor: ActorContext,
    row: LegacyNxpkgImportRow,
    after: Record<string, unknown>,
    tx: TransactionScope,
  ): Promise<void> {
    await this.deps.audit.record(
      scope,
      actor,
      {
        action: LEGACY_NXPKG_AUDIT_ACTIONS.configure,
        entityType: ENTITY,
        entityId: row.id,
        before: { status: row.status },
        after,
        result: 'SUCCESS',
      },
      tx,
    );
  }

  private async detailUnchecked(
    scope: TenantContext,
    id: string,
  ): Promise<LegacyMigrationImportView> {
    return legacyMigrationView(await this.require(scope, id), this.deps.clock.now());
  }

  private async require(scope: TenantContext, id: string): Promise<LegacyNxpkgImportRow> {
    const row = await this.deps.repository.byId(scope.tenantId, validId(id));
    if (row === null) throw notFound();
    return row;
  }

  private assertEnabled(): void {
    if (!this.deps.enabled) {
      throw errors.preconditionFailed(
        CODES.DISABLED,
        'Mirza package import is turned off on this installation (LEGACY_MIGRATION_ENABLED).',
      );
    }
  }

  private async assertScopeActive(scope: TenantContext, tx: TransactionScope): Promise<void> {
    if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
      throw errors.conflict(CODES.SCOPE_STOPPED, 'This installation has stopped accepting work.');
    }
  }

  /** An early check that leaves the same DENIED trace a refusal inside the transaction does. */
  private async requirePermission(
    scope: TenantContext,
    actor: ActorContext,
    permission: PermissionKey,
    denial: { readonly action: string; readonly entityId: string | null },
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, permission);
    } catch (error) {
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        permission,
        { action: denial.action, entityType: ENTITY, entityId: denial.entityId },
        error,
      );
      throw error;
    }
  }

  private mutationDeps() {
    return {
      uow: this.deps.uow,
      guard: this.deps.guard,
      audit: this.deps.audit,
      opsLog: this.deps.opsLog,
      sessions: this.deps.sessions,
      clock: this.deps.clock,
    };
  }
}

/** What a reconfiguration or a new dry-run request clears. */
const CLEAR_DRY_RUN: LegacyNxpkgImportPatch = {
  dryRunReport: null,
  dryRunSha256: null,
  dryRunLegacyRunId: null,
};

function acceptsCommand(
  row: LegacyNxpkgImportRow,
  from: readonly LegacyNxpkgImportStatus[],
): boolean {
  return from.includes(row.status) && row.claimedBy === null;
}

/**
 * The ONLY thing that turns an import row into JSON. It does not carry `filePath`,
 * `decisionsFilePath`, `keyCiphertext`, `keyKeyId`, `manifestSummary` or `decisionsSummary`:
 * paths on the installation's disk, the sealed key and its keyring id are not a browser's
 * business. Whether a key is held is a boolean. Each report is re-validated against its
 * contract schema; one that does not match is shown as absent rather than passed through.
 */
export function legacyMigrationView(
  row: LegacyNxpkgImportRow,
  now: Date,
): LegacyMigrationImportView {
  const verify = legacyMigrationVerifyReportSchema.safeParse(row.verifyReport);
  const dryRun = legacyMigrationDryRunReportSchema.safeParse(row.dryRunReport);
  const apply = legacyMigrationApplyReportSchema.safeParse(row.applyReport);
  return {
    id: row.id,
    status: row.status,
    errorCode: row.errorCode,
    fileName: row.fileName,
    fileSha256: row.fileSha256,
    fileBytes: String(row.fileBytes),
    packageImportId: row.packageImportId,
    packageSourceFingerprint: row.packageSourceFingerprint,
    packageSchemaVersion: row.packageSchemaVersion,
    converterVersion: row.converterVersion,
    keyPresent: row.keyCiphertext !== null,
    keyKind: row.keyKind,
    decisionsPresent: row.decisionsFilePath !== null,
    panelBindings:
      row.panelBindings === null
        ? null
        : row.panelBindings.map((binding) => ({
            codePanel: binding.codePanel,
            panelId: binding.panelId,
          })),
    verifyReport: verify.success ? verify.data : null,
    dryRunReport: dryRun.success ? dryRun.data : null,
    dryRunSha256: row.dryRunSha256,
    approvedDryRunSha256: row.approvedDryRunSha256,
    applyReport: apply.success ? apply.data : null,
    dryRunLegacyRunId: row.dryRunLegacyRunId,
    applyLegacyRunId: row.applyLegacyRunId,
    backupRunId: row.backupRunId,
    progress: { ...row.progress },
    working:
      row.claimedBy !== null && row.leaseUntil !== null && row.leaseUntil.getTime() > now.getTime(),
    requestedByAdminId: row.requestedByAdminId,
    approvedByAdminId: row.approvedByAdminId,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

function validId(id: string): string {
  const parsed = uuidV7Schema.safeParse(id);
  // A malformed id is a not-found, never a 22P02 turned into a 500 by the database.
  if (!parsed.success) throw notFound();
  return parsed.data;
}

function adminIdOf(actor: ActorContext): string {
  // The guard decides WHO may act; this only names them. The column is an admin of this
  // tenant (composite foreign key), so a SYSTEM_JOB could not be named here anyway.
  if (actor.id === null || actor.type === 'SYSTEM_JOB' || actor.type === 'CUSTOMER') {
    throw errors.permissionDenied('platform.permission_denied', 'Only an administrator does this.');
  }
  return actor.id;
}

function notFound(): Error {
  return errors.notFound(CODES.NOT_FOUND, 'No such Mirza package import.');
}

function alreadyActive(): Error {
  return errors.conflict(
    CODES.ALREADY_ACTIVE,
    'Another Mirza package import of this installation is not finished. One at a time.',
  );
}

function invalidState(status: LegacyNxpkgImportStatus | null): Error {
  return errors.conflict(
    CODES.INVALID_STATE,
    'This import is not in a state that accepts this command. Nothing changed.',
    status === null ? {} : { status },
  );
}
