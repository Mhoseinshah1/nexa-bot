import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  SERVICE_ROUTES,
  serviceListQuerySchema,
  type PanelId,
  type ServiceDetailResponse,
  type ServiceListResponse,
  type ServiceOperationResponse,
  type ServiceOperationsResponse,
  type ServiceResponse,
  type ServiceSummaryResponse,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, requireSessionToken } from './authenticated-request.js';
import { singleValued } from './query.js';
import { decodeKeysetCursor, encodeKeysetCursor } from './keyset-cursor.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type {
  OperationRecord,
  ServiceCursor,
  ServiceRecord,
} from '../../modules/commerce/provisioning/application/ports.js';

/**
 * Services over HTTP, at `/services`. Three reads and NO writes.
 *
 * `docs/phase4h-audit.md` §7 measured the gap: four `services.*` permissions declared
 * since Phase 2, three seeded roles carrying two of them, real service rows since 4D,
 * and no route at all — so `/services` rendered a "planned" placeholder to operators
 * whose own role said they could view services.
 *
 * ## No writes, deliberately
 *
 * `services.terminate` and `services.transfer` remain declared and unserved. Terminate
 * deletes somebody's provider account and is a HIGH-risk permission; its customer half
 * exists (4E) and the operator half needs a confirmation flow and an announcement
 * decision this phase has not taken. Transfer has no stated rule for what becomes of
 * the order, the payment and the subscription the previous owner still holds —
 * `docs/open-questions.md` carries it, and a controller is the worst place to invent
 * one. A route that half-worked would be the legacy silent-success pattern.
 *
 * ## What the responses do not carry
 *
 * No `subscriptionUrl`, no `subscriptionRef`, no `providerClientId` — on the list OR
 * the detail. All three are bearer capabilities, and an operator list is the worst
 * place to break ADR-0023's one-way rule because it would hand out every customer's
 * live configuration in bulk on one request. `hasSubscription` is the boolean that
 * answers the only question an operator has about it.
 *
 * Authentication happens here; AUTHORIZATION does not — `ServiceAdminService` charges
 * `services.view` itself.
 */
@Controller(`${API_PREFIX}`)
export class ServicesController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(SERVICE_ROUTES.list)
  async list(
    @Req() request: FastifyRequest,
    @Query() raw: Record<string, unknown>,
  ): Promise<ServiceListResponse> {
    const { scope, actor } = await this.authenticate(request);
    // A repeated parameter is an ARRAY, not a string — the guard every list here uses.
    const query = singleValued(raw);
    const page = serviceListQuerySchema.parse({
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.state === undefined ? {} : { state: query.state }),
      ...(query.deliveryState === undefined ? {} : { deliveryState: query.deliveryState }),
      ...(query.customerId === undefined ? {} : { customerId: query.customerId }),
      ...(query.panelId === undefined ? {} : { panelId: query.panelId }),
    });
    const result = await this.container.serviceAdmin.list(scope, actor, {
      ...(page.limit === undefined ? {} : { limit: page.limit }),
      ...(page.cursor === undefined ? {} : { cursor: serviceCursorFrom(page.cursor) }),
      search: {
        ...(page.state === undefined ? {} : { state: page.state }),
        ...(page.deliveryState === undefined ? {} : { deliveryState: page.deliveryState }),
        ...(page.customerId === undefined ? {} : { customerId: page.customerId as UserId }),
        ...(page.panelId === undefined ? {} : { panelId: page.panelId as PanelId }),
      },
    });
    return {
      services: result.items.map(toSummary),
      nextCursor: result.nextCursor === null ? null : encodeKeysetCursor(result.nextCursor),
    };
  }

  @Get('services/:id')
  async detail(@Req() request: FastifyRequest, @Param('id') id: string): Promise<ServiceResponse> {
    const { scope, actor } = await this.authenticate(request);
    return { service: toDetail(await this.container.serviceAdmin.get(scope, actor, id)) };
  }

  /**
   * What has been attempted on one service.
   *
   * The question an operator actually arrives with — "why has this customer not had
   * their link" — which `state` alone cannot answer: an `UNRECONCILED` service says
   * this installation does not know what exists on the panel, and the operation history
   * is where the reason lives.
   */
  @Get('services/:id/operations')
  async operations(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<ServiceOperationsResponse> {
    const { scope, actor } = await this.authenticate(request);
    const operations = await this.container.serviceAdmin.operations(scope, actor, id);
    return { operations: operations.map(toOperation) };
  }

  private async authenticate(
    request: FastifyRequest,
  ): Promise<{ scope: TenantContext; actor: ReturnType<typeof adminActor> }> {
    const token = requireSessionToken(request, this.isProduction);
    const { admin, session } = await this.container.auth.authenticate(token);
    const correlationId = currentCorrelationId() ?? newCorrelationId(this.container.ids.uuid());
    return {
      scope: { tenantId: admin.tenantId, botInstanceId: null },
      actor: adminActor(admin, correlationId, request, session.id),
    };
  }

  private get isProduction(): boolean {
    return this.container.config.NODE_ENV === 'production';
  }
}

