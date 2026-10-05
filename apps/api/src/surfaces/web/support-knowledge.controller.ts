import { Body, Controller, Get, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  API_PREFIX,
  SUPPORT_KNOWLEDGE_ARTICLE_STATES,
  SUPPORT_KNOWLEDGE_BUILD_ROUTES,
  SUPPORT_KNOWLEDGE_ROUTES,
  SUPPORT_KNOWLEDGE_SOURCES,
  SUPPORT_LEARNING_CANDIDATE_STATES,
  routePattern,
  type SupportKnowledgeArticleView,
  type SupportKnowledgeBuildApplyResponse,
  type SupportKnowledgeBuildView,
  type SupportKnowledgeProposalView,
  type SupportKnowledgeRevisionView,
  type SupportLearningCandidateView,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, assertOriginAllowed, requireSessionToken } from './authenticated-request.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type { KnowledgeBuildDetail } from '../../modules/control/support-knowledge/application/support-knowledge-build.service.js';
import type {
  KnowledgeArticleRecord,
  KnowledgeProposalRecord,
  LearningCandidateRecord,
} from '../../modules/control/support-knowledge/infrastructure/drizzle-support-knowledge.repository.js';

const articleFilterSchema = z.object({
  source: z.enum(SUPPORT_KNOWLEDGE_SOURCES).optional(),
  state: z.enum(SUPPORT_KNOWLEDGE_ARTICLE_STATES).optional(),
});
const candidateFilterSchema = z.object({
  state: z.enum(SUPPORT_LEARNING_CANDIDATE_STATES).optional(),
});

/**
 * TB8 — support knowledge and the learning-candidate queue over HTTP (ADR-0035). Authentication
 * and the origin check happen here; AUTHORIZATION does not — the services charge
 * `support_knowledge.view`, `.review` and `.propose` themselves.
 */
