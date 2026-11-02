import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  clearTenantMediaRequestSchema,
  deliveryQrPreviewRequestSchema,
  type DeliveryQrPreviewResponse,
  tenantMediaPurposeSchema,
  uploadTenantMediaRequestSchema,
  type TenantMediaPurpose,
  type TenantMediaResponse,
  type TenantMediaStateResponse,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { authenticateAdmin } from './authenticated-request.js';
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
    const { scope, actor } = await authenticateAdmin(this.container, request);
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
    const { scope, actor } = await authenticateAdmin(this.container, request);
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
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const purpose = purposeOf(rawPurpose);
    const command = clearTenantMediaRequestSchema.parse(body);
    await this.container.tenantMedia.clear(scope, actor, purpose, {
      idempotencyKey: command.idempotencyKey,
    });
    return { media: null };
  }

  /**
   * Phase 2 item 4: the QR a customer would receive, for a DRAFT `delivery.qr_template`, on
   * the background stored now and encoding a sample link — so the operator sees the real
   * image, scannability included, before saving. Read-only: nothing is stored, so it takes
   * no idempotency key; a POST because the draft is a body. `settings.view`.
   */
  @Post('delivery-qr/preview')
  @HttpCode(200)
  async previewQr(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<DeliveryQrPreviewResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const command = deliveryQrPreviewRequestSchema.parse(body);
    return this.container.deliveryQrPreview.preview(scope, actor, command.template);
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