function serviceCursorFrom(raw: string): ServiceCursor {
  const position = decodeKeysetCursor(raw);
  return { createdAt: position.createdAt, id: position.id };
}

/**
 * The projection, and the three fields it does not select.
 *
 * `subscriptionRef`, `providerClientId` and `subscriptionUrl` are absent from the
 * RESPONSE rather than masked, for the reason ADR-0023 gives about a panel password:
 * a masked stand-in is a value somebody can try to resubmit, and `********` in a field
 * called `subscriptionUrl` teaches a reader that the real one belongs there.
 *
 * `hasSubscription` is derived from the URL and is the only thing an operator needs:
 * whether the customer has something to be sent, which is what distinguishes "the send
 * failed" from "there is nothing to send".
 */
function toSummary(record: ServiceRecord): ServiceSummaryResponse {
  return {
    id: record.id,
    customerId: record.customerId,
    orderId: record.orderId,
    panelId: record.panelId,
    productId: record.productId,
    state: record.state,
    providerUsername: record.providerUsername,
    providerUserId: record.providerUserId,
    hasSubscription: record.subscriptionUrl !== null,
    expiresAt: record.expiresAt === null ? null : record.expiresAt.toISOString(),
    // Text on the wire: JSON has one number type and a byte count passes 2^53.
    trafficLimitBytes: record.trafficLimitBytes.toString(),
    trafficUsedBytes: record.trafficUsedBytes.toString(),
    usageSyncedAt: record.usageSyncedAt === null ? null : record.usageSyncedAt.toISOString(),
    deliveryState: record.deliveryState,
    deliveredAt: record.deliveredAt === null ? null : record.deliveredAt.toISOString(),
    provisionedAt: record.provisionedAt === null ? null : record.provisionedAt.toISOString(),
    terminatedAt: record.terminatedAt === null ? null : record.terminatedAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/** The detail adds the two delivery counters, and no credential. */
function toDetail(record: ServiceRecord): ServiceDetailResponse {
  return {
    ...toSummary(record),
    deliveryAttempts: record.deliveryAttempts,
    deliveryNextAttemptAt:
      record.deliveryNextAttemptAt === null ? null : record.deliveryNextAttemptAt.toISOString(),
  };
}

/**
 * One operation, without its lease.
 *
 * `leaseUntil`, `claimedBy` and the worker's own bookkeeping are NOT here: they are how
 * two replicas avoid taking the same row, and an operator reading them would be reading
 * our scheduling rather than their customer's service.
 */
function toOperation(record: OperationRecord): ServiceOperationResponse {
  return {
    id: record.id,
    type: record.type,
    state: record.state,
    attempts: record.attempts,
    failureMessage: record.failureMessage,
    scheduledAt: record.nextAttemptAt === null ? null : record.nextAttemptAt.toISOString(),
    /* When the PROVIDER call began, which is `callStartedAt` — the stamp 4D writes
     * before dialling so a worker that dies mid-call is recoverable. It is the closest
     * true answer to "when did this actually start". */
    startedAt: record.callStartedAt === null ? null : record.callStartedAt.toISOString(),
    completedAt: record.completedAt === null ? null : record.completedAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
  };
}
