import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  HEALTH_ROUTES,
  type HealthInfoResponse,
  type HealthLiveResponse,
  type HealthReadyResponse,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { requireSessionToken } from './authenticated-request.js';
import { ReadinessProbe } from './readiness.probe.js';

/**
 * Health.
 *
 * Liveness and readiness are genuinely different questions and this controller
 * keeps them apart. Liveness answers "is this process alive" and deliberately
 * says nothing about dependencies — reporting a dead database as "not live"
 * makes an orchestrator restart a healthy process and lose in-flight work.
 * Readiness answers "can this process serve traffic", as a status code.
 *
 * Who may ask is the other axis, and it was wrong. `live` and `ready` are
 * anonymous because the caller is an orchestrator with no credentials; `info`
 * is not, because nothing without a session needs the build's identity. And
 * readiness now answers with a word rather than a description of the
 * deployment. The reasons are served to a signed-in administrator by
 * `ControlController.systemReadiness`, which shares this controller's
 * `ReadinessProbe` so there is one readiness computation rather than two that
 * can disagree.
 */
@Controller()
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(
    @Inject(CONTAINER) private readonly container: Container,
    // Explicitly injected by token rather than by parameter type. A
    // type-only import would satisfy the lint rule and emit no runtime value
    // for `design:paramtypes`, so Nest would have nothing to resolve — the
    // fix the linter suggests here is the one that breaks dependency
    // injection at boot.
    @Inject(ReadinessProbe) private readonly probe: ReadinessProbe,
  ) {}

  /**
   * A live Web Admin session, or 401.
   *
   * The same token and the same authenticator every other administrative
   * request uses. Nothing here resolves a permission: build metadata is the
   * shape of the deployment rather than a tenant's data, and a permission
   * nobody can be denied is decoration.
   */
  private async requireSession(request: FastifyRequest): Promise<void> {
    const token = requireSessionToken(request, this.container.config.NODE_ENV === 'production');
    await this.container.auth.authenticate(token);
  }

  @Get(HEALTH_ROUTES.live)
  live(): HealthLiveResponse {
    return {
      status: 'ok',
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  /**
   * Anonymous, and a status code is all it says.
   *
   * The probes still run — the answer has to be real — but their names,
   * latencies, migration counts, relay lag and failure classifications stay
   * here. `ControlController.systemReadiness` runs the same probe and reports
   * them to a session.
   */
  @Get(HEALTH_ROUTES.ready)
  async ready(@Res({ passthrough: true }) reply: FastifyReply): Promise<HealthReadyResponse> {
    const { degraded } = await this.probe.run();
    reply.status(degraded ? 503 : 200);
    return { status: degraded ? 'degraded' : 'ok' };
  }

  @Get(HEALTH_ROUTES.info)
  async info(@Req() request: FastifyRequest): Promise<HealthInfoResponse> {
    await this.requireSession(request);
    return {
      name: 'nexa-bot',
      version: this.container.config.BUILD_VERSION,
      commit: this.container.config.BUILD_COMMIT,
      buildTime: this.container.config.BUILD_TIME,
      nodeVersion: process.version,
      environment: this.container.config.NODE_ENV,
    };
  }
}
