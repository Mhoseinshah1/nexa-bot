import { Body, Controller, Get, Inject, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  audiencePreviewRequestSchema,
  type AudienceOptionsResponse,
  type AudiencePreviewResponse,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, assertOriginAllowed, requireSessionToken } from './authenticated-request.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';

/**
 * The shared audience over HTTP (round N, `docs/round-n-broadcast-audit.md` §3).
 *
 * Authentication here, authorization in `AudienceService`: the preview needs `users.view` (a
 * count and a sample of customers is reading customers); the options — names of tiers,
 * products and panels — are readable on `users.view` or any action an audience is built for
 * (`AUDIENCE_OPTIONS_PERMISSIONS`). The preview is a POST because a definition is a
 * structured body, and it writes nothing — which is also why it takes no idempotency key.
 * The Origin check still applies: a cross-site form must not be able to make an operator's
 * browser enumerate the customer base.
 */
@Controller(`${API_PREFIX}/audience`)
export class AudienceController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Post('preview')
  async preview(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<AudiencePreviewResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = audiencePreviewRequestSchema.parse(body ?? {});
    return { preview: await this.container.audience.preview(scope, actor, command.definition) };
  }

  @Get('options')
  async options(@Req() request: FastifyRequest): Promise<AudienceOptionsResponse> {
    const { scope, actor } = await this.authenticate(request);
    const options = await this.container.audience.options(scope, actor);
    return {
      currency: options.currency,
      resellerTiers: [...options.resellerTiers],
      products: [...options.products],
      panels: [...options.panels],
    };
  }

  private async authenticate(
    request: FastifyRequest,
    options: { write?: boolean } = {},
  ): Promise<{ scope: TenantContext; actor: ReturnType<typeof adminActor> }> {
    const token = requireSessionToken(request, this.container.config.NODE_ENV === 'production');
    if (options.write === true) {
      assertOriginAllowed(request, this.container.config.WEB_ADMIN_ORIGINS);
    }
    const { admin, session } = await this.container.auth.authenticate(token);
    const correlationId = currentCorrelationId() ?? newCorrelationId(this.container.ids.uuid());
    return {
      scope: { tenantId: admin.tenantId, botInstanceId: null },
      actor: adminActor(admin, correlationId, request, session.id),
    };
  }
}
