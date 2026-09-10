import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import { NexaError, PLATFORM_ERROR_CODES } from '@nexa/contracts';
import type {
  DatabaseTools,
  DumpOutcome,
  RestoreTarget,
  VerifyOutcome,
} from '../application/ports.js';
import type { DatabaseInspection, RestoreEngine } from '../../recovery/application/ports.js';
import type { AppliedMigration } from '../../../../infrastructure/persistence/migration-state.js';
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
  /**
   * The migrator's entrypoint, for migrating a restored CANDIDATE forward.
   *
   * A path rather than an import, because the migrator opens its own pool and
   * its own transaction: pointing it at a second database from inside this
   * process would mean two pools to the same cluster under one shutdown path.
   * Resolved by the container from the running module's own location, so it is
   * the migrator this release ships rather than whatever is on disk.
   */
  readonly migratorEntrypoint: string;
}

export class PostgresDatabaseTools implements DatabaseTools, RestoreEngine {
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

  // --- The restore primitives -------------------------------------------
  //
  // Separated because a recovery needs them separately: it has to KEEP the
  // candidate it restored (the candidate is what gets cut over to) and has to
  // read the candidate's migration state. `verifyRestore` below is rebuilt on
  // top of these rather than left as a second implementation, so there is still
  // exactly one `pg_restore` call site and one emptiness check.
  // `docs/disaster-recovery-audit.md` § MISSING-4.

  get liveDatabase(): string {
    return this.connection.database;
  }

  /**
   * Creates an EMPTY database.
   *
   * `quoteIdent` is not decoration here even though every name this codebase
   * generates is a random hex suffix on a constant prefix: a `CREATE DATABASE`
   * built by concatenation is the shape of defect that stops being harmless the
   * day somebody makes the name configurable.
   */
  async createDatabase(name: string): Promise<void> {
    assertNotLiveTarget({ database: name }, this.databaseName);
    const created = await run(
      this.bin('psql'),
      ['--no-psqlrc', '--quiet', '--command', `CREATE DATABASE ${quoteIdent(name)}`],
      this.env('postgres'),
      60_000,
    );
    if (created.code !== 0) {
      throw new NexaError({
        kind: 'INTERNAL',
        code: PLATFORM_ERROR_CODES.BACKUP_VERIFICATION_FAILED,
        message: 'A database could not be created for a restore.',
        details: { stderr: created.stderr.slice(0, 1000) },
      });
    }
  }

  /**
   * Drops a database, reporting rather than throwing.
   *
   * A failed drop is debris on the operator's server, not a reason to fail the
   * operation that produced it — and it is NEVER silent: the name goes on
   * `leaked`, which the cleanup stage reads and reports. `WITH (FORCE)`
   * terminates sessions still attached, which is what makes this work on a
   * candidate a failed restore left a connection on.
   */
  async dropDatabase(name: string): Promise<{ dropped: boolean }> {
    // The live database can never be dropped by this code path, whatever a
    // caller passes. There is no legitimate reason to drop it and one
    // catastrophic outcome if a name is ever computed wrongly.
    assertNotLiveTarget({ database: name }, this.databaseName);
    const dropped = await run(
      this.bin('psql'),
      [
        '--no-psqlrc',
        '--quiet',
        '--command',
        `DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`,
      ],
      this.env('postgres'),
      60_000,
    ).catch(() => null);
    if (dropped === null || dropped.code !== 0) {
      this.leaked.push(name);
      return { dropped: false };
    }
    return { dropped: true };
  }

