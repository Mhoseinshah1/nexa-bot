import type { Readable } from 'node:stream';
import {
  DATA_EXPORT_ERROR_CODES,
  DATA_EXPORT_FILE_PREFIX,
  HOSTING_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  dataExportHostRequestSchema,
  dataExportRequestSchema,
  errors,
  isSystemContext,
  uuidV7Schema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type DataExportRequestResponse,
  type DataExportsResponse,
  type DataExportView,
  type IdempotencyStore,
  type IdGenerator,
  type OperationalEventRecorder,
  type PermissionKey,
  type ScopeContext,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import { withTenantScopeIn } from '../../../../infrastructure/persistence/database-scope.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
} from '../../access/application/authorized-mutation.js';
import type { PermissionGuard } from '../../access/application/permission-guard.js';
import type { SessionRepository } from '../../identity/application/ports.js';
import { rememberOnce } from '../../idempotency/application/remember-once.js';
import { hashRequest } from '../../idempotency/infrastructure/drizzle-idempotency-store.js';
import type { HostingOwnerGuard } from '../../hosting/application/hosting-owner-guard.js';
import type { HostingSectionService } from '../../hosting/application/hosting-section.service.js';
import type { ScopeActivityReader } from '../../system/application/record-ping.service.js';
import type {
  DataExportFiles,
  DataExportRepository,
  DataExportRow,
  HostedBotLookup,
} from './ports.js';

/** The permission this feature is charged on. CRITICAL; seeded to `owner`. */
export const DATA_EXPORT_PERMISSION: PermissionKey = 'data.export';

/** How many exports a list shows: the newest. A finished one lives 24 h, so few exist. */
export const DATA_EXPORT_LIST_LIMIT = 20;

export interface DataExportServiceDeps {
  readonly repository: DataExportRepository;
  readonly files: DataExportFiles;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly guard: PermissionGuard;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly hostedBots: HostedBotLookup;
  readonly section: Pick<
    HostingSectionService,
    'requireSection' | 'withFreshProof' | 'assertSectionIn'
  >;
  readonly owner: Pick<HostingOwnerGuard, 'check'>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** The installation's own tenant: its data is not exported (it is no hosted bot's). */
  readonly installationTenantId: () => string | null;
}

export interface DataExportDownload {
  readonly stream: Readable;
  readonly bytes: number;
  readonly fileName: string;
  readonly sha256: string;
}

/**
 * Phase 6B PR-3 (ADR-0039, the open data export): asking for an export, listing, and taking
 * the file. The work itself is the worker's (`DataExportRunner`), through the heavy-job queue.
 *
 * TWO DOORS to the same rows. A hosted bot's OWNER, in their own Web Admin, holding the
 * CRITICAL `data.export` in their own tenant. The INSTALLATION OWNER, from «میزبانی‌ها»: the
 * section session and a fresh second-factor code on the request (`HostingSectionService`), the
 * audit row in HIS log (the hosted tenant's log is not written, D5), the export row in the
 * hosted tenant's scope. The installation's own tenant is never exported
 * (`data_export.not_hosted`).
 *
 * Every write re-checks, INSIDE its transaction, the permission or the owner and the section,
 * the session's liveness and the scope's activity (`ScopeActivityReader`), then the row, the
 * audit row and the idempotency record commit together.
 */
export class DataExportService {
  constructor(private readonly deps: DataExportServiceDeps) {}

  // ------------------------------------------------------------------------------------
  // A hosted bot's owner, in their own Web Admin
  // ------------------------------------------------------------------------------------

  async listOwn(scope: ScopeContext, actor: ActorContext): Promise<DataExportsResponse> {
    const tenant = await this.ownTenant(scope, actor, 'data_export.list');
    // A hosted owner sees their own requests; the host's are the host's to see.
    const rows = await this.deps.repository.list(tenant, DATA_EXPORT_LIST_LIMIT, undefined, {
      requestedByHost: false,
    });
    return { exports: rows.map((row) => this.view(row)) };
  }

