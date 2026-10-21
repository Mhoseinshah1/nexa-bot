import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { isNexaError } from '@nexa/contracts';
import { createContainer, type Container } from './container.js';
import { loadConfig } from './infrastructure/config/load-config.js';
import { resolveKeyring } from './infrastructure/crypto/resolve-keyring.js';
import { DualFormatBackupArchiver } from './modules/platform/backup/infrastructure/archiver.js';
import { isSevenZipFile } from './modules/platform/backup/infrastructure/seven-zip.js';
import {
  DEFAULT_SEVEN_ZIP_HEADROOM_MB,
  DEFAULT_SEVEN_ZIP_MEMORY_MB,
  readMemAvailableMb,
} from './modules/platform/backup/infrastructure/seven-zip-levels.js';
import { readArchiveHeader } from './modules/platform/backup/infrastructure/archive.js';
import {
  keepScratchAlive,
  privateScratchDirectory,
} from './modules/platform/backup/infrastructure/workspace.js';
import { InstallationKeyring } from './infrastructure/crypto/installation-keyring.js';
import { openRecoveryKit } from './infrastructure/crypto/recovery-kit.js';

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
  '  backup run                              take a backup now (trigger MANUAL); exits 2 when',
  '                                          one is running, 4 while a recovery is restoring',
  '  backup list [--limit N]                 recent runs and their delivery state',
  '  backup verify --archive PATH            decrypt and checksum; touches no database',
  '  backup restore --archive PATH --target DB',
  '                                          restore into an explicit, empty, non-live database',
  '',
  '  A backup delivered in parts (E4): repeat --archive for every part, in any order, or',
  '  name only the .001 and the .002, .003 … beside it are found. The parts are joined',
  '  in order, byte for byte, before anything is opened.',
  '',
  '  A 7-Zip archive (.7z) opens with the backup password, read from standard input',
  '  with --password-stdin, never from an argument:',
  '      read -rs P; printf %s "$P" | pnpm backup verify --archive A.7z.001 --password-stdin',
  '  restore without --password-stdin tries the passwords this installation stored.',
  '',
  '  verify and restore also take --kit PATH: a Recovery Kit (ADR-0032) whose keys',
  '  open an archive another installation sealed. They are used for this command',
  "  only and never become this installation's encryption key. The passphrase is",
  '  read from standard input, never from an argument:',
  '      read -rs P; printf %s "$P" | pnpm backup verify --archive A --kit K',
].join('\n');

interface Args {
  readonly command: 'run' | 'list' | 'verify' | 'restore';
  readonly archive: string | null;
  /** Every `--archive` given, in the order given (E4: the parts of one archive). */
  readonly archives: readonly string[];
  /** E4: the 7-Zip backup password comes on standard input. */
  readonly passwordStdin: boolean;
  readonly target: string | null;
  readonly limit: number;
  readonly kit: string | null;
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
  const archives: string[] = [];
  argv.forEach((arg, index) => {
    if (arg !== '--archive') return;
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) archives.push(next);
  });
  const passwordStdin = argv.includes('--password-stdin');
  if (argv.some((arg) => arg === '--password' || arg.startsWith('--password='))) {
    throw new UsageError(
      'The backup password is read from standard input, never from an argument.',
    );
  }
  const target = value('--target');
  const kit = value('--kit');
  if (kit !== null && passwordStdin) {
    throw new UsageError(
      '--kit and --password-stdin both read standard input. A 7-Zip archive needs no kit to open.',
    );
  }
  if (kit !== null && command !== 'verify' && command !== 'restore') {
    throw new UsageError('--kit applies to verify and restore only.');
  }
  // Refused as an argument outright. argv is world-readable in /proc and lands
  // in shell history; the passphrase is the only thing between a kit and every
  // key in it.
  if (argv.some((arg) => arg === '--passphrase' || arg.startsWith('--passphrase='))) {
    throw new UsageError('The kit passphrase is read from standard input, never from an argument.');
  }

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

  return { command, archive, archives, passwordStdin, target, limit, kit };
}

/** `name.7z.001` → its siblings `.002`, `.003` … that exist, in order. */
async function siblingParts(first: string): Promise<string[]> {
  const match = /^(.*)\.(\d{3,})$/.exec(first);
  if (match === null || Number(match[2]) !== 1) return [first];
  const base = match[1] ?? '';
  const width = (match[2] ?? '').length;
  const found = [first];
  for (let n = 2; n < 100_000; n += 1) {
    const candidate = `${base}.${String(n).padStart(width, '0')}`;
    const exists = await stat(candidate).then(
      (info) => info.isFile(),
      () => false,
    );
    if (!exists) break;
    found.push(candidate);
  }
  return found;
}

