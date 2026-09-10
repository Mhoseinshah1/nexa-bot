import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isNexaError, MAX_REQUESTS_PER_PROBE, PROVIDER_DESCRIPTORS } from '@nexa/contracts';
import { loadConfig } from '../../apps/api/src/infrastructure/config/load-config';
import {
  effectiveProbeCooldownMs,
  healthyCadenceOutlastsCooldown,
} from '../../apps/api/src/modules/platform/panels/domain/monitor-cadence';

/** The smallest environment this schema accepts, so a case varies one thing. */
const baseEnv = (): NodeJS.ProcessEnv => ({
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  SECRETS_KEK: Buffer.alloc(32, 7).toString('base64'),
  SECRETS_KEK_ID: 'dev-1',
  TRUSTED_PROXY_IPS: '127.0.0.1,::1',
});

/**
 * The per-panel probe cooldown must outlast a probe.
 *
 * The cooldown exists so a second probe cannot start while the first is still
 * on the wire. It was floored on `timeout * (1 + retries)` — ONE request's
 * budget — because `SafeHttpClient` starts its deadline per request and a probe
 * was assumed to be one request.
 *
 * It is not. Marzban's probe is a token exchange and a status read. 3X-UI's
 * session probe is a CSRF token, a two-factor pre-check, a login and a status
 * read. At the shipped defaults that made the floor ten seconds while a session
 * probe could occupy forty, so a second probe of the same panel could be granted
 * while the first login sequence was still running — against a panel that counts
 * failed logins per address and username. The cooldown's whole purpose is to
 * avoid locking an operator out of their own panel on Nexa's behalf, and it was
 * understating the work it bounded by a factor of four.
 */