  /**
   * The `pg_dump` custom-format magic, read from the head of the file.
   *
   * `PGDMP` is the five-byte signature every custom-format archive starts with,
   * and it is what `pg_restore` itself looks for. Reading five bytes is the whole
   * check: this answers "is this the kind of file the manifest says it is", not
   * "will it restore" — that question only a real restore answers, and the
   * restore-test is what asks it.
   *
   * An unreadable or shorter-than-five-bytes file answers `false` rather than
   * throwing: the caller's next move is the same either way, and a throw here
   * would surface as the unclassified code instead of the specific one.
   */
  async isCustomFormatDump(dumpPath: string): Promise<boolean> {
    const MAGIC = Buffer.from('PGDMP', 'ascii');
    let handle: FileHandle | null = null;
    try {
      handle = await open(dumpPath, 'r');
      const head = Buffer.alloc(MAGIC.length);
      const { bytesRead } = await handle.read(head, 0, MAGIC.length, 0);
      return bytesRead === MAGIC.length && head.equals(MAGIC);
    } catch {
      return false;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  /**
   * Restores a dump into a database this method has confirmed is EMPTY.
   *
   * The emptiness check is the important part, and it is a check rather than an
   * assumption for the reason stated on the port: `pg_restore` into a populated
   * database exits non-zero on the conflicts having already created whatever it
   * managed first, which looks like a restore that nearly worked and is in fact
   * two damaged copies.
   */
  async restoreIntoEmpty(name: string, dumpPath: string): Promise<void> {
    assertNotLiveTarget({ database: name }, this.databaseName);
    const env = this.env(name);
    await this.assertEmpty(name, env);

    const restore = await run(
      this.bin('pg_restore'),
      [
        '--no-owner',
        '--no-acl',
        // Every error is fatal. `--exit-on-error` is what makes a partial
        // restore a failure rather than a warning nobody reads.
        '--exit-on-error',
        '--dbname',
        name,
        dumpPath,
      ],
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

  /** Refuses a target that already holds objects. Shared by both restore paths. */
  private async assertEmpty(name: string, env: NodeJS.ProcessEnv): Promise<void> {
    const populated = await run(
      this.bin('psql'),
      [
        '--no-psqlrc',
        '--quiet',
        '--tuples-only',
        '--no-align',
        '--dbname',
        name,
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
          `Could not inspect "${name}" before restoring into it. A restore is only ` +
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
          `Refusing to restore into "${name}": it already contains ${populated.stdout.trim()} ` +
          'tables. Restore into a database created empty for the purpose.',
        details: { target: name },
      });
    }
  }

  /**
   * A restored database's structural facts.
   *
   * Two questions in one round trip per question, and both answers matter
   * independently. `tableCount === 0` is the failure an empty dump produces: it
   * restores perfectly and holds nothing. `migrations === null` means
   * `__drizzle_migrations` is not there at all, which is NOT the same as "no
   * migrations applied" — a dump of something that was never this application
   * would say the second if the first were folded into it, and a verdict derived
   * from that would be a confident wrong answer.
   */
  async inspectDatabase(name: string): Promise<DatabaseInspection> {
    const env = this.env(name);
    const tables = await run(
      this.bin('psql'),
      [
        '--no-psqlrc',
        '--quiet',
        '--tuples-only',
        '--no-align',
        '--dbname',
        name,
        '--command',
        "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'",
      ],
      env,
      60_000,
    );
    if (tables.code !== 0) {
      throw new NexaError({
        kind: 'INTERNAL',
        code: PLATFORM_ERROR_CODES.BACKUP_VERIFICATION_FAILED,
        message: 'A restored database could not be inspected.',
        details: { stderr: tables.stderr.slice(0, 1000) },
      });
    }
    const tableCount = Number.parseInt(tables.stdout.trim(), 10);
    if (!Number.isFinite(tableCount)) {
      throw new NexaError({
        kind: 'INTERNAL',
        code: PLATFORM_ERROR_CODES.BACKUP_VERIFICATION_FAILED,
        message: 'The structural check returned something that is not a count.',
      });
    }

    // `to_regclass` rather than a query that throws: a missing table is an
    // ANSWER here, and catching an exception to learn it would also catch a
    // permission error and report it as the same thing.
    const migrations = await run(
      this.bin('psql'),
      [
        '--no-psqlrc',
        '--quiet',
        '--tuples-only',
        '--no-align',
        '--field-separator',
        '|',
        '--dbname',
        name,
        '--command',
        `SELECT CASE WHEN to_regclass('drizzle.__drizzle_migrations') IS NULL THEN 'ABSENT' ELSE 'PRESENT' END`,
      ],
      env,
      60_000,
    );
    if (migrations.code !== 0) {
      throw new NexaError({
        kind: 'INTERNAL',
        code: PLATFORM_ERROR_CODES.BACKUP_VERIFICATION_FAILED,
        message: "A restored database's migration state could not be read.",
        details: { stderr: migrations.stderr.slice(0, 1000) },
      });
    }
    if (migrations.stdout.trim() !== 'PRESENT') return { tableCount, migrations: null };

    const rows = await run(
      this.bin('psql'),
      [
        '--no-psqlrc',
        '--quiet',
        '--tuples-only',
        '--no-align',
        '--field-separator',
        '|',
        '--dbname',
        name,
        '--command',
        'SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at',
      ],
      env,
      60_000,
    );
    if (rows.code !== 0) {
      throw new NexaError({
        kind: 'INTERNAL',
        code: PLATFORM_ERROR_CODES.BACKUP_VERIFICATION_FAILED,
        message: "A restored database's migration rows could not be read.",
        details: { stderr: rows.stderr.slice(0, 1000) },
      });
    }
    const applied: AppliedMigration[] = [];
    for (const line of rows.stdout.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      const [hash = '', createdAt = ''] = trimmed.split('|');
      const when = Number.parseInt(createdAt, 10);
      if (hash === '' || !Number.isFinite(when)) {
        // A row this release cannot parse is not a row to guess at. The caller
        // maps a null history to `migration_state_unreadable`, which refuses the
        // cutover — the safe reading of "we cannot tell".
        return { tableCount, migrations: null };
      }
      applied.push({ hash, createdAt: when });
    }
    return { tableCount, migrations: applied };
  }

  /**
   * Applies this release's pending migrations to a CANDIDATE database.
   *
   * `migrateCandidate`, never `migrate`. The name is the guard a reader gets;
   * `assertNotLiveTarget` is the guard the code gets. A recovery that migrated
   * production would be writing to the one database this design exists to leave
   * untouched until the renames.
   *
   * Runs the compiled migrator as a child process with `DATABASE_URL` pointed at
   * the candidate, rather than importing it: the migrator opens its own pool and
   * its own transaction, and giving it a second database inside this process
   * would mean two pools to the same cluster under one shutdown path.
   */
  async migrateCandidate(name: string): Promise<void> {
    assertNotLiveTarget({ database: name }, this.databaseName);
    const url = new URL(this.options.databaseUrl);
    url.pathname = `/${encodeURIComponent(name)}`;
    const migrated = await run(
      process.execPath,
      [this.options.migratorEntrypoint],
      {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        NODE_ENV: process.env.NODE_ENV ?? 'production',
        // The URL carries the password, which is why this is an ENVIRONMENT
        // variable and not an argument: argv is world-readable in /proc.
        DATABASE_URL: url.toString(),
        ...(process.env.SECRETS_KEYS ? { SECRETS_KEYS: process.env.SECRETS_KEYS } : {}),
        ...(process.env.SECRETS_ACTIVE_KEY_ID
          ? { SECRETS_ACTIVE_KEY_ID: process.env.SECRETS_ACTIVE_KEY_ID }
          : {}),
      },
      this.options.restoreTimeoutMs,
    );
    if (migrated.code !== 0) {
      throw new NexaError({
        kind: 'INTERNAL',
        code: PLATFORM_ERROR_CODES.BACKUP_TOOL_FAILED,
        message: 'The candidate database could not be migrated forward.',
        details: { exitCode: migrated.code, stderr: migrated.stderr.slice(0, 2000) },
      });
    }
  }

  /**
   * The cutover. Two renames, and the only irreversible operation here.
   *
   * ADR-0028 § 2. Every statement runs against the `postgres` maintenance
   * database, because a session connected to a database cannot rename it.
   *
   * The order matters and each step is there for a reason:
   *
   *   REVOKE first, so a process that reconnects during the window is refused
   *   rather than re-establishing a session the rename would then have to kill
   *   again — without it, a pool with a retry loop can keep the rename waiting
   *   indefinitely.
   *
   *   TERMINATE second. The API, the worker and the monitor lose their
   *   connections here, and they SURVIVE it only because of the pool error
   *   listener: `pg` delivers a connection death as an `'error'` event and
   *   `EventEmitter` throws for an unlistened one. ADR-0028 § 3 records that
   *   dependency, because reverting that listener turns this into an outage and
   *   nothing in `database.ts` mentions recovery.
   *
   *   The renames third, live out of the way before the candidate takes its
   *   name. There is no transaction around them: `ALTER DATABASE` cannot run in
   *   one, so the window between them is real and is the reason the journal is
   *   written on both sides of it.
   *
   *   GRANT last, and in a `finally`, so a failure between the renames does not
   *   leave the installation unable to connect to anything.
   */
  async cutover(input: { candidateName: string; displacedName: string }): Promise<void> {
    const live = this.databaseName;
    // The candidate must not BE the live database, and the displaced name must
    // not be either — a displaced name equal to the live name would make the
    // first rename a no-op and the second one fail with the live data still in
    // place under a name the row then lies about.
    assertNotLiveTarget({ database: input.candidateName }, live);
    assertNotLiveTarget({ database: input.displacedName }, live);
    const maintenance = this.env('postgres');
    const exec = async (command: string, what: string): Promise<void> => {
      const result = await run(
        this.bin('psql'),
        ['--no-psqlrc', '--quiet', '--command', command],
        maintenance,
        60_000,
      );
      if (result.code !== 0) {
        throw new NexaError({
          kind: 'INTERNAL',
          code: PLATFORM_ERROR_CODES.BACKUP_TOOL_FAILED,
          message: `The cutover could not ${what}.`,
          details: { stderr: result.stderr.slice(0, 2000) },
        });
      }
    };

    await exec(
      `REVOKE CONNECT ON DATABASE ${quoteIdent(live)} FROM PUBLIC`,
      'stop new connections to the live database',
    );
    try {
      // Terminating nothing is not an error: an installation with no other
      // session open is the easiest case this can run in, and `PERFORM` over an
      // empty result set is a no-op rather than a failure.
      await exec(
        `DO $$ BEGIN PERFORM pg_terminate_backend(pid) FROM pg_stat_activity ` +
          `WHERE datname = ${quoteLiteral(live)} AND pid <> pg_backend_pid(); END $$`,
        'disconnect the live database',
      );
      await exec(
        `ALTER DATABASE ${quoteIdent(live)} RENAME TO ${quoteIdent(input.displacedName)}`,
        'rename the outgoing database',
      );
      await exec(
        `ALTER DATABASE ${quoteIdent(input.candidateName)} RENAME TO ${quoteIdent(live)}`,
        'rename the restored database into place',
      );
    } finally {
      // ALWAYS, including after a failure between the renames. An installation
      // that cannot connect to its own database is a worse outcome than a failed
      // recovery, and this is the statement that prevents it.
      await exec(
        `GRANT CONNECT ON DATABASE ${quoteIdent(live)} TO PUBLIC`,
        'restore connection grants',
      ).catch(() => undefined);
    }
  }

  /**
   * Creates a scratch database, restores into it, checks it, and drops it.
   *
   * The pipeline's verification, now assembled from the primitives above rather
   * than holding its own copies of them. That is the whole reason they were
   * separated: a recovery needed a restore that keeps its target, and the
   * alternative was a second `pg_restore` call site — which is the shape
   * `probe-core.ts` already warns about, where the copy that silently keeps the
   * old behaviour is the unattended one.
   *
   * The name is random and prefixed, so it cannot collide with a real database
   * and is recognisable as debris if a cleanup ever fails.
   */
  async verifyRestore(dumpPath: string): Promise<VerifyOutcome> {
    const scratch = `nexa_verify_${randomBytes(8).toString('hex')}`;
    // Belt and braces: the generator cannot produce the live name, and the
    // guard says so anyway, because "cannot" is a property of today's code.
    assertNotLiveTarget({ database: scratch }, this.databaseName);

    try {
      await this.createDatabase(scratch);
    } catch (error) {
      throw new NexaError({
        kind: 'INTERNAL',
        code: PLATFORM_ERROR_CODES.BACKUP_VERIFICATION_FAILED,
        message:
          'A backup could not be verified: the scratch database could not be created. ' +
          'Verification is mandatory, so the run fails rather than delivering an unproven archive.',
        details: { reason: error instanceof Error ? error.message : String(error) },
      });
    }

    let tableCount = 0;
    let failure: string | null = null;
    try {
      await this.restoreIntoEmpty(scratch, dumpPath);
      tableCount = (await this.inspectDatabase(scratch)).tableCount;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      // `dropDatabase` records a failed drop on `leaked` itself, which the
      // cleanup stage reports. Visible, never swallowed: a scratch database left
      // behind is real debris on the operator's server.
      await this.dropDatabase(scratch);
    }

    if (failure !== null) {
      return { ok: false, scratchDatabase: scratch, tableCount: 0, detail: failure };
    }
    return { ok: true, scratchDatabase: scratch, tableCount, detail: null };
  }

  /** Scratch databases whose DROP failed. Read by the cleanup stage. */
  readonly leaked: string[] = [];

  /**
   * The operator's restore, from the CLI, into a database they name.
   *
   * Unchanged in behaviour and now one line, because `restoreIntoEmpty` is the
   * behaviour: the live-target refusal, the emptiness check and the
   * `--exit-on-error` restore were always the same three things the pipeline
   * needed, and having them in two places was how they would have come to
   * differ.
   */
  async restoreInto(target: RestoreTarget, dumpPath: string): Promise<void> {
    await this.restoreIntoEmpty(target.database, dumpPath);
  }
}

/**
 * A string literal for a `psql --command`, quoted and escaped.
 *
 * Used for the one place a VALUE rather than an identifier has to be
 * interpolated: `pg_stat_activity.datname = '<live>'`. The database name comes
 * from `DATABASE_URL`, which is the installation's own configuration and not
 * caller input — so this is the same belt-and-braces as `quoteIdent`, and for the
 * same reason: a quoted literal built by concatenation stops being safe the day
 * the value's provenance changes, and the provenance is not visible from here.
 */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
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
