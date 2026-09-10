import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { testConfig } from './harness';

/**
 * What happens to a process when PostgreSQL closes one of its connections.
 *
 * Item M of the hardening audit named this as untested — `pg_terminate_backend`
 * appeared nowhere in the repository — and testing it found a real defect rather
 * than confirming a rule. `pg` delivers a connection death as an `'error'` EVENT,
 * and `EventEmitter` THROWS for an unlistened `'error'`: nothing in this codebase
 * listened, so the death became an uncaught exception and the process died. Past
 * every `try`/`catch`, past the shutdown hooks, past the lease release.
 *
 * Measured before the fix, against a real PostgreSQL 16:
 *
 *   idle client         UNCAUGHT: terminating connection due to administrator command
 *   open transaction    UNCAUGHT: Connection terminated unexpectedly
 *
 * The triggers are ordinary: an operator running `pg_terminate_backend`, a
 * PostgreSQL restart or package upgrade, a failover, an OOM-killed backend. Each
 * would have taken down the API, the worker and the monitor — where the correct
 * behaviour already existed, because readiness reports a database it cannot reach
 * and the load balancer takes the process out of rotation until it can.
 *
 * ## Why a child process
 *
 * The property is "this process is still alive", and no test can assert that
 * about its own runner. Vitest installs an `uncaughtException` handler, reports
 * the error beside a test that may still pass, and carries on — so in-process the
 * defect shows up as a line in the output that a green summary invites you to
 * ignore. An exit code cannot be ignored.
 *
 * `tests/support/terminate-backend-probe.ts` is the child. It exits 9 on an
 * uncaught exception, 8 if a transaction somehow survived its own backend, 7 if
 * the pool could not reconnect afterwards, and 0 only when the death was
 * reported, the work failed cleanly, and a later checkout worked.
 */
describe('a terminated PostgreSQL backend', () => {
  const probe = fileURLToPath(new URL('../support/terminate-backend-probe.ts', import.meta.url));
  const config = testConfig();

  interface Run {
    readonly code: number | null;
    readonly output: string;
  }

  const run = (mode: 'idle' | 'transaction'): Promise<Run> =>
    new Promise((resolve) => {
      // `node_modules/.bin/tsx`, the workspace's own runner. Resolved from this
      // file rather than taken from PATH so the child runs the same TypeScript
      // loader the rest of the repository does.
      const tsx = fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url));
      const child = spawn(tsx, [probe, mode], {
        env: { ...process.env, DATABASE_URL: config.DATABASE_URL },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
      child.on('close', (code) => resolve({ code, output }));
    });

  it('does not kill a process whose IDLE pooled connection is terminated', async () => {
    const { code, output } = await run('idle');
    // The exact failure mode, named, so a non-zero exit for some other reason is
    // not mistaken for this one.
    expect(output).not.toContain('UNCAUGHT');
    expect(output).toContain('REPORTED: terminating connection due to administrator command');
    expect(output).toContain('SURVIVED');
    expect(code).toBe(0);
  }, 60_000);

  it('does not kill a process whose OPEN TRANSACTION loses its backend', async () => {
    /*
     * The harder half, and the one the obvious fix missed. `pg-pool` removes its
     * own error listener for the duration of a checkout, so between acquire and
     * release the client has no listener at all — and `Connection terminated
     * unexpectedly` arrives in that window, before the transaction's `finally`
     * can release. A listener on the POOL alone leaves this case crashing; the
     * listener has to be on the CLIENT, attached on `connect`.
     */
    const { code, output } = await run('transaction');
    expect(output).not.toContain('UNCAUGHT');
    expect(output).not.toContain('NOT REJECTED');
    expect(output).not.toContain('NOT RECOVERED');
    expect(output).toContain('SURVIVED');
    // REPORTED too, and not only survived. `database.ts` says "the one thing they
    // must not be is silent", and without this line that claim is unasserted for
    // this half — `client.on('error', () => {})` would pass the case. The review of
    // this branch found it.
    expect(output).toMatch(/^REPORTED: /m);
    expect(output).not.toContain('SURVIVED reported=0');
    expect(code).toBe(0);
  }, 60_000);
});
