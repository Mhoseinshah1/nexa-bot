import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  BROADCAST_PAGE_DEFAULT,
  broadcastListQuerySchema,
  broadcastRecipientListQuerySchema,
  createBroadcastRequestSchema,
  launchBroadcastRequestSchema,
  updateBroadcastRequestSchema,
  uploadBroadcastMediaRequestSchema,
  type AudiencePreviewResponse,
  type BroadcastBotDeliveryResponse,
  type BroadcastCounts,
  type BroadcastHistoryResponse,
  type BroadcastListResponse,
  type BroadcastFailureReasonsResponse,
  type BroadcastRecipientListResponse,
  type BroadcastResponse,
  type BroadcastResponseItem,
  type BroadcastTestResponse,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, assertOriginAllowed, requireSessionToken } from './authenticated-request.js';
import { singleValued } from './query.js';
import { decodeKeysetCursor, encodeKeysetCursor } from './keyset-cursor.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type { BroadcastRecord } from '../../modules/commerce/broadcasts/application/ports.js';

const EMPTY_COUNTS: BroadcastCounts = {
  total: 0,
  pending: 0,
  sending: 0,
  sent: 0,
  unconfirmed: 0,
  failed: 0,
  unreachable: 0,
  skipped: 0,
  cancelled: 0,
  pinned: 0,
  pinFailed: 0,
};

/**
 * Broadcast over HTTP (round N, B1): «ارسال همگانی». Authentication here, authorization in
 * `BroadcastService` — `broadcasts.view` to read, `broadcasts.send` for everything else.
 */