/**
 * The parts of one archive, in order (E4). Repeated `--archive`s are ordered by their
 * numeric suffix and must be exactly `.001` … `.N` with none missing; a lone `.001`
 * brings its siblings. A gap is refused here, by name, rather than left to fail as an
 * unreadable archive.
 */
async function orderedParts(archives: readonly string[]): Promise<string[]> {
  if (archives.length === 1) return siblingParts(archives[0] ?? '');
  const numbered = archives.map((path) => {
    const match = /^(.*)\.(\d{3,})$/.exec(basename(path));
    if (match === null) {
      throw new UsageError(`${path} is not a numbered part (.001, .002 …).`);
    }
    return { path, base: match[1] ?? '', n: Number(match[2]) };
  });
  // One backup's parts share one name: `a.7z.001` with `b.7z.002` is two backups, and
  // joining them would fail later as an unreadable archive instead of saying so here.
  const bases = new Set(numbered.map((part) => part.base));
  if (bases.size > 1) {
    throw new UsageError(
      `These parts belong to different backups (${[...bases].join(', ')}). Give one backup's parts.`,
    );
  }
  numbered.sort((a, b) => a.n - b.n);
  numbered.forEach((part, index) => {
    if (part.n !== index + 1) {
      throw new UsageError(`Part ${String(index + 1).padStart(3, '0')} is missing.`);
    }
  });
  return numbered.map((part) => part.path);
}

/** Joins the parts into one file in `directory`, streamed; one part is used where it is. */
async function joinedArchive(parts: readonly string[], directory: string): Promise<string> {
  if (parts.length === 1) return parts[0] ?? '';
  const joined = join(directory, 'joined.archive');
  const out = createWriteStream(joined, { mode: 0o600 });
  for (const part of parts) await pipeline(createReadStream(part), out, { end: false });
  await new Promise<void>((resolve, reject) => {
    out.once('error', reject);
    out.end(resolve);
  });
  process.stdout.write(`parts    ${String(parts.length)} joined in order\n`);
  return joined;
}

