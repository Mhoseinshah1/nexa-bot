import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isNexaError } from '@nexa/contracts';
import { createContainer, type Container } from './container.js';
import { loadConfig } from './infrastructure/config/load-config.js';
import { resolveKeyring } from './infrastructure/crypto/resolve-keyring.js';
import { KeyringBackupArchiver } from './modules/platform/backup/infrastructure/archiver.js';
import { readArchiveHeader } from './modules/platform/backup/infrastructure/archive.js';

/**
 * `backup run|list|verify|restore` — the operator's side of the pipeline.
 *
 * Four commands, and the interesting design is in what two of them REFUSE.
 *
 * `run` is the manual trigger, and it calls exactly the service the scheduler
 * calls. It does not take its own lock, run its own stages or skip
 * verification: `trigger` is the only difference between a backup an operator
 * asked for and one the clock asked for, and it is a recorded field rather than
 * a branch.
 *
 * `restore` has NO DEFAULT TARGET. `--target` is required, the live database is
 * refused even when named explicitly, and the target must be empty. A restore
 * command whose target defaults to "the database in DATABASE_URL" is one
 * mistyped flag away from overwriting production with an old copy of itself,
 * and the whole reason this pipeline exists is the moment somebody is running
 * it under pressure.
 *
 * `verify` is the drill ADR-0011's seventh compensating control asks for: an
 * operator can take any archive they hold and prove it decrypts and checksums,
 * without touching a database at all.
 */

class UsageError extends Error {}

const USAGE = [
  'usage:',
  '  backup run                              take a backup now (trigger MANUAL)',
  '  backup list [--limit N]                 recent runs and their delivery state',
  '  backup verify --archive PATH            decrypt and checksum; touches no database',
  '  backup restore --archive PATH --target DB',
  '                                          restore into an explicit, empty, non-live database',
].join('\n');

interface Args {
  readonly command: 'run' | 'list' | 'verify' | 'restore';
  readonly archive: string | null;
  readonly target: string | null;
  readonly limit: number;
}

function parseArgs(argv: readonly string[]): Args {
  const command = argv[0];
  if (command !== 'run' && command !== 'list' && command !== 'verify' && command !== 'restore') {
    throw new UsageError(USAGE);
  }
  const value = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    if (index === -1) return null;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) throw new UsageError(`${flag} needs a value.`);
    return next;
  };
  const rawLimit = value('--limit');
  const limit = rawLimit === null ? 20 : Number.parseInt(rawLimit, 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new UsageError('--limit must be between 1 and 500.');
  }
  return { command, archive: value('--archive'), target: value('--target'), limit };
}

async function cmdRun(container: Container): Promise<number> {
  const outcome = await container.backup.run('MANUAL');
  if (outcome.kind === 'BUSY') {
    // Not an error the operator caused, and not something to retry behind their
    // back. One backup at a time is the invariant; this is it working.
    process.stdout.write(
      `A backup is already running (${outcome.holder.id}, started ` +
        `${outcome.holder.startedAt.toISOString()}, stage ${outcome.holder.stage}).\n`,
    );
    return 2;
  }
  const run = outcome.run;
  process.stdout.write(
    [
      `backup   ${run.id}`,
      `state    ${run.state}${run.state === 'FAILED' ? ` at ${run.stage}` : ''}`,
      `dump     ${run.dumpBytes === null ? '-' : `${String(run.dumpBytes)} bytes`}`,
      `archive  ${run.archiveBytes === null ? '-' : `${String(run.archiveBytes)} bytes`}`,
      `sha256   ${run.checksum ?? '-'}`,
      `verified ${run.verifiedAt === null ? 'NO' : run.verifiedAt.toISOString()}`,
      `delivery ${run.deliveryState}${run.deliveryDetail === null ? '' : ` — ${run.deliveryDetail}`}`,
      `cleanup  ${run.cleanupOk ? 'ok' : `INCOMPLETE — ${run.cleanupDetail ?? 'unknown'}`}`,
      run.failureMessage === null ? '' : `failure  ${run.failureCode ?? ''} ${run.failureMessage}`,
    ]
      .filter((line) => line !== '')
      .join('\n') + '\n',
  );
  // A cleanup that did not complete is not a successful run from an operator's
  // point of view: plaintext database bytes are still on their disk.
  if (run.state === 'FAILED') return 1;
  return run.cleanupOk ? 0 : 3;
}

