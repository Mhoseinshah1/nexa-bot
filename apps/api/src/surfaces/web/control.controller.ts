import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  type FeatureFlagListResponse,
  type FeatureFlagResponse,
  type NotificationDetailResponse,
  type NotificationListResponse,
  type OperationalEventListResponse,
  type PreviewTemplateResponse,
  type ResolvedSettingResponse,
  type SettingListResponse,
  type TemplateListResponse,
  type TemplateRevisionListResponse,
  type TemplateViewResponse,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import { adminActor, assertOriginAllowed, requireSessionToken } from './authenticated-request.js';
import type { ResolvedSetting } from '../../modules/control/settings/application/settings-resolver.js';
import type { ResolvedFeatureFlag } from '../../modules/control/features/application/feature-flags.service.js';
import type { TemplateView } from '../../modules/control/templates/application/template-management.service.js';
import type { OperationalEventRow } from '../../modules/platform/opslog/application/ports.js';
import type {
  DeliveryAttemptRecord,
  NotificationIntent,
} from '../../modules/control/notifications/application/ports.js';

/**
 * The control plane over HTTP.
 *
 * Authentication happens here; AUTHORIZATION does not. Every method calls an
 * application service that checks the permission itself, so a Telegram admin
 * surface added later cannot reach a different answer, and no endpoint is
 * protected merely by the web app not drawing a button for it.
 *
 * There is no read that is answered from a cache and no write that reports
 * success without returning the persisted row.
 */
