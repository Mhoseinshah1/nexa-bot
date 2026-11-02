import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  SERVICE_LOCATION_ROUTES,
  serviceLocationDeleteSchema,
  serviceLocationWriteSchema,
  type ServiceLocationDeleteResponse,
  type ServiceLocationListResponse,
  type ServiceLocationResponse,
  type ServiceLocationSummaryResponse,
  type ServiceLocationWriteRequest,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { authenticateAdmin } from './authenticated-request.js';
import type { ServiceLocationInput } from '../../modules/commerce/locations/application/service-location-admin.service.js';
import type { ServiceLocationRecord } from '../../modules/commerce/locations/application/ports.js';

/**
 * The operator's service locations over HTTP, at `/service-locations` (WP-A6).
 *
 * Authentication here; AUTHORIZATION in `ServiceLocationAdminService`, which charges
 * `catalog.view` / `catalog.edit` — the pair every other add-on price is written under.
 * No endpoint is protected by the Web Admin not drawing a button.
 */
@Controller(`${API_PREFIX}`)
export class ServiceLocationsController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(SERVICE_LOCATION_ROUTES.list)
  async list(@Req() request: FastifyRequest): Promise<ServiceLocationListResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const rows = await this.container.serviceLocations.list(scope, actor);
    return { locations: rows.map(toSummary) };
  }

  @Post(SERVICE_LOCATION_ROUTES.create)
  async create(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<ServiceLocationResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const command = serviceLocationWriteSchema.parse(body);
    const saved = await this.container.serviceLocations.create(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      location: inputFrom(command),
    });
    return { location: toSummary(saved.location), changed: saved.changed };
  }

  @Post('service-locations/:id')
  async update(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ServiceLocationResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const command = serviceLocationWriteSchema.parse(body);
    // Not cast here: the service validates the id, so a malformed segment is a 400.
    const saved = await this.container.serviceLocations.update(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      locationId: id,
      location: inputFrom(command),
    });
    return { location: toSummary(saved.location), changed: saved.changed };
  }

  @Post('service-locations/:id/delete')
  async remove(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ServiceLocationDeleteResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const command = serviceLocationDeleteSchema.parse(body);
    return this.container.serviceLocations.remove(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      locationId: id,
    });
  }
}

/** The wire shape as the application's input; the price pair becomes one value here. */
function inputFrom(command: ServiceLocationWriteRequest): ServiceLocationInput {
  return {
    panelId: command.panelId,
    productId: command.productId,
    locationKey: command.locationKey,
    label: command.label,
    initial: command.initial,
    enabled: command.enabled,
    price:
      command.priceAmount === null || command.priceCurrency === null
        ? null
        : { amountMinor: BigInt(command.priceAmount), currency: command.priceCurrency },
    limits: {
      cooldownHours: command.cooldownHours,
      maxChanges: command.maxChanges,
      periodDays: command.periodDays,
    },
    sortOrder: command.sortOrder,
  };
}

/** The only `ServiceLocationRecord` → JSON conversion on this surface. */
function toSummary(record: ServiceLocationRecord): ServiceLocationSummaryResponse {
  return {
    id: record.id,
    panelId: record.panelId,
    productId: record.productId,
    locationKey: record.locationKey,
    label: record.label,
    initial: record.initial,
    enabled: record.enabled,
    // Minor units as text: an amount passes 2^53 within reach, and JSON has one number type.
    priceAmount: record.price === null ? null : record.price.amountMinor.toString(),
    priceCurrency: record.price === null ? null : record.price.currency,
    cooldownHours: record.limits.cooldownHours,
    maxChanges: record.limits.maxChanges,
    periodDays: record.limits.periodDays,
    sortOrder: record.sortOrder,
    version: record.version,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