  async requestOwn(
    scope: ScopeContext,
    actor: ActorContext,
    input: unknown,
  ): Promise<DataExportRequestResponse> {
    const tenant = await this.ownTenant(scope, actor, 'data_export.requested');
    const command = dataExportRequestSchema.parse(input);
    const requestHash = hashRequest({ action: 'data_export.requested', tenantId: tenant.tenantId });
    const replay = await this.replayOf(tenant, actor, command.idempotencyKey, requestHash);
    if (replay !== null) return replay;
    const exportId = this.deps.ids.uuid();
    await runAuthorizedMutation(
      this.deps,
      tenant,
      actor,
      DATA_EXPORT_PERMISSION,
      { action: 'data_export.requested', entityType: 'DataExport', entityId: null },
      async (tx) => {
        await this.assertActive(tenant, tx);
        await this.insertRow(
          tenant,
          tenant,
          actor,
          exportId,
          false,
          requestHash,
          command.idempotencyKey,
          tx,
        );
      },
    );
    return { export: await this.requireView(tenant, exportId), replayed: false };
  }

  async downloadOwn(
    scope: ScopeContext,
    actor: ActorContext,
    id: string,
  ): Promise<DataExportDownload> {
    const tenant = await this.ownTenant(scope, actor, 'data_export.downloaded');
    const exportId = parseExportId(id);
    const row = await this.deps.repository.find(tenant, exportId);
    // The host's own requests are the host's: not found here, not "forbidden".
    if (row === null || row.requestedByHost) throw notFound();
    const download = await this.open(row);
    try {
      await runAuthorizedMutation(
        this.deps,
        tenant,
        actor,
        DATA_EXPORT_PERMISSION,
        { action: 'data_export.downloaded', entityType: 'DataExport', entityId: exportId },
        async (tx) => this.auditDownload(tenant, tenant, actor, row, tx),
      );
    } catch (error) {
      // No audit row, no file: the opened stream is closed, not handed out.
      download.stream.destroy();
      throw error;
    }
    return download;
  }

  // ------------------------------------------------------------------------------------
  // The installation owner, from «میزبانی‌ها»
  // ------------------------------------------------------------------------------------

  async listHosted(
    scope: ScopeContext,
    actor: ActorContext,
    token: string | null,
    id: string,
  ): Promise<DataExportsResponse> {
    const hosted = parseHostedTenantId(id);
    const installation = await this.deps.section.requireSection(
      scope,
      actor,
      token,
      'data_export.list',
      hosted,
    );
    await this.requireHosted(installation, hosted);
    const rows = await this.deps.repository.list(
      { tenantId: hosted, botInstanceId: null } as TenantContext,
      DATA_EXPORT_LIST_LIMIT,
    );
    return { exports: rows.map((row) => this.view(row)) };
  }

  async requestHosted(
    scope: ScopeContext,
    actor: ActorContext,
    token: string | null,
    id: string,
    input: unknown,
  ): Promise<DataExportRequestResponse> {
    const hosted = parseHostedTenantId(id);
    const installation = await this.deps.section.requireSection(
      scope,
      actor,
      token,
      'data_export.requested',
      hosted,
    );
    const command = dataExportHostRequestSchema.parse(input);
    await this.requireHosted(installation, hosted);
    const target = { tenantId: hosted, botInstanceId: null } as TenantContext;
    const requestHash = hashRequest({ action: 'data_export.requested', tenantId: hosted });
    // A retry of a request that committed answers its first result BEFORE a code is spent.
    const replay = await this.replayOf(
      installation,
      actor,
      command.idempotencyKey,
      requestHash,
      target,
    );
    if (replay !== null) return replay;
    const exportId = this.deps.ids.uuid();
    await this.deps.section.withFreshProof(
      installation,
      actor,
      command.proof,
      'data_export.requested',
      async (tx, _now, method) => {
        await this.assertHostInTransaction(installation, actor, token, tx);
        const row = await this.deps.hostedBots.findHosted(installation, hosted, tx);
        if (row === null || row.state === 'PURGED') throw hostNotFound();
        await this.insertRow(
          installation,
          target,
          actor,
          exportId,
          true,
          requestHash,
          command.idempotencyKey,
          tx,
          method,
        );
      },
    );
    return { export: await this.requireView(target, exportId), replayed: false };
  }

