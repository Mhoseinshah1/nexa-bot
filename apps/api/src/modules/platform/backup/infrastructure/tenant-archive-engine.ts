import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  NexaError,
  PLATFORM_ERROR_CODES,
  TENANT_ARCHIVE_ERROR_CODES,
  type SecretCipher,
  type TenantArchiveManifest,
  type TenantRestoreMode,
  type TenantRestoreStage,
} from '@nexa/contracts';
import { KEY_BUNDLE_ENTRY, sealKeyBundle } from '../../../../infrastructure/crypto/key-bundle.js';
import type { KdfProfile } from '../../../../infrastructure/crypto/kek.js';
import { expectedMigrations } from '../../../../infrastructure/persistence/migration-state.js';
import type {
  ScratchSweep,
  TenantArchiveEngine,
  TenantArchiveWorkspace,
  TenantRestoreEngine,
  TenantRestoreSummary,
} from '../application/tenant-archive.service.js';
import { applyRestore, preflightRestore } from './tenant-archive-apply.js';
import { applyReplace } from './tenant-archive-replace.js';
import { exportTenant, type TenantExportInput } from './tenant-archive-export.js';
import {
  compareArchiveHead,
  loadScratch,
  migrateScratchTo,
  openTenantArchive,
  refuseHead,
  verifyScratch,
  withScratchHandle,
  type OpenedTenantArchive,
} from './tenant-archive-restore.js';
import { archiveCipher, archiveKeyId } from './tenant-archive-secrets.js';
import { sealSevenZipEntries, type SevenZipOptions } from './seven-zip.js';
import { HOSTED_DIRECTORY, HOSTED_PLAINTEXT } from './workspace.js';

/**
 * Phase 6B (ADR-0039): the tenant archive engine — the export, the 7z, the scratch
 * verification and the restore, assembled from `tenant-archive-*.ts` behind the application's
 * ports. Holds no handle of its own beyond the application's (`nexa_app`) one; every database
 * statement is made by those modules under an explicit scope.
 */

/** Where scratch databases come from: `PostgresDatabaseTools` (the verify server). */
export interface ScratchDatabases {
  createScratchDatabase(): Promise<{ readonly name: string; readonly url: string }>;
  dropScratchDatabase(name: string): Promise<{ readonly dropped: boolean }>;
  readonly databaseName: string;
  readonly leaked: readonly string[];
  /** Drops idle tenant scratch databases a killed process left (`PostgresDatabaseTools`). */
  dropAbandonedScratchDatabases(): Promise<ScratchSweep>;
}

export interface TenantArchiveEngineDeps {
  /** The application's handle, as `nexa_app` (an owner handle is refused at export). */
  readonly app: TenantExportInput['app'];
  readonly scratch: ScratchDatabases;
  readonly sevenZip: SevenZipOptions;
  /** `BACKUP_WORK_DIR`: hosted archives live under `<root>/hosted/<tenantId>/<runId>/`. */
  readonly root: string;
  /** This server's cipher: decrypts at export, seals under the ACTIVE key at restore. */
  readonly cipher: SecretCipher;
  readonly kdf: KdfProfile;
  readonly installationTenantId: () => string;
  readonly installationId: () => string;
  readonly release: string;
  readonly migrationsFolder: string;
  readonly now: () => Date;
  /**
   * Security review of PR-1: the most part bytes one archive may declare, never taken from the
   * archive (default 32 GiB), and the free space kept beside it on the work volume (1 GiB).
   */
  readonly maxExtractedBytes?: number;
  readonly headroomBytes?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/**
 * Copies `source` to `destination` (created 0600, never over an existing file) through a
 * SHA-256, and returns the copy's hash: the hash of exactly the bytes every later read sees.
 */
async function copyThroughSha256(source: string, destination: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(
    createReadStream(source),
    new Transform({
      transform(chunk: Buffer, _encoding, done) {
        hash.update(chunk);
        done(null, chunk);
      },
    }),
    createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
  );
  return hash.digest('hex');
}

/** The private copy of an uploaded archive, inside the restore's own work directory. */
const RESTORE_ARCHIVE_COPY = 'upload.7z';

async function removeAll(paths: readonly string[]): Promise<string[]> {
  const left: string[] = [];
  for (const path of paths) {
    await rm(path, { recursive: true, force: true }).catch(() => left.push(path));
  }
  return left;
}

export class PostgresTenantArchiveEngine implements TenantArchiveEngine, TenantRestoreEngine {
  constructor(private readonly deps: TenantArchiveEngineDeps) {}

