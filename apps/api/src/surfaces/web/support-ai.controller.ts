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
  SUPPORT_AI_CONSOLE_ROUTES,
  SUPPORT_AI_ROUTES,
  SUPPORT_ANALYTICS_ROUTES,
  routePattern,
  supportAiControlRequestSchema,
  supportAiDraftRequestSchema,
  supportAnalyticsQuerySchema,
  type SupportAiConfigResponse,
  type SupportAiDraftView,
  type SupportAiTestResponse,
  type SupportHandoffQuestionsResponse,
  type SupportKnowledgeGapsResponse,
  type SupportReadinessResponse,
  type SupportTestConsoleResponse,
  type SupportAiUsageResponse,
  type SupportAnalyticsResponse,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { authenticateAdmin } from './authenticated-request.js';
import { singleValued } from './query.js';
import type { SupportAiDraftRecord } from '../../modules/control/support-ai/application/support-assist.service.js';

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
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.supportAiConfig.view(scope, actor);
  }

  @Put(SUPPORT_AI_ROUTES.config)
  async update(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<{ version: number }> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const saved = await this.container.supportAiConfig.update(scope, actor, body);
    return { version: saved.version };
  }

  @Put(routePattern(SUPPORT_AI_ROUTES.credential, 'provider'))
  async setCredential(
    @Req() request: FastifyRequest,
    @Param('provider') provider: string,
    @Body() body: unknown,
  ): Promise<{ replaced: boolean }> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.supportAiConfig.setCredential(scope, actor, provider, body);
  }

  @Delete(routePattern(SUPPORT_AI_ROUTES.credential, 'provider'))
  async deleteCredential(
    @Req() request: FastifyRequest,
    @Param('provider') provider: string,
    @Query() query: unknown,
  ): Promise<{ removed: boolean }> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const { idempotencyKey } = supportAiControlRequestSchema.parse(query ?? {});
    return this.container.supportAiConfig.deleteCredential(scope, actor, provider, idempotencyKey);
  }

  @Post(routePattern(SUPPORT_AI_ROUTES.test, 'provider'))
  async test(
    @Req() request: FastifyRequest,
    @Param('provider') provider: string,
    @Body() body: unknown,
  ): Promise<SupportAiTestResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.supportAiConfig.test(scope, actor, provider, body);
  }

  @Get(SUPPORT_AI_ROUTES.usage)
  async usage(@Req() request: FastifyRequest): Promise<SupportAiUsageResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
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
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const input = supportAnalyticsQuerySchema.parse(
      singleValued((query ?? {}) as Record<string, unknown>),
    );
    return this.container.supportAnalytics.analytics(scope, actor, input);
  }

  /** Phase 4 PR-5: the readiness card (`support_ai.configure`); read-only. */
  @Get(SUPPORT_AI_CONSOLE_ROUTES.readiness)
  async readiness(@Req() request: FastifyRequest): Promise<SupportReadinessResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.supportInsights.readiness(scope, actor);
  }

  /**
   * Phase 4 PR-5: «امتحان یک سؤال». Runs the stored configuration through the decision
   * pipeline and its guards and reports what WOULD happen. Sends nothing to anyone; the service
   * has no outbound port. `support_ai.configure`, audited.
   */
  @Post(SUPPORT_AI_CONSOLE_ROUTES.testConsole)
  async testConsole(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<SupportTestConsoleResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.supportTestConsole.run(scope, actor, body);
  }

  /** Phase 4 PR-5: the customers' questions behind one handoff reason (last 30 days). */
  @Get(SUPPORT_AI_CONSOLE_ROUTES.handoffQuestions)
  async handoffQuestions(
    @Req() request: FastifyRequest,
    @Query() query: unknown,
  ): Promise<SupportHandoffQuestionsResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.supportInsights.handoffQuestions(
      scope,
      actor,
      singleValued((query ?? {}) as Record<string, unknown>),
    );
  }

  /** Phase 4 PR-5: clustered questions the AI could not answer from approved content. */
  @Get(SUPPORT_AI_CONSOLE_ROUTES.knowledgeGaps)
  async knowledgeGaps(@Req() request: FastifyRequest): Promise<SupportKnowledgeGapsResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.supportInsights.knowledgeGaps(scope, actor);
  }

  /** TB5: the recent drafts of one conversation (`support_ai.assist`). */
  @Get(routePattern(SUPPORT_AI_ASSIST_ROUTES.drafts, 'conversationId'))
  async drafts(
    @Req() request: FastifyRequest,
    @Param('conversationId') conversationId: string,
  ): Promise<{ drafts: SupportAiDraftView[] }> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
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
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const { idempotencyKey } = supportAiDraftRequestSchema.parse(body);
    const job = await this.container.supportAssist.request(scope, actor, {
      conversationId,
      idempotencyKey,
    });
    const [annotated] = await this.container.supportAssist.annotate(scope, [job]);
    return draftView(annotated ?? { ...job, failure: null, replyOverLimit: false });
  }

  /** TB5: the operator sends the draft, edited or not, through the ordinary lane. */
  @Post(routePattern(SUPPORT_AI_ASSIST_ROUTES.send, 'draftId'))
  async sendDraft(
    @Req() request: FastifyRequest,
    @Param('draftId') draftId: string,
    @Body() body: unknown,
  ): Promise<{ outboundId: string }> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.supportAssist.send(scope, actor, draftId, body);
  }

  @Post(routePattern(SUPPORT_AI_ASSIST_ROUTES.discard, 'draftId'))
  async discardDraft(
    @Req() request: FastifyRequest,
    @Param('draftId') draftId: string,
  ): Promise<{ discarded: boolean }> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.supportAssist.discard(scope, actor, draftId);
  }
}

function draftView(job: SupportAiDraftRecord): SupportAiDraftView {
  return {
    id: job.id,
    state: job.state,
    createdAt: job.createdAt.toISOString(),
    readyAt: job.readyAt?.toISOString() ?? null,
    failureCode: job.failureCode,
    failure: job.failure,
    decision: job.decision,
    topic: job.topic,
    confidence: job.confidence,
    summary: job.summary,
    intent: job.intent,
    suggestedReply: job.suggestedReply,
    replyOverLimit: job.replyOverLimit,
    ticketAction: job.ticketAction,
    factLabels: [...job.factLabels],
    knowledgeLabels: [...job.knowledgeLabels],
    provider: job.provider,
    model: job.model,
    imagesSeen: job.imagesSeen,
    imagesUnseen: job.imagesUnseen,
    unseenImageHandoff: job.unseenImageHandoff,
  };
}
