import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  type DataExportRequestResponse,
  type DataExportsResponse,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import type { DataExportDownload } from '../../modules/platform/data-export/application/data-export.service.js';
import { authenticateAdmin, readHostingSectionToken } from './authenticated-request.js';

/**
 * Phase 6B PR-3 (ADR-0039, the open data export): «خروجی داده» over HTTP
 * (`DATA_EXPORT_ROUTES`).
 *
 * Presentation only. Two doors to `DataExportService`: a hosted bot's own owner in their own
 * Web Admin (`/data-exports`, charged on `data.export`), and the installation owner from
 * «میزبانی‌ها» (`/hosting/bots/:tenantId/data-exports`, the section session and, on the
 * request, a fresh code). The file is streamed from disk, never buffered, and is never cached.
 */
@Controller(API_PREFIX)
export class DataExportController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  // --- a hosted bot's owner ---------------------------------------------------------------

  @Get('data-exports')
  async list(@Req() request: FastifyRequest): Promise<DataExportsResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.dataExport.listOwn(scope, actor);
  }

  @Post('data-exports')
  @HttpCode(200)
  async request(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<DataExportRequestResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.dataExport.requestOwn(scope, actor, body);
  }

  @Get('data-exports/:id/download')
  async download(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param('id') id: string,
  ): Promise<void> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    await this.send(reply, await this.container.dataExport.downloadOwn(scope, actor, id));
  }

  // --- the installation owner, from «میزبانی‌ها» ---------------------------------------------

  @Get('hosting/bots/:tenantId/data-exports')
  async listHosted(
    @Req() request: FastifyRequest,
    @Param('tenantId') tenantId: string,
  ): Promise<DataExportsResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.dataExport.listHosted(scope, actor, this.token(request), tenantId);
  }

  @Post('hosting/bots/:tenantId/data-exports')
  @HttpCode(200)
  async requestHosted(
    @Req() request: FastifyRequest,
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
  ): Promise<DataExportRequestResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.dataExport.requestHosted(
      scope,
      actor,
      this.token(request),
      tenantId,
      body,
    );
  }

  @Get('hosting/bots/:tenantId/data-exports/:id/download')
  async downloadHosted(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
  ): Promise<void> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    await this.send(
      reply,
      await this.container.dataExport.downloadHosted(
        scope,
        actor,
        this.token(request),
        tenantId,
        id,
      ),
    );
  }

  private token(request: FastifyRequest): string | null {
    return readHostingSectionToken(request, this.container.config.NODE_ENV === 'production');
  }

  /**
   * `@Res()` rather than a returned value: Nest would buffer a returned stream into memory.
   * The file name is built from a UUID by the service, so the header carries no quote, no
   * newline and no semicolon.
   */
  private async send(reply: FastifyReply, file: DataExportDownload): Promise<void> {
    await reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="${file.fileName}"`)
      .header('content-length', String(file.bytes))
      .header('x-content-sha256', file.sha256)
      // The tenant's customers in plain text must not sit in a proxy or a browser cache.
      .header('cache-control', 'no-store')
      .send(file.stream);
  }
}
