import { errors, LEGACY_MIGRATION_HTTP_ERROR_CODES } from '@nexa/contracts';
import {
  EMPTY_LEGACY_MIGRATION_PROGRESS,
  isLegacyMigrationFailure,
  isLegacyMigrationTerminal,
  LEGACY_MIGRATION_WORK_STATUSES,
} from '../../apps/api/src/modules/platform/legacy-migration/domain/import-lifecycle';
import type {
  LegacyNxpkgImportRepository,
  LegacyNxpkgImportRow,
  LegacyNxpkgTransition,
  MigrationImportFiles,
  MigrationWorkspaces,
  NewLegacyNxpkgImport,
} from '../../apps/api/src/modules/platform/legacy-migration/application/ports';

/**
 * In-memory doubles for the `legacy-migration` module's repository and workspaces, with the
 * SAME semantics the Drizzle repository has (conditional from-states, the lease guard, the
 * terminal key erasure, one active import per tenant). The integration suite runs the real
 * repository against PostgreSQL; this is for fast state-machine cases.
 */
export class InMemoryLegacyNxpkgImports implements LegacyNxpkgImportRepository {
  readonly rows = new Map<string, LegacyNxpkgImportRow>();

  async insert(input: NewLegacyNxpkgImport): Promise<LegacyNxpkgImportRow> {
    if ((await this.active(input.tenantId)) !== null) {
      throw errors.conflict(LEGACY_MIGRATION_HTTP_ERROR_CODES.ALREADY_ACTIVE, 'active');
    }
    const row: LegacyNxpkgImportRow = {
      id: input.id,
      tenantId: input.tenantId,
      status: 'UPLOADED',
      errorCode: null,
      fileName: input.fileName,
      filePath: input.filePath,
      fileSha256: input.fileSha256,
      fileBytes: input.fileBytes,
      packageImportId: null,
      packageSourceFingerprint: null,
      packageSchemaVersion: null,
      converterVersion: null,
      manifestSummary: null,
      keyCiphertext: null,
      keyKeyId: null,
      keyKind: null,
      decisionsFilePath: null,
      decisionsSummary: null,
      panelBindings: null,
      verifyReport: null,
      dryRunReport: null,
      dryRunSha256: null,
      approvedDryRunSha256: null,
      applyReport: null,
      dryRunLegacyRunId: null,
      applyLegacyRunId: null,
      backupRunId: null,
      progress: { ...EMPTY_LEGACY_MIGRATION_PROGRESS },
      requestedByAdminId: input.requestedByAdminId,
      approvedByAdminId: null,
      approvedAt: null,
      claimedBy: null,
      leaseUntil: null,
      createdAt: input.now,
      updatedAt: input.now,
      finishedAt: null,
    };
    this.rows.set(row.id, row);
    return row;
  }

  async byId(tenantId: string, id: string): Promise<LegacyNxpkgImportRow | null> {
    const row = this.rows.get(id);
    return row !== undefined && row.tenantId === tenantId ? row : null;
  }

  async byIdUnscoped(id: string): Promise<LegacyNxpkgImportRow | null> {
    return this.rows.get(id) ?? null;
  }

  async active(tenantId: string): Promise<LegacyNxpkgImportRow | null> {
    return (
      [...this.rows.values()].find(
        (row) => row.tenantId === tenantId && !isLegacyMigrationTerminal(row.status),
      ) ?? null
    );
  }

  async page(input: { tenantId: string; limit: number; before: string | null }) {
    return [...this.rows.values()]
      .filter((row) => row.tenantId === input.tenantId)
      .filter((row) => input.before === null || row.id < input.before)
      .sort((a, b) => (a.id < b.id ? 1 : -1))
      .slice(0, input.limit + 1);
  }

  private matches(input: Omit<LegacyNxpkgTransition, 'to' | 'now' | 'patch'>) {
    const row = this.rows.get(input.id);
    if (row === undefined) return null;
    if (!input.from.includes(row.status)) return null;
    if (input.tenantId !== undefined && row.tenantId !== input.tenantId) return null;
    if (input.leaseOwner !== undefined && row.claimedBy !== input.leaseOwner) return null;
    if (input.unowned === true && row.claimedBy !== null) return null;
    if (input.expectDryRunSha256 !== undefined && row.dryRunSha256 !== input.expectDryRunSha256) {
      return null;
    }
    return row;
  }

