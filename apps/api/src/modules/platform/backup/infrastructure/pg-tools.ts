import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { NexaError, PLATFORM_ERROR_CODES } from '@nexa/contracts';
import type {
  DatabaseTools,
  DumpOutcome,
  RestoreTarget,
  VerifyOutcome,
} from '../application/ports.js';
import { assertOutsideTransaction } from '../../../../infrastructure/transaction-boundary.js';

/**
 * The PostgreSQL command-line tools, as an adapter.
 *
 * `pg_dump` and `pg_restore` rather than anything written here. A custom-format
 * dump is PostgreSQL's own artifact, understood by every `pg_restore` of a
 * compatible version and by an operator with no access to this codebase, which
 * is exactly what a disaster-recovery artifact has to be. A bespoke exporter
 * would be a second implementation of the one thing nobody gets to debug during
 * an actual disaster.
 *
 * THE CONNECTION NEVER APPEARS ON A COMMAND LINE. `PGPASSWORD` and the rest go
 * through the child's environment; the URL is parsed here and passed as
 * discrete flags. A password in `argv` is world-readable in `/proc` for the
 * lifetime of the process, which on a dump of a real database is minutes.
 */

/** The parsed pieces of a connection URL, kept apart from its password. */
interface Connection {
  readonly host: string;
  readonly port: string;
  readonly user: string;
  readonly password: string | null;
  readonly database: string;
}

export function parseConnection(url: string): Connection {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new NexaError({
      kind: 'CONFIGURATION',
      code: PLATFORM_ERROR_CODES.BACKUP_TOOL_FAILED,
      message: 'DATABASE_URL is not a URL, so a backup cannot address the database.',
    });
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (database === '') {
    throw new NexaError({
      kind: 'CONFIGURATION',
      code: PLATFORM_ERROR_CODES.BACKUP_TOOL_FAILED,
      message: 'DATABASE_URL names no database, so a backup has nothing to dump.',
    });
  }
  return {
    host: parsed.hostname === '' ? 'localhost' : parsed.hostname,
    port: parsed.port === '' ? '5432' : parsed.port,
    user: decodeURIComponent(parsed.username),
    password: parsed.password === '' ? null : decodeURIComponent(parsed.password),
    database,
  };
}

/**
 * A PostgreSQL identifier is not a string that can be interpolated.
 *
 * Scratch database names are generated here and never operator input, so this
 * is belt to the generator's braces — but a `CREATE DATABASE` built by string
 * concatenation is the shape of defect that only stops being harmless once
 * somebody makes the name configurable.
 */
function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) {
    throw new NexaError({
      kind: 'INTERNAL',
      code: PLATFORM_ERROR_CODES.BACKUP_TOOL_FAILED,
      message: 'A database name this pipeline generated is not a plain identifier.',
    });
  }
  return `"${name}"`;
}

export interface RunResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Keeps a tool's diagnostics bounded and useful; a dump can be very loud. */
const MAX_CAPTURED_OUTPUT = 16 * 1024;

function run(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<RunResult> {
  // `pg_dump` and `pg_restore` open their OWN connections to the database, and
  // a dump runs for as long as the database is large. Inside a transaction that
  // would be a connection from the pool waiting on a subprocess which is itself
  // waiting on the same database — the deadlock-shaped version of the rule in
  // `transaction-boundary.ts`, not merely the slow one.
  assertOutsideTransaction(`The ${command} subprocess`);

  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // A dump that ignores SIGTERM still has to stop, or the lease it holds
      // outlives the run that took it.
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_CAPTURED_OUTPUT) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_CAPTURED_OUTPUT) stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(
        new NexaError({
          kind: 'CONFIGURATION',
          code: PLATFORM_ERROR_CODES.BACKUP_TOOL_FAILED,
          message:
            `Could not run "${command}". A backup needs the PostgreSQL client tools on PATH, ` +
            'at a version compatible with the server.',
          details: { command, reason: error.message },
        }),
      );
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new NexaError({
            kind: 'INTERNAL',
            code: PLATFORM_ERROR_CODES.BACKUP_TOOL_FAILED,
            message: `"${command}" did not finish within ${timeoutMs}ms and was stopped.`,
            details: { command, stderr: stderr.slice(0, 2000) },
          }),
        );
        return;
      }
      resolve({ code, signal, stdout, stderr });
    });
  });
}

