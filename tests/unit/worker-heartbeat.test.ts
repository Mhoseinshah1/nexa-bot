import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { readFileSync as read } from 'node:fs';
import {
  heartbeatIsFresh,
  startHeartbeat,
} from '../../apps/api/src/infrastructure/lifecycle/heartbeat';
import { configSchema } from '../../apps/api/src/infrastructure/config/config.schema';

/**
 * The worker's heartbeat (C8): the file the container health check reads.
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

describe('the worker heartbeat', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexa-heartbeat-'));
    path = join(dir, 'worker.heartbeat');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the time only after the check succeeds', async () => {
    let now = 1_000_000;
    let healthy = true;
    const heartbeat = startHeartbeat({
      path,
      intervalMs: 60_000,
      now: () => now,
      logger,
      check: async () => healthy,
    });
    try {
      expect(await heartbeat.beat()).toBe(true);
      expect(readFileSync(path, 'utf8').trim()).toBe('1000000');

      // The database goes away: the file is NOT refreshed, so it ages.
      healthy = false;
      now = 2_000_000;
      expect(await heartbeat.beat()).toBe(false);
      expect(readFileSync(path, 'utf8').trim()).toBe('1000000');

      // A check that throws counts as unhealthy, never as a crash of the loop.
      const throwing = startHeartbeat({
        path: join(dir, 'other'),
        intervalMs: 60_000,
        now: () => now,
        logger,
        check: async () => {
          throw new Error('boom');
        },
      });
      try {
        expect(await throwing.beat()).toBe(false);
      } finally {
        throwing.stop();
      }
    } finally {
      heartbeat.stop();
    }
  });

  it('writes nothing once stopped, so a draining worker is not reported alive', async () => {
    const heartbeat = startHeartbeat({
      path,
      intervalMs: 60_000,
      now: () => 5,
      logger,
      check: async () => true,
    });
    await heartbeat.beat();
    heartbeat.stop();
    rmSync(path);
    expect(await heartbeat.beat()).toBe(false);
    expect(() => readFileSync(path)).toThrow();
  });

  it('reads freshness as the container check does', () => {
    expect(heartbeatIsFresh('1000\n', 1000 + 30_000, 30_000)).toBe(true);
    expect(heartbeatIsFresh('1000\n', 1000 + 30_001, 30_000)).toBe(false);
    expect(heartbeatIsFresh('', 1000, 30_000)).toBe(false);
    expect(heartbeatIsFresh('not a number', 1000, 30_000)).toBe(false);
  });

  it('agrees with the compose health check on the path and the age', () => {
    // The container check is a `node -e` one-liner in compose.yml with the
    // path and the maximum age written into it. It must read the file the
    // worker writes, and the age must leave room for the interval: three
    // intervals, so one slow check does not flap the container.
    const compose = parse(read(join(__dirname, '../../deploy/compose.yml'), 'utf8')) as {
      services: { worker: { healthcheck: { test: string[]; interval: string } } };
    };
    const check = compose.services.worker.healthcheck;
    const script = check.test.at(-1) ?? '';
    const defaults = configSchema.parse({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://u:p@h/db',
      REDIS_URL: 'redis://h',
      SECRETS_KEK: Buffer.from('x'.repeat(32)).toString('base64'),
      SECRETS_KEK_ID: 'k',
      AUTH_MODE: 'password',
      DEPLOYMENT_TOPOLOGY: 'direct',
    });
    expect(script).toContain(defaults.WORKER_HEARTBEAT_PATH);
    const age = /<=(\d+)\?0:1/.exec(script)?.[1];
    expect(age).toBeDefined();
    expect(Number(age)).toBe(defaults.WORKER_HEARTBEAT_INTERVAL_MS * 3);
    expect(check.interval).toBe('10s');
  });

  it('pins the monitor container check to the path and age the monitor writes', () => {
    // The same pin for the third process role. Its heartbeat path is its own
    // — two roles writing one file would let a healthy worker mask a dead
    // monitor — and it is asserted to DIFFER from the worker's for exactly
    // that reason.
    const compose = parse(read(join(__dirname, '../../deploy/compose.yml'), 'utf8')) as {
      services: {
        monitor: { healthcheck: { test: string[]; interval: string }; command: string[] };
      };
    };
    const service = compose.services.monitor;
    // The SAME image, a different entrypoint. A second image would be a second
    // thing to build, publish, pin by digest and roll back.
    expect(service.command).toEqual(['node', 'dist/main.monitor.js']);

    const script = service.healthcheck.test.at(-1) ?? '';
    const defaults = configSchema.parse({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://u:p@h/db',
      REDIS_URL: 'redis://h',
      SECRETS_KEK: Buffer.from('x'.repeat(32)).toString('base64'),
      SECRETS_KEK_ID: 'k',
      AUTH_MODE: 'password',
      DEPLOYMENT_TOPOLOGY: 'direct',
    });
    expect(defaults.PANEL_MONITOR_HEARTBEAT_PATH).not.toBe(defaults.WORKER_HEARTBEAT_PATH);
    expect(script).toContain(defaults.PANEL_MONITOR_HEARTBEAT_PATH);
    expect(script).not.toContain(defaults.WORKER_HEARTBEAT_PATH);
    const age = /<=(\d+)\?0:1/.exec(script)?.[1];
    expect(Number(age)).toBe(defaults.WORKER_HEARTBEAT_INTERVAL_MS * 3);
    expect(service.healthcheck.interval).toBe('10s');
  });
});
