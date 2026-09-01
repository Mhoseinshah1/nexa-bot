import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  HEALTH_ROUTES,
  type DependencyStatus,
  type HealthInfoResponse,
  type HealthLiveResponse,
  type HealthReadyResponse,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';

/**
 * Health.
 *
 * Liveness and readiness are genuinely different questions and this controller
 * keeps them apart. Liveness answers "is this process alive" and deliberately
 * says nothing about dependencies — reporting a dead database as "not live"
 * makes an orchestrator restart a healthy process and lose in-flight work.
 * Readiness answers "can this process serve traffic" and names what is broken.
 */
@Controller()
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(HEALTH_ROUTES.live)
  live(): HealthLiveResponse {
    return {
      status: 'ok',
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  @Get(HEALTH_ROUTES.ready)
  async ready(@Res({ passthrough: true }) reply: FastifyReply): Promise<HealthReadyResponse> {
    const dependencies = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
      this.checkMigrations(),
      this.checkOutboxLag(),
    ]);

    const degraded = dependencies.some((d) => d.status === 'down');
    reply.status(degraded ? 503 : 200);
    return { status: degraded ? 'degraded' : 'ok', dependencies };
  }

  @Get(HEALTH_ROUTES.info)
  info(): HealthInfoResponse {
    return {
      name: 'nexa-bot',
      version: this.container.config.BUILD_VERSION,
      commit: this.container.config.BUILD_COMMIT,
      buildTime: this.container.config.BUILD_TIME,
      nodeVersion: process.version,
      environment: this.container.config.NODE_ENV,
    };
  }

  private async timed(
    name: string,
    probe: () => Promise<{ ok: boolean; detail?: string }>,
  ): Promise<DependencyStatus> {
    const started = Date.now();
    try {
      const result = await probe();
      return {
        name,
        status: result.ok ? 'up' : 'down',
        latencyMs: Date.now() - started,
        ...(result.detail ? { detail: result.detail } : {}),
      };
    } catch (error) {
      // Readiness is unauthenticated. A driver message here would hand an
      // anonymous caller internal hostnames, ports, database and role names —
      // precisely when the system is broken. The real message goes to the log
      // with the correlation id; the response gets a fixed word.
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