  async downloadHosted(
    scope: ScopeContext,
    actor: ActorContext,
    token: string | null,
    id: string,
    exportIdRaw: string,
  ): Promise<DataExportDownload> {
    const hosted = parseHostedTenantId(id);
    const installation = await this.deps.section.requireSection(
      scope,
      actor,
      token,
      'data_export.downloaded',
      hosted,
    );
    await this.requireHosted(installation, hosted);
    const target = { tenantId: hosted, botInstanceId: null } as TenantContext;
    const exportId = parseExportId(exportIdRaw);
    const row = await this.deps.repository.find(target, exportId);
    if (row === null) throw notFound();
    const download = await this.open(row);
    try {
      await this.deps.uow.run(installation, async (tx) => {
        await this.assertHostInTransaction(installation, actor, token, tx);
        await this.auditDownload(installation, target, actor, row, tx);
      });
    } catch (error) {
      download.stream.destroy();
      throw error;
    }
    return download;
  }

  // ------------------------------------------------------------------------------------

  /** The caller's tenant, after the permission and the "not the installation" rule. */
  private async ownTenant(
    scope: ScopeContext,
    actor: ActorContext,
    action: string,
  ): Promise<TenantContext> {
    if (isSystemContext(scope)) {
      throw errors.permissionDenied(
        PLATFORM_ERROR_CODES.PERMISSION_DENIED,
        'A tenant is required.',
        {
          permission: DATA_EXPORT_PERMISSION,
        },
      );
    }
    try {
      await this.deps.guard.check(scope, actor, DATA_EXPORT_PERMISSION);
    } catch (denial) {
      await recordMutationDenial(
        this.deps,
        scope,
        actor,
        DATA_EXPORT_PERMISSION,
        { action, entityType: 'DataExport', entityId: null },
        denial,
      );
      throw denial;
    }
    const installation = this.deps.installationTenantId();
    if (installation === null || scope.tenantId.toLowerCase() === installation.toLowerCase()) {
      throw errors.preconditionFailed(
        DATA_EXPORT_ERROR_CODES.NOT_HOSTED,
        'Only a hosted bot’s data is exported.',
      );
    }
    return { tenantId: scope.tenantId, botInstanceId: null } as TenantContext;
  }

  private async requireHosted(installation: TenantContext, hosted: string): Promise<void> {
    const row = await this.deps.hostedBots.findHosted(installation, hosted);
    if (row === null || row.state === 'PURGED') throw hostNotFound();
  }

  /** What every host write re-checks first, on its own connection (as `HostingService`). */
  private async assertHostInTransaction(
    installation: TenantContext,
    actor: ActorContext,
    token: string | null,
    tx: TransactionScope,
  ): Promise<void> {
    await this.deps.owner.check(installation, actor, tx);
    await this.deps.section.assertSectionIn(installation, actor, token, tx);
    if (!(await this.deps.scopeActivity.scopeIsActive(installation, tx))) {
      throw errors.notFound(
        PLATFORM_ERROR_CODES.TENANT_NOT_FOUND,
        'This scope is not accepting work.',
      );
    }
  }

