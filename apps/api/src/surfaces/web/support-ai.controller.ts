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
  SUPPORT_AI_ASSIST_ROUTES,
  SUPPORT_AI_ROUTES,
  SUPPORT_ANALYTICS_ROUTES,
  routePattern,
  supportAiControlRequestSchema,
  supportAiDraftRequestSchema,
  supportAnalyticsQuerySchema,
  type SupportAiConfigResponse,
  type SupportAiDraftView,
  type SupportAiTestResponse,
  type SupportAiUsageResponse,
  type SupportAnalyticsResponse,
  type TenantContext,
} from '@nexa/contracts';
import { z } from 'zod';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, assertOriginAllowed, requireSessionToken } from './authenticated-request.js';
import { singleValued } from './query.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type { SupportAiJobRecord } from '../../modules/control/support-ai/infrastructure/drizzle-support-ai-job.repository.js';

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

  /**
   * TB10: support analytics over a half-open report window (`support_ai.configure`). The
   * query is parsed before the session is used for anything else, so a malformed range is a
   * 400 that reads nothing.
   */
  @Get(SUPPORT_ANALYTICS_ROUTES.analytics)
  async analytics(
    @Req() request: FastifyRequest,
    @Query() query: unknown,
  ): Promise<SupportAnalyticsResponse> {
    const { scope, actor } = await this.authenticate(request);
    const input = supportAnalyticsQuerySchema.parse(
      singleValued((query ?? {}) as Record<string, unknown>),
    );
    return this.container.supportAnalytics.analytics(scope, actor, input);
  }

  /** TB5: the recent drafts of one conversation (`support_ai.assist`). */
  @Get(routePattern(SUPPORT_AI_ASSIST_ROUTES.drafts, 'conversationId'))
  async drafts(
    @Req() request: FastifyRequest,
    @Param('conversationId') conversationId: string,
  ): Promise<{ drafts: SupportAiDraftView[] }> {
    const { scope, actor } = await this.authenticate(request);
    const drafts = await this.container.supportAssist.drafts(scope, actor, conversationId);
    return { drafts: drafts.map(draftView) };
  }

  /** TB5: asks the `assistant` role for a draft. Nothing is sent. */
  @Post(routePattern(SUPPORT_AI_ASSIST_ROUTES.drafts, 'conversationId'))
  async requestDraft(
    @Req() request: FastifyRequest,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ): Promise<SupportAiDraftView> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const { idempotencyKey } = supportAiDraftRequestSchema.parse(body);
    return draftView(
      await this.container.supportAssist.request(scope, actor, { conversationId, idempotencyKey }),
    );
  }

  /** TB5: the operator sends the draft, edited or not, through the ordinary lane. */
  @Post(routePattern(SUPPORT_AI_ASSIST_ROUTES.send, 'draftId'))
  async sendDraft(
    @Req() request: FastifyRequest,
    @Param('draftId') draftId: string,
    @Body() body: unknown,
  ): Promise<{ outboundId: string }> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    return this.container.supportAssist.send(scope, actor, draftId, body);
  }

  @Post(routePattern(SUPPORT_AI_ASSIST_ROUTES.discard, 'draftId'))
  async discardDraft(
    @Req() request: FastifyRequest,
    @Param('draftId') draftId: string,
  ): Promise<{ discarded: boolean }> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    return this.container.supportAssist.discard(scope, actor, draftId);
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

function draftView(job: SupportAiJobRecord): SupportAiDraftView {
  return {
    id: job.id,
    state: job.state,
    createdAt: job.createdAt.toISOString(),
    readyAt: job.readyAt?.toISOString() ?? null,
    failureCode: job.failureCode,
    decision: job.decision,
    topic: job.topic,
    confidence: job.confidence,
    summary: job.summary,
    intent: job.intent,
    suggestedReply: job.suggestedReply,
    ticketAction: job.ticketAction,
    factLabels: [...job.factLabels],
    provider: job.provider,
    model: job.model,
    imagesSeen: job.imagesSeen,
    imagesUnseen: job.imagesUnseen,
    unseenImageHandoff: job.unseenImageHandoff,
  };
}