export interface PgToolsOptions {
  readonly databaseUrl: string;
  readonly dumpTimeoutMs: number;
  readonly restoreTimeoutMs: number;
  /** Where the tools live, when they are not on PATH. */
  readonly binDir?: string | undefined;
}

export class PostgresDatabaseTools implements DatabaseTools {
  private readonly connection: Connection;

  constructor(private readonly options: PgToolsOptions) {
    this.connection = parseConnection(options.databaseUrl);
  }

  get databaseName(): string {
    return this.connection.database;
  }

  private bin(name: string): string {
    return this.options.binDir === undefined ? name : `${this.options.binDir}/${name}`;
  }

  /**
   * The child's environment.
   *
   * Inherits nothing by default beyond PATH and the locale: a dump does not
   * need this process's configuration, and every variable it does not receive
   * is one that cannot end up in a diagnostic. `PGPASSWORD` is set here and
   * nowhere else.
   */
  private env(database: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      LC_ALL: 'C',
      PGHOST: this.connection.host,
      PGPORT: this.connection.port,
      PGDATABASE: database,
      // Never interactive. Without this a tool that wants a password blocks on
      // a terminal that does not exist until the timeout fires.
      PGCONNECT_TIMEOUT: '10',
    };
    if (this.connection.user !== '') env.PGUSER = this.connection.user;
    if (this.connection.password !== null) env.PGPASSWORD = this.connection.password;
    return env;
  }

  private async version(command: string): Promise<string> {
    const result = await run(this.bin(command), ['--version'], this.env(this.databaseName), 30_000);
    if (result.code !== 0) {
      throw new NexaError({
        kind: 'CONFIGURATION',
        code: PLATFORM_ERROR_CODES.BACKUP_TOOL_FAILED,
        message: `"${command} --version" failed, so the tool is not usable.`,
        details: { stderr: result.stderr.slice(0, 500) },
      });
    }
    return result.stdout.trim();
  }

  async pgDumpVersion(): Promise<string> {
    return this.version('pg_dump');
  }

  /**
   * The SERVER's version, read from the server rather than inferred.
   *
   * `pg_dump --version` reports the CLIENT, and the two differ routinely — a
   * host upgraded its client packages, or a managed server runs a version
   * older than the tools on the box. The manifest carries both, so a restore
   * years later can tell whether it is being asked to restore a newer server's
   * dump into an older one, which `pg_restore` cannot do.
   */
  async serverVersion(): Promise<string> {
    const result = await run(
      this.bin('psql'),
      ['--no-psqlrc', '--quiet', '--tuples-only', '--no-align', '--command', 'SHOW server_version'],
      this.env(this.databaseName),
      30_000,
    );
    if (result.code !== 0) {
      throw new NexaError({
        kind: 'INTERNAL',
        code: PLATFORM_ERROR_CODES.BACKUP_TOOL_FAILED,
        message: 'Could not read the PostgreSQL server version.',
        details: { stderr: result.stderr.slice(0, 500) },
      });
    }
    return result.stdout.trim();
  }

  /**
   * `pg_dump --format=custom` of the WHOLE database, to a file.
   *
   * No `--exclude-table`, no `--schema`, nothing left out. The instruction was
   * to include everything not proven safely reconstructable, and nothing here
   * is: `processed_messages` looks like a cache and is the only thing standing
   * between a redelivered outbox message and a duplicated effect;
   * `panel_probe_budgets` looks like a counter and is what bounds an
   * installation's outbound rate. A dump is not the place to be clever.
   *
   * Read-only against the live database, and it takes no lock that blocks
   * writers — `pg_dump` runs in a repeatable-read snapshot.
   */
  async dump(destination: string): Promise<DumpOutcome> {
    const result = await run(
      this.bin('pg_dump'),
      [
        '--format=custom',
        // No owner or ACL statements: a restore into a scratch database owned
        // by whoever is verifying must not fail because a role does not exist
        // there. The roles are a property of the cluster, not of this database.
        '--no-owner',
        '--no-acl',
        '--file',
        destination,
        this.databaseName,
      ],
      this.env(this.databaseName),
      this.options.dumpTimeoutMs,
    );
    if (result.code !== 0) {
      throw new NexaError({
        kind: 'INTERNAL',
        code: PLATFORM_ERROR_CODES.BACKUP_TOOL_FAILED,
        message: 'pg_dump did not complete, so this run produced no artifact.',
        details: { exitCode: result.code, stderr: result.stderr.slice(0, 2000) },
      });
    }
    return {
      databaseName: this.databaseName,
      pgDumpVersion: await this.pgDumpVersion(),
    };
  }

  /**
   * Creates a scratch database, restores into it, checks it, and drops it.
   *
   * The name is random and prefixed, so it cannot collide with a real database
   * and is recognisable as debris if a cleanup ever fails. It is created EMPTY
   * — `pg_restore` into a database with existing objects proves nothing, since
   * the objects the restore failed to create were already there.
   *
   * The refusal below is the important part of this method. See
   * `assertNotLiveTarget`.
   */
  async verifyRestore(dumpPath: string): Promise<VerifyOutcome> {
    const scratch = `nexa_verify_${randomBytes(8).toString('hex')}`;
    // Belt and braces: the generator cannot produce the live name, and the
    // guard says so anyway, because "cannot" is a property of today's code.
    assertNotLiveTarget({ database: scratch }, this.databaseName);

    const maintenance = this.env('postgres');
    const create = await run(
      this.bin('psql'),
      ['--no-psqlrc', '--quiet', '--command', `CREATE DATABASE ${quoteIdent(scratch)}`],
      maintenance,
      60_000,
    );
    if (create.code !== 0) {
      throw new NexaError({
        kind: 'INTERNAL',
        code: PLATFORM_ERROR_CODES.BACKUP_VERIFICATION_FAILED,
        message:
          'A backup could not be verified: the scratch database could not be created. ' +
          'Verification is mandatory, so the run fails rather than delivering an unproven archive.',
        details: { stderr: create.stderr.slice(0, 1000) },
      });
    }

    let restored = false;
    let tableCount = 0;
    let failure: string | null = null;
    try {
      const restore = await run(
        this.bin('pg_restore'),
        [
          '--no-owner',
          '--no-acl',
          // Every error, not the first: a restore that stops at the first
          // problem reports one symptom of a dump that may be broken in
          // several places, and `--exit-on-error` is what makes a partial
          // restore a failure rather than a warning nobody reads.
          '--exit-on-error',
          '--dbname',
          scratch,
          dumpPath,
        ],
        this.env(scratch),
        this.options.restoreTimeoutMs,
      );
      if (restore.code !== 0) {
        failure = restore.stderr.slice(0, 2000);
      } else {
        restored = true;
        // The structural check. A `pg_restore` that exits zero having created
        // nothing is the failure mode this catches — an empty dump restores
        // perfectly.
        const check = await run(
          this.bin('psql'),
          [
            '--no-psqlrc',
            '--quiet',
            '--tuples-only',
            '--no-align',
            '--dbname',
            scratch,
            '--command',
            "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'",
          ],
          this.env(scratch),
          60_000,
        );
        if (check.code !== 0) {
          failure = check.stderr.slice(0, 2000);
          restored = false;
        } else {
          tableCount = Number.parseInt(check.stdout.trim(), 10);
          if (!Number.isFinite(tableCount)) {
            failure = 'the structural check returned something that is not a count';
            restored = false;
          }
        }
      }
    } finally {
      const drop = await run(
        this.bin('psql'),
        [
          '--no-psqlrc',
          '--quiet',
          '--command',
          `DROP DATABASE IF EXISTS ${quoteIdent(scratch)} WITH (FORCE)`,
        ],
        maintenance,
        60_000,
      ).catch(() => null);
      if (drop === null || drop.code !== 0) {
        // Visible, never swallowed: a scratch database left behind is real
        // debris on the operator's server, and the pipeline reports it as a
        // cleanup failure rather than letting a green run hide it.
        this.leaked.push(scratch);
      }
    }

    if (!restored) {
      return { ok: false, scratchDatabase: scratch, tableCount: 0, detail: failure ?? 'unknown' };
    }
    return { ok: true, scratchDatabase: scratch, tableCount, detail: null };
  }

  /** Scratch databases whose DROP failed. Read by the cleanup stage. */
  readonly leaked: string[] = [];

  async restoreInto(target: RestoreTarget, dumpPath: string): Promise<void> {
    assertNotLiveTarget(target, this.databaseName);
    const env = this.env(target.database);

    // An EMPTY target, checked rather than assumed. `pg_restore` into a
    // populated database produces a half-merged result that exits non-zero on
    // the conflicts and leaves behind whatever it managed to create first —
    // which looks, to somebody restoring under pressure, like a restore that
    // nearly worked. It did not; it damaged both copies.
    const populated = await run(
      this.bin('psql'),
      [
        '--no-psqlrc',
        '--quiet',
        '--tuples-only',
        '--no-align',
        '--dbname',
        target.database,
        '--command',
        "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema')",
      ],
      env,
      60_000,
    );
    if (populated.code !== 0) {
      throw new NexaError({
        kind: 'VALIDATION',
        code: PLATFORM_ERROR_CODES.BACKUP_UNSAFE_RESTORE_TARGET,
        message:
          `Could not inspect "${target.database}" before restoring into it. A restore is only ` +
          'attempted against a database this command can read and has confirmed is empty.',
        details: { stderr: populated.stderr.slice(0, 500) },
      });
    }
    const tables = Number.parseInt(populated.stdout.trim(), 10);
    if (!Number.isFinite(tables) || tables > 0) {
      throw new NexaError({
        kind: 'VALIDATION',
        code: PLATFORM_ERROR_CODES.BACKUP_UNSAFE_RESTORE_TARGET,
        message:
          `Refusing to restore into "${target.database}": it already contains ${populated.stdout.trim()} ` +
          'tables. Restore into a database created empty for the purpose.',
        details: { target: target.database },
      });
    }

    const restore = await run(
      this.bin('pg_restore'),
      ['--no-owner', '--no-acl', '--exit-on-error', '--dbname', target.database, dumpPath],
      env,
      this.options.restoreTimeoutMs,
    );
    if (restore.code !== 0) {
      throw new NexaError({
        kind: 'INTERNAL',
        code: PLATFORM_ERROR_CODES.BACKUP_TOOL_FAILED,
        message: 'pg_restore did not complete against the requested target.',
        details: { exitCode: restore.code, stderr: restore.stderr.slice(0, 2000) },
      });
    }
  }
}

/**
 * Refuses to restore over the database this installation is running on.
 *
 * The one rule in this module that exists purely to prevent a catastrophe
 * rather than to detect one. Verification restores into a database it creates
 * seconds earlier, and the operator's restore command takes an explicit target
 * with no default — but "there is no way to pass the live name" is a property
 * of the current call sites, and this is a property of the operation.
 *
 * Compared by NAME against the configured `DATABASE_URL`'s database, which is
 * what both paths connect to. It cannot catch a target that is the same
 * database reached under a different name through a different host, and saying
 * so is more useful than implying a completeness this cannot have: an operator
 * restoring across hosts is responsible for where they point it.
 */
export function assertNotLiveTarget(target: { database: string }, liveDatabase: string): void {
  if (target.database === liveDatabase) {
    throw new NexaError({
      kind: 'VALIDATION',
      code: PLATFORM_ERROR_CODES.BACKUP_UNSAFE_RESTORE_TARGET,
      message:
        `Refusing to restore into "${target.database}": that is the database this installation ` +
        'is running on. A restore overwrites; name a different, empty database.',
      details: { target: target.database },
    });
  }
}
