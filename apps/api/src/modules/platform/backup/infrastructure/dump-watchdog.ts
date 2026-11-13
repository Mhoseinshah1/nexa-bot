import { NexaError, PLATFORM_ERROR_CODES } from '@nexa/contracts';

/**
 * The dump watchdog (field, 2026-11-13): how long `pg_dump` may run, what it may wait for, and
 * what is recorded about the session when it is stopped.
 *
 * A manual backup on the owner's test server stayed in DUMP for almost two hours. Nothing
 * bounded the dump below `BACKUP_DUMP_TIMEOUT_MS` (two hours), `pg_dump` waited for its table
 * locks for as long as anybody held a conflicting one, and nothing said what it had been
 * waiting on. So:
 *
 *   - the dump's timeout is SIZED from the database: a floor plus an allowance per GiB, never
 *     above `BACKUP_DUMP_TIMEOUT_MS` (`dumpTimeoutFor`);
 *   - `pg_dump` takes its ACCESS SHARE locks under `--lock-wait-timeout`, so a table someone
 *     holds ACCESS EXCLUSIVE (TRUNCATE, DROP, ALTER, VACUUM FULL, a migration) fails the dump in
 *     minutes, with the table and its holder recorded (`backup.dump_lock_timeout`);
 *   - the dump's session carries an `application_name` of its own, so at the timeout the
 *     watchdog can find it in `pg_stat_activity` and record what it was waiting on — a lock and
 *     who held it, or the client not reading — before it kills the process group
 *     (`backup.dump_timeout`).
 *
 * Pure functions and SQL text here; `pg-tools.ts` runs them.
 */

const MINUTE_MS = 60_000;
const GIB = 1024 ** 3;

/** The least any dump is given, whatever the database's size (capped by the env ceiling). */
export const DUMP_TIMEOUT_FLOOR_MS = 20 * MINUTE_MS;
/**
 * The allowance per GiB of `pg_database_size`. About 3.4 MB/s — far below what `pg_dump` writes
 * even under the backup's CPU quota on a two-vCPU host, so a dump that is merely slow is never
 * stopped, and one that is stuck is stopped in tens of minutes rather than hours.
 */
export const DUMP_TIMEOUT_PER_GIB_MS = 5 * MINUTE_MS;
/**
 * `pg_dump --lock-wait-timeout`: how long it waits for ONE table's ACCESS SHARE lock at the start
 * of the dump. Every lock the dump needs is taken then; a wait longer than this is a session
 * holding the table exclusively, and the scheduler's backoff retries later.
 */
export const DUMP_LOCK_WAIT_TIMEOUT_MS = 5 * MINUTE_MS;
/** The prefix of the dump session's `application_name`; a per-dump token follows it. */
export const DUMP_APPLICATION_NAME_PREFIX = 'nexa-backup-dump';
/** How much of a blocking session's query text is kept. */
const QUERY_TEXT_MAX = 300;

/**
 * The dump's timeout: `floor + perGiB × size in GiB`, never above `capMs`.
 *
 * `capMs` is `BACKUP_DUMP_TIMEOUT_MS` (default 2 h). The floor is itself capped by it, so an
 * operator who sets the variable below 20 minutes gets exactly that, for every size. A size
 * that could not be read gets the cap: the bound that held before the watchdog, never less.
 */
export function dumpTimeoutFor(input: {
  readonly databaseBytes: number | null;
  readonly capMs: number;
  readonly floorMs?: number;
  readonly perGibMs?: number;
}): number {
  const floor = Math.min(input.floorMs ?? DUMP_TIMEOUT_FLOOR_MS, input.capMs);
  if (input.databaseBytes === null || !Number.isFinite(input.databaseBytes)) return input.capMs;
  const bytes = Math.max(0, input.databaseBytes);
  const sized = floor + Math.ceil(((input.perGibMs ?? DUMP_TIMEOUT_PER_GIB_MS) * bytes) / GIB);
  return Math.min(input.capMs, sized);
}

/** `nexa-backup-dump-<token>`: unique per dump, under PostgreSQL's 63 bytes. */
export function dumpApplicationName(token: string): string {
  return `${DUMP_APPLICATION_NAME_PREFIX}-${token}`;
}

/** A PostgreSQL string literal (standard_conforming_strings: only `'` needs doubling). */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** `SELECT pg_database_size(current_database())`: one integer. */
export const DATABASE_SIZE_SQL = 'SELECT pg_database_size(current_database())';

/**
 * One JSON array: the dump's session(s) by `application_name`, what each is waiting for (the
 * ungranted lock, if any) and every session blocking it, with the mode it holds on that relation.
 */
