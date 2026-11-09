import { mkdir, rename, rm, rmdir, statfs, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  BACKUP_ARCHIVE_PASSWORD_MIN_LENGTH,
  MOVE_ERROR_CODES,
  NexaError,
  PLATFORM_ERROR_CODES,
  type TenantArchiveManifest,
} from '@nexa/contracts';
import type { ExpectedMigration } from '../../../../infrastructure/persistence/migration-state.js';
import type { BackupRunRow } from '../application/ports.js';
import {
  MOVE_BUNDLE_FORMAT,
  MOVE_BUNDLE_FORMAT_VERSION,
  MOVE_CHECKLIST_ENTRY,
  MOVE_ENVIRONMENT_SECRET_NAMES,
  MOVE_ENVIRONMENT_VALUES,
  MOVE_MANIFEST_ENTRY,
  moveBundleManifestSchema,
  moveChecklistFa,
  sealMoveBundle,
  sha256OfFile,
  type MoveBundleManifest,
  type MoveBundleMember,
  type OpenedMoveBundle,
} from './move-bundle.js';
import type { HostedPresence, LiveTenantDigest, MoveBotFacts } from './move-queries.js';
import { compareArchiveHead, TENANT_ARCHIVE_HEAD_NEWER_REASON } from './tenant-archive-restore.js';
import type { SevenZipOptions } from './seven-zip.js';

/**
 * Phase 6B PR-4 (ADR-0039 § 8): the server move — what `botctl move export` and the two steps
 * of `botctl move import` do, over ports the CLI wires to the container.
 *
 * EXPORT (old server, frozen by botctl): a fresh installation backup and a fresh archive of
 * every non-PURGED hosted bot, each through the heavy-job queue, one at a time, each sealed
 * with the BUNDLE password and each a VERIFIED success (ADR-0025: a member exists only after
 * its VERIFY_RESTORE passed); then the manifest, the checklist and the bundle. Any failure
 * removes the whole work directory: no partial bundle is ever left behind.
 *
 * IMPORT (new server): the bundle is opened and checked; its head must not be newer than this
 * release; the target must be fresh; the installation member is restored through the EXISTING
 * recovery path. Then, in a new process against the restored database, each hosted member is
 * VERIFIED against its tenant's live rows (§ 6 is not done, so the installation backup holds
 * them) by counts and a canonical SHA-256, and the activations' marks are cleared.
 */

export interface MoveMemberRun {
  readonly run: BackupRunRow;
  /** The member's sealed archive, where its run left it. */
  readonly archivePath: string;
}

export interface MoveExportDeps {
  readonly installationTenantId: string;
  readonly installationId: string;
  readonly release: string;
  readonly image: string | null;
  readonly migrations: TenantArchiveManifest['migrations'];
  readonly now: () => Date;
  readonly sevenZip: SevenZipOptions;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly ownerDomains: readonly string[];
  readonly cnameTarget: string | null;
  readonly serverIps: readonly string[];
  readonly databaseBytes: () => Promise<number>;
  readonly freeBytes: (path: string) => Promise<number | null>;
  readonly bots: () => Promise<readonly MoveBotFacts[]>;
  /** A MOVE installation backup sealed with `password`, through the heavy-job queue. */
  readonly backupInstallation: (password: string) => Promise<MoveMemberRun | null>;
  /** A MOVE tenant archive of `tenantId` sealed with `password`, through the queue. */
  readonly archiveHosted: (tenantId: string, password: string) => Promise<MoveMemberRun | null>;
  readonly progress: (line: string) => void;
}

export function refuseMovePassword(password: string): void {
  if ([...password].length < BACKUP_ARCHIVE_PASSWORD_MIN_LENGTH) {
    throw new NexaError({
      kind: 'VALIDATION',
      code: MOVE_ERROR_CODES.PASSWORD_REFUSED,
      message: `The bundle password must be at least ${String(BACKUP_ARCHIVE_PASSWORD_MIN_LENGTH)} characters.`,
    });
  }
}

