import { Pool, type PoolClient } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { applyPgTypeParsers } from './pg-type-parsers.js';
import { schema } from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

/**
 * A handle to either the pool or an open transaction. Repositories accept this
 * so the same method works inside and outside a unit of work — there is no
 * "transactional variant" of a repository to forget to use.
 */
export type Executor = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

export interface ClientOptions {
  /**
   * An absolute time (epoch milliseconds) by which every statement `fn` runs
   * must have finished, enforced by PostgreSQL.
   *
   * This is what makes a bounded probe actually bounded. A `Promise.race`
   * against a timer returns to the caller on time and leaves the losing query
   * running on a connection nobody will release until it finishes — and a
   * readiness endpoint polled every few seconds against a stalled database
   * turns that into a pool full of orphans. Here the remaining time is
   * computed when the connection is ACQUIRED, not when it was asked for, and
   * set as `statement_timeout` for the checkout: a statement that overruns is
   * cancelled by the server, the client sees `57014 query_canceled`, and the
   * connection is back in the pool. A checkout that acquires its connection
   * after the deadline has already passed — it was queued behind others — is
   * released untouched, so work never starts on behalf of a caller that has
   * already answered. `RESET` on release puts the pool's own configured value
   * back for the next borrower.
   */
  readonly deadlineAt?: number;
}

export interface DatabaseHandle {
  readonly db: Database;
  readonly pool: Pool;
  withClient<T>(fn: (client: PoolClient) => Promise<T>, options?: ClientOptions): Promise<T>;
  /**
   * `withClient`, with the checkout wrapped as a query builder.
   *
   * For a caller that has a repository-style read to run under a deadline —
   * the readiness probe's outbox-lag query — and must not construct a drizzle
   * instance itself, because database access belongs in this adapter and
   * nowhere else.
   */
  withExecutor<T>(fn: (executor: Database) => Promise<T>, options?: ClientOptions): Promise<T>;
  /**
   * Round-trips to PostgreSQL under a deadline. Answers "is it there", nothing else.
   *
   * Named here so the readiness probe does not have to hold a statement. A
   * surface holding SQL is the thing `check-boundaries.sh` exists to refuse,
   * and it could not see this one: the probe reached the pool through the
   * container rather than by importing `pg`, so the check passed vacuously on
   * the one file that broke the rule it was reporting.
   */
  ping(deadlineAt: number): Promise<void>;
  /**
   * The applied migration ledger, oldest first, under a deadline.
   *
   * The readiness probe compares this against the journal THIS release ships,
   * which is a persistence question asked by a surface. The comparison stays in
   * the probe; the statement lives here.
   */
  appliedMigrations(deadlineAt: number): Promise<readonly { hash: string; createdAt: number }[]>;
  close(): Promise<void>;
}

/**
 * Server-side bounds on how long a connection may wait or work.
 *
 * This branch made the tenant row the serialization boundary: every
 * administrator mutation takes `FOR UPDATE` on it, every login and every
 * webhook write takes `FOR SHARE`, and the API takes it again at boot to sync
 * roles. That is right, and it concentrated the whole installation onto one
 * row — measured, a burst of 16 mutations puts every concurrent login behind
 * them, from ~43ms to ~263ms.
 *
 * Waiting is fine. Waiting FOREVER is not, and Postgres defaults all three of
 * these to 0, which means exactly that: one transaction that stalls while
 * holding the tenant row blocks every login for that installation with no
 * error and no bound, until the pool fills with waiters and the API stops
 * serving anything at all. A bounded wait fails one request loudly instead.
 *
 * `idle_in_transaction_session_timeout` is the one that matters most here,
 * because the dangerous case is not a slow query — it is application code that
 * opened a transaction, took the lock, and then stalled.
 *
 * Deliberately NOT applied to migrations, which open their own handle: a long
 * index build is not a stuck transaction, and killing one halfway is worse
 * than waiting for it.
 */
export interface DatabaseTimeouts {
  /** Cap on a single statement. */
  readonly statementTimeoutMs: number;
  /** Cap on waiting for a lock. Shorter: waiting this long is already wrong. */
  readonly lockTimeoutMs: number;
  /** Cap on a transaction held open while the application does nothing. */
  readonly idleInTransactionTimeoutMs: number;
}

/**
 * What to do when a pooled connection dies on its own.
 *
 * **Attaching this is not optional**, and the reason is that `pg` turns an
 * unhandled `'error'` event into an UNCAUGHT EXCEPTION. `EventEmitter` throws for
 * an unlistened `'error'`, so the process dies — past every `try`/`catch`, past
 * the shutdown hooks, past the lease release.
 *
 * The triggers are ordinary operations, not exotic ones: an operator running
 * `pg_terminate_backend`, a PostgreSQL restart or package upgrade, a failover, an
 * OOM-killed backend. Every one of them used to take down the API, the worker and
 * the monitor rather than leaving them to report NOT READY and reconnect — which
 * readiness already does, correctly, for a database it cannot reach. `createDatabase`
 * attaches this in both places `pg` can deliver such an error; see there.
 */
export type PoolErrorListener = (error: Error) => void;

