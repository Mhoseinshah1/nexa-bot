import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  type PanelSettingListResponse,
  type PanelSettingWriteResponse,
  type ResolvedPanelSettingResponse,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { authenticateAdmin } from './authenticated-request.js';
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
    const { scope, actor } = await authenticateAdmin(this.container, request);
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
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const result = await this.container.panelSettings.set(scope, actor, id, key, body);
    // The persisted row, re-read inside the transaction, and whether it changed anything.
    return { setting: toResponse(result.setting), changed: result.changed };
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
