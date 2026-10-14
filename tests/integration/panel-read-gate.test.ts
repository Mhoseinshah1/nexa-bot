import { afterAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import {
  PANEL_READ_LOCK_CLASS,
  PgPanelReadGate,
  panelReadKey,
} from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/panel-read-gate';
import { testConfig } from './harness';

/**
 * The installation-wide panel read gate (owner requirement on PR #281): one migration read of a
 * panel at a time across PROCESSES — each acquire is its own PostgreSQL session, exactly as two
 * worker replicas, the recovery role and the CLI would each hold one.
 */
describe('PgPanelReadGate: one read of a panel at a time, across sessions', () => {
  const { DATABASE_URL } = testConfig();
  const gate = new PgPanelReadGate(DATABASE_URL, { pollMs: 20 });
  const key = panelReadKey('https://panel-gate-test.invalid');
  const held: { release(): Promise<void> }[] = [];
  afterAll(async () => {
    await Promise.all(held.map((x) => x.release()));
  });

  it('a second read of the same panel waits until the first releases; another panel does not wait', async () => {
    const first = await gate.acquire(key);
    held.push(first);
    let secondHeld = false;
    const second = gate.acquire(key).then((lease) => {
      secondHeld = true;
      return lease;
    });
    const other = await gate.acquire(panelReadKey('https://another-panel.invalid'));
    await other.release();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(secondHeld).toBe(false);
    await first.release();
    const lease = await second;
    expect(secondHeld).toBe(true);
    expect(lease.isLost()).toBe(false);
    await lease.release();
  });

  it('a waiter whose job is cancelled gives up: rejects, takes nothing, closes its session', async () => {
    const holder = await gate.acquire(key);
    held.push(holder);
    const job = new AbortController();
    const waiting = gate.acquire(key, job.signal);
    setTimeout(() => {
      job.abort(new Error('lease lost'));
    }, 60);
    await expect(waiting).rejects.toThrow('lease lost');
    await holder.release();
    // Free again: the cancelled waiter did not take it on its way out.
    const after = await gate.acquire(key);
    await after.release();
  });

  it('a holder whose session dies loses the lock to the next waiter (a crashed process blocks nobody)', async () => {
    const holder = await gate.acquire(key);
    held.push(holder);
    const next = gate.acquire(key);
    // Kill the holder's session from outside, as a crash or a dropped connection would.
    const admin = new Client({ connectionString: DATABASE_URL });
    await admin.connect();
    try {
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_locks
          WHERE locktype = 'advisory' AND classid = $1 AND granted
            AND objid = hashtext($2)::oid`,
        [PANEL_READ_LOCK_CLASS, key],
      );
    } finally {
      await admin.end();
    }
    const lease = await next;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(holder.isLost()).toBe(true);
    await lease.release();
  });
});