export function dumpSessionSql(applicationName: string): string {
  return `SELECT coalesce(json_agg(s), '[]'::json) FROM (
  SELECT w.pid, w.state, w.wait_event_type AS "waitEventType", w.wait_event AS "waitEvent",
    (SELECT json_build_object('locktype', l.locktype, 'mode', l.mode,
        'relation', CASE WHEN l.relation IS NULL THEN NULL ELSE l.relation::regclass::text END)
       FROM pg_locks l WHERE l.pid = w.pid AND NOT l.granted LIMIT 1) AS "lock",
    (SELECT coalesce(json_agg(json_build_object(
        'pid', b.pid, 'applicationName', b.application_name, 'state', b.state,
        'query', left(b.query, ${String(QUERY_TEXT_MAX)}),
        'mode', (SELECT string_agg(DISTINCT bl.mode, ',') FROM pg_locks bl
                  WHERE bl.pid = b.pid AND bl.granted AND bl.locktype = 'relation'
                    AND bl.relation IN (SELECT wl.relation FROM pg_locks wl
                                         WHERE wl.pid = w.pid AND NOT wl.granted)))), '[]'::json)
       FROM pg_stat_activity b WHERE b.pid = ANY (pg_blocking_pids(w.pid))) AS "blockers"
  FROM pg_stat_activity w
  WHERE w.application_name = ${literal(applicationName)}
) s`;
}

/** The relations named in `pg_dump`'s failed `LOCK TABLE a, b IN ACCESS SHARE MODE`. */
export function lockTimeoutRelations(stderr: string): readonly string[] | null {
  if (!/canceling statement due to (?:statement|lock) timeout/.test(stderr)) return null;
  const match = /LOCK TABLE (.+?) IN ACCESS SHARE MODE/.exec(stderr);
  if (match?.[1] === undefined) return null;
  // Quoted identifiers may hold a comma; such names are not ours, and a wrong split only
  // costs the holder lookup (`to_regclass` of a fragment is NULL), never the failure code.
  return match[1]
    .split(/,\s*/)
    .map((name) => name.trim())
    .filter((name) => name !== '')
    .slice(0, 50);
}

/** One JSON array: every session holding ACCESS EXCLUSIVE on one of `relations`. */
export function lockHoldersSql(relations: readonly string[]): string {
  const regclasses = relations.map((name) => `to_regclass(${literal(name)})`).join(', ');
  return `SELECT coalesce(json_agg(json_build_object(
    'pid', a.pid, 'applicationName', a.application_name, 'state', a.state,
    'query', left(a.query, ${String(QUERY_TEXT_MAX)}), 'mode', l.mode,
    'relation', l.relation::regclass::text)), '[]'::json)
  FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
  WHERE l.locktype = 'relation' AND l.granted AND l.mode = 'AccessExclusiveLock'
    AND l.relation IN (${regclasses === '' ? 'NULL' : regclasses})`;
}

export interface DumpLockHolder {
  readonly pid: number;
  readonly applicationName: string | null;
  readonly state: string | null;
  readonly mode: string | null;
  readonly query: string | null;
  readonly relation?: string | null;
}

/** What the dump's PostgreSQL session was doing when the watchdog looked. */
export interface DumpSessionState {
  readonly pid: number;
  readonly state: string | null;
  readonly waitEventType: string | null;
  readonly waitEvent: string | null;
  readonly lock: {
    readonly locktype: string | null;
    readonly mode: string | null;
    readonly relation: string | null;
  } | null;
  readonly blockers: readonly DumpLockHolder[];
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function holderOf(value: unknown): DumpLockHolder | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.pid !== 'number') return null;
  return {
    pid: row.pid,
    applicationName: str(row.applicationName),
    state: str(row.state),
    mode: str(row.mode),
    query: str(row.query),
    ...('relation' in row ? { relation: str(row.relation) } : {}),
  };
}

function parseArray(stdout: string): unknown[] {
  const parsed: unknown = JSON.parse(stdout.trim() === '' ? '[]' : stdout);
  return Array.isArray(parsed) ? parsed : [];
}

/** The dump session(s) from `dumpSessionSql`'s output; [] when the session is gone. */
export function parseDumpSessions(stdout: string): readonly DumpSessionState[] {
  return parseArray(stdout).flatMap((value) => {
    if (typeof value !== 'object' || value === null) return [];
    const row = value as Record<string, unknown>;
    if (typeof row.pid !== 'number') return [];
    const lock = typeof row.lock === 'object' && row.lock !== null ? row.lock : null;
    const lockRow = lock as Record<string, unknown> | null;
    return [
      {
        pid: row.pid,
        state: str(row.state),
        waitEventType: str(row.waitEventType),
        waitEvent: str(row.waitEvent),
        lock:
          lockRow === null
            ? null
            : {
                locktype: str(lockRow.locktype),
                mode: str(lockRow.mode),
                relation: str(lockRow.relation),
              },
        blockers: (Array.isArray(row.blockers) ? row.blockers : []).flatMap((entry) => {
          const holder = holderOf(entry);
          return holder === null ? [] : [holder];
        }),
      },
    ];
  });
}