@Controller(`${API_PREFIX}/broadcasts`)
export class BroadcastsController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get()
  async list(
    @Req() request: FastifyRequest,
    @Query() raw: Record<string, unknown>,
  ): Promise<BroadcastListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const query = broadcastListQuerySchema.parse(singleValued(raw));
    const limit = query.limit ?? BROADCAST_PAGE_DEFAULT;
    const position = query.cursor === undefined ? null : decodeKeysetCursor(query.cursor);
    const records = await this.container.broadcasts.list(scope, actor, {
      limit: limit + 1,
      cursor:
        position === null ? null : { createdAt: new Date(position.createdAt), id: position.id },
    });
    const page = records.slice(0, limit);
    const counts = await this.container.broadcasts.counts(
      scope,
      actor,
      page.map((record) => record.id),
    );
    const last = page.at(-1);
    return {
      broadcasts: page.map((record) => toItem(record, counts.get(record.id) ?? EMPTY_COUNTS)),
      nextCursor:
        records.length > limit && last !== undefined
          ? encodeKeysetCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
          : null,
    };
  }

  @Post()
  async create(@Req() request: FastifyRequest, @Body() body: unknown): Promise<BroadcastResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = createBroadcastRequestSchema.parse(body);
    const record = await this.container.broadcasts.create(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      title: command.title,
      contentKind: command.contentKind,
      body: command.body,
      buttons: command.buttons,
      audience: command.audience,
      purpose: command.purpose,
      source: command.source,
      pin: command.pin,
      frozenAudienceId: command.frozenAudienceId,
    });
    return this.respond(scope, actor, record);
  }

  @Get(':id')
  async one(@Req() request: FastifyRequest, @Param('id') id: string): Promise<BroadcastResponse> {
    const { scope, actor } = await this.authenticate(request);
    return this.respond(scope, actor, await this.container.broadcasts.get(scope, actor, id));
  }

  @Post(':id/draft')
  async update(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<BroadcastResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = updateBroadcastRequestSchema.parse(body);
    const record = await this.container.broadcasts.update(scope, actor, id, {
      expectedVersion: command.expectedVersion,
      title: command.title,
      contentKind: command.contentKind,
      body: command.body,
      buttons: command.buttons,
      audience: command.audience,
      purpose: command.purpose,
      source: command.source,
      pin: command.pin,
    });
    return this.respond(scope, actor, record);
  }

  @Post(':id/media')
  async media(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<BroadcastResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = uploadBroadcastMediaRequestSchema.parse(body);
    return this.respond(
      scope,
      actor,
      await this.container.broadcasts.setMedia(scope, actor, id, command),
    );
  }

  @Post(':id/media/remove')
  async removeMedia(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<BroadcastResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    return this.respond(
      scope,
      actor,
      await this.container.broadcasts.removeMedia(scope, actor, id),
    );
  }

  /** The counted preview of the draft's own audience. Writes nothing. */
  @Post(':id/preview')
  async preview(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<AudiencePreviewResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    return { preview: await this.container.broadcasts.preview(scope, actor, id) };
  }

  @Post(':id/test')
  async test(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<BroadcastTestResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    return { outcome: await this.container.broadcasts.test(scope, actor, id) };
  }

  @Post(':id/launch')
  async launch(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<BroadcastResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = launchBroadcastRequestSchema.parse(body);
    const record = await this.container.broadcasts.launch(scope, actor, id, {
      idempotencyKey: command.idempotencyKey,
      mode: command.mode,
      scheduledAt: command.scheduledAt === null ? null : new Date(command.scheduledAt),
      expectedVersion: command.expectedVersion,
      expectedDefinitionHash: command.expectedDefinitionHash,
      expectedRecipients: command.expectedRecipients,
      expectedFingerprint: command.expectedFingerprint,
      typedCount: command.typedCount,
    });
    return this.respond(scope, actor, record);
  }

  @Post(':id/pause')
  async pause(@Req() request: FastifyRequest, @Param('id') id: string): Promise<BroadcastResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    return this.respond(scope, actor, await this.container.broadcasts.pause(scope, actor, id));
  }

  @Post(':id/resume')
  async resume(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<BroadcastResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    return this.respond(scope, actor, await this.container.broadcasts.resume(scope, actor, id));
  }

  @Post(':id/cancel')
  async cancel(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<BroadcastResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    return this.respond(scope, actor, await this.container.broadcasts.cancel(scope, actor, id));
  }

  @Post(':id/retry-failed')
  async retryFailed(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<BroadcastResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    return this.respond(
      scope,
      actor,
      await this.container.broadcasts.retryFailed(scope, actor, id),
    );
  }

  @Get(':id/recipients')
  async recipients(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Query() raw: Record<string, unknown>,
  ): Promise<BroadcastRecipientListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const query = broadcastRecipientListQuerySchema.parse(singleValued(raw));
    const limit = query.limit ?? BROADCAST_PAGE_DEFAULT;
    const rows = await this.container.broadcasts.recipients(scope, actor, id, {
      state: query.state ?? null,
      limit: limit + 1,
      after: query.cursor ?? null,
    });
    const page = rows.slice(0, limit);
    return {
      recipients: page.map((row) => ({
        customerId: row.customerId,
        firstName: row.firstName,
        username: row.username,
        state: row.state,
        attempts: row.attempts,
        errorCode: row.errorCode,
        resolvedAt: row.resolvedAt?.toISOString() ?? null,
        pinState: row.pinState,
        pinErrorCode: row.pinErrorCode,
        nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
      })),
      nextCursor: rows.length > limit ? (page.at(-1)?.customerId ?? null) : null,
    };
  }

  /** Broadcast V2 (program §19): failures by state and reason. */
  @Get(':id/failures')
  async failures(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<BroadcastFailureReasonsResponse> {
    const { scope, actor } = await this.authenticate(request);
    return { reasons: [...(await this.container.broadcasts.failureReasons(scope, actor, id))] };
  }

  /** Roadmap C2: the delivery per bot. */
  @Get(':id/bots')
  async bots(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<BroadcastBotDeliveryResponse> {
    const { scope, actor } = await this.authenticate(request);
    const rows = await this.container.broadcasts.botDelivery(scope, actor, id);
    return {
      bots: rows.map((row) => ({
        botInstanceId: row.botInstanceId,
        botUsername: row.botUsername,
        botStatus: row.botStatus,
        counts: row.counts,
        waitingRetry: row.waitingRetry,
        heldUntil: row.heldUntil?.toISOString() ?? null,
      })),
    };
  }

  /** Roadmap C2: the broadcast's own history — tests, launch, steers, re-queues. */
  @Get(':id/history')
  async history(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<BroadcastHistoryResponse> {
    const { scope, actor } = await this.authenticate(request);
    const rows = await this.container.broadcasts.history(scope, actor, id);
    return {
      entries: rows.map((row) => ({
        id: row.id,
        action: row.action,
        result: row.result,
        actorLabel: row.actorLabel,
        occurredAt: row.occurredAt.toISOString(),
        testOutcome: row.testOutcome,
        requeued: row.requeued,
        fromState: row.fromState,
        toState: row.toState,
      })),
    };
  }

  private async respond(
    scope: TenantContext,
    actor: ReturnType<typeof adminActor>,
    record: BroadcastRecord,
  ): Promise<BroadcastResponse> {
    const counts = await this.container.broadcasts.counts(scope, actor, [record.id]);
    return { broadcast: toItem(record, counts.get(record.id) ?? EMPTY_COUNTS) };
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

/** The one record → HTTP conversion. The media's bytes never leave; only its metadata does. */
export function toItem(record: BroadcastRecord, counts: BroadcastCounts): BroadcastResponseItem {
  const attempted = counts.total - counts.pending - counts.sending;
  return {
    id: record.id,
    title: record.title,
    state: record.state,
    pauseReason: record.pauseReason,
    contentKind: record.contentKind,
    body: record.body,
    buttons: [...record.buttons],
    media:
      record.media === null
        ? null
        : {
            mimeType: record.media.mimeType,
            fileName: record.media.fileName,
            byteLength: record.media.byteLength,
            available: record.media.available,
          },
    purpose: record.purpose,
    source: record.source,
    sourceVerifiedAt: record.sourceVerifiedAt?.toISOString() ?? null,
    pin: record.pin,
    frozenAudienceId: record.frozenAudienceId,
    audience: record.audienceDefinition,
    audienceHash: record.audienceHash,
    audienceAsOf: record.audienceAsOf?.toISOString() ?? null,
    recipientCount: record.recipientCount,
    fingerprint: record.audienceFingerprint,
    scheduledAt: record.scheduledAt?.toISOString() ?? null,
    counts,
    progressPercent:
      record.state === 'DRAFT' || counts.total === 0
        ? null
        : Math.floor((attempted * 100) / counts.total),
    version: record.version,
    createdBy: record.createdBy,
    launchedBy: record.launchedBy,
    createdAt: record.createdAt.toISOString(),
    launchedAt: record.launchedAt?.toISOString() ?? null,
    startedAt: record.startedAt?.toISOString() ?? null,
    completedAt: record.completedAt?.toISOString() ?? null,
    cancelledAt: record.cancelledAt?.toISOString() ?? null,
  };
}