  async transition(input: LegacyNxpkgTransition): Promise<boolean> {
    const row = this.matches(input);
    if (row === null) return false;
    const patch = input.patch ?? {};
    if (isLegacyMigrationFailure(input.to) && (patch.errorCode ?? null) === null) {
      throw new Error(`A transition to ${input.to} needs an error code.`);
    }
    const terminal = isLegacyMigrationTerminal(input.to);
    const next: LegacyNxpkgImportRow = {
      ...row,
      ...stripUndefined(patch),
      status: input.to,
      updatedAt: input.now,
      finishedAt: terminal ? input.now : null,
      errorCode: isLegacyMigrationFailure(input.to) ? (patch.errorCode ?? null) : null,
      ...(terminal ? { keyCiphertext: null, keyKeyId: null } : {}),
      ...(terminal || input.releaseLease === true ? { claimedBy: null, leaseUntil: null } : {}),
    };
    this.rows.set(row.id, next);
    return true;
  }

  async patch(input: Omit<LegacyNxpkgTransition, 'to' | 'releaseLease'>): Promise<boolean> {
    const row = this.matches(input);
    if (row === null) return false;
    this.rows.set(row.id, { ...row, ...stripUndefined(input.patch ?? {}), updatedAt: input.now });
    return true;
  }

  async claim(input: { leaseOwner: string; now: Date; leaseUntil: Date }) {
    const work: readonly string[] = LEGACY_MIGRATION_WORK_STATUSES;
    const candidate = [...this.rows.values()]
      .filter((row) => work.includes(row.status))
      .filter((row) => row.status !== 'UPLOADED' || row.keyCiphertext !== null)
      .filter((row) => row.claimedBy === null || row.claimedBy === input.leaseOwner)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
    if (candidate === undefined) return null;
    const next = { ...candidate, claimedBy: input.leaseOwner, leaseUntil: input.leaseUntil };
    this.rows.set(candidate.id, next);
    return next;
  }

  async heartbeat(input: { id: string; leaseOwner: string; leaseUntil: Date }) {
    const row = this.rows.get(input.id);
    if (row === undefined || row.claimedBy !== input.leaseOwner) return false;
    this.rows.set(row.id, { ...row, leaseUntil: input.leaseUntil });
    return true;
  }

  async release(input: { id: string; leaseOwner: string; now: Date }) {
    const row = this.rows.get(input.id);
    if (row === undefined || row.claimedBy !== input.leaseOwner) return;
    this.rows.set(row.id, { ...row, claimedBy: null, leaseUntil: null });
  }

  async reclaimStale(input: { now: Date }) {
    const work: readonly string[] = LEGACY_MIGRATION_WORK_STATUSES;
    const released: LegacyNxpkgImportRow[] = [];
    for (const row of this.rows.values()) {
      if (
        work.includes(row.status) &&
        row.leaseUntil !== null &&
        row.leaseUntil.getTime() < input.now.getTime()
      ) {
        const next = { ...row, claimedBy: null, leaseUntil: null };
        this.rows.set(row.id, next);
        released.push(next);
      }
    }
    return released;
  }

  /** Test helper: overwrite a row. */
  put(row: LegacyNxpkgImportRow): void {
    this.rows.set(row.id, row);
  }
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Partial<T>;
}

/** Workspaces that touch no disk; the package digest is whatever the test says it is. */
export class InMemoryMigrationWorkspaces implements MigrationWorkspaces {
  readonly steps = new Set<string>();
  readonly discarded: string[] = [];
  digests = new Map<string, string>();
  private counter = 0;

  async create(importId: string): Promise<MigrationImportFiles> {
    return this.filesOf(importId);
  }
  filesOf(importId: string): MigrationImportFiles {
    return { directory: `/fake/${importId}`, packagePath: `/fake/${importId}/package.nxpkg` };
  }
  decisionsUploadPath(importId: string): string {
    return `/fake/${importId}/upload.partial`;
  }
  decisionsPath(importId: string, sha256: string): string {
    return `/fake/${importId}/ownership-decisions-${sha256}.json`;
  }
  async promote(): Promise<void> {}
  async removeFile(): Promise<void> {}
  async discard(importId: string): Promise<void> {
    this.discarded.push(importId);
  }
  async stepDirectory(importId: string): Promise<string> {
    this.counter += 1;
    const path = `/fake/${importId}/step-${String(this.counter)}`;
    this.steps.add(path);
    return path;
  }
  async discardStep(path: string): Promise<void> {
    this.steps.delete(path);
  }
  async discardStaleSteps(): Promise<number> {
    return 0;
  }
  async digest(path: string): Promise<{ sha256: string; bytes: number }> {
    return { sha256: this.digests.get(path) ?? 'f'.repeat(64), bytes: 1 };
  }
}
