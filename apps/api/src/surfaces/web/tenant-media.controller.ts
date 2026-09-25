import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  clearTenantMediaRequestSchema,
  tenantMediaPurposeSchema,
  uploadTenantMediaRequestSchema,
  type TenantContext,
  type TenantMediaPurpose,
  type TenantMediaResponse,
  type TenantMediaStateResponse,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, assertOriginAllowed, requireSessionToken } from './authenticated-request.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type { TenantMediaRecord } from '../../modules/control/media/application/ports.js';

/**
 * The tenant's media slots over HTTP (`docs/customer-ux-completion-audit.md` §I, §L):
 * the referral banner's metadata, its upload as base64 JSON, and its removal.
 *
 * Authentication here, authorization in `TenantMediaService` (`settings.view` to read,
 * `settings.edit` to write). No route here ever returns the bytes: the Web Admin shows
 * the digest, the size and the version, and Telegram is the only consumer of the image.
 *
 * Every path is a literal, never a client URL builder called with `':purpose'`
 * (`tests/integration/route-registration.test.ts`).
 */
@Controller(`${API_PREFIX}`)
export class TenantMediaController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get('media/:purpose')
  async detail(
    @Req() request: FastifyRequest,
    @Param('purpose') rawPurpose: string,
  ): Promise<TenantMediaStateResponse> {
    const { scope, actor } = await this.authenticate(request);
    const purpose = purposeOf(rawPurpose);
    const media = await this.container.tenantMedia.get(scope, actor, purpose);
    return { media: media === null ? null : toResponse(media) };
  }

  @Post('media/:purpose')
  async upload(
    @Req() request: FastifyRequest,
    @Param('purpose') rawPurpose: string,
    @Body() body: unknown,
  ): Promise<TenantMediaStateResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const purpose = purposeOf(rawPurpose);
    const command = uploadTenantMediaRequestSchema.parse(body);
    const media = await this.container.tenantMedia.upload(scope, actor, purpose, {
      mimeType: command.mimeType,
      contentBase64: command.contentBase64,
      idempotencyKey: command.idempotencyKey,
    });
    return { media: toResponse(media) };
  }

  @Post('media/:purpose/clear')
  async clear(
    @Req() request: FastifyRequest,
    @Param('purpose') rawPurpose: string,
    @Body() body: unknown,
  ): Promise<TenantMediaStateResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const purpose = purposeOf(rawPurpose);
    const command = clearTenantMediaRequestSchema.parse(body);
    await this.container.tenantMedia.clear(scope, actor, purpose, {
      idempotencyKey: command.idempotencyKey,
    });
    return { media: null };
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
    // A media slot belongs to the TENANT: one banner for every bot the tenant runs.
    return {
      scope: { tenantId: admin.tenantId, botInstanceId: null },
      actor: adminActor(admin, correlationId, request, session.id),
    };
  }
}

/** The purpose from the URL, or a validation error the filter renders as 400. */
function purposeOf(raw: string): TenantMediaPurpose {
  return tenantMediaPurposeSchema.parse(raw);
}

function toResponse(record: TenantMediaRecord): TenantMediaResponse {
  return {
    purpose: record.purpose,
    mimeType: record.mimeType,
    byteLength: record.byteLength,
    sha256: record.sha256,
    version: record.version,
    updatedAt: record.updatedAt.toISOString(),
  };
}
