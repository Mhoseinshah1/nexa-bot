import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  createIncidentRequestSchema,
  incidentActionRequestSchema,
  incidentListQuerySchema,
  incidentNoticeRequestSchema,
  updateIncidentRequestSchema,
  type IncidentBannerResponse,
  type IncidentDetailResponse,
  type IncidentItem,
  type IncidentListResponse,
  type IncidentNoticePreviewResponse,
  type IncidentNoticeResponse,
  type IncidentResponse,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, assertOriginAllowed, requireSessionToken } from './authenticated-request.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type { IncidentView } from '../../modules/platform/incidents/application/incident.service.js';

/**
 * Phase E3: incidents and maintenance over HTTP. Authentication here; every permission —
 * `incidents.view`, `incidents.manage`, `incidents.notify`, and each effect's own module
 * key — is charged in the service. Every write carries an idempotency key and is refused
 * from an origin the installation does not list.
 */
@Controller(`${API_PREFIX}`)
export class IncidentsController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  /** One page, newest first; `?cursor=` is the previous page's `nextCursor`. */
  @Get('incidents')
  async list(
    @Req() request: FastifyRequest,
    @Query() query: unknown,
  ): Promise<IncidentListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const { cursor } = incidentListQuerySchema.parse(query ?? {});
    const page = await this.container.incidents.list(scope, actor, cursor ?? null);
    return { incidents: page.incidents.map(toItem), nextCursor: page.nextCursor };
  }

  @Get('incidents/banner')
  async banner(@Req() request: FastifyRequest): Promise<IncidentBannerResponse> {
    const { scope, actor } = await this.authenticate(request);
    const rows = await this.container.incidents.banner(scope, actor);
    return {
      incidents: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        severity: row.severity,
        title: row.title,
        startedAt: row.startedAt?.toISOString() ?? null,
        scheduledEndAt: row.scheduledEndAt?.toISOString() ?? null,
      })),
    };
  }

  @Get('incidents/:id')
  async get(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<IncidentDetailResponse> {
    const { scope, actor } = await this.authenticate(request);
    const view = await this.container.incidents.get(scope, actor, id);
    return {
      incident: toItem(view),
      timeline: view.timeline.map((event) => ({
        id: event.id,
        kind: event.kind,
        actorLabel: event.actorLabel,
        detail: event.detail,
        occurredAt: event.occurredAt.toISOString(),
      })),
    };
  }

  @Post('incidents')
  async create(@Req() request: FastifyRequest, @Body() body: unknown): Promise<IncidentResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = createIncidentRequestSchema.parse(body);
    return { incident: toItem(await this.container.incidents.create(scope, actor, command)) };
  }

  @Post('incidents/:id/edit')
  async update(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<IncidentResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = updateIncidentRequestSchema.parse(body);
    return { incident: toItem(await this.container.incidents.update(scope, actor, id, command)) };
  }

  @Post('incidents/:id/start')
  async start(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<IncidentResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = incidentActionRequestSchema.parse(body);
    return { incident: toItem(await this.container.incidents.start(scope, actor, id, command)) };
  }

  @Post('incidents/:id/resolve')
  async resolve(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<IncidentResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = incidentActionRequestSchema.parse(body);
    return { incident: toItem(await this.container.incidents.resolve(scope, actor, id, command)) };
  }

  @Post('incidents/:id/cancel')
  async cancel(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<IncidentResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = incidentActionRequestSchema.parse(body);
    return { incident: toItem(await this.container.incidents.cancel(scope, actor, id, command)) };
  }

  /** Idempotent by construction: the effects are claimed per subject and each call keyed. */
  @Post('incidents/:id/effects/apply')
  async applyEffects(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<IncidentResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    return { incident: toItem(await this.container.incidents.applyEffects(scope, actor, id)) };
  }

  @Get('incidents/:id/notice/preview')
  async noticePreview(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<IncidentNoticePreviewResponse> {
    const { scope, actor } = await this.authenticate(request);
    return this.container.incidents.noticePreview(scope, actor, id);
  }

  @Post('incidents/:id/notice')
  async notice(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<IncidentNoticeResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = incidentNoticeRequestSchema.parse(body);
    const result = await this.container.incidents.notify(scope, actor, id, command);
    return { incident: toItem(result), queued: result.queued };
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

export function toItem(view: IncidentView): IncidentItem {
  const { incident, effects } = view;
  return {
    id: incident.id,
    kind: incident.kind,
    severity: incident.severity,
    status: incident.status,
    title: incident.title,
    description: incident.description,
    customerMessage: incident.customerMessage,
    targets: [...incident.targets],
    stopSales: incident.stopSales,
    adminBanner: incident.adminBanner,
    scheduledStartAt: incident.scheduledStartAt?.toISOString() ?? null,
    scheduledEndAt: incident.scheduledEndAt?.toISOString() ?? null,
    startedAt: incident.startedAt?.toISOString() ?? null,
    resolvedAt: incident.resolvedAt?.toISOString() ?? null,
    version: incident.version,
    createdAt: incident.createdAt.toISOString(),
    effects: effects.map((effect) => ({
      kind: effect.kind,
      targetKind: effect.targetKind,
      targetRef: effect.targetRef,
      subjectRef: effect.subjectRef,
      state: effect.state,
      errorCode: effect.errorCode,
      updatedAt: effect.updatedAt.toISOString(),
    })),
  };
}
