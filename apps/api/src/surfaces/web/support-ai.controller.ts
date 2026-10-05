import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  SUPPORT_AI_ROUTES,
  routePattern,
  supportAiControlRequestSchema,
  type SupportAiConfigResponse,
  type SupportAiTestResponse,
  type SupportAiUsageResponse,
  type TenantContext,
} from '@nexa/contracts';
import { z } from 'zod';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, assertOriginAllowed, requireSessionToken } from './authenticated-request.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';

const testRequestSchema = z.object({ model: z.string().trim().min(1).max(128) });

/**
 * TB4 — the support AI's configuration over HTTP (ADR-0034 §8). Authentication and the origin
 * check happen here; AUTHORIZATION does not — `SupportAiConfigService` charges
 * `support_ai.configure` (and `support_ai.auto_reply` for entering automatic replies) itself.
 * No response ever carries a key or a masked stand-in.
 */
@Controller(`${API_PREFIX}`)
export class SupportAiController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(SUPPORT_AI_ROUTES.config)
  async view(@Req() request: FastifyRequest): Promise<SupportAiConfigResponse> {
    const { scope, actor } = await this.authenticate(request);
    return this.container.supportAiConfig.view(scope, actor);
  }

  @Put(SUPPORT_AI_ROUTES.config)
  async update(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<{ version: number }> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const saved = await this.container.supportAiConfig.update(scope, actor, body);
    return { version: saved.version };
  }

  @Put(routePattern(SUPPORT_AI_ROUTES.credential, 'provider'))
  async setCredential(
    @Req() request: FastifyRequest,
    @Param('provider') provider: string,
    @Body() body: unknown,
  ): Promise<{ replaced: boolean }> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    return this.container.supportAiConfig.setCredential(scope, actor, provider, body);
  }

  @Delete(routePattern(SUPPORT_AI_ROUTES.credential, 'provider'))
  async deleteCredential(
    @Req() request: FastifyRequest,
    @Param('provider') provider: string,
    @Query() query: unknown,
  ): Promise<{ removed: boolean }> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const { idempotencyKey } = supportAiControlRequestSchema.parse(query ?? {});
    return this.container.supportAiConfig.deleteCredential(scope, actor, provider, idempotencyKey);
  }

  @Post(routePattern(SUPPORT_AI_ROUTES.test, 'provider'))
  async test(
    @Req() request: FastifyRequest,
    @Param('provider') provider: string,
    @Body() body: unknown,
  ): Promise<SupportAiTestResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const { model } = testRequestSchema.parse(body);
    return this.container.supportAiConfig.test(scope, actor, provider, model);
  }

  @Get(SUPPORT_AI_ROUTES.usage)
  async usage(@Req() request: FastifyRequest): Promise<SupportAiUsageResponse> {
    const { scope, actor } = await this.authenticate(request);
    return this.container.supportAiConfig.usage(scope, actor);
  }

  private async authenticate(
    request: FastifyRequest,
    options: { write?: boolean } = {},
  ): Promise<{ scope: TenantContext; actor: ReturnType<typeof adminActor> }> {
    const token = requireSessionToken(request, this.container.config.NODE_ENV === 'production');
    if (options.write === true)
      assertOriginAllowed(request, this.container.config.WEB_ADMIN_ORIGINS);
    const { admin, session } = await this.container.auth.authenticate(token);
    const correlationId = currentCorrelationId() ?? newCorrelationId(this.container.ids.uuid());
    return {
      scope: { tenantId: admin.tenantId, botInstanceId: null },
      actor: adminActor(admin, correlationId, request, session.id),
    };
  }
}
