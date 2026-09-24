import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  SUPPORT_FAQ_ROUTES,
  createSupportFaqRequestSchema,
  routePattern,
  setSupportFaqStatusRequestSchema,
  updateSupportFaqRequestSchema,
  type SupportFaqListResponse,
  type SupportFaqResponse,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, assertOriginAllowed, requireSessionToken } from './authenticated-request.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type { SupportFaqRecord } from '../../modules/control/support/application/ports.js';

/**
 * The tenant's FAQ over HTTP, at `/support/faqs` (customer UX completion §J).
 *
 * One read and three writes. Create and edit are separate from activate/deactivate
 * for the reason the gateways controller states: hiding an answer and rewording it are
 * different operator decisions with different audit rows.
 *
 * The support DESTINATION is not here. It is `support.accounts`, a setting with its own
 * editor on the settings page, and the Web Admin's support page links to it rather than
 * growing a second editor for the same key.
 *
 * Authentication happens here; AUTHORIZATION does not — `SupportFaqService` charges
 * `settings.view` and `settings.edit` itself.
 */
@Controller(`${API_PREFIX}`)
export class SupportFaqController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(SUPPORT_FAQ_ROUTES.list)
  async list(@Req() request: FastifyRequest): Promise<SupportFaqListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const items = await this.container.supportFaqs.listForOperator(scope, actor);
    return { items: items.map(toView) };
  }

  @Post(SUPPORT_FAQ_ROUTES.create)
  async create(@Req() request: FastifyRequest, @Body() body: unknown): Promise<SupportFaqResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const input = createSupportFaqRequestSchema.parse(body);
    return toView(await this.container.supportFaqs.create(scope, actor, input));
  }

  @Post(routePattern(SUPPORT_FAQ_ROUTES.update, 'id'))
  async update(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<SupportFaqResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const input = updateSupportFaqRequestSchema.parse(body);
    return toView(await this.container.supportFaqs.update(scope, actor, { ...input, id }));
  }

  @Post(routePattern(SUPPORT_FAQ_ROUTES.status, 'id'))
  async setStatus(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<SupportFaqResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const input = setSupportFaqStatusRequestSchema.parse(body);
    return toView(await this.container.supportFaqs.setStatus(scope, actor, { ...input, id }));
  }

  private async authenticate(
    request: FastifyRequest,
    options: { write?: boolean } = {},
  ): Promise<{ scope: TenantContext; actor: ReturnType<typeof adminActor> }> {
    const token = requireSessionToken(request, this.isProduction);
    if (options.write === true) {
      assertOriginAllowed(request, this.container.config.WEB_ADMIN_ORIGINS);
    }
    const { admin, session } = await this.container.auth.authenticate(token);
    const correlationId = currentCorrelationId() ?? newCorrelationId(this.container.ids.uuid());
    // `botInstanceId: null`: the FAQ belongs to the TENANT, and a tenant running two
    // bots answers one set of questions.
    return {
      scope: { tenantId: admin.tenantId, botInstanceId: null },
      actor: adminActor(admin, correlationId, request, session.id),
    };
  }

  private get isProduction(): boolean {
    return this.container.config.NODE_ENV === 'production';
  }
}

/**
 * The wire shape, `supportFaqSchema`. A write answers with the ROW, unwrapped, because
 * that schema is the one the contract declares for an entry and the list wraps the same
 * shape in `items`.
 */
function toView(row: SupportFaqRecord): SupportFaqResponse {
  return {
    id: row.id,
    question: row.question,
    answer: row.answer,
    status: row.status,
    sortOrder: row.sortOrder,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