describe('the probe cooldown floor', () => {
  it('covers the longest probe any registered provider can make', () => {
    // Derived, not restated. A hand-written constant here would be a second
    // copy that a new adapter silently falsifies.
    const worst = Math.max(...PROVIDER_DESCRIPTORS.map((d) => d.maxRequestsPerProbe));
    expect(MAX_REQUESTS_PER_PROBE).toBe(worst);
  });

  it('counts more than one request, which is the whole point', () => {
    // The bug was a floor of exactly one request's budget. If this ever returns
    // to 1 — because a descriptor lost its count, or the derivation broke — the
    // race is open again and silently so.
    expect(MAX_REQUESTS_PER_PROBE).toBeGreaterThan(1);
  });

  /**
   * Each declared count, with the path that justifies it.
   *
   * `sends` is the number of `http.send(` CALL SITES in the adapter, which is
   * an upper bound rather than the answer: Sanaei has five because its bearer
   * mode and its session mode each end in a status read, and those are
   * alternatives rather than additions. Its longest path is four. Recording
   * both numbers is the point — a reader comparing a declared 4 against a
   * grep that says 5 would otherwise conclude one of them is wrong.
   */
  const EXPECTED: Readonly<Record<string, { longestPath: number; sends: number; file: string }>> = {
    marzban: {
      longestPath: 2,
      sends: 2,
      file: 'apps/api/src/modules/platform/providers/infrastructure/marzban.adapter.ts',
    },
    sanaei: {
      longestPath: 4,
      sends: 5,
      file: 'apps/api/src/modules/platform/providers/infrastructure/sanaei.adapter.ts',
    },
  };

  it('declares, for every provider, the length of its longest probe path', () => {
    for (const descriptor of PROVIDER_DESCRIPTORS) {
      const expected = EXPECTED[descriptor.key];
      expect(expected, `${descriptor.key} has no row in this test`).toBeDefined();
      expect(descriptor.maxRequestsPerProbe).toBe(expected?.longestPath);
    }
    // Both directions, so a provider added without a row fails rather than
    // being skipped — the failure mode this repository keeps finding.
    expect(Object.keys(EXPECTED).sort()).toEqual(PROVIDER_DESCRIPTORS.map((d) => d.key).sort());
  });

  it('never declares more requests than the adapter has call sites', () => {
    // Read from the SOURCE, because the declared number is arithmetic only the
    // adapter's flow justifies, and an adapter that grows a request without
    // raising its count reopens the race with nothing to object. A count above
    // the call-site total cannot be right either — it would be a longer
    // cooldown bought with a number nothing supports.
    for (const descriptor of PROVIDER_DESCRIPTORS) {
      const expected = EXPECTED[descriptor.key];
      if (expected === undefined) continue;
      const source = readFileSync(join(__dirname, '../..', expected.file), 'utf8');
      const sends = [...source.matchAll(/http\.send\(/g)].length;
      expect(sends, `${descriptor.key}'s call-site count changed`).toBe(expected.sends);
      expect(descriptor.maxRequestsPerProbe).toBeLessThanOrEqual(sends);
    }
  });
});

/**
 * The cooldown floor and the configured cadence have to be compatible.
 *
 * Review finding 11 of this branch, and a gap the branch itself opened: the floor
 * used to be `timeout × (1 + retries)`, and item E-2 multiplied it by the longest
 * probe any registered provider makes. At `PANEL_HTTP_TIMEOUT_MS=120000` that is
 * 480s against a default healthy interval of 180s, and nothing refused it.
 *
 * A cooldown longer than the interval is not a slow monitor; it is a monitor that
 * does not run. The scheduler finds every panel due, the per-panel claim refuses
 * every attempt as a cooldown, and the configured cadence is silently not honoured
 * while the process reports itself healthy.
 */
describe('the cooldown floor against the configured cadence', () => {
  it('is ONE expression, shared by the container and the schema', () => {
    /*
     * Both callers pass the same four terms. The reason this matters is that the
     * schema's job is to refuse a configuration the container will then obey
     * differently — so a floor computed in two places is a floor that disagrees with
     * itself the first time either side gains a term, which is exactly what happened
     * when `MAX_REQUESTS_PER_PROBE` was added.
     */
    expect(
      effectiveProbeCooldownMs({
        configuredMs: 1_000,
        timeoutMs: 10_000,
        retries: 0,
        requestsPerProbe: 4,
      }),
    ).toBe(40_000);
    // The configured value wins when it is the larger of the two: the floor is a
    // floor, not an override.
    expect(
      effectiveProbeCooldownMs({
        configuredMs: 90_000,
        timeoutMs: 10_000,
        retries: 0,
        requestsPerProbe: 4,
      }),
    ).toBe(90_000);
    // And retries are a term rather than an assumed zero.
    expect(
      effectiveProbeCooldownMs({
        configuredMs: 0,
        timeoutMs: 10_000,
        retries: 1,
        requestsPerProbe: 4,
      }),
    ).toBe(80_000);
  });

  it('refuses a healthy interval the cooldown cannot honour', () => {
    // The real combination: the documented timeout ceiling against the default
    // interval. Both are values an operator may set, and together they are a
    // monitor that never probes.
    expect(healthyCadenceOutlastsCooldown(180_000, 480_000)).toBe(false);
    // Equal is allowed: one probe per interval is the cadence being honoured
    // exactly, which is the boundary and not a failure.
    expect(healthyCadenceOutlastsCooldown(480_000, 480_000)).toBe(true);
    expect(healthyCadenceOutlastsCooldown(480_001, 480_000)).toBe(true);
  });

  it('is applied by the config schema, not only available to it', () => {
    /*
     * The check itself can be right and unreachable. This drives the REAL schema
     * with a configuration whose only problem is this one, so the assertion is that
     * the refusal is wired — and it names the field, because an operator reading
     * "something is wrong" has nowhere to go.
     */
    let refusal = '';
    try {
      loadConfig({
        ...baseEnv(),
        PANEL_HTTP_TIMEOUT_MS: '120000',
        PANEL_MONITOR_HEALTHY_INTERVAL_MS: '180000',
      });
    } catch (error) {
      refusal = isNexaError(error) ? JSON.stringify(error.details) : String(error);
    }
    expect(refusal).toMatch(/PANEL_MONITOR_HEALTHY_INTERVAL_MS/);
    expect(refusal).toMatch(/cooldown/);

    // And the same timeout with a long enough interval is accepted, so this is not
    // "every configuration is refused". The freshness window has to move with the
    // interval, which is check 1 doing its own job.
    expect(() =>
      loadConfig({
        ...baseEnv(),
        PANEL_HTTP_TIMEOUT_MS: '120000',
        PANEL_MONITOR_HEALTHY_INTERVAL_MS: '600000',
        PANEL_HEALTH_FRESH_FOR_MS: '1800000',
        PANEL_MONITOR_TICK_MS: '30000',
      }),
    ).not.toThrow();
  });
});

/**
 * `PANEL_HTTP_RETRIES` is declared in two files, and must not drift.
 *
 * The schema has to refuse a cadence the cooldown cannot honour, and it cannot
 * import the container. So the constant exists in both, and a divergence would
 * make the schema accept a configuration the container then obeys differently —
 * precisely the two-places problem `effectiveProbeCooldownMs` exists to remove,
 * reappearing in one of its arguments.
 *
 * Read from the SOURCE, because the container does not export it and the property
 * is about what the files say.
 */
describe('the retry count the cooldown is computed from', () => {
  it('agrees between the container and the config schema', () => {
    const read = (path: string): string => {
      const source = readFileSync(join(__dirname, '../..', path), 'utf8');
      const match = /^const PANEL_HTTP_RETRIES = (\d+);$/m.exec(source);
      if (match === null) throw new Error(`${path} no longer declares PANEL_HTTP_RETRIES`);
      return match[1] ?? '';
    };
    const container = read('apps/api/src/container.ts');
    const schema = read('apps/api/src/infrastructure/config/config.schema.ts');
    // The guard on the guard: a regex that stopped matching would make this pass
    // by comparing two empty strings, so the value is asserted to be a number.
    expect(container).toMatch(/^\d+$/);
    expect(schema).toBe(container);
  });
});
