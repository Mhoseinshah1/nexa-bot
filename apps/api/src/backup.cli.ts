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

  const archive = value('--archive');
  const target = value('--target');

  // The requirements are checked HERE, not in `main`, for two reasons.
  //
  // A missing `--target` should not need a database connection to be refused.
  // It used to: `main` built the whole container first and only then noticed,
  // so the one command an operator reaches for when the database is broken
  // failed on the database rather than on the flag they got wrong.
  //
  // And this function is pure, so the refusals are testable. The commit that
  // added this CLI cited seven manually-run command outcomes and left no test
  // behind, which is exactly what CLAUDE.md means by a claim being worse than
  // no claim. These two branches are the ones that message quoted.
  if ((command === 'verify' || command === 'restore') && archive === null) {
    throw new UsageError(`${command} needs --archive PATH.`);
  }
  if (command === 'restore' && target === null) {
    throw new UsageError(
      'restore needs --target DATABASE. There is deliberately no default: a restore ' +
        'overwrites, and the default would be the database you are running on.',
    );
  }

  return { command, archive, target, limit };
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
  // The KEYRING ONLY, straight from the environment — not `loadConfig()`.
  //
  // This command's whole purpose is the case where the database is what is
  // broken, and `loadConfig()` refuses to return without a valid
  // `DATABASE_URL`, a `REDIS_URL` and every other setting this command never
  // touches. So the docblock above said "builds no container" while the code
  // still demanded a database it does not use: an operator holding an archive
  // and a dead server could not verify it. A test caught that.
  //
  // `resolveKeyring` takes exactly the four keyring variables, so reading them
  // here is not a second configuration path — it is the same parser, given the
  // subset this command actually depends on.
  const archiver = new KeyringBackupArchiver(
    resolveKeyring({
      SECRETS_KEYS: process.env.SECRETS_KEYS,
      SECRETS_ACTIVE_KEY_ID: process.env.SECRETS_ACTIVE_KEY_ID,
      SECRETS_KEK: process.env.SECRETS_KEK,
      SECRETS_KEK_ID: process.env.SECRETS_KEK_ID,
    }),
  );

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
    // States what was ASKED FOR, not what is happening. The target checks live
    // in `restoreInto` and run after this line, so an announcement phrased as
    // "Restoring … into nexa_dev" printed immediately above a refusal to do
    // exactly that — which reads, to somebody moving fast, like it went ahead.
    process.stdout.write(
      `Archive   ${opened.manifest.backupId} (taken ${opened.manifest.createdAt})\n` +
        `Target    ${target}\n`,
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
    // `parseArgs` has already refused a missing `--archive`.
    process.exit(await cmdVerify(args.archive ?? ''));
  }

  const config = loadConfig();
  const container = createContainer(config, 'worker');
  try {
    if (args.command === 'run') process.exit(await cmdRun(container));
    if (args.command === 'list') process.exit(await cmdList(container, args.limit));
    // Both refused by `parseArgs`, before this container was built.
    process.exit(await cmdRestore(container, args.archive ?? '', args.target ?? ''));
  } finally {
    await container.shutdown();
  }
}

// Guarded, like the other maintenance CLIs, so `scripts/check-runtime-cli.sh`
// can IMPORT this module and prove its whole graph loads from `dist` without a
// devDependency — which matters more here than for any of them, because this is
// the command somebody runs while the database is the thing that is broken.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
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
}

export { parseArgs, cmdVerify, UsageError, USAGE };
