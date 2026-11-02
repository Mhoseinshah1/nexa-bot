import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  giftCardBatchCreateRequestSchema,
  giftCardBatchListQuerySchema,
  giftCardDisableRequestSchema,
  type GiftCardBatchListResponse,
  type GiftCardBatchResponse,
  type GiftCardBatchWire,
  type GiftCardDisablePreviewResponse,
  type GiftCardDisableResponse,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { authenticateAdmin } from './authenticated-request.js';
import { singleValued } from './query.js';
import { decodeKeysetCursor, encodeKeysetCursor } from './keyset-cursor.js';
import type { GiftCardBatchView } from '../../modules/commerce/gift-cards/application/gift-card-admin.service.js';

/**
 * Gift card batches over HTTP (R10 D4): list, create, download the codes, preview a disable,
 * disable. Authentication here; every permission (`gift_cards.view`, `.create`, `.export`,
 * `.disable`) is charged by `GiftCardAdminService`, so nothing is protected by the Web Admin
 * not drawing a button. Every path is a literal, never a client URL builder called with `':id'`.
 */
@Controller(`${API_PREFIX}`)
export class GiftCardsController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get('gift-card-batches')
  async list(
    @Req() request: FastifyRequest,
    @Query() raw: Record<string, unknown>,
  ): Promise<GiftCardBatchListResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const query = singleValued(raw);
    const page = giftCardBatchListQuerySchema.parse({
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
    const result = await this.container.giftCards.list(scope, actor, {
      ...(page.limit === undefined ? {} : { limit: page.limit }),
      ...(page.cursor === undefined ? {} : { cursor: cursorFrom(page.cursor) }),
    });
    return {
      batches: result.items.map(toWire),
      nextCursor: result.next === null ? null : encodeKeysetCursor(result.next),
      walletCurrency: result.walletCurrency,
      enabled: result.enabled,
    };
  }

  /**
   * Mints a batch. The answer is the batch — never its codes: those are downloaded from the
   * export route, so a replayed or lost response neither repeats nor loses them.
   */
  @Post('gift-card-batches')
  async create(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<GiftCardBatchResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const input = giftCardBatchCreateRequestSchema.parse(body);
    const view = await this.container.giftCards.create(scope, actor, {
      idempotencyKey: input.idempotencyKey,
      label: input.label,
      amountMinor: BigInt(input.amountMinor),
      currency: input.currency,
      count: input.count,
      expiresAt: new Date(input.expiresAt),
      perCustomerLimit: input.perCustomerLimit,
      reason: input.reason,
      expectedTotalMinor: BigInt(input.expectedTotalMinor),
      typedCount: input.typedCount,
    });
    return { batch: toWire(view) };
  }

  @Get('gift-card-batches/:id')
  async get(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<GiftCardBatchResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return { batch: toWire(await this.container.giftCards.get(scope, actor, id)) };
  }

  /**
   * The codes, as a CSV download, while the 24-hour window is open. `@Res()` for the reason the
   * report export gives (a returned buffer would be serialised as JSON); `attachment`,
   * `nosniff` and `no-store`, because the file is a list of bearer instruments that must not
   * sit in a proxy or a browser cache. The file name is built on the server from hex only.
   */
  @Get('gift-card-batches/:id/export')
  async exportCsv(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param('id') id: string,
  ): Promise<void> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const file = await this.container.giftCards.exportCodes(scope, actor, id);
    const bytes = Buffer.from(file.content, 'utf8');
    await reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', `attachment; filename="${file.fileName}"`)
      .header('content-length', String(bytes.byteLength))
      .header('cache-control', 'no-store')
      .send(bytes);
  }

  @Get('gift-card-batches/:id/disable-preview')
  async disablePreview(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<GiftCardDisablePreviewResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const preview = await this.container.giftCards.disablePreview(scope, actor, id);
    return {
      batchId: preview.batch.id,
      state: preview.batch.state,
      unredeemedCount: preview.unredeemed,
    };
  }

  @Post('gift-card-batches/:id/disable')
  async disable(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<GiftCardDisableResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const input = giftCardDisableRequestSchema.parse(body);
    const result = await this.container.giftCards.disable(scope, actor, id, {
      idempotencyKey: input.idempotencyKey,
      reason: input.reason,
      expectedUnredeemed: input.expectedUnredeemed,
    });
    return {
      batch: toWire(result.view),
      codesDisabled: result.codesDisabled,
      changed: result.changed,
    };
  }
}

function cursorFrom(raw: string): { createdAt: string; id: string } {
  const position = decodeKeysetCursor(raw);
  return { createdAt: position.createdAt, id: position.id };
}

function toWire(view: GiftCardBatchView): GiftCardBatchWire {
  const { batch, counts } = view;
  const amount = batch.amount;
  return {
    id: batch.id,
    label: batch.label,
    amount: { amountMinor: amount.amountMinor.toString(), currency: amount.currency },
    count: batch.codeCount,
    perCustomerLimit: batch.perCustomerLimit,
    expiresAt: batch.expiresAt.toISOString(),
    state: batch.state,
    createdAt: batch.createdAt.toISOString(),
    createdByAdminId: batch.createdByAdminId,
    disabledAt: batch.disabledAt === null ? null : batch.disabledAt.toISOString(),
    redeemedCount: counts.redeemed,
    disabledCount: counts.disabled,
    unredeemedCount: counts.unredeemed,
    redeemedTotal: {
      amountMinor: view.redeemedTotal.amountMinor.toString(),
      currency: view.redeemedTotal.currency,
    },
    exportAvailableUntil:
      view.exportAvailableUntil === null ? null : view.exportAvailableUntil.toISOString(),
  };
}
