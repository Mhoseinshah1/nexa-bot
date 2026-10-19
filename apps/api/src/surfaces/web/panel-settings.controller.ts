import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  type PanelSettingListResponse,
  type PanelSettingWriteResponse,
  type ResolvedPanelSettingResponse,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, assertOriginAllowed, requireSessionToken } from './authenticated-request.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type { ResolvedPanelSetting } from '../../modules/control/settings/application/panel-settings-resolver.js';

/**
 * Track 3 §2: one panel's PANEL-scoped settings over HTTP (`PANEL_ROUTES.settings` and
 * `.setting`) — the «فایل‌های اتصال» section of the panel's page.
 *
 * Authentication happens here and authorization does not: `PanelSettingsService` charges
 * `panels.view` to read and `panels.edit` to write, refuses a key that is not
 * PANEL-scoped as unknown, and validates the value against the key's own declaration.
 */
@Controller(`${API_PREFIX}`)
export class PanelSettingsController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get('panels/:id/settings')
  async list(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<PanelSettingListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const settings = await this.container.panelSettings.list(scope, actor, id);
    return { settings: settings.map(toResponse) };
  }

  @Post('panels/:id/settings/:key')
  async set(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Param('key') key: string,
    @Body() body: unknown,
  ): Promise<PanelSettingWriteResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const result = await this.container.panelSettings.set(scope, actor, id, key, body);
    // The persisted row, re-read inside the transaction, and whether it changed anything.
    return { setting: toResponse(result.setting), changed: result.changed };
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
      // A panel belongs to the TENANT, not to a bot.
      scope: { tenantId: admin.tenantId, botInstanceId: null },
      actor: adminActor(admin, correlationId, request, session.id),
    };
  }
}

function toResponse(setting: ResolvedPanelSetting): ResolvedPanelSettingResponse {
  return {
    key: setting.key,
    panelId: setting.panelId,
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
    consumer: setting.consumer,
    storedValueInvalid: setting.storedValueInvalid,
  };
}