@Controller(`${API_PREFIX}`)
export class SupportKnowledgeController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(SUPPORT_KNOWLEDGE_ROUTES.articles)
  async articles(
    @Req() request: FastifyRequest,
    @Query() query: unknown,
  ): Promise<{ articles: SupportKnowledgeArticleView[] }> {
    const { scope, actor } = await this.authenticate(request);
    const filter = articleFilterSchema.parse(query ?? {});
    const rows = await this.container.supportKnowledge.listArticles(scope, actor, filter);
    return { articles: rows.map(articleView) };
  }

  @Post(SUPPORT_KNOWLEDGE_ROUTES.articles)
  async create(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<SupportKnowledgeArticleView> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    return articleView(await this.container.supportKnowledge.createArticle(scope, actor, body));
  }

  @Put(routePattern(SUPPORT_KNOWLEDGE_ROUTES.article, 'id'))
  async update(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<SupportKnowledgeArticleView> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    return articleView(await this.container.supportKnowledge.updateArticle(scope, actor, id, body));
  }

  @Get(routePattern(SUPPORT_KNOWLEDGE_ROUTES.revisions, 'id'))
  async revisions(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<{ revisions: SupportKnowledgeRevisionView[] }> {
    const { scope, actor } = await this.authenticate(request);
    const rows = await this.container.supportKnowledge.revisions(scope, actor, id);
    return {
      revisions: rows.map((row) => ({
        revision: row.revision,
        origin: row.origin,
        title: row.title,
        body: row.body,
        category: row.category,
        tags: [...row.tags],
        reviewerAdminId: row.reviewerAdminId,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  @Post(routePattern(SUPPORT_KNOWLEDGE_ROUTES.publish, 'id'))
  async publish(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<SupportKnowledgeArticleView> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    return articleView(
      await this.container.supportKnowledge.publishArticle(scope, actor, id, body),
    );
  }

  @Post(routePattern(SUPPORT_KNOWLEDGE_ROUTES.retire, 'id'))
  async retire(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<SupportKnowledgeArticleView> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    return articleView(await this.container.supportKnowledge.retireArticle(scope, actor, id, body));
  }

  @Post(routePattern(SUPPORT_KNOWLEDGE_ROUTES.enabled, 'id'))
  async enabled(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<SupportKnowledgeArticleView> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    return articleView(await this.container.supportKnowledge.setEnabled(scope, actor, id, body));
  }

  @Get(SUPPORT_KNOWLEDGE_ROUTES.candidates)
  async candidates(
    @Req() request: FastifyRequest,
    @Query() query: unknown,
  ): Promise<{ candidates: SupportLearningCandidateView[] }> {
    const { scope, actor } = await this.authenticate(request);
    const filter = candidateFilterSchema.parse(query ?? {});
    const rows = await this.container.supportKnowledge.listCandidates(scope, actor, filter);
    return { candidates: rows.map(candidateView) };
  }

  @Post(routePattern(SUPPORT_KNOWLEDGE_ROUTES.approve, 'id'))
  async approve(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<SupportLearningCandidateView> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    return candidateView(
      await this.container.supportKnowledge.approveCandidate(scope, actor, id, body),
    );
  }

  @Post(routePattern(SUPPORT_KNOWLEDGE_ROUTES.reject, 'id'))
  async reject(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<SupportLearningCandidateView> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    return candidateView(
      await this.container.supportKnowledge.rejectCandidate(scope, actor, id, body),
    );
  }

  /** "Propose as knowledge" on one delivered reply of a business conversation. */
  @Post(routePattern(SUPPORT_KNOWLEDGE_ROUTES.propose, 'conversationId'))
  async propose(
    @Req() request: FastifyRequest,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ): Promise<{ jobId: string; state: string }> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const job = await this.container.supportLearning.propose(scope, actor, conversationId, body);
    return { jobId: job.id, state: job.state };
  }

  /** TB9: the latest build and its proposals (`support_knowledge.view`). */
  @Get(SUPPORT_KNOWLEDGE_BUILD_ROUTES.latest)
  async latestBuild(
    @Req() request: FastifyRequest,
  ): Promise<{ build: SupportKnowledgeBuildView | null }> {
    const { scope, actor } = await this.authenticate(request);
    const detail = await this.container.supportKnowledgeBuild.latest(scope, actor);
    return { build: detail === null ? null : buildView(detail) };
  }

  /** TB9: "build from NEXA" — a change-set of proposals; no article changes. */
  @Post(SUPPORT_KNOWLEDGE_BUILD_ROUTES.builds)
  async runBuild(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<{ build: SupportKnowledgeBuildView }> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    return { build: buildView(await this.container.supportKnowledgeBuild.run(scope, actor, body)) };
  }

  @Post(routePattern(SUPPORT_KNOWLEDGE_BUILD_ROUTES.apply, 'id'))
  async applyBuild(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<SupportKnowledgeBuildApplyResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    return this.container.supportKnowledgeBuild.apply(scope, actor, id, body);
  }

  @Post(routePattern(SUPPORT_KNOWLEDGE_BUILD_ROUTES.resolve, 'id'))
  async resolveProposal(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<SupportKnowledgeProposalView> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    return proposalView(await this.container.supportKnowledgeBuild.resolve(scope, actor, id, body));
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

export function articleView(row: KnowledgeArticleRecord): SupportKnowledgeArticleView {
  return {
    id: row.id,
    source: row.source,
    state: row.state,
    enabled: row.enabled,
    title: row.title,
    body: row.body,
    category: row.category,
    tags: [...row.tags],
    revision: row.revision,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function candidateView(row: LearningCandidateRecord): SupportLearningCandidateView {
  return {
    id: row.id,
    state: row.state,
    title: row.title,
    body: row.body,
    category: row.category,
    tags: [...row.tags],
    rationale: row.rationale,
    confidence: row.confidence,
    rejectReason: row.rejectReason,
    sensitiveKinds: [...row.sensitiveKinds],
    conversationId: row.conversationId,
    sourceCount: row.sourceCount,
    provider: row.provider,
    model: row.model,
    articleId: row.articleId,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
  };
}

/** The source key never leaves the server: it is a row id for most sources. */
export function proposalView(row: KnowledgeProposalRecord): SupportKnowledgeProposalView {
  return {
    id: row.id,
    sourceType: row.sourceType,
    kind: row.kind,
    state: row.state,
    title: row.content.title,
    body: row.content.body,
    category: row.content.category,
    baseTitle: row.baseTitle,
    baseBody: row.baseBody,
    baseRevision: row.baseRevision,
    articleId: row.articleId,
    resolution: row.resolution,
  };
}

export function buildView(detail: KnowledgeBuildDetail): SupportKnowledgeBuildView {
  return {
    id: detail.build.id,
    state: detail.build.state,
    createdAt: detail.build.createdAt.toISOString(),
    counts: { ...detail.build.counts },
    proposals: detail.proposals.map(proposalView),
  };
}
