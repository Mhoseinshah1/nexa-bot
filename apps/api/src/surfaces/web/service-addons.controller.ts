import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  SERVICE_ADDON_ROUTES,
  money,
  productStatusRequestSchema,
  serviceAddonListQuerySchema,
  serviceAddonWriteSchema,
  type ServiceAddonId,
  type ServiceAddonListResponse,
  type ServiceAddonResponse,
  type ServiceAddonSummaryResponse,
  type ServiceAddonWriteRequest,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, assertOriginAllowed, requireSessionToken } from './authenticated-request.js';
import { singleValued } from './query.js';
import { decodeKeysetCursor, encodeKeysetCursor } from './keyset-cursor.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type {
  ServiceAddonCursor,
  ServiceAddonDraft,
  ServiceAddonEdit,
  ServiceAddonRecord,
} from '../../modules/commerce/catalog/application/addon-ports.js';

/**
 * Service add-ons over HTTP, at `/service-addons`.
 *
 * Authentication here; AUTHORIZATION in `ServiceAddonService`, which charges the same
 * `catalog.view` / `catalog.edit` pair products do. No endpoint is protected merely by
 * the Web Admin not drawing a button.
 *
 * It exists in Phase 4F rather than with the rest of the Web Admin because of what the
 * phase promises: an action with no configured price is explicitly unavailable, and an
 * add-on nobody can configure would make extra traffic and extra time permanently
 * unavailable. The React screens are 4H's; this is the server half they will call.
 *
 * `productStatusRequestSchema` is reused for activate and deactivate deliberately — it
 * carries an idempotency key and nothing else, which is the whole of what a state
 * change needs here, and a second identical schema would be a second thing to keep in
 * step.
 */
@Controller(`${API_PREFIX}`)
export class ServiceAddonsController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(SERVICE_ADDON_ROUTES.list)
  async list(
    @Req() request: FastifyRequest,
    @Query() raw: Record<string, unknown>,
  ): Promise<ServiceAddonListResponse> {
    const { scope, actor } = await this.authenticate(request);
    // A repeated parameter is an ARRAY, not a string — the guard every list here uses
    // rather than trusting the schema to refuse it.
    const query = singleValued(raw);
    const page = serviceAddonListQuerySchema.parse({
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.status === undefined ? {} : { status: query.status }),
    });
    const result = await this.container.serviceAddons.list(scope, actor, {
      ...(page.limit === undefined ? {} : { limit: page.limit }),
      ...(page.cursor === undefined ? {} : { cursor: addonCursorFrom(page.cursor) }),
      search: {
        ...(page.kind === undefined ? {} : { kind: page.kind }),
        ...(page.status === undefined ? {} : { status: page.status }),
      },
    });
    return {
      addons: result.items.map(toSummary),
      nextCursor: result.nextCursor === null ? null : encodeKeysetCursor(result.nextCursor),
    };
  }

  @Post(SERVICE_ADDON_ROUTES.create)
  async create(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<ServiceAddonResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = serviceAddonWriteSchema.parse(body);
    const addon = await this.container.serviceAddons.create(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      draft: draftFrom(command),
    });
    return { addon: toSummary(addon) };
  }

  @Get('service-addons/:id')
  async detail(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<ServiceAddonResponse> {
    const { scope, actor } = await this.authenticate(request);
    // Not cast here: the service validates it, so a malformed path segment is a 400
    // rather than a 500 at the `uuid` cast.
    return { addon: toSummary(await this.container.serviceAddons.get(scope, actor, id)) };
  }

  @Post('service-addons/:id')
  async update(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ServiceAddonResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = serviceAddonWriteSchema.parse(body);
    /*
     * The `kind` in the body is NOT how the edit decides what this add-on is.
     *
     * `ServiceAddonEdit` omits it and `ServiceAddonService.update` checks the amount
     * against the kind the ROW already has, so a form rendered for one kind and
     * submitted against an id that is the other is refused rather than silently
     * changing what customers have already bought.
     */
    const addon = await this.container.serviceAddons.update(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      addonId: id,
      edit: draftFrom(command),
    });
    return { addon: toSummary(addon) };
  }

  @Post('service-addons/:id/activate')
  async activate(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ServiceAddonResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = productStatusRequestSchema.parse(body);
    const addon = await this.container.serviceAddons.activate(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      addonId: id,
    });
    return { addon: toSummary(addon) };
  }

  @Post('service-addons/:id/deactivate')
  async deactivate(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ServiceAddonResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = productStatusRequestSchema.parse(body);
    const addon = await this.container.serviceAddons.deactivate(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      addonId: id,
    });
    return { addon: toSummary(addon) };
  }

  private async authenticate(
    request: FastifyRequest,
    options: { write?: boolean } = {},
  ): Promise<{ scope: TenantContext; actor: ReturnType<typeof adminActor> }> {
    const token = requireSessionToken(request, this.isProduction);
    if (options.write === true) {
      assertOriginAllowed(request, this.container.config.WEB_ADMIN_ORIGINS);
    }
    const { admin, session } = await this.container.auth.authenticate(token);
    const correlationId = currentCorrelationId() ?? newCorrelationId(this.container.ids.uuid());
    // `botInstanceId: null`, for the reason products give: an add-on belongs to the
    // TENANT, and a tenant running two bots sells one catalogue.
    return {
      scope: { tenantId: admin.tenantId, botInstanceId: null },
      actor: adminActor(admin, correlationId, request, session.id),
    };
  }

  private get isProduction(): boolean {
    return this.container.config.NODE_ENV === 'production';
  }
}

/**
 * The wire shape as the application's own draft.
 *
 * The price pair becomes ONE `Money` here, the layer below which nothing can construct
 * a half-price. The amounts stay a union the kind decides between — the schema has
 * already refused a body carrying both or neither.
 */
function draftFrom(command: ServiceAddonWriteRequest): ServiceAddonDraft {
  return {
    kind: command.kind,
    title: command.title,
    sortOrder: command.sortOrder,
    specification: {
      kind: command.kind,
      trafficBytes: command.trafficBytes === null ? null : BigInt(command.trafficBytes),
      durationDays: command.durationDays,
    },
    price:
      command.priceAmount === null || command.priceCurrency === null
        ? null
        : money(BigInt(command.priceAmount), command.priceCurrency),
  } satisfies ServiceAddonDraft & ServiceAddonEdit;
}

/** The shared cursor, branded for this list. */
function addonCursorFrom(raw: string): ServiceAddonCursor {
  const position = decodeKeysetCursor(raw);
  return { createdAt: position.createdAt, id: position.id as ServiceAddonId };
}

/** The only `ServiceAddonRecord` → JSON conversion on this surface. */
function toSummary(record: ServiceAddonRecord): ServiceAddonSummaryResponse {
  return {
    id: record.id,
    kind: record.kind,
    title: record.title,
    status: record.status,
    sortOrder: record.sortOrder,
    // Text on the wire: a traffic amount in bytes and a price in minor units each pass
    // 2^53 within reach, and JSON has one number type.
    trafficBytes: record.specification.trafficBytes?.toString() ?? null,
    durationDays: record.specification.durationDays,
    priceAmount: record.price === null ? null : record.price.amountMinor.toString(),
    priceCurrency: record.price === null ? null : record.price.currency,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
