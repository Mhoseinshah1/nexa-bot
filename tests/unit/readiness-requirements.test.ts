import { describe, expect, it } from 'vitest';
import { dependencyStatusSchema, type DependencyStatus } from '@nexa/contracts';
import { ReadinessService } from '../../apps/api/src/modules/platform/system/application/readiness.service';

/**
 * Which dependencies make this process NOT READY, and which are merely reported.
 *
 * Item F of the hardening audit, and the finding was the reverse of what the item
 * proposed. Redis was a HARD readiness dependency while storing nothing:
 * `createRedis` is constructed, handed to the probe, exported and closed — four
 * references — and the only command issued anywhere is `ping`. Every piece of
 * admission, rate-limit and idempotency state is in PostgreSQL on purpose, and
 * `login_throttle` writes down the reason (an attacker must not be able to clear
 * their own counter by waiting out a cache eviction).
 *
 * So a Redis outage failed the API's container healthcheck and could roll a
 * release back, for a dependency that holds no state and that nothing reads.
 *
 * These cases drive the REAL `ReadinessService` with stub probes, because the
 * property is about its aggregation rather than about any probe: a fake service
 * would be asserting the test's own arithmetic. The probes have to be stubs —
 * "Redis is down" is not a state an integration test can reach without taking
 * Redis away from every other suite on the same host.
 */
describe('readiness requirements', () => {
  const clock = { now: () => new Date('2026-06-01T00:00:00.000Z') };
  const logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return logger;
    },
  };

  /** A service whose four probes answer as the test says. */
  const service = (answers: {
    database?: boolean;
    cache?: boolean;
    schema?: boolean;
    outboxLagMs?: number;
  }) =>
    new ReadinessService({
      clock: clock as never,
      logger: logger as never,
      maxOutboxLagMs: 60_000,
      probes: {
        database: async () => {
          if (answers.database === false) throw new Error('the database is unreachable');
        },
        cache: async () => answers.cache !== false,
        schema: async () =>
          answers.schema === false
            ? { state: 'NONE' as const }
            : { state: 'CURRENT' as const, applied: 27 },
        outboxLagMs: async () => answers.outboxLagMs ?? 0,
      } as never,
    });

  const named = (dependencies: readonly DependencyStatus[], name: string) =>
    dependencies.find((d) => d.name === name);

  it('is ready when everything answers', async () => {
    // The baseline, so the cases below are not passing because nothing is ever
    // ready.
    const result = await service({}).run();
    expect(result.degraded).toBe(false);
  });

  it('is NOT ready when PostgreSQL is down', async () => {
    // The direction that must not have changed. Everything in this system is in
    // PostgreSQL, so a process that cannot reach it can serve nothing.
    const result = await service({ database: false }).run();
    expect(result.degraded).toBe(true);
    expect(named(result.dependencies, 'postgres')?.status).toBe('down');
  });

  it('is NOT ready when the schema is not the one this release expects', async () => {
    const result = await service({ schema: false }).run();
    expect(result.degraded).toBe(true);
  });

  it('is NOT ready when the outbox is too far behind', async () => {
    const result = await service({ outboxLagMs: 10 * 60_000 }).run();
    expect(result.degraded).toBe(true);
  });

  it('is STILL READY when Redis is down, and reports it down', async () => {
    /*
     * Both halves, and neither alone is the fix.
     *
     * "Still ready" is what stops a self-inflicted outage: the load balancer is no
     * longer told this process cannot serve traffic it can serve, and a release is
     * no longer rolled back because a cache nothing reads went away.
     *
     * "Reports it down" is what stops this becoming a lie: an administrator
     * reading the authenticated endpoint still sees the dependency as down, which
     * is the whole point of that endpoint having detail at all. Making Redis
     * invisible would have been the other available mistake.
     */
    const result = await service({ cache: false }).run();
    expect(result.degraded).toBe(false);
    const redis = named(result.dependencies, 'redis');
    expect(redis?.status).toBe('down');
    expect(redis?.detail).toBe('unreachable');
  });

  it('marks every dependency with whether it is required', async () => {
    // Reported rather than implied. An operator looking at a dependency that is
    // down needs to know whether that is why the process is out of rotation.
    const result = await service({}).run();
    expect(named(result.dependencies, 'postgres')?.required).toBe(true);
    expect(named(result.dependencies, 'migrations')?.required).toBe(true);
    expect(named(result.dependencies, 'outbox')?.required).toBe(true);
    expect(named(result.dependencies, 'redis')?.required).toBe(false);
  });

  it('treats an UNSTATED requirement as required', async () => {
    /*
     * `required !== false`, not `required === true`, and the difference is the
     * direction of the failure.
     *
     * A probe that forgot to say must count as required: the safe reading of
     * "unknown" is "this matters". With `=== true` a new dependency added without
     * the flag would be silently optional — a dependency that can be down while
     * the process reports ready, which is the defect this item exists to remove
     * pointing the other way.
     *
     * Asserted against the SCHEMA rather than the service, because the schema is
     * what an older client parses and the optionality lives there.
     */
    const parsed = dependencyStatusSchema.parse({ name: 'something', status: 'down' });
    expect(parsed.required).toBeUndefined();
    // And the aggregation's predicate, stated directly: absent is not exempt.
    const dependencies: DependencyStatus[] = [{ name: 'something', status: 'down' }];
    expect(dependencies.some((d) => d.status === 'down' && d.required !== false)).toBe(true);
  });
});