function memberFailed(what: string, run: BackupRunRow | null): NexaError {
  return new NexaError({
    kind: 'INTERNAL',
    code: MOVE_ERROR_CODES.MEMBER_FAILED,
    message: `${what} did not reach a verified success; no bundle was written.`,
    details: {
      runId: run?.id ?? null,
      state: run?.state ?? 'NOT_ADMITTED',
      failureCode: run?.failureCode ?? null,
    },
  });
}

/** A run that may become a member: SUCCEEDED, verified (ADR-0025), a 7z. */
function verifiedMember(run: BackupRunRow | null): run is BackupRunRow {
  return (
    run !== null &&
    run.state === 'SUCCEEDED' &&
    run.verifiedAt !== null &&
    run.archiveFormat === 'SEVEN_ZIP'
  );
}

/** `nexa-backup-20261019-0400-0193ab12.7z`, the installation archive's own name. */
function installationMemberName(run: BackupRunRow): string {
  const iso = run.startedAt.toISOString();
  const stamp = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}`;
  return `installation/nexa-backup-${stamp}-${run.id.replace(/-/g, '').slice(0, 8)}.7z`;
}

/**
 * Builds the bundle in `workDirectory` (created 0700, must not exist) and returns it. On any
 * failure the whole work directory goes, members and partial bundle alike.
 */
export async function exportMoveBundle(
  deps: MoveExportDeps,
  input: { readonly password: string; readonly workDirectory: string },
): Promise<{
  readonly bundlePath: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly manifest: MoveBundleManifest;
}> {
  refuseMovePassword(input.password);
  await mkdir(input.workDirectory, { recursive: false, mode: 0o700 });
  try {
    // ADR-0039 § 8 step 3: room for the members and the bundle beside them.
    const needed = 2 * (await deps.databaseBytes());
    const free = await deps.freeBytes(input.workDirectory);
    if (free !== null && free < needed) {
      throw new NexaError({
        kind: 'PRECONDITION_FAILED',
        code: PLATFORM_ERROR_CODES.BACKUP_DISK_INSUFFICIENT,
        message: 'There is not enough free disk space for the move bundle (twice the database).',
        details: { freeBytes: free, requiredBytes: needed },
      });
    }
    await mkdir(join(input.workDirectory, 'installation'), { mode: 0o700 });
    await mkdir(join(input.workDirectory, 'hosted'), { mode: 0o700 });
    const bots = await deps.bots();
    const members: MoveBundleMember[] = [];
    const take = async (
      member: Omit<MoveBundleMember, 'bytes' | 'sha256'>,
      from: string,
    ): Promise<void> => {
      const destination = join(input.workDirectory, member.path);
      // MOVED out of the run's directory, never copied: no second copy sealed with the
      // bundle password stays in the backup tree, where retention would keep it.
      await rename(from, destination);
      await rmdir(dirname(from)).catch(() => undefined);
      const hashed = await sha256OfFile(destination);
      members.push({ ...member, bytes: hashed.bytes, sha256: hashed.sha256 });
    };

    deps.progress('installation backup (MOVE): dump, encrypt, verify');
    const installation = await deps.backupInstallation(input.password);
    if (!verifiedMember(installation?.run ?? null) || installation === null) {
      throw memberFailed('The installation backup', installation?.run ?? null);
    }
    await take(
      {
        path: installationMemberName(installation.run),
        kind: 'INSTALLATION',
        tenantId: deps.installationTenantId,
        runId: installation.run.id,
      },
      installation.archivePath,
    );

    const hosted = bots.filter((bot) => bot.kind === 'HOSTED');
    for (const [index, bot] of hosted.entries()) {
      deps.progress(
        `hosted archive ${String(index + 1)}/${String(hosted.length)}: ${bot.username ?? bot.tenantId}`,
      );
      const archived = await deps.archiveHosted(bot.tenantId, input.password);
      if (!verifiedMember(archived?.run ?? null) || archived === null) {
        throw memberFailed(`The archive of hosted bot ${bot.tenantId}`, archived?.run ?? null);
      }
      await take(
        {
          path: `hosted/${bot.tenantId}.7z`,
          kind: 'HOSTED',
          tenantId: bot.tenantId,
          runId: archived.run.id,
        },
        archived.archivePath,
      );
    }

    const values: Record<string, string> = {};
    for (const key of MOVE_ENVIRONMENT_VALUES) {
      const value = deps.environment[key];
      if (value !== undefined && value !== '') values[key] = value;
    }
    const secretNames = MOVE_ENVIRONMENT_SECRET_NAMES.filter(
      (name) => (deps.environment[name] ?? '') !== '',
    );
    const manifest: MoveBundleManifest = moveBundleManifestSchema.parse({
      format: MOVE_BUNDLE_FORMAT,
      formatVersion: MOVE_BUNDLE_FORMAT_VERSION,
      createdAt: deps.now().toISOString(),
      source: {
        installationId: deps.installationId,
        release: deps.release,
        image: deps.image,
      },
      migrations: deps.migrations,
      members,
      domains: {
        owner: [...deps.ownerDomains],
        cnameTarget: deps.cnameTarget,
        serverIps: [...deps.serverIps],
      },
      bots: bots.map((bot) => ({
        tenantId: bot.tenantId,
        kind: bot.kind,
        username: bot.username,
        telegramBotId: bot.telegramBotId,
        domain: bot.domain,
        state: bot.state,
      })),
      environment: { values, secretNames },
    });
    await writeFile(
      join(input.workDirectory, MOVE_MANIFEST_ENTRY),
      JSON.stringify(manifest, null, 2),
      { mode: 0o600 },
    );
    await writeFile(
      join(input.workDirectory, MOVE_CHECKLIST_ENTRY),
      moveChecklistFa({
        ownerDomains: deps.ownerDomains,
        serverAddresses: [],
        cnameTarget: null,
        hostedDomains: bots
          .filter((bot) => bot.kind === 'HOSTED' && bot.domain !== null)
          .map((bot) => ({ domain: bot.domain ?? '', username: bot.username })),
        bots,
        secretNames,
      }),
      { mode: 0o600 },
    );
    deps.progress('sealing the bundle');
    const bundlePath = join(input.workDirectory, 'nexa-move.7z');
    const sealed = await sealMoveBundle({
      directory: input.workDirectory,
      bundlePath,
      password: input.password,
      sevenZip: deps.sevenZip,
    });
    // The members are inside the bundle now; their loose copies go.
    await rm(join(input.workDirectory, 'installation'), { recursive: true, force: true });
    await rm(join(input.workDirectory, 'hosted'), { recursive: true, force: true });
    return { bundlePath, sha256: sealed.sha256, bytes: sealed.bytes, manifest };
  } catch (error) {
    await rm(input.workDirectory, { recursive: true, force: true });
    throw error;
  }
}

/** Free bytes of the volume holding `path`, or null. */
export async function volumeFreeBytes(path: string): Promise<number | null> {
  const info = await statfs(path).catch(() => null);
  return info === null ? null : Number(info.bavail) * Number(info.bsize);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** The bundle's head against this release (ADR-0039 § 3 policy, for the whole bundle). */
export function refuseBundleHead(
  manifest: MoveBundleManifest,
  expected: readonly ExpectedMigration[],
): 'EQUAL' | 'OLDER' {
  const verdict = compareArchiveHead(manifest.migrations, expected);
  if (verdict === 'NEWER') {
    throw new NexaError({
      kind: 'PRECONDITION_FAILED',
      code: MOVE_ERROR_CODES.HEAD_NEWER,
      message: TENANT_ARCHIVE_HEAD_NEWER_REASON,
    });
  }
  if (verdict === 'DIVERGED') {
    throw new NexaError({
      kind: 'PRECONDITION_FAILED',
      code: MOVE_ERROR_CODES.HEAD_DIVERGED,
      message: 'The bundle was taken under a migration history this release does not share.',
    });
  }
  return verdict;
}

export interface HostedVerifyDeps {
  readonly installationTenantId: string;
  readonly presence: (tenantId: string) => Promise<HostedPresence>;
  /** Opens the member, runs `fn` with its manifest and its canonical digests, cleans up. */
  readonly openMember: <T>(
    member: MoveBundleMember,
    fn: (manifest: TenantArchiveManifest, digests: Readonly<Record<string, string>>) => Promise<T>,
  ) => Promise<T>;
  readonly live: (tenantId: string, manifest: TenantArchiveManifest) => Promise<LiveTenantDigest>;
  readonly progress: (line: string) => void;
}

export interface HostedVerifyResult {
  readonly verified: readonly { readonly tenantId: string; readonly tables: number }[];
  /** Members whose tenant is not in the restored installation: kept for «بازیابی از فایل». */
  readonly missing: readonly string[];
}

/**
 * Verifies every hosted member against its tenant's rows in the restored installation: the
 * archive's tables by row count AND canonical SHA-256 (secrets decrypted, key ids dropped, the
 * archive's own columns), and no live table with rows the archive does not have. Any mismatch
 * stops the import, naming the tenant and the table — never a value.
 */
export async function verifyHostedMembers(
  deps: HostedVerifyDeps,
  bundle: OpenedMoveBundle,
): Promise<HostedVerifyResult> {
  const verified: { tenantId: string; tables: number }[] = [];
  const missing: string[] = [];
  for (const member of bundle.manifest.members) {
    if (member.kind !== 'HOSTED') continue;
    const presence = await deps.presence(member.tenantId);
    if (presence === 'NOT_HOSTED') {
      throw new NexaError({
        kind: 'PRECONDITION_FAILED',
        code: MOVE_ERROR_CODES.HOSTED_MISMATCH,
        message: 'A hosted member names a tenant that is not a hosted bot of this installation.',
        details: { tenantId: member.tenantId },
      });
    }
    if (presence === 'ABSENT') {
      missing.push(member.tenantId);
      deps.progress(`hosted ${member.tenantId}: NOT in the restored installation`);
      continue;
    }
    deps.progress(`hosted ${member.tenantId}: comparing with the restored rows`);
    const tables = await deps.openMember(member, async (manifest, archived) => {
      if (manifest.tenant.id !== member.tenantId) {
        throw new NexaError({
          kind: 'PRECONDITION_FAILED',
          code: MOVE_ERROR_CODES.HOSTED_MISMATCH,
          message: 'A hosted member holds another tenant than the bundle names.',
          details: { tenantId: member.tenantId },
        });
      }
      const live = await deps.live(member.tenantId, manifest);
      for (const table of manifest.tables) {
        const expected = archived[table.name];
        const actual = live.digests[table.name];
        const rows = Number((actual ?? '').split(':')[0]);
        if (expected === undefined || actual !== expected || rows !== table.rows) {
          throw new NexaError({
            kind: 'PRECONDITION_FAILED',
            code: MOVE_ERROR_CODES.HOSTED_MISMATCH,
            message: 'A hosted bot does not match its archive in the restored installation.',
            details: {
              tenantId: member.tenantId,
              table: table.name,
              archiveRows: table.rows,
              liveRows: Number.isFinite(rows) ? rows : null,
            },
          });
        }
      }
      if (live.extraTables.length > 0) {
        throw new NexaError({
          kind: 'PRECONDITION_FAILED',
          code: MOVE_ERROR_CODES.HOSTED_MISMATCH,
          message: 'A hosted bot has rows in the restored installation its archive does not.',
          details: { tenantId: member.tenantId, table: live.extraTables[0] },
        });
      }
      return manifest.tables.length;
    });
    verified.push({ tenantId: member.tenantId, tables });
  }
  return { verified, missing };
}
