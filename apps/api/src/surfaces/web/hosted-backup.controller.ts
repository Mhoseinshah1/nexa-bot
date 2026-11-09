import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  errors,
  HOSTED_BACKUP_ROUTES,
  HOSTING_ERROR_CODES,
  TENANT_RESTORE_UPLOAD_MAX_BYTES,
  type HostedBackupResponse,
  type HostedOwnBackupResponse,
  type TenantRestoreUploadResponse,
  type TenantRestoreView,
  type TenantRestoresResponse,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { authenticateAdmin, readHostingSectionToken } from './authenticated-request.js';

/**
 * Phase 6B PR-2 (ADR-0039 § 7): hosted-bot backups over HTTP (`HOSTED_BACKUP_ROUTES`).
 *
 * Presentation only. The owner, the section session, the fresh code, the audit row and the
 * path of a file are `HostedBackupService` / `TenantRestoreAdminService`'s decisions; this
 * reads the section cookie, streams an upload into the directory the service made, and
 * streams a download from the path the service derived. Its own controller, beside
 * `HostingController` under the same prefix.
 */
@Controller(API_PREFIX)
export class HostedBackupController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(HOSTED_BACKUP_ROUTES.bot)
  async bot(
    @Req() request: FastifyRequest,
    @Param('tenantId') tenantId: string,
  ): Promise<HostedBackupResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.hostedBackups.view(scope, actor, this.token(request), tenantId);
  }

  @Post(HOSTED_BACKUP_ROUTES.schedule)
  @HttpCode(200)
  async schedule(
    @Req() request: FastifyRequest,
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
  ): Promise<HostedBackupResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.hostedBackups.setSchedule(
      scope,
      actor,
      this.token(request),
      tenantId,
      body,
    );
  }

  @Post(HOSTED_BACKUP_ROUTES.password)
  @HttpCode(200)
  async password(
    @Req() request: FastifyRequest,
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
  ): Promise<HostedBackupResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.hostedBackups.setPassword(
      scope,
      actor,
      this.token(request),
      tenantId,
      body,
    );
  }

  @Post(HOSTED_BACKUP_ROUTES.run)
  @HttpCode(200)
  async run(
    @Req() request: FastifyRequest,
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
  ): Promise<HostedBackupResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.hostedBackups.requestRun(
      scope,
      actor,
      this.token(request),
      tenantId,
      body,
    );
  }

  /** A POST, because it spends a fresh code; the body of the answer is the archive. */
  @Post(HOSTED_BACKUP_ROUTES.download)
  @HttpCode(200)
  async download(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param('tenantId') tenantId: string,
    @Param('runId') runId: string,
    @Body() body: unknown,
  ): Promise<void> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const artifact = await this.container.hostedBackups.download(
      scope,
      actor,
      this.token(request),
      tenantId,
      runId,
      body,
    );
    await reply
      .header('content-type', 'application/octet-stream')
      // Built from two validated uuids by the service: no quote, newline or semicolon.
      .header('content-disposition', `attachment; filename="${artifact.filename}"`)
      .header('content-length', String(artifact.bytes))
      .header('cache-control', 'no-store')
      .send(createReadStream(artifact.path));
  }

  /**
   * «بازیابی روی همین سرور»: one of the bot's own verified archives, dry-run as a REPLACE of
   * the same bot (fresh code). Answers the VERIFIED restore request, confirmed like an upload's.
   */
  @Post(HOSTED_BACKUP_ROUTES.restoreHere)
  @HttpCode(200)
  async restoreHere(
    @Req() request: FastifyRequest,
    @Param('tenantId') tenantId: string,
    @Param('runId') runId: string,
    @Body() body: unknown,
  ): Promise<TenantRestoreView> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.tenantRestoreAdmin.restoreHere(
      scope,
      actor,
      this.token(request),
      tenantId,
      runId,
      body,
    );
  }

  @Get(HOSTED_BACKUP_ROUTES.own)
  async own(@Req() request: FastifyRequest): Promise<HostedOwnBackupResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.hostedBackups.ownView(scope, actor);
  }

  // --- «بازیابی ربات از فایل» -----------------------------------------------------------

  @Get(HOSTED_BACKUP_ROUTES.restores)
  async restores(@Req() request: FastifyRequest): Promise<TenantRestoresResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.tenantRestoreAdmin.list(scope, actor, this.token(request));
  }

  /**
   * The archive, streamed as `application/octet-stream` into the directory the service made,
   * counted against the ceiling as it arrives (a chunked body declares no length). Nothing
   * the client sent reaches a path.
   */
  @Post(HOSTED_BACKUP_ROUTES.upload)
  @HttpCode(200)
  async upload(@Req() request: FastifyRequest): Promise<TenantRestoreUploadResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const admin = this.container.tenantRestoreAdmin;
    const { restoreId, archivePath } = await admin.beginUpload(scope, actor, this.token(request));
    const limit = Math.min(
      this.container.config.RECOVERY_UPLOAD_MAX_BYTES,
      TENANT_RESTORE_UPLOAD_MAX_BYTES,
    );
    let received = 0;
    const digest = createHash('sha256');
    try {
      await pipeline(
        request.raw,
        async function* (chunks: AsyncIterable<Buffer>) {
          for await (const chunk of chunks) {
            received += chunk.length;
            if (received > limit) {
              throw errors.validation(
                HOSTING_ERROR_CODES.ARCHIVE_NOT_FOUND,
                'The uploaded archive is larger than this installation accepts.',
              );
            }
            digest.update(chunk);
            yield chunk;
          }
        },
        createWriteStream(archivePath, { mode: 0o600, flags: 'wx' }),
      );
    } catch (error) {
      await admin.discardUpload(restoreId);
      throw error;
    }
    if (received === 0) {
      await admin.discardUpload(restoreId);
      throw errors.validation(HOSTING_ERROR_CODES.ARCHIVE_NOT_FOUND, 'The upload was empty.');
    }
    return { restoreId, bytes: received, sha256: digest.digest('hex') };
  }

  @Post(HOSTED_BACKUP_ROUTES.dryRun)
  @HttpCode(200)
  async dryRun(
    @Req() request: FastifyRequest,
    @Param('restoreId') restoreId: string,
    @Body() body: unknown,
  ): Promise<TenantRestoreView> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.tenantRestoreAdmin.dryRun(
      scope,
      actor,
      this.token(request),
      restoreId,
      body,
    );
  }

  @Post(HOSTED_BACKUP_ROUTES.confirm)
  @HttpCode(200)
  async confirm(
    @Req() request: FastifyRequest,
    @Param('restoreId') restoreId: string,
    @Body() body: unknown,
  ): Promise<TenantRestoreView> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.tenantRestoreAdmin.confirm(
      scope,
      actor,
      this.token(request),
      restoreId,
      body,
    );
  }

  @Post(HOSTED_BACKUP_ROUTES.cancel)
  @HttpCode(200)
  async cancel(
    @Req() request: FastifyRequest,
    @Param('restoreId') restoreId: string,
    @Body() body: unknown,
  ): Promise<TenantRestoreView> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.tenantRestoreAdmin.cancel(
      scope,
      actor,
      this.token(request),
      restoreId,
      body,
    );
  }

  private token(request: FastifyRequest): string | null {
    return readHostingSectionToken(request, this.container.config.NODE_ENV === 'production');
  }
}