  private async assertActive(scope: TenantContext, tx: TransactionScope): Promise<void> {
    if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
      throw errors.notFound(
        PLATFORM_ERROR_CODES.TENANT_NOT_FOUND,
        'This scope is not accepting work.',
      );
    }
  }

  /**
   * The row, its audit row and the idempotency record, in ONE transaction. `home` is the scope
   * the audit row and the key belong to (the actor's: the owner's own log); `target` the
   * exported tenant the row belongs to — the same scope for a hosted owner, the hosted
   * tenant's for the installation owner, bound for the insert alone.
   */
  private async insertRow(
    home: TenantContext,
    target: TenantContext,
    actor: ActorContext,
    exportId: string,
    byHost: boolean,
    requestHash: string,
    idempotencyKey: string,
    tx: TransactionScope,
    method?: string,
  ): Promise<void> {
    const now = this.deps.clock.now();
    const insert = async (): Promise<void> => {
      if ((await this.deps.repository.active(target, tx)) !== null) {
        throw errors.conflict(
          DATA_EXPORT_ERROR_CODES.IN_PROGRESS,
          'An export of this data is already being made.',
        );
      }
      await this.deps.repository.insert(
        target,
        { id: exportId, requestedByAdminId: actor.id as string, requestedByHost: byHost, now },
        tx,
      );
    };
    if (target.tenantId === home.tenantId) await insert();
    else await withTenantScopeIn(tx.tx, target, insert);
    await this.deps.audit.record(
      home,
      actor,
      {
        action: 'data_export.requested',
        entityType: 'DataExport',
        entityId: exportId,
        before: null,
        after: {
          tenantId: target.tenantId,
          requestedByHost: byHost,
          ...(method === undefined ? {} : { proof: method }),
        },
        result: 'SUCCESS',
      },
      tx,
    );
    await rememberOnce(
      this.deps.idempotency,
      home,
      actor.surface,
      idempotencyKey,
      requestHash,
      { exportId },
      tx,
    );
  }

  private async auditDownload(
    home: TenantContext,
    target: TenantContext,
    actor: ActorContext,
    row: DataExportRow,
    tx: TransactionScope,
  ): Promise<void> {
    await this.deps.audit.record(
      home,
      actor,
      {
        action: 'data_export.downloaded',
        entityType: 'DataExport',
        entityId: row.id,
        before: null,
        after: { tenantId: target.tenantId, bytes: row.bytes, sha256: row.sha256 },
        result: 'SUCCESS',
      },
      tx,
    );
  }

  /** The first result of a key that already committed, as the same response. */
  private async replayOf(
    home: TenantContext,
    actor: ActorContext,
    key: string,
    requestHash: string,
    target: TenantContext = home,
  ): Promise<DataExportRequestResponse | null> {
    const found = await this.deps.idempotency.find<{ exportId: string }>(
      home,
      actor.surface,
      key,
      requestHash,
    );
    if (found === null) return null;
    return { export: await this.requireView(target, found.result.exportId), replayed: true };
  }

  /** The file of a READY export, or the refusal that says why not. */
  private async open(row: DataExportRow): Promise<DataExportDownload> {
    const now = this.deps.clock.now();
    if (
      row.state === 'EXPIRED' ||
      (row.state === 'READY' && row.expiresAt !== null && row.expiresAt <= now)
    ) {
      throw errors.preconditionFailed(
        DATA_EXPORT_ERROR_CODES.EXPIRED,
        'The download link of this export has expired. Ask for a new export.',
      );
    }
    if (row.state !== 'READY' || row.fileName === null || row.sha256 === null) {
      throw errors.preconditionFailed(
        DATA_EXPORT_ERROR_CODES.NOT_READY,
        'This export is not ready.',
      );
    }
    const file = await this.deps.files.open(row.tenantId, row.fileName);
    if (file === null) {
      // The row says READY and the file is gone (swept, or a disk lost): as expired as it gets.
      throw errors.preconditionFailed(
        DATA_EXPORT_ERROR_CODES.EXPIRED,
        'The file of this export is no longer available. Ask for a new export.',
      );
    }
    return {
      stream: file.stream,
      bytes: file.bytes,
      sha256: row.sha256,
      fileName: `${DATA_EXPORT_FILE_PREFIX}-${row.id}.zip`,
    };
  }

  private async requireView(scope: TenantContext, id: string): Promise<DataExportView> {
    const row = await this.deps.repository.find(scope, id);
    if (row === null) throw notFound();
    return this.view(row);
  }

  view(row: DataExportRow): DataExportView {
    const now = this.deps.clock.now();
    const live = row.state === 'READY' && row.expiresAt !== null && row.expiresAt > now;
    return {
      id: row.id,
      // A READY row past its deadline is shown EXPIRED before the sweep has caught up.
      state: row.state === 'READY' && !live ? 'EXPIRED' : row.state,
      requestedAt: row.requestedAt.toISOString(),
      requestedByHost: row.requestedByHost,
      readyAt: row.readyAt?.toISOString() ?? null,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      bytes: row.bytes,
      failureCode: row.failureCode,
      downloadable: live,
    };
  }
}

function notFound(): Error {
  return errors.notFound(DATA_EXPORT_ERROR_CODES.NOT_FOUND, 'No such export.');
}

function hostNotFound(): Error {
  return errors.notFound(HOSTING_ERROR_CODES.BOT_NOT_FOUND, 'No such hosted bot.');
}

function parseExportId(id: string): string {
  const parsed = uuidV7Schema.safeParse(id);
  if (!parsed.success) throw notFound();
  return parsed.data;
}

function parseHostedTenantId(id: string): string {
  const parsed = uuidV7Schema.safeParse(id);
  if (!parsed.success) throw hostNotFound();
  return parsed.data;
}
