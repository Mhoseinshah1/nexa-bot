import { Inject, Injectable } from '@nestjs/common';
import type { DependencyStatus } from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';

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
   */
  private static readonly PROBE_TIMEOUT_MS = 3_000;

  private async timed(
    name: string,
    probe: () => Promise<{ ok: boolean; detail?: string }>,
  ): Promise<DependencyStatus> {
    const started = Date.now();
    try {
      const result = await Promise.race([
        probe(),
        new Promise<{ ok: boolean; detail?: string }>((resolve) =>
          setTimeout(
            () => resolve({ ok: false, detail: 'timeout' }),
            ReadinessProbe.PROBE_TIMEOUT_MS,
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
    return this.timed('postgres', async () => {
      await this.container.database.withClient((client) => client.query('SELECT 1'));
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
   * A process running against a schema older than its code is not ready. This
   * catches the deployment that starts before its migration finishes.
   */
  private checkMigrations(): Promise<DependencyStatus> {
    return this.timed('migrations', async () => {
      const result = await this.container.database.withClient((client) =>
        client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations`,
        ),
      );
      const applied = Number(result.rows[0]?.count ?? '0');
      return applied > 0
        ? { ok: true, detail: `${applied} applied` }
        : { ok: false, detail: 'no migrations applied' };
    });
  }

  private checkOutboxLag(): Promise<DependencyStatus> {
    return this.timed('outbox', async () => {
      const lag = await this.container.relay.lagMs();
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
  if (message.includes('econnrefused') || message.includes('enotfound')) return 'unreachable';
  if (message.includes('etimedout') || message.includes('timeout')) return 'timeout';
  if (message.includes('password') || message.includes('authentication')) return 'auth failed';
  if (message.includes('does not exist')) return 'missing';
  return 'unavailable';
}