export function createDatabase(
  connectionString: string,
  poolMax: number,
  timeouts?: DatabaseTimeouts,
  onPoolError?: PoolErrorListener,
): DatabaseHandle {
  applyPgTypeParsers();

  const pool = new Pool({
    connectionString,
    max: poolMax,
    // Set as connection options rather than a `SET` per checkout: it costs no
    // round trip and cannot be skipped by a code path that forgot to run it.
    ...(timeouts
      ? {
          options: [
            `-c statement_timeout=${timeouts.statementTimeoutMs}`,
            `-c lock_timeout=${timeouts.lockTimeoutMs}`,
            `-c idle_in_transaction_session_timeout=${timeouts.idleInTransactionTimeoutMs}`,
          ].join(' '),
        }
      : {}),
  });
  const report =
    onPoolError ??
    ((error: Error) => {
      // The default writes one line to stderr: the short-lived CLIs that build a
      // handle of their own have no logger, and a connection death that printed
      // nothing would leave an operator reading "the migration just stopped".
      process.stderr.write(
        `a pooled PostgreSQL connection was closed by the server: ${error.message}\n`,
      );
    });

  /*
   * TWO listeners, because a terminated backend is delivered to two different
   * places depending on whether its client was in use — and only one of them was
   * covered by the obvious fix.
   *
   * An IDLE client: `pg-pool` holds its own `'error'` listener, which removes the
   * client and re-emits on the pool. So the pool needs a listener.
   *
   * A CHECKED-OUT client: `pg-pool` removes that listener for the duration of the
   * checkout, so between acquire and release the client has NO error listener of
   * its own — and `Connection terminated unexpectedly` arrives in that window,
   * before the transaction's `finally` gets to release. So the CLIENT needs a
   * listener, for its whole life, attached on `connect` before it is ever handed
   * out.
   *
   * Measured, against a real PostgreSQL 16, with `pg_terminate_backend` from a
   * second connection: with neither, both cases exit the process
   * (`UNCAUGHT: terminating connection due to administrator command` idle,
   * `UNCAUGHT: Connection terminated unexpectedly` in a transaction). With only
   * the pool listener the idle case survives and the in-transaction case still
   * exits. With both, both survive, the in-flight query rejects, the transaction
   * rolls back because it never committed, and the next checkout reconnects.
   *
   * Neither retries or reconnects: the pool has already discarded the broken
   * client. The one thing they must not be is silent.
   */
  /*
   * De-duplicated by error IDENTITY, because an idle client's death reaches both
   * listeners: the client emits, our listener runs, `pg-pool`'s own idle listener
   * then re-emits THE SAME Error on the pool. Without this a PostgreSQL restart
   * logs two lines per connection — `2 × poolMax` — and an operator counting them
   * reads twice the damage.
   *
   * A `WeakSet` rather than a flag or a counter: the same object arriving twice is
   * exactly what is being detected, and holding the errors weakly means a long-lived
   * pool does not accumulate them.
   */
  const alreadyReported = new WeakSet<Error>();
  const reportOnce = (error: Error): void => {
    if (alreadyReported.has(error)) return;
    alreadyReported.add(error);
    report(error);
  };
  pool.on('error', reportOnce);
  pool.on('connect', (client) => {
    client.on('error', reportOnce);
  });
  const db = drizzle(pool, { schema });

  return {
    db,
    pool,
    async withClient(fn, options) {
      const client = await pool.connect();
      const deadline = options?.deadlineAt;
      let bounded: number | undefined;
      if (deadline !== undefined) {
        bounded = Math.floor(deadline - Date.now());
        if (bounded <= 0) {
          client.release();
          throw new Error('the checkout was acquired after its deadline had passed');
        }
      }
      // Released with `true` — destroyed rather than returned — if the
      // session's timeout could not be put back. A connection whose
      // statement_timeout is silently three seconds would fail the next
      // borrower's ordinary work in a way nothing would explain.
      let destroy = false;
      try {
        if (bounded !== undefined) {
          // Interpolated as an integer, never as a parameter: `SET` takes no
          // bind parameters, and the value is an integer this code computed
          // rather than anything a caller supplied.
          await client.query(`SET statement_timeout = ${bounded}`);
        }
        return await fn(client);
      } finally {
        if (bounded !== undefined) {
          try {
            await client.query('RESET statement_timeout');
          } catch {
            destroy = true;
          }
        }
        client.release(destroy);
      }
    },
    withExecutor(fn, options) {
      return this.withClient((client) => fn(drizzle(client, { schema })), options);
    },
    async ping(deadlineAt) {
      await this.withClient((client) => client.query('SELECT 1'), { deadlineAt });
    },
    async appliedMigrations(deadlineAt) {
      const result = await this.withClient(
        (client) =>
          client.query<{ hash: string; created_at: string }>(
            `SELECT hash, created_at::text AS created_at
               FROM drizzle.__drizzle_migrations
              ORDER BY created_at ASC`,
          ),
        { deadlineAt },
      );
      return result.rows.map((row) => ({ hash: row.hash, createdAt: Number(row.created_at) }));
    },
    async close() {
      await pool.end();
    },
  };
}

export const DATABASE = Symbol('DATABASE');
