import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  COMMERCE_ERROR_CODES,
  errors,
  SERVICE_ROUTES,
  SERVICE_TERMINATE_CONFIRMATION,
  serviceActionRequestSchema,
  serviceListQuerySchema,
  serviceTerminateRequestSchema,
  type PanelId,
  type ServiceActionAvailability,
  type ServiceActionResponse,
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
import { adminActor, assertOriginAllowed, requireSessionToken } from './authenticated-request.js';
import { singleValued } from './query.js';
import { decodeKeysetCursor, encodeKeysetCursor } from './keyset-cursor.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type {
  OperationRecord,
  ServiceCursor,
  ServiceRecord,
} from '../../modules/commerce/provisioning/application/ports.js';
import type { OperatorServiceOperation } from '../../modules/commerce/provisioning/application/provisioning.service.js';

/**
 * Services over HTTP, at `/services`. Three reads and seven actions.
 *
 * `docs/phase4h-audit.md` §7 measured the gap: four `services.*` permissions declared
 * since Phase 2, three seeded roles carrying two of them, real service rows since 4D,
 * and no route at all — so `/services` rendered a "planned" placeholder to operators
 * whose own role said they could view services.
 *
 * ## The writes, and the one still deliberately absent
 *
 * Phase 6A added the seven actions an operator takes on one service. Each is its own
 * path, because the permission differs — terminate charges `services.terminate` and the
 * rest charge `services.edit` — and a single typed route would make that a runtime
 * switch inside a handler instead of a property of the URL.
 *
 * `services.transfer` remains declared and unserved, and that is not an oversight: it
 * has no stated rule for what becomes of the order, the payment and the subscription
 * the previous owner still holds. `docs/open-questions.md` carries the question, a
 * controller is the worst place to invent an answer, and a route that half-worked would
 * be the legacy silent-success pattern with a customer's paid-for account attached.
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
 * `services.view` and the action services charge their own keys. Two things ARE this
 * controller's: the origin check every cookie-authenticated write here performs, and
 * the terminate confirmation phrase, which is a property of the surface that collected
 * it rather than of the operation.
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
    const found = await this.container.serviceAdmin.detail(scope, actor, id);
    return { service: toDetail(found.service, found.actions) };
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

  /**
   * The five actions that plan an operation, and nothing else.
   *
   * Each one is a thin route over `ProvisioningService.requestFromOperator`, which
   * charges the permission — `services.terminate` for a terminate, `services.edit` for
   * the rest — and applies every refusal. The controller's own job is three lines: parse
   * the body, name the operation, re-read the service so the response carries the row as
   * it now is.
   *
   * Terminate additionally demands the typed phrase, checked HERE. That is the one piece
   * of confirmation the application layer does not want: a phrase is a property of the
   * SURFACE that collected it, and a service method whose contract included "the caller
   * typed a word" would be a service method that could be satisfied by a caller passing
   * the constant.
   */
  @Post('services/:id/sync-usage')
  async syncUsage(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ServiceActionResponse> {
    return this.planned(request, id, body, 'SYNC_USAGE');
  }

  @Post('services/:id/reconcile')
  async reconcile(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ServiceActionResponse> {
    return this.planned(request, id, body, 'RECONCILE');
  }

  @Post('services/:id/suspend')
  async suspend(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ServiceActionResponse> {
    return this.planned(request, id, body, 'SUSPEND');
  }

  @Post('services/:id/resume')
  async resume(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ServiceActionResponse> {
    return this.planned(request, id, body, 'RESUME');
  }

  @Post('services/:id/terminate')
  async terminate(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ServiceActionResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const input = serviceTerminateRequestSchema.parse(body);
    /*
     * The phrase, compared after trimming and in full.
     *
     * Refused BEFORE the guard on purpose — this is a malformed request, not a denial,
     * and it is the operator's own client failing to send what its own screen collected.
     * A caller without `services.terminate` still gets the guard's refusal and its
     * operational event, because `requestFromOperator` charges the key before it reads
     * anything.
     */
    if (input.confirm.trim() !== SERVICE_TERMINATE_CONFIRMATION) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'Terminating a service needs its confirmation phrase.',
      );
    }
    const operation = await this.container.provisioning.requestFromOperator(
      scope,
      actor,
      id,
      'TERMINATE',
      { idempotencyKey: input.idempotencyKey },
    );
    return this.answer(scope, actor, id, operation);
  }

  /**
   * Retrying a provisioning attempt, which is NOT `requestFromOperator`'s.
   *
   * `retryProvisioning` has refusals of its own that matter more than the shared ones:
   * an `UNRECONCILED` service is refused with `RECONCILE_FIRST` rather than asked for a
   * second provider account, which is the whole reason it is a separate method.
   */
  @Post('services/:id/retry-provision')
  async retryProvision(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ServiceActionResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const input = serviceActionRequestSchema.parse(body);
    const operation = await this.container.provisioning.retryProvisioning(scope, actor, id, {
      idempotencyKey: input.idempotencyKey,
    });
    return this.answer(scope, actor, id, operation);
  }

  /**
   * Sending the configuration again, which plans no operation at all.
   *
   * `operation: null` in the response is the honest answer: a resend is a message and a
   * delivery row, no provider is called, and reporting a planned operation would invent
   * one. The delivery outcome is on the service's own `deliveryState`, which the
   * re-read carries.
   */
  @Post('services/:id/resend')
  async resend(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ServiceActionResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    serviceActionRequestSchema.parse(body);
    await this.container.delivery.resendForOperator(scope, actor, id);
    return this.answer(scope, actor, id, null);
  }

  private async planned(
    request: FastifyRequest,
    id: string,
    body: unknown,
    type: OperatorServiceOperation,
  ): Promise<ServiceActionResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const input = serviceActionRequestSchema.parse(body);
    const operation = await this.container.provisioning.requestFromOperator(
      scope,
      actor,
      id,
      type,
      {
        idempotencyKey: input.idempotencyKey,
      },
    );
    return this.answer(scope, actor, id, operation);
  }

  /**
   * The service as it NOW is, plus what was planned.
   *
   * Re-read rather than patched from the record the action returned: the action wrote an
   * operation row and the service's own `actions` list has changed because of it —
   * `IN_PROGRESS` where it was available — and a response built from the pre-action read
   * would send the screen back a set of buttons that are no longer true.
   */
  private async answer(
    scope: TenantContext,
    actor: ReturnType<typeof adminActor>,
    id: string,
    operation: OperationRecord | null,
  ): Promise<ServiceActionResponse> {
    const found = await this.container.serviceAdmin.detail(scope, actor, id);
    return {
      service: toDetail(found.service, found.actions),
      operation: operation === null ? null : toOperation(operation),
    };
  }

  private async authenticate(
    request: FastifyRequest,
    options: { write?: boolean } = {},
  ): Promise<{ scope: TenantContext; actor: ReturnType<typeof adminActor> }> {
    const token = requireSessionToken(request, this.isProduction);
    if (options.write) {
      // Cookie-authenticated writes only from a configured origin, exactly as every
      // other write surface here does it.
      assertOriginAllowed(request, this.container.config.WEB_ADMIN_ORIGINS);
    }
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

/**
 * The detail adds the two delivery counters and the action matrix, and no credential.
 *
 * `actions` is computed by `ServiceAdminService.detail` and passed in rather than
 * derived here: a controller that decided availability would be a second opinion about
 * it, and the one place that answer is allowed to come from is the evaluator the write
 * paths agree with.
 */
function toDetail(
  record: ServiceRecord,
  actions: readonly ServiceActionAvailability[],
): ServiceDetailResponse {
  return {
    ...toSummary(record),
    deliveryAttempts: record.deliveryAttempts,
    deliveryNextAttemptAt:
      record.deliveryNextAttemptAt === null ? null : record.deliveryNextAttemptAt.toISOString(),
    actions: actions.map((entry) => ({ ...entry })),
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