  get leaked(): readonly string[] {
    return this.deps.scratch.leaked;
  }

  async workspace(tenantId: string, runId: string): Promise<TenantArchiveWorkspace> {
    if (!UUID.test(tenantId) || !UUID.test(runId)) {
      throw new NexaError({
        kind: 'INTERNAL',
        code: PLATFORM_ERROR_CODES.BACKUP_TOOL_FAILED,
        message: 'A tenant archive workspace is named by two uuids.',
      });
    }
    const directory = join(this.deps.root, HOSTED_DIRECTORY, tenantId, runId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // The orphan and debris sweeps (`run-directories.ts`, `workspace.ts`) know these names.
    const [plainName, verifyName] = HOSTED_PLAINTEXT;
    const plainDirectory = join(directory, plainName);
    const verifyDirectory = join(directory, verifyName);
    await mkdir(plainDirectory, { mode: 0o700 });
    await mkdir(verifyDirectory, { mode: 0o700 });
    return {
      plainDirectory,
      verifyDirectory,
      archivePath: join(directory, 'archive.7z'),
      discardPlaintext: () => removeAll([plainDirectory, verifyDirectory]),
      discardAll: () => removeAll([directory]),
    };
  }

  async dump(input: {
    readonly tenantId: string;
    readonly directory: string;
    readonly archiveId: string;
    readonly createdAt: Date;
    readonly password: string;
  }): Promise<{ manifest: TenantArchiveManifest; manifestSha256: string; dataBytes: number }> {
    // A fresh 256-bit archive key, never this server's keyring (ADR-0039 § 2).
    const material = randomBytes(32);
    const keyId = archiveKeyId(input.archiveId);
    try {
      const manifest = await exportTenant({
        app: this.deps.app,
        tenantId: input.tenantId,
        installationTenantId: this.deps.installationTenantId(),
        directory: input.directory,
        archiveId: input.archiveId,
        archiveKeyId: keyId,
        createdAt: input.createdAt,
        source: { installationId: this.deps.installationId(), release: this.deps.release },
        sourceCipher: this.deps.cipher,
        archiveCipher: archiveCipher(keyId, material),
        migrationsFolder: this.deps.migrationsFolder,
      });
      const bundle = await sealKeyBundle({
        keys: [{ keyId, material }],
        password: input.password,
        backupId: input.archiveId,
        profile: this.deps.kdf,
      });
      await writeFile(join(input.directory, KEY_BUNDLE_ENTRY), bundle, { mode: 0o600 });
      const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
      await writeFile(join(input.directory, 'manifest.json'), manifestBytes, { mode: 0o600 });
      return {
        manifest,
        manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
        dataBytes: manifest.tables.reduce((sum, table) => sum + table.bytes, 0),
      };
    } finally {
      material.fill(0);
    }
  }

  async seal(input: {
    readonly directory: string;
    readonly archivePath: string;
    readonly password: string;
  }): Promise<{ archiveBytes: number }> {
    const entries = ['manifest.json', KEY_BUNDLE_ENTRY];
    if ((await readdir(join(input.directory, 'data'))).length > 0) entries.push('data');
    return sealSevenZipEntries({
      directory: input.directory,
      entries,
      archivePath: input.archivePath,
      password: input.password,
      options: this.deps.sevenZip,
    });
  }

  /** Opens the archive, then runs `fn` with a scratch at the archive's head, loaded and verified. */
  private async inVerifiedScratch<T>(
    input: { readonly archivePath: string; readonly password: string; readonly directory: string },
    onStage: (stage: TenantRestoreStage) => Promise<void>,
    onOpened: (opened: OpenedTenantArchive) => Promise<void>,
    fn: (
      opened: OpenedTenantArchive,
      scratch: Parameters<Parameters<typeof withScratchHandle>[1]>[0],
      scratchUrl: string,
      verdict: 'EQUAL' | 'OLDER',
    ) => Promise<T>,
  ): Promise<T> {
    await onStage('OPEN');
    let opened: OpenedTenantArchive;
    try {
      opened = await openTenantArchive({
        archivePath: input.archivePath,
        password: input.password,
        directory: input.directory,
        sevenZip: this.deps.sevenZip,
        limits: {
          maxExtractedBytes: this.deps.maxExtractedBytes ?? 32 * 1024 ** 3,
          headroomBytes: this.deps.headroomBytes ?? 1024 ** 3,
          freeBytes: async () => {
            const info = await statfs(input.directory).catch(() => null);
            return info === null ? null : Number(info.bavail) * Number(info.bsize);
          },
        },
      });
    } catch (error) {
      // Opening may have extracted entries before it failed (a later part's checksum): the
      // plaintext boundary includes the open itself.
      await removeAll([input.directory]);
      throw error;
    }
    try {
      await onOpened(opened);
      await onStage('SCHEMA');
      const expected = expectedMigrations(this.deps.migrationsFolder);
      const verdict = compareArchiveHead(opened.manifest.migrations, expected);
      refuseHead(verdict);
      const head = verdict === 'OLDER' ? 'OLDER' : 'EQUAL';
      const scratch = await this.deps.scratch.createScratchDatabase();
      try {
        await migrateScratchTo({
          databaseUrl: scratch.url,
          liveDatabase: this.deps.scratch.databaseName,
          folder: this.deps.migrationsFolder,
          expected,
          count: opened.manifest.migrations.count,
          workDirectory: input.directory,
        });
        return await withScratchHandle(scratch.url, async (handle) => {
          await onStage('SCRATCH_LOAD');
          await loadScratch(handle, opened);
          await onStage('SCRATCH_VERIFY');
          await verifyScratch(handle, opened);
          return fn(opened, handle, scratch.url, head);
        });
      } finally {
        await this.deps.scratch.dropScratchDatabase(scratch.name);
      }
    } finally {
      opened.keyMaterial.fill(0);
      await removeAll([input.directory]);
    }
  }

  async verify(input: {
    readonly archivePath: string;
    readonly password: string;
    readonly directory: string;
    readonly expectedManifestSha256: string;
  }): Promise<{ tables: number; rows: number }> {
    return this.inVerifiedScratch(
      input,
      async () => undefined,
      async () => {
        // The manifest inside the encrypted archive is the one the run wrote, byte for byte.
        const inside = await readFile(join(input.directory, 'manifest.json'));
        if (createHash('sha256').update(inside).digest('hex') !== input.expectedManifestSha256) {
          throw new NexaError({
            kind: 'INTERNAL',
            code: PLATFORM_ERROR_CODES.BACKUP_CHECKSUM_MISMATCH,
            message: 'The manifest inside the archive is not the one the run wrote.',
          });
        }
      },
      async (opened) => ({
        tables: opened.manifest.tables.length,
        rows: opened.manifest.tables.reduce((sum, table) => sum + table.rows, 0),
      }),
    );
  }

  sha256(archivePath: string): Promise<string> {
    return sha256File(archivePath);
  }

  sweepAbandonedScratch(): Promise<ScratchSweep> {
    return this.deps.scratch.dropAbandonedScratchDatabases();
  }

  async restore(input: {
    readonly archivePath: string;
    readonly expectedSha256: string;
    readonly password: string;
    readonly directory: string;
    readonly installationTenantId: string;
    readonly actorAdminId: string;
    readonly slug?: string;
    readonly mode?: TenantRestoreMode;
    readonly requestId?: string;
    readonly apply: boolean;
    readonly onOpened: (manifest: TenantArchiveManifest) => Promise<void>;
    readonly onStage: (stage: TenantRestoreStage) => Promise<void>;
  }): Promise<TenantRestoreSummary> {
    // Security review of PR #447, finding 4: the restore writes as the restored tenant and
    // relies on RLS `WITH CHECK` to refuse any row of another; an owner connection would not.
    if ((await this.deps.app.scopeEnforcement()) !== 'enforcing') {
      throw new NexaError({
        kind: 'PRECONDITION_FAILED',
        code: TENANT_ARCHIVE_ERROR_CODES.RLS_BYPASSED,
        message:
          'The restore connection bypasses row-level security; a tenant archive is restored as nexa_app.',
      });
    }
    await mkdir(input.directory, { recursive: true, mode: 0o700 });
    // Finding 5: the request (or its confirmation) is bound to the file's SHA-256, and 7-Zip
    // reads the archive once per entry. Every read is of a private copy hashed as it was
    // written, so a file swapped after the confirmation is refused, never opened.
    const archivePath = join(input.directory, RESTORE_ARCHIVE_COPY);
    try {
      const copied = await copyThroughSha256(input.archivePath, archivePath);
      if (copied !== input.expectedSha256) {
        throw new NexaError({
          kind: 'PRECONDITION_FAILED',
          code: TENANT_ARCHIVE_ERROR_CODES.VERIFICATION_FAILED,
          message: 'The archive file changed after its restore was requested or confirmed.',
        });
      }
    } catch (error) {
      await removeAll([input.directory]);
      throw error;
    }
    return this.inVerifiedScratch(
      { ...input, archivePath },
      input.onStage,
      (opened) => input.onOpened(opened.manifest),
      async (opened, scratch, scratchUrl, head) => {
        if (head === 'OLDER') {
          // Migrate the verified scratch UP to this release's head; compare counts only — a
          // migration may legitimately rewrite values (ADR-0039 § 5).
          await input.onStage('MIGRATE_SCRATCH');
          await migrateScratchTo({
            databaseUrl: scratchUrl,
            liveDatabase: this.deps.scratch.databaseName,
            folder: this.deps.migrationsFolder,
            expected: expectedMigrations(this.deps.migrationsFolder),
            count: expectedMigrations(this.deps.migrationsFolder).length,
            workDirectory: input.directory,
          });
        }
        await input.onStage('PREFLIGHT');
        const preflight = await preflightRestore({
          app: this.deps.app,
          scratch,
          manifest: opened.manifest,
          ...(input.slug === undefined || input.mode === 'REPLACE' ? {} : { slug: input.slug }),
          mode: input.mode ?? 'NEW',
          installationTenantId: input.installationTenantId,
        });
        for (const table of opened.manifest.tables) {
          if (preflight.counts[table.name] !== table.rows) {
            throw new NexaError({
              kind: 'INTERNAL',
              code: TENANT_ARCHIVE_ERROR_CODES.VERIFICATION_FAILED,
              message: 'The migrated scratch lost or gained rows.',
              details: { table: table.name },
            });
          }
        }
        const summary = {
          hostedTenantId: opened.manifest.tenant.id,
          archiveId: opened.manifest.archiveId,
          head,
          slug: preflight.slug,
          counts: preflight.counts,
        };
        if (!input.apply) return summary;
        await input.onStage('APPLY');
        if (input.mode === 'REPLACE') {
          if (input.requestId === undefined) {
            throw new NexaError({
              kind: 'INTERNAL',
              code: TENANT_ARCHIVE_ERROR_CODES.VERIFICATION_FAILED,
              message: 'A replace is applied only under its own request row.',
            });
          }
          const replaced = await applyReplace({
            app: this.deps.app,
            scratch,
            manifest: opened.manifest,
            installationTenantId: input.installationTenantId,
            requestId: input.requestId,
            now: this.deps.now(),
            archiveCipher: opened.cipher,
            targetCipher: this.deps.cipher,
          });
          return { ...summary, counts: replaced };
        }
        const counts = await applyRestore({
          app: this.deps.app,
          scratch,
          manifest: opened.manifest,
          slug: preflight.slug,
          installationTenantId: input.installationTenantId,
          actorAdminId: input.actorAdminId,
          now: this.deps.now(),
          archiveCipher: opened.cipher,
          targetCipher: this.deps.cipher,
        });
        return { ...summary, counts };
      },
    );
  }
}
