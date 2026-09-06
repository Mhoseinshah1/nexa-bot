import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
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

  /** The `node -e` one-liner compose runs, for one service. */
  function containerCheck(service: 'worker' | 'monitor'): string {
    const compose = parse(read(join(__dirname, '../../deploy/compose.yml'), 'utf8')) as {
      services: Record<
        string,
        { healthcheck: { test: string[]; interval: string }; command?: string[] }
      >;
    };
    const script = compose.services[service]?.healthcheck.test.at(-1);
    if (script === undefined) throw new Error(`no healthcheck script for ${service}`);
    return script;
  }

  function composeDefaults(): ReturnType<typeof configSchema.parse> {
    return configSchema.parse({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://u:p@h/db',
      REDIS_URL: 'redis://h',
      SECRETS_KEK: Buffer.from('x'.repeat(32)).toString('base64'),
      SECRETS_KEK_ID: 'k',
      AUTH_MODE: 'password',
      DEPLOYMENT_TOPOLOGY: 'direct',
    });
  }

  /**
   * RUNS the container check, the way Docker does.
   *
   * Not a regex over the script. The bug this replaces a regex for was a
   * maximum age written into the one-liner as a literal, which agreed with the
   * DEFAULT interval and with nothing else — and a test that asserted the
   * literal equalled `default * 3` passed against exactly that bug. Executing
   * it with a configured interval is the only check that can tell the two
   * apart.
   */
  function runCheck(
    script: string,
    env: Record<string, string | undefined>,
    heartbeat: string | null,
  ): number {
    if (heartbeat === null) rmSync(path, { force: true });
    else writeFileSync(path, heartbeat);
    const result = spawnSync(process.execPath, ['-e', script], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
    if (result.status === null) throw new Error(`the check did not exit: ${result.stderr}`);
    return result.status;
  }

  describe.each([
    { service: 'worker' as const, pathVar: 'WORKER_HEARTBEAT_PATH' },
    { service: 'monitor' as const, pathVar: 'PANEL_MONITOR_HEARTBEAT_PATH' },
  ])('the $service container check', ({ service, pathVar }) => {
    const at = (ageMs: number) => `${Date.now() - ageMs}\n`;

    it('reads the file the process writes, and only that one', () => {
      const script = containerCheck(service);
      const defaults = composeDefaults();
      const expected =
        service === 'worker'
          ? defaults.WORKER_HEARTBEAT_PATH
          : defaults.PANEL_MONITOR_HEARTBEAT_PATH;
      const other =
        service === 'worker'
          ? defaults.PANEL_MONITOR_HEARTBEAT_PATH
          : defaults.WORKER_HEARTBEAT_PATH;
      // Two roles writing one file would let a healthy worker mask a dead
      // monitor.
      expect(expected).not.toBe(other);
      expect(script).toContain(expected);
      expect(script).not.toContain(other);
    });

    it('accepts a beat inside three of the DEFAULT interval and rejects one outside', () => {
      const script = containerCheck(service);
      const interval = composeDefaults().WORKER_HEARTBEAT_INTERVAL_MS;
      const env = { [pathVar]: path, WORKER_HEARTBEAT_INTERVAL_MS: String(interval) };
      expect(runCheck(script, env, at(interval * 3 - 1_000))).toBe(0);
      expect(runCheck(script, env, at(interval * 3 + 5_000))).toBe(1);
    });

    it('accepts a beat inside three of the LARGEST interval the schema allows', () => {
      // 60s is the schema maximum, and at that setting the check that shipped
      // — a literal 30000 — called a monitor unhealthy between every pair of
      // beats. Docker restarts it, `botctl` reports the release not ready, and
      // nothing is actually wrong with the scheduling.
      const script = containerCheck(service);
      const interval = 60_000;
      expect(configSchema.shape.WORKER_HEARTBEAT_INTERVAL_MS.safeParse(interval).success).toBe(
        true,
      );
      const env = { [pathVar]: path, WORKER_HEARTBEAT_INTERVAL_MS: String(interval) };
      // One interval past the last beat: healthy under any correct derivation,
      // and unhealthy under a fixed 30s.
      expect(runCheck(script, env, at(interval + 1_000))).toBe(0);
      expect(runCheck(script, env, at(interval * 3 - 1_000))).toBe(0);
      expect(runCheck(script, env, at(interval * 3 + 5_000))).toBe(1);
    });

    it('falls back to the schema default when the interval is absent or nonsense', () => {
      const script = containerCheck(service);
      const fallback = composeDefaults().WORKER_HEARTBEAT_INTERVAL_MS;
      for (const value of [undefined, '', 'soon', '0', '-5']) {
        const env = { [pathVar]: path, WORKER_HEARTBEAT_INTERVAL_MS: value };
        expect(runCheck(script, env, at(fallback * 3 - 1_000))).toBe(0);
        expect(runCheck(script, env, at(fallback * 3 + 5_000))).toBe(1);
      }
    });

    it('is unhealthy when the file is missing, empty or not a time', () => {
      const script = containerCheck(service);
      const env = { [pathVar]: path, WORKER_HEARTBEAT_INTERVAL_MS: '10000' };
      expect(runCheck(script, env, null)).toBe(1);
      expect(runCheck(script, env, '')).toBe(1);
      expect(runCheck(script, env, '   \n')).toBe(1);
      expect(runCheck(script, env, 'not a number\n')).toBe(1);
    });
  });

  it('runs the monitor entrypoint from the same image', () => {
    const compose = parse(read(join(__dirname, '../../deploy/compose.yml'), 'utf8')) as {
      services: { monitor: { command: string[]; healthcheck: { interval: string } } };
    };
    // The SAME image, a different entrypoint. A second image would be a second
    // thing to build, publish, pin by digest and roll back.
    expect(compose.services.monitor.command).toEqual(['node', 'dist/main.monitor.js']);
    expect(compose.services.monitor.healthcheck.interval).toBe('10s');
  });
});
