import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startHeartbeat } from '../../apps/api/src/infrastructure/lifecycle/heartbeat';
import { LIVENESS_WATCHDOG_THREAD_SOURCE } from '../../apps/api/src/infrastructure/lifecycle/liveness-watchdog';
import { configSchema } from '../../apps/api/src/infrastructure/config/config.schema';

/**
 * R12 F2 item 3: a role that is alive but no longer working leaves, so Docker restarts it.
 *
 * `restart: unless-stopped` restarts a container whose process exits and never one that is
 * merely unhealthy, so before this a hung worker, monitor or provisioner stayed hung with a
 * stale heartbeat file until an operator noticed.
 */
const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return logger;
  },
} as never;

const never = () => new Promise<boolean>(() => undefined);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('the liveness watchdog', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexa-liveness-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits(1) a role whose loop got stuck after N missed beats', async () => {
    let beats = 0;
    const exits: number[] = [];
    let exited: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      exited = resolve;
    });
    const started = Date.now();
    const heartbeat = startHeartbeat({
      path: join(dir, 'hb'),
      intervalMs: 40,
      now: () => Date.now(),
      logger,
      exitAfterMissed: 3,
      role: 'worker',
      exit: (code) => {
        exits.push(code);
        exited();
      },
      // Healthy once, then a check that never returns: the shape of a loop wedged on a lock.
      check: () => {
        beats += 1;
        return beats === 1 ? Promise.resolve(true) : never();
      },
    });
    try {
      await Promise.race([done, wait(3_000)]);
      expect(exits).toEqual([1]);
      // Not before the three intervals of silence it is allowed.
      expect(Date.now() - started).toBeGreaterThanOrEqual(120);
      expect(readFileSync(join(dir, 'hb'), 'utf8').trim()).not.toBe('');
    } finally {
      heartbeat.stop();
    }
  });

  it('exits a role whose checks keep failing, and not one that keeps succeeding', async () => {
    let healthy = true;
    const exits: number[] = [];
    const failing = startHeartbeat({
      path: join(dir, 'a'),
      intervalMs: 30,
      now: () => Date.now(),
      logger,
      exitAfterMissed: 3,
      exit: (code) => exits.push(code),
      check: async () => {
        const answer = healthy;
        healthy = false;
        return answer;
      },
    });
    const fine: number[] = [];
    const working = startHeartbeat({
      path: join(dir, 'b'),
      intervalMs: 30,
      now: () => Date.now(),
      logger,
      exitAfterMissed: 3,
      exit: (code) => fine.push(code),
      check: async () => true,
    });
    try {
      await wait(600);
      expect(exits.length).toBeGreaterThanOrEqual(1);
      expect(exits[0]).toBe(1);
      expect(fine).toEqual([]);
    } finally {
      failing.stop();
      working.stop();
    }
  });

  it('is not armed before the first healthy beat, is off at zero, and stop() disarms it', async () => {
    const exits: number[] = [];
    const neverHealthy = startHeartbeat({
      path: join(dir, 'c'),
      intervalMs: 20,
      now: () => Date.now(),
      logger,
      exitAfterMissed: 2,
      exit: (code) => exits.push(code),
      check: async () => false,
    });
    let first = true;
    const off = startHeartbeat({
      path: join(dir, 'd'),
      intervalMs: 20,
      now: () => Date.now(),
      logger,
      exitAfterMissed: 0,
      exit: (code) => exits.push(code),
      check: () => {
        const answer = first;
        first = false;
        return answer ? Promise.resolve(true) : never();
      },
    });
    let once = true;
    const stopped = startHeartbeat({
      path: join(dir, 'e'),
      intervalMs: 20,
      now: () => Date.now(),
      logger,
      exitAfterMissed: 2,
      exit: (code) => exits.push(code),
      check: () => {
        const answer = once;
        once = false;
        return answer ? Promise.resolve(true) : never();
      },
    });
    await wait(10);
    // A role shutting down stops its heartbeat first and must not be killed for going quiet.
    stopped.stop();
    try {
      await wait(400);
      expect(exits).toEqual([]);
    } finally {
      neverHealthy.stop();
      off.stop();
    }
  });

  it('KILLS a process whose main thread is blocked and cannot act on the request', async () => {
    // A real child process whose event loop is blocked by a synchronous loop: no timer of
    // its own can ever fire again, so only the thread can end it.
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
        const { Worker } = require('node:worker_threads');
        const shared = new SharedArrayBuffer(16);
        const stamp = new BigInt64Array(shared);
        const worker = new Worker(process.env.WATCHDOG_SOURCE, {
          eval: true,
          workerData: { shared, role: 'test', maxSilenceMs: 150, graceMs: 150, checkEveryMs: 20 },
        });
        worker.unref();
        // Held open until the thread is up; production's unref'd thread runs beside a role
        // that has plenty of its own handles.
        const keepAlive = setTimeout(() => undefined, 60000);
        Atomics.store(stamp, 0, process.hrtime.bigint());
        worker.on('online', () => {
          process.stdout.write('blocking\\n');
          for (;;) {}
        });
        `,
      ],
      { env: { ...process.env, WATCHDOG_SOURCE: LIVENESS_WATCHDOG_THREAD_SOURCE }, stdio: 'pipe' },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const outcome = await Promise.race([
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
        child.on('exit', (code, signal) => resolve({ code, signal })),
      ),
      wait(10_000).then(() => null),
    ]);
    if (outcome === null) child.kill('SIGKILL');
    expect(outcome).toEqual({ code: null, signal: 'SIGKILL' });
    expect(stderr).toContain('liveness watchdog');
  });

  it('defaults to three missed beats, on every role but recovery', () => {
    expect(configSchema.shape.HEARTBEAT_EXIT_AFTER_MISSED.parse(undefined)).toBe(3);
    for (const role of ['worker', 'monitor', 'provisioner', 'assistant', 'migration']) {
      const source = readFileSync(`apps/api/src/main.${role}.ts`, 'utf8');
      expect(source, role).toContain('exitAfterMissed: config.HEARTBEAT_EXIT_AFTER_MISSED');
    }
    expect(readFileSync('apps/api/src/main.ts', 'utf8')).toContain('startLivenessWatchdog({');
    // The restore's cutover has no safe point between its two renames.
    expect(readFileSync('apps/api/src/main.recovery.ts', 'utf8')).not.toContain(
      'exitAfterMissed: config',
    );
  });
});