@Controller(`${API_PREFIX}`)
export class ControlController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  private get isProduction(): boolean {
    return this.container.config.NODE_ENV === 'production';
  }

  // --- Settings ------------------------------------------------------------

  @Get('settings')
  async settings(@Req() request: FastifyRequest): Promise<SettingListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const settings = await this.container.settingsService.list(scope, actor);
    return { settings: settings.map(toSettingResponse) };
  }

  @Post('settings/:key')
  async setSetting(
    @Req() request: FastifyRequest,
    @Param('key') key: string,
    @Body() body: unknown,
  ): Promise<ResolvedSettingResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const result = await this.container.settingsService.set(scope, actor, {
      ...(body as Record<string, unknown>),
      key,
    });
    // The PERSISTED row, re-read inside the transaction. A response built from
    // the request would report success for a write that may not have happened —
    // which three unrelated legacy subsystems do.
    return toSettingResponse(result.setting);
  }

  // --- Feature flags -------------------------------------------------------

  @Get('features')
  async features(@Req() request: FastifyRequest): Promise<FeatureFlagListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const flags = await this.container.featureFlags.list(scope, actor);
    return { flags: flags.map(toFlagResponse) };
  }

  @Post('features/:key')
  async setFeature(
    @Req() request: FastifyRequest,
    @Param('key') key: string,
    @Body() body: unknown,
  ): Promise<FeatureFlagResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const result = await this.container.featureFlags.set(scope, actor, {
      ...(body as Record<string, unknown>),
      key,
    });
    return toFlagResponse(result.flag);
  }

  // --- Templates -----------------------------------------------------------

  @Get('templates')
  async templates(@Req() request: FastifyRequest): Promise<TemplateListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const templates = await this.container.templatesService.list(scope, actor);
    return { templates: templates.map(toTemplateResponse) };
  }

  @Get('templates/:key')
  async template(
    @Req() request: FastifyRequest,
    @Param('key') key: string,
  ): Promise<TemplateViewResponse> {
    const { scope, actor } = await this.authenticate(request);
    return toTemplateResponse(await this.container.templatesService.get(scope, actor, key));
  }

  @Get('templates/:key/revisions')
  async revisions(
    @Req() request: FastifyRequest,
    @Param('key') key: string,
  ): Promise<TemplateRevisionListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const revisions = await this.container.templatesService.revisions(scope, actor, key);
    return {
      revisions: revisions.map((revision) => ({
        revision: revision.revision,
        action: revision.action,
        body: revision.body,
        createdAt: revision.createdAt.toISOString(),
        createdByAdminId: revision.createdByAdminId,
      })),
    };
  }

  @Post('templates/:key')
  async setTemplate(
    @Req() request: FastifyRequest,
    @Param('key') key: string,
    @Body() body: unknown,
  ): Promise<TemplateViewResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const result = await this.container.templatesService.set(scope, actor, {
      ...(body as Record<string, unknown>),
      key,
    });
    return toTemplateResponse(result.template);
  }

  @Post('templates/:key/revert')
  async revertTemplate(
    @Req() request: FastifyRequest,
    @Param('key') key: string,
    @Body() body: unknown,
  ): Promise<TemplateViewResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const result = await this.container.templatesService.revert(scope, actor, {
      ...(body as Record<string, unknown>),
      key,
    });
    return toTemplateResponse(result.template);
  }

  /**
   * Renders a body with caller-supplied sample values and stores nothing.
   *
   * A POST because it carries a body, not because it changes anything. The
   * values come from the request; they are never taken from the acting
   * administrator's own account, which is the difference between this and the
   * legacy edit screen that renders `{first_name}` as the viewer's own name.
   */
  @Post('templates/:key/preview')
  async previewTemplate(
    @Req() request: FastifyRequest,
    @Param('key') key: string,
    @Body() body: unknown,
  ): Promise<PreviewTemplateResponse> {
    const { scope, actor } = await this.authenticate(request);
    const result = await this.container.templatesService.preview(scope, actor, {
      ...(body as Record<string, unknown>),
      key,
    });
    return { rendered: result.rendered, unresolved: [...result.unresolved] };
  }

  // --- Operational events --------------------------------------------------

  @Get('ops-log')
  async opsLog(
    @Req() request: FastifyRequest,
    @Query() query: Record<string, string | undefined>,
  ): Promise<OperationalEventListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const events = await this.container.opsLogService.list(scope, actor, {
      ...(query.limit ? { limit: Number(query.limit) } : {}),
      ...(query.code ? { code: query.code } : {}),
      ...(query.severity ? { severities: query.severity.split(',') } : {}),
      ...(query.since ? { since: new Date(query.since) } : {}),
      ...(query.until ? { until: new Date(query.until) } : {}),
      ...(query.open ? { open: query.open === 'true' } : {}),
    });
    return { events: events.map(toEventResponse) };
  }

  // --- Notifications -------------------------------------------------------

  @Get('notifications')
  async notifications(
    @Req() request: FastifyRequest,
    @Query() query: Record<string, string | undefined>,
  ): Promise<NotificationListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const found = await this.container.notifications.list(scope, actor, {
      ...(query.limit ? { limit: Number(query.limit) } : {}),
    });
    return { notifications: found.map(toNotificationResponse) };
  }

  @Get('notifications/:id')
  async notification(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<NotificationDetailResponse> {
    const { scope, actor } = await this.authenticate(request);
    const { intent, attempts } = await this.container.notifications.get(scope, actor, id);
    return {
      notification: toNotificationResponse(intent),
      attempts: attempts.map(toAttemptResponse),
    };
  }

  /**
   * Sends a test message to the configured operations destination.
   *
   * The legacy log group has no test-send and no way to discover whether its
   * forum topic id is right — the id was never captured anywhere at all
   * (`UNK-GS-002`) — so a misconfigured destination was only found during an
   * incident.
   */
  @Post('notifications/test')
  async testNotification(@Req() request: FastifyRequest): Promise<NotificationDetailResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const { intent } = await this.container.notifications.sendTest(scope, actor);
    return { notification: toNotificationResponse(intent), attempts: [] };
  }

  /**
   * Resolves the session into a scope and an actor.
   *
   * The tenant comes from the SESSION, never from the request: a caller-supplied
   * tenant id is how one administrator reads another tenant's data.
   */
  private async authenticate(
    request: FastifyRequest,
    options: { write?: boolean } = {},
  ): Promise<{ scope: TenantContext; actor: ReturnType<typeof adminActor> }> {
    const token = requireSessionToken(request, this.isProduction);
    if (options.write) {
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

function toSettingResponse(setting: ResolvedSetting): ResolvedSettingResponse {
  return {
    key: setting.key,
    value: setting.value,
    source: setting.source,
    version: setting.version,
    updatedAt: setting.updatedAt?.toISOString() ?? null,
    updatedByAdminId: setting.updatedByAdminId,
    description: setting.description,
    zeroMeaning: setting.zeroMeaning,
    mutability: setting.mutability,
    classification: setting.classification,
    configures: setting.configures,
  };
}

function toFlagResponse(flag: ResolvedFeatureFlag): FeatureFlagResponse {
  return {
    key: flag.key,
    enabled: flag.enabled,
    source: flag.source,
    version: flag.version,
    updatedAt: flag.updatedAt?.toISOString() ?? null,
    updatedByAdminId: flag.updatedByAdminId,
    reason: flag.reason,
    description: flag.description,
    blastRadius: flag.blastRadius,
    configuration: flag.configuration.map((setting) => ({
      ...toSettingResponse(setting),
      inert: setting.inert,
    })),
  };
}

function toTemplateResponse(template: TemplateView): TemplateViewResponse {
  return {
    key: template.key,
    locale: template.locale,
    description: template.description,
    format: template.format,
    placeholders: template.placeholders.map((placeholder) => ({ ...placeholder })),
    maxLength: template.maxLength,
    body: template.body,
    overrideBody: template.overrideBody,
    defaultBody: template.defaultBody,
    source: template.source,
    overrideSuppressed: template.overrideSuppressed,
    version: template.version,
    revision: template.revision,
    updatedAt: template.updatedAt?.toISOString() ?? null,
    updatedByAdminId: template.updatedByAdminId,
  };
}

function toEventResponse(
  event: OperationalEventRow,
): OperationalEventListResponse['events'][number] {
  return {
    id: event.id,
    code: event.code,
    severity: event.severity,
    message: event.message,
    context: event.context,
    occurrenceCount: event.occurrenceCount,
    firstSeenAt: event.firstSeenAt.toISOString(),
    lastSeenAt: event.lastSeenAt.toISOString(),
    correlationId: event.correlationId,
    recoversCode: event.recoversCode,
    resolvedAt: event.resolvedAt?.toISOString() ?? null,
    resolvedByEventId: event.resolvedByEventId,
  };
}

/**
 * A notification as a surface may see it.
 *
 * Deliberately WITHOUT the destination and the payload. The destination
 * identifies an internal operations channel and the payload is an event's
 * message with whatever context it carried; neither is needed to answer "did
 * this go out, and if not why not", which is what this screen is for.
 */
function toNotificationResponse(
  intent: NotificationIntent,
): NotificationListResponse['notifications'][number] {
  return {
    id: intent.id,
    kind: intent.kind,
    status: intent.status,
    templateKey: intent.templateKey,
    attemptCount: intent.attemptCount,
    maxAttempts: intent.maxAttempts,
    createdAt: intent.createdAt.toISOString(),
    lastAttemptAt: intent.lastAttemptAt?.toISOString() ?? null,
    completedAt: intent.completedAt?.toISOString() ?? null,
    correlationId: intent.correlationId,
  };
}

function toAttemptResponse(
  attempt: DeliveryAttemptRecord,
): NotificationDetailResponse['attempts'][number] {
  return {
    attemptNumber: attempt.attemptNumber,
    transport: attempt.transport,
    outcome: attempt.outcome,
    startedAt: attempt.startedAt.toISOString(),
    finishedAt: attempt.finishedAt.toISOString(),
    errorCode: attempt.errorCode,
    errorMessage: attempt.errorMessage,
    retryAfterMs: attempt.retryAfterMs,
  };
}