/** The 7-Zip password from standard input, when asked for; else none. */
async function passwordsFrom(args: {
  readonly passwordStdin: boolean;
}): Promise<string[] | undefined> {
  if (!args.passwordStdin) return undefined;
  if (process.stdin.isTTY) {
    throw new UsageError(
      'Pipe the backup password on standard input; it is not read from a prompt.',
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const password = Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
  if (password === '') throw new UsageError('--password-stdin read an empty password.');
  return [password];
}

/** Reads the kit passphrase from standard input: everything up to EOF, one trailing newline dropped. */
async function passphraseFromStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new UsageError(
      'Pipe the kit passphrase on standard input (see `backup` with no arguments); it is not ' +
        'read from a terminal prompt or an argument.',
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}

/**
 * Adds a Recovery Kit's keys to `keyring`, for this command's lifetime only.
 *
 * Nothing is written anywhere: the CLI's job is to open one archive. Importing
 * the keys so the restored installation can read its own credentials is the Web
 * Admin's import, which wraps them under the active key and audits it.
 */
async function withKit(keyring: InstallationKeyring, kitPath: string): Promise<number> {
  const opened = await openRecoveryKit(await readFile(kitPath), await passphraseFromStdin());
  try {
    const next = new Map(keyring.importedKeys);
    for (const key of opened.keys) {
      if (!keyring.isConfigured(key.keyId)) next.set(key.keyId, key.material);
    }
    keyring.replaceImported(next);
    return opened.keys.length;
  } finally {
    for (const key of opened.keys) key.material.fill(0);
  }
}

/**
 * Points the container at the installation's primary tenant.
 *
 * Without this the CLI's container has `installationTenantId === null` for its
 * whole life, and every consequence of that is silent: `BackupService.report`
 * takes its "no tenant provisioned" branch and records NOTHING, so a manual
 * backup that succeeds cannot close an open `backup.run_failed` condition. The
 * operator's way out of a nightly-failure alert was to wait for a SCHEDULED run
 * to succeed, and the log line they got instead asserted something false on a
 * provisioned installation. The manifest also recorded `installationId:
 * 'unprovisioned'`, which is the same root cause.
 *
 * NOT `resolveInstallationTenant`, which also creates any missing system role.
 * That is the right thing at a process boot and the wrong thing in a maintenance
 * command: `backup restore` is run while the database is the thing that is
 * broken, and a CLI that writes roles on its way to reading a tenant is a CLI
 * that can fail for a reason unrelated to the backup.
 *
 * Failures are SWALLOWED for the same reason. A backup must not be refused
 * because a tenant lookup failed; losing the condition is the status quo this
 * fixes, and losing the backup would be worse than the defect.
 */
async function pointAtInstallation(
  container: Pick<Container, 'tenants' | 'setInstallationTenant' | 'logger'>,
): Promise<void> {
  try {
    const primary = await container.tenants.findPrimary();
    container.setInstallationTenant(primary?.id ?? null);
  } catch (error) {
    container.logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'could not resolve the installation tenant; this run will record no operational condition',
    );
  }
}

/** `backup run` refused because a recovery holds the installation. Distinct from BUSY (2). */
const EXIT_RECOVERY_QUIESCED = 4;

async function cmdRun(
  container: Pick<
    Container,
    'backup' | 'recoveryQuiesced' | 'tenants' | 'setInstallationTenant' | 'logger'
  >,
): Promise<number> {
  /*
   * NOT DURING A RECOVERY — the scheduler's rule and the Web button's, for the
   * third trigger.
   *
   * `backup_runs` is written on the database handle, not through the unit of
   * work, so neither quiesce chokepoint stops a backup: a shell `backup run`
   * while a recovery is QUIESCING or RESTORING dumped a database that was about
   * to be renamed away, and its later writes landed in whichever database then
   * held the live name. Asked of the SAME predicate the scheduler asks
   * (`container.recoveryQuiesced`), before anything else, so a refusal writes
   * nothing — not even the tenant lookup's role repairs.
   *
   * Racy by construction, exactly like the button: a recovery can begin
   * quiescing a millisecond later. The executor's own pre-restore backup holds
   * the one-at-a-time lock up to the quiesce, which is what closes the window
   * from the other side. `PRE_RESTORE_BACKUP` is deliberately outside the
   * quiesce (ADR-0028), so this refuses nothing the executor needs.
   */
  if (await container.recoveryQuiesced()) {
    process.stderr.write(
      'A recovery is restoring this installation, which is not taking backups until it ' +
        'finishes. The recovery takes its own pre-restore backup. Nothing was started.\n',
    );
    return EXIT_RECOVERY_QUIESCED;
  }
  await pointAtInstallation(container);
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
 * `BACKUP_WORK_DIR` as `verify` sees it: the environment, with the configuration
 * schema's own default — the same reasoning as the keyring below. `verify` must
 * not need `loadConfig()`, and the directory it decrypts into must be the SAME
 * 0700 volume the pipeline writes to, never `/tmp`: there a SIGKILL left a
 * plaintext database outside the volume, in a directory nothing ever cleaned.
 */
/** The 7-Zip settings from the environment alone — `verify` loads no configuration. */
function sevenZipOptionsFromEnvironment() {
  const number = (name: string, fallback: number): number => {
    const parsed = Number.parseInt(process.env[name] ?? '', 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    binary: process.env.BACKUP_SEVEN_ZIP_BIN?.trim() || '7z',
    level: number('BACKUP_SEVEN_ZIP_LEVEL', 9),
    threads: number('BACKUP_SEVEN_ZIP_THREADS', 2),
    memoryBudgetMb: number('BACKUP_SEVEN_ZIP_MEMORY_MB', DEFAULT_SEVEN_ZIP_MEMORY_MB),
    memoryHeadroomMb: number('BACKUP_SEVEN_ZIP_HEADROOM_MB', DEFAULT_SEVEN_ZIP_HEADROOM_MB),
    readAvailableMb: readMemAvailableMb,
    sealTimeoutMs: number('BACKUP_DUMP_TIMEOUT_MS', 2 * 3_600_000),
    openTimeoutMs: number('BACKUP_RESTORE_TIMEOUT_MS', 2 * 3_600_000),
  };
}

function backupWorkDirFromEnvironment(): string {
  const configured = process.env.BACKUP_WORK_DIR?.trim() ?? '';
  return configured === '' ? '/var/lib/nexa/backups' : configured;
}

/**
 * Decrypts an archive to a temporary file and checks it against its own
 * manifest. Never opens a database.
 *
 * The temporary directory is a 0700 `.cli-verify-*` directory under
 * `BACKUP_WORK_DIR`; if this process is killed before its `finally`, the
 * backup housekeeping's debris sweep removes it once it is past the grace.
 *
 * The temporary directory is removed in a `finally`, including on failure: the
 * file it holds is a plaintext database, and leaving one behind because a
 * verification failed would be the worst possible time to leave one behind.
 */
async function cmdVerify(
  archivePaths: string | readonly string[],
  kitPath: string | null = null,
  passwordStdin = false,
): Promise<number> {
  const paths = typeof archivePaths === 'string' ? [archivePaths] : archivePaths;
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
  const keyring = new InstallationKeyring(
    resolveKeyring({
      SECRETS_KEYS: process.env.SECRETS_KEYS,
      SECRETS_ACTIVE_KEY_ID: process.env.SECRETS_ACTIVE_KEY_ID,
      SECRETS_KEK: process.env.SECRETS_KEK,
      SECRETS_KEK_ID: process.env.SECRETS_KEK_ID,
    }),
  );
  if (kitPath !== null) {
    process.stdout.write(
      `kit      ${String(await withKit(keyring, kitPath))} key(s), decrypt-only\n`,
    );
  }
  // No database here, so no stored password: a 7-Zip archive opens with the one given on
  // standard input, or not at all.
  const passwords = await passwordsFrom({ passwordStdin });
  const archiver = new DualFormatBackupArchiver(
    keyring,
    { current: async () => null, all: async () => [] },
    sevenZipOptionsFromEnvironment(),
  );

  // The archive is RECOGNISED before anything is created. A file that is not an archive,
  // or a 7-Zip one without its password, is refused here, so neither needs a writable
  // BACKUP_WORK_DIR: an operator verifying a file on a broken host is told what the file
  // is, not that a directory it never needed cannot be made. The scratch directory stays
  // on the backup volume (never /tmp, see above); only its creation comes later.
  const parts = await orderedParts(paths);
  const sevenZip = await isSevenZipFile(parts[0] ?? '');
  if (sevenZip && passwords === undefined) {
    throw new UsageError('A 7-Zip backup needs its password: add --password-stdin.');
  }
  const describeNative = async (path: string): Promise<void> => {
    const header = await readArchiveHeader(path);
    process.stdout.write(
      `archive  format ${String(header.header.format)}, ${String(header.archiveBytes)} bytes\n` +
        `backup   ${header.header.backupId}\n` +
        `key      ${header.header.keyId}\n`,
    );
  };
  if (!sevenZip && parts.length === 1) await describeNative(parts[0] ?? '');

  const directory = await privateScratchDirectory(backupWorkDirFromEnvironment(), 'verify');
  const alive = keepScratchAlive(directory);
  try {
    const archivePath = await joinedArchive(parts, directory);
    if (sevenZip) {
      const { size } = await stat(archivePath);
      process.stdout.write(`archive  7-Zip (AES-256, encrypted headers), ${String(size)} bytes\n`);
    } else if (parts.length > 1) {
      await describeNative(archivePath);
    }
    const opened = await archiver.open({
      archivePath,
      dumpPath: join(directory, 'dump.pgcustom'),
      ...(passwords === undefined ? {} : { passwords }),
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
    alive.stop();
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
  archivePaths: string | readonly string[],
  target: string,
  kitPath: string | null = null,
  passwordStdin = false,
): Promise<number> {
  const paths = typeof archivePaths === 'string' ? [archivePaths] : archivePaths;
  const passwords = await passwordsFrom({ passwordStdin });
  // The installation's imported keys, then the kit's, if one was given. Both
  // only ever DECRYPT: the container's keyring encrypts with the configured key.
  await container.installationKeyLoader.refreshQuietly();
  if (kitPath !== null) {
    process.stdout.write(
      `Kit       ${String(await withKit(container.keyring, kitPath))} key(s), decrypt-only\n`,
    );
  }
  const directory = await privateScratchDirectory(container.config.BACKUP_WORK_DIR, 'restore');
  const alive = keepScratchAlive(directory);
  try {
    const dumpPath = join(directory, 'dump.pgcustom');
    const archivePath = await joinedArchive(await orderedParts(paths), directory);
    // The container's archiver: a 7-Zip archive tries the given password, else this
    // installation's stored ones (an archive it sealed itself).
    const opened = await container.backupArchiver.open({
      archivePath,
      dumpPath,
      ...(passwords === undefined ? {} : { passwords }),
    });
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
    alive.stop();
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
    process.exit(await cmdVerify(args.archives, args.kit, args.passwordStdin));
  }

  const config = loadConfig();
  const container = createContainer(config, 'worker');
  try {
    if (args.command === 'run') process.exit(await cmdRun(container));
    if (args.command === 'list') process.exit(await cmdList(container, args.limit));
    // Both refused by `parseArgs`, before this container was built.
    process.exit(
      await cmdRestore(container, args.archives, args.target ?? '', args.kit, args.passwordStdin),
    );
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

export {
  backupWorkDirFromEnvironment,
  orderedParts,
  parseArgs,
  cmdVerify,
  cmdRun,
  pointAtInstallation,
  UsageError,
  USAGE,
  EXIT_RECOVERY_QUIESCED,
};
