import { Inject, Injectable } from '@nestjs/common';
import type { DependencyStatus } from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { migrationsFolder } from '../../infrastructure/persistence/migrate.js';
import {
  compareMigrations,
  expectedMigrations,
  type ExpectedMigration,
} from '../../infrastructure/persistence/migration-state.js';

/**
 * Whether this process can serve traffic, and why not.
 *
 * One computation, two audiences. The anonymous `/health/ready` reports only
 * the verdict, because the thing asking is a load balancer with no
 * credentials; the authenticated `system/readiness` reports the reasons to an
 * administrator who has signed in.
 *
 * It is a provider rather than a method on either controller because both need
 * it, and a controller injected into a controller is a circular graph waiting
 * to happen — the first attempt at this failed Nest's initialisation outright.
 * Two independent readiness computations would be worse: they would eventually
 * disagree, and the disagreement would be an outage nobody could explain.
 */
@Injectable()
export class ReadinessProbe {
  /**
   * What this release's journal says the schema must contain. Read once: the
   * files do not change while the process runs, and a probe that read the
   * migration folder on every poll would put twenty file reads on a path a
   * load balancer hits every few seconds.
   */
  private expected: readonly ExpectedMigration[] | null = null;

  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  async run(): Promise<{ degraded: boolean; dependencies: DependencyStatus[] }> {
    const dependencies = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
      this.checkMigrations(),
      this.checkOutboxLag(),
    ]);
    return { degraded: dependencies.some((d) => d.status === 'down'), dependencies };
  }

  /**
   * How long any one dependency may take to answer before it counts as down.
   *
   * A readiness endpoint that can hang is not a readiness endpoint. The Redis
   * client is configured with `maxRetriesPerRequest: null`, which means a
   * command issued while the connection is down waits for ever rather than
   * rejecting — correct for a queue, fatal for a probe. `/health/ready` is
   * polled by a load balancer that has no timeout of its own, so the bound has
   * to be here.
   *
   * For the database it is enforced by PostgreSQL, as a `statement_timeout`
   * on the probe's own checkout (see `withClient`). The timer below is the
   * bound for Redis and the backstop for everything else; it is NOT what
   * stops a database query. A `Promise.race` that "wins" against a query
   * leaves that query running on a connection nobody can release, and a
   * probe polled every few seconds against a stalled database fills the pool
   * with exactly those. That was C15.
   */
  static readonly PROBE_TIMEOUT_MS = 3_000;

  /**
   * The timer sits BEHIND the database's own deadline on purpose. When both
   * are due, PostgreSQL cancels the statement first and the probe learns of
   * it as `57014`; the timer then only ever fires for Redis, for a checkout
   * still waiting on the pool, or as the backstop nothing should reach.
   */
  private static readonly BACKSTOP_MS = ReadinessProbe.PROBE_TIMEOUT_MS + 500;

  private async timed(
    name: string,
    probe: (deadlineAt: number) => Promise<{ ok: boolean; detail?: string }>,
  ): Promise<DependencyStatus> {
    const started = Date.now();
    // ONE absolute deadline for everything this probe does, handed to every
    // checkout it makes. A checkout that waits on the pool and is granted a
    // connection late gets only the time that is left, or nothing — so no
    // query starts on behalf of an answer that has already gone out.
    const deadlineAt = started + ReadinessProbe.PROBE_TIMEOUT_MS;
    try {
      const result = await Promise.race([
        probe(deadlineAt),
        new Promise<{ ok: boolean; detail?: string }>((resolve) =>
          setTimeout(
            () => resolve({ ok: false, detail: 'timeout' }),
            ReadinessProbe.BACKSTOP_MS,
          ).unref?.(),
        ),
      ]);
      return {
        name,
        status: result.ok ? 'up' : 'down',
        latencyMs: Date.now() - started,
        ...(result.detail ? { detail: result.detail } : {}),
      };
    } catch (error) {
      // A driver message would carry internal hostnames, ports, database and
      // role names. Even now that this detail only reaches an authenticated
      // administrator, the real message belongs in the log with its
      // correlation id rather than in an HTTP body that may be pasted into a
      // ticket. The response gets a fixed word.
      this.container.logger.error(
        { dependency: name, err: error instanceof Error ? error.stack : String(error) },
        'Readiness probe failed',
      );
      return {
        name,
        status: 'down',
        latencyMs: Date.now() - started,
        detail: classifyProbeFailure(error),
      };
    }
  }

  private checkDatabase(): Promise<DependencyStatus> {
    return this.timed('postgres', async (deadlineAt) => {
      await this.container.database.ping(deadlineAt);
      return { ok: true };
    });
  }

  private checkRedis(): Promise<DependencyStatus> {
    // The Redis handle swallows its own connection errors so a blip degrades
    // readiness rather than crashing the process, which means this probe never
    // throws — it still has to say something when the answer is no.
    return this.timed('redis', async () => {
      const ok = await this.container.redis.ping();
      return ok ? { ok } : { ok, detail: 'unreachable' };
    });
  }

  /**
   * The schema is the one this code was built for — not merely "some schema".
   *
   * Compared by identity against this release's own journal: every expected
   * migration applied, with the content this release ships. A database behind
   * the release (the deployment that starts before its migration finishes, or
   * a migration that died part-way through) is not ready. A database AHEAD of
   * the release — the shape a rollback leaves, because migrations only add —
   * is ready. A history this release cannot account for is not.
   *
   * No application secret is needed to answer this; the query reads the
   * migrations table and nothing else.
   */
  private checkMigrations(): Promise<DependencyStatus> {
    return this.timed('migrations', async (deadlineAt) => {
      this.expected ??= expectedMigrations(migrationsFolder());
      const applied = await this.container.database.appliedMigrations(deadlineAt);
      const verdict = compareMigrations([...applied], this.expected);
      switch (verdict.state) {
        case 'current':
          return { ok: true, detail: `${verdict.applied} applied` };
        case 'ahead':
          return {
            ok: true,
            detail: `${verdict.expected} applied, ${verdict.extra} newer than this release`,
          };
        case 'none':
          return { ok: false, detail: 'no migrations applied' };
        case 'behind':
          return {
            ok: false,
            detail: `behind: ${verdict.applied} of ${verdict.expected} applied, next ${verdict.missing[0]}`,
          };
        case 'diverged':
          return { ok: false, detail: `diverged: ${verdict.reason}` };
      }
    });
  }

  private checkOutboxLag(): Promise<DependencyStatus> {
    return this.timed('outbox', async (deadlineAt) => {
      // On a bounded checkout too. This is the one probe that reads an
      // application table, and a slow table scan here is exactly the query
      // that used to outlive the probe.
      const lag = await this.container.relay.lagMsWithin(deadlineAt);
      const healthy = lag <= this.container.config.OUTBOX_RELAY_MAX_LAG_MS;
      return { ok: healthy, detail: `oldest unpublished ${lag}ms` };
    });
  }
}

/**
 * A closed vocabulary. Enough for an operator to know where to look, not enough
 * to describe the deployment to a stranger.
 */
function classifyProbeFailure(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  // PostgreSQL's own wording for a statement it cancelled at our bound.
  if (message.includes('canceling statement') || message.includes('after its deadline')) {
    return 'timeout';
  }
  if (message.includes('econnrefused') || message.includes('enotfound')) return 'unreachable';
  if (message.includes('etimedout') || message.includes('timeout')) return 'timeout';
  if (message.includes('password') || message.includes('authentication')) return 'auth failed';
  if (message.includes('does not exist')) return 'missing';
  return 'unavailable';
}
