/**
 * Proves, in its own process, that a terminated PostgreSQL backend does not kill
 * the process.
 *
 * A SEPARATE process because the property is "this process is still alive", and
 * nothing inside a test runner can assert that about itself: vitest installs its
 * own `uncaughtException` handler, reports the error beside a test that may still
 * pass, and carries on. The only honest assertion is an exit code.
 *
 * Run by `tests/integration/connection-death.test.ts`, which owns the reasoning.
 * The two modes exercise the two places `pg` delivers such an error:
 *
 *   idle         a client returned to the pool, then killed
 *   transaction  a client killed while a transaction is open on it
 *
 * Prints one line per event so the caller can tell "survived because it was
 * handled" from "survived because nothing happened".
 */
import { createDatabase } from '../../apps/api/src/infrastructure/persistence/database';

const url = process.env.DATABASE_URL;
if (url === undefined || url === '') {
  process.stderr.write('DATABASE_URL is required\n');
  process.exit(2);
}
const mode = process.argv[2];
if (mode !== 'idle' && mode !== 'transaction') {
  process.stderr.write('usage: terminate-backend-probe <idle|transaction>\n');
  process.exit(2);
}

process.on('uncaughtException', (error: Error) => {
  process.stdout.write(`UNCAUGHT: ${error.message}\n`);
  // Deliberately not 1: a non-zero exit for any other reason must not read as
  // "the connection death killed the process".
  process.exit(9);
});

const reported: string[] = [];
const handle = createDatabase(url, 3, undefined, (error) => {
  reported.push(error.message);
  process.stdout.write(`REPORTED: ${error.message}\n`);
});
// The killer needs its OWN connection: a pool whose backend is being terminated
// cannot be the one issuing the terminate.
const killer = createDatabase(url, 1);

const pidOf = async (executor: { execute: (q: never) => Promise<unknown> }): Promise<number> => {
  const { sql } = await import('drizzle-orm');
  const result = (await executor.execute(sql`SELECT pg_backend_pid() AS pid` as never)) as {
    rows: readonly { pid: number }[];
  };
  const pid = result.rows[0]?.pid;
  if (pid === undefined) throw new Error('could not read the backend pid');
  return pid;
};

const kill = async (pid: number): Promise<void> => {
  const { sql } = await import('drizzle-orm');
  await killer.db.execute(sql`SELECT pg_terminate_backend(${pid})`);
};

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 600));

async function main(): Promise<void> {
  const { sql } = await import('drizzle-orm');

  if (mode === 'idle') {
    // One checkout, released, then killed while sitting in the pool.
    const pid = await handle.withClient(async (client) => {
      const result = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      return result.rows[0]!.pid;
    });
    await kill(pid);
    await settle();
  } else {
    let rejected = false;
    await handle.db
      .transaction(async (tx) => {
        const pid = await pidOf(tx as never);
        await kill(pid);
        // The statement that meets the dead socket. Without it the transaction
        // would reach COMMIT and fail there instead, which is a different path.
        await tx.execute(sql`SELECT 1`);
      })
      .catch(() => {
        rejected = true;
      });
    if (!rejected) {
      process.stdout.write('NOT REJECTED: the transaction survived its own backend\n');
      process.exit(8);
    }
    await settle();
  }

  // The pool recovers: a fresh checkout must work, or "survived" would mean
  // "still running with a handle that can no longer be used".
  const recovered = (await handle.db.execute(sql`SELECT 1 AS ok`)) as {
    rows: readonly { ok: number }[];
  };
  if (recovered.rows[0]?.ok !== 1) {
    process.stdout.write('NOT RECOVERED: the pool could not open a new connection\n');
    process.exit(7);
  }

  process.stdout.write(`SURVIVED reported=${reported.length}\n`);
  await handle.pool.end();
  await killer.pool.end();
  process.exit(0);
}

void main();