/** The holders from `lockHoldersSql`'s output. */
export function parseLockHolders(stdout: string): readonly DumpLockHolder[] {
  return parseArray(stdout).flatMap((entry) => {
    const holder = holderOf(entry);
    return holder === null ? [] : [holder];
  });
}

function holderText(holder: DumpLockHolder): string {
  const app =
    holder.applicationName === null || holder.applicationName === '' ? '?' : holder.applicationName;
  const query = holder.query === null ? '' : `: ${holder.query.replace(/\s+/g, ' ').trim()}`;
  return `pid ${String(holder.pid)} "${app}" (${holder.mode ?? 'mode unknown'}, ${holder.state ?? 'state unknown'})${query}`;
}

/** One English sentence about the session, for the run's failure text and the log. */
export function describeDumpSession(sessions: readonly DumpSessionState[] | null): string {
  if (sessions === null) return 'Its database session could not be observed.';
  const session = sessions[0];
  if (session === undefined) return 'It had no open database session when it was stopped.';
  if (session.lock !== null) {
    const what = session.lock.relation ?? session.lock.locktype ?? 'a lock';
    const by =
      session.blockers.length === 0
        ? 'held by a session that could not be identified'
        : `held by ${session.blockers.map(holderText).join('; ')}`;
    return `Its session (pid ${String(session.pid)}) was waiting for ${session.lock.mode ?? 'a lock'} on ${what}, ${by}.`;
  }
  const wait =
    session.waitEvent === null
      ? 'no wait event'
      : `wait ${session.waitEventType ?? '?'}/${session.waitEvent}`;
  return `Its session (pid ${String(session.pid)}) was not waiting on a lock (${session.state ?? 'state unknown'}, ${wait}).`;
}

/** The relation and mode the session waited on, when it waited on a relation's lock. */
function lockFacts(
  sessions: readonly DumpSessionState[] | null,
): { readonly lockRelation: string; readonly lockMode: string | null } | null {
  const lock = sessions?.[0]?.lock ?? null;
  if (lock === null || lock.relation === null) return null;
  return { lockRelation: lock.relation, lockMode: lock.mode };
}

function minutes(ms: number): string {
  return `${String(Math.round(ms / 60_000))} min`;
}

/** The `backup.dump_timeout` failure: what ran out, and what the session was doing. */
export function dumpTimedOut(input: {
  readonly timeoutMs: number;
  readonly databaseBytes: number | null;
  readonly applicationName: string;
  readonly sessions: readonly DumpSessionState[] | null;
  readonly stderr: string;
}): NexaError {
  const size =
    input.databaseBytes === null
      ? 'the database size could not be read'
      : `sized for ${(input.databaseBytes / GIB).toFixed(2)} GiB`;
  return new NexaError({
    kind: 'INTERNAL',
    code: PLATFORM_ERROR_CODES.BACKUP_DUMP_TIMEOUT,
    message:
      `pg_dump did not finish within ${minutes(input.timeoutMs)} (${size}) and was stopped ` +
      `with every process it started. ${describeDumpSession(input.sessions)}`,
    details: {
      timeoutMs: input.timeoutMs,
      databaseBytes: input.databaseBytes,
      applicationName: input.applicationName,
      sessions: input.sessions,
      ...(lockFacts(input.sessions) ?? {}),
      stderr: input.stderr.slice(0, 2000),
    },
  });
}

/** The `backup.dump_lock_timeout` failure: which table, and who held it. */
export function dumpLockTimedOut(input: {
  readonly relations: readonly string[];
  readonly holders: readonly DumpLockHolder[] | null;
  readonly lockWaitMs: number;
  readonly exitCode: number | null;
  readonly stderr: string;
}): NexaError {
  const relation = input.holders?.[0]?.relation ?? input.relations[0] ?? 'a table';
  const holders =
    input.holders === null
      ? 'The holder could not be observed.'
      : input.holders.length === 0
        ? 'The holder had released it by the time the dump failed.'
        : `Held by ${input.holders.map(holderText).join('; ')}.`;
  return new NexaError({
    kind: 'INTERNAL',
    code: PLATFORM_ERROR_CODES.BACKUP_DUMP_LOCK_TIMEOUT,
    message:
      `pg_dump could not take its ACCESS SHARE lock on ${relation} within ` +
      `${minutes(input.lockWaitMs)}: another session held it exclusively. ${holders}`,
    details: {
      lockRelation: relation,
      lockMode: 'AccessShareLock',
      relations: input.relations,
      holders: input.holders,
      exitCode: input.exitCode,
      stderr: input.stderr.slice(0, 2000),
    },
  });
}