async function cmdList(container: Container, limit: number): Promise<number> {
  const runs = await container.backupRuns.latest(limit);
  if (runs.length === 0) {
    process.stdout.write('No backup has ever run on this installation.\n');
    return 0;
  }
  for (const run of runs) {
    process.stdout.write(
      [
        run.startedAt.toISOString(),
        run.id,
        run.trigger,
        run.state,
        run.verifiedAt === null ? 'unverified' : 'verified',
        run.deliveryState,
        run.cleanupOk ? '' : 'CLEANUP-INCOMPLETE',
      ]
        .filter((field) => field !== '')
        .join('  ') + '\n',
    );
  }
  return 0;
}

/**
 * Decrypts an archive to a temporary file and checks it against its own
 * manifest. Never opens a database.
 *
 * The temporary directory is removed in a `finally`, including on failure: the
 * file it holds is a plaintext database, and leaving one behind because a
 * verification failed would be the worst possible time to leave one behind.
 */
async function cmdVerify(archivePath: string): Promise<number> {
  const config = loadConfig();
  const archiver = new KeyringBackupArchiver(resolveKeyring(config));

  const header = await readArchiveHeader(archivePath);
  process.stdout.write(
    `archive  format ${String(header.header.format)}, ${String(header.archiveBytes)} bytes\n` +
      `backup   ${header.header.backupId}\n` +
      `key      ${header.header.keyId}\n`,
  );

  const directory = await mkdtemp(join(tmpdir(), 'nexa-verify-'));
  try {
    const opened = await archiver.open({
      archivePath,
      dumpPath: join(directory, 'dump.pgcustom'),
    });
    const matches = opened.dumpChecksum === opened.manifest.checksum;
    process.stdout.write(
      [
        `taken    ${opened.manifest.createdAt}`,
        `database ${opened.manifest.databaseName} (PostgreSQL ${opened.manifest.postgresVersion})`,
        `dump     ${String(opened.dumpBytes)} bytes`,
        `sha256   ${opened.dumpChecksum}`,
        `manifest ${opened.manifest.checksum}`,
        `checksum ${matches ? 'MATCHES' : 'DOES NOT MATCH'}`,
        opened.manifest.exclusions.length === 0
          ? 'excluded nothing'
          : `excluded ${opened.manifest.exclusions.map((e) => e.object).join(', ')}`,
      ].join('\n') + '\n',
    );
    return matches ? 0 : 1;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Restores an archive into a database the operator names.
 *
 * Three refusals, in order: no target is not a target; the live database is
 * never a target; a target with tables in it is not an empty target. The last
 * one matters because `pg_restore` into a populated database produces a
 * half-merged result that looks like it worked.
 */
async function cmdRestore(
  container: Container,
  archivePath: string,
  target: string,
): Promise<number> {
  const directory = await mkdtemp(join(tmpdir(), 'nexa-restore-'));
  try {
    const dumpPath = join(directory, 'dump.pgcustom');
    const opened = await container.backupArchiver.open({ archivePath, dumpPath });
    if (opened.dumpChecksum !== opened.manifest.checksum) {
      process.stderr.write(
        'The archive decrypted and its contents do not match its manifest. Refusing to restore ' +
          'bytes that are not the bytes that were backed up.\n',
      );
      return 1;
    }
    process.stdout.write(
      `Restoring backup ${opened.manifest.backupId} (taken ${opened.manifest.createdAt}) ` +
        `into "${target}".\n`,
    );
    await container.backupTools.restoreInto({ database: target }, dumpPath);
    process.stdout.write('Restored.\n');
    return 0;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // `verify` deliberately builds no container: it must work when the database
  // is the thing that is broken, which is the only situation anybody verifies
  // an archive in.
  if (args.command === 'verify') {
    if (args.archive === null) throw new UsageError('verify needs --archive PATH.');
    process.exit(await cmdVerify(args.archive));
  }

  const config = loadConfig();
  const container = createContainer(config, 'worker');
  try {
    if (args.command === 'run') process.exit(await cmdRun(container));
    if (args.command === 'list') process.exit(await cmdList(container, args.limit));
    if (args.archive === null) throw new UsageError('restore needs --archive PATH.');
    if (args.target === null) {
      throw new UsageError(
        'restore needs --target DATABASE. There is deliberately no default: a restore ' +
          'overwrites, and the default would be the database you are running on.',
      );
    }
    process.exit(await cmdRestore(container, args.archive, args.target));
  } finally {
    await container.shutdown();
  }
}

main().catch((error: unknown) => {
  if (error instanceof UsageError) {
    console.error(error.message);
    process.exit(64);
  }
  if (isNexaError(error)) {
    console.error(`${error.code}: ${error.message}`);
    process.exit(1);
  }
  console.error(error);
  process.exit(1);
});
