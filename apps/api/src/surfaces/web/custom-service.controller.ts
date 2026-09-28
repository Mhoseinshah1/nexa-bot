import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  COMMERCE_ERROR_CODES,
  CUSTOM_SERVICE_ROUTES,
  customServiceLocationWriteSchema,
  customServiceRuleDeleteSchema,
  customServiceRuleWriteSchema,
  errors,
  formatCustomServiceVolume,
  parseCustomServiceVolume,
  type CustomServiceLocationListResponse,
  type CustomServiceLocationResponse,
  type CustomServiceLocationSummaryResponse,
  type CustomServiceRuleListResponse,
  type CustomServiceRuleResponse,
  type CustomServiceRuleSummaryResponse,
  type CustomServiceRuleWriteRequest,
  type OrderCustomServiceResponse,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, assertOriginAllowed, requireSessionToken } from './authenticated-request.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type { CustomServiceRuleInput } from '../../modules/commerce/custom-service/application/custom-service-admin.service.js';
import type {
  CustomServiceLocationRecord,
  CustomServiceRuleRecord,
  OrderCustomServiceTerms,
} from '../../modules/commerce/custom-service/application/ports.js';

/**
 * The custom service's rules and locations, and a custom order's terms, over HTTP
 * (Package D, brief D2, D6).
 *
 * Authentication here; AUTHORIZATION in `CustomServiceAdminService` — `catalog.view` to
 * read, `catalog.pricing.edit` to write, `orders.view` for an order's terms. Every path
 * is a literal, never a client URL builder called with `':id'`
 * (`tests/integration/route-registration.test.ts`).
 */
@Controller(`${API_PREFIX}`)
export class CustomServiceController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(CUSTOM_SERVICE_ROUTES.rules)
  async listRules(@Req() request: FastifyRequest): Promise<CustomServiceRuleListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const rules = await this.container.customServiceAdmin.listRules(scope, actor);
    return { rules: rules.map(toRuleSummary) };
  }

  @Post(CUSTOM_SERVICE_ROUTES.createRule)
  async createRule(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<CustomServiceRuleResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = customServiceRuleWriteSchema.parse(body);
    const rule = await this.container.customServiceAdmin.createRule(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      rule: ruleInputFrom(command),
    });
    return { rule: toRuleSummary(rule) };
  }

  @Get('custom-service/rules/:id')
  async ruleDetail(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<CustomServiceRuleResponse> {
    const { scope, actor } = await this.authenticate(request);
    return {
      rule: toRuleSummary(await this.container.customServiceAdmin.getRule(scope, actor, id)),
    };
  }

  @Post('custom-service/rules/:id')
  async updateRule(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CustomServiceRuleResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = customServiceRuleWriteSchema.parse(body);
    const rule = await this.container.customServiceAdmin.updateRule(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      ruleId: id,
      rule: ruleInputFrom(command),
    });
    return { rule: toRuleSummary(rule) };
  }

  @Post('custom-service/rules/:id/delete')
  async deleteRule(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ readonly deleted: boolean }> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = customServiceRuleDeleteSchema.parse(body);
    return this.container.customServiceAdmin.deleteRule(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      ruleId: id,
    });
  }

  @Get(CUSTOM_SERVICE_ROUTES.locations)
  async listLocations(@Req() request: FastifyRequest): Promise<CustomServiceLocationListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const locations = await this.container.customServiceAdmin.listLocations(scope, actor);
    return { locations: locations.map(toLocationSummary) };
  }

  @Post('custom-service/locations/:panelId')
  async saveLocation(
    @Req() request: FastifyRequest,
    @Param('panelId') panelId: string,
    @Body() body: unknown,
  ): Promise<CustomServiceLocationResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = customServiceLocationWriteSchema.parse(body);
    const saved = await this.container.customServiceAdmin.saveLocation(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      panelId,
      label: command.label,
      enabled: command.enabled,
    });
    return { location: toLocationSummary(saved.location) };
  }

  @Post('custom-service/locations/:panelId/delete')
  async deleteLocation(
    @Req() request: FastifyRequest,
    @Param('panelId') panelId: string,
    @Body() body: unknown,
  ): Promise<{ readonly deleted: boolean }> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = customServiceRuleDeleteSchema.parse(body);
    return this.container.customServiceAdmin.deleteLocation(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      panelId,
    });
  }

  @Get('orders/:id/custom-service')
  async orderTerms(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<OrderCustomServiceResponse> {
    const { scope, actor } = await this.authenticate(request);
    const terms = await this.container.customServiceAdmin.orderTerms(scope, actor, id);
    return { terms: terms === null ? null : toTermsWire(terms) };
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
    // The rules belong to the TENANT, like the catalogue: one set for every bot it runs.
    return {
      scope: { tenantId: admin.tenantId, botInstanceId: null },
      actor: adminActor(admin, correlationId, request, session.id),
    };
  }
}

/** The typed figures as units: hundredths of a GB for VOLUME, days for TIME. */
function ruleInputFrom(command: CustomServiceRuleWriteRequest): CustomServiceRuleInput {
  const units = (text: string): bigint => {
    const value = command.dimension === 'TIME' ? BigInt(text) : parseCustomServiceVolume(text);
    // The schema has already refused anything this could fail on.
    if (value === null) {
      throw errors.validation(COMMERCE_ERROR_CODES.CUSTOM_SERVICE_RULE_INVALID, 'Invalid bound.', {
        field: 'minimum',
      });
    }
    return value;
  };
  return {
    dimension: command.dimension,
    label: command.label,
    minUnits: units(command.minimum),
    maxUnits: units(command.maximum),
    unitPriceMinor: BigInt(command.unitPriceAmount),
    customerId: command.customerId,
    resellerTierId: command.resellerTierId,
    panelId: command.panelId,
    enabled: command.enabled,
  };
}

function bound(rule: CustomServiceRuleRecord, units: bigint): string {
  return rule.dimension === 'TIME' ? units.toString() : formatCustomServiceVolume(units);
}

function toRuleSummary(rule: CustomServiceRuleRecord): CustomServiceRuleSummaryResponse {
  return {
    id: rule.id,
    dimension: rule.dimension,
    label: rule.label,
    minimum: bound(rule, rule.minUnits),
    maximum: bound(rule, rule.maxUnits),
    unitPriceAmount: rule.unitPrice.amountMinor.toString(),
    currency: rule.unitPrice.currency,
    customerId: rule.customerId,
    resellerTierId: rule.resellerTierId,
    panelId: rule.panelId,
    enabled: rule.enabled,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
  };
}

function toLocationSummary(
  location: CustomServiceLocationRecord,
): CustomServiceLocationSummaryResponse {
  return {
    panelId: location.panelId,
    panelName: location.panelName,
    label: location.label,
    enabled: location.enabled,
    createdAt: location.createdAt.toISOString(),
    updatedAt: location.updatedAt.toISOString(),
  };
}

function toTermsWire(terms: OrderCustomServiceTerms): OrderCustomServiceResponse['terms'] {
  return {
    panelId: terms.panelId,
    locationLabel: terms.locationLabel,
    volume: formatCustomServiceVolume(terms.volumeUnits),
    trafficBytes: terms.trafficBytes.toString(),
    durationDays: terms.durationDays,
    volumeRuleId: terms.volumeRuleId,
    volumeRuleLevel: terms.volumeRuleLevel,
    pricePerGbAmount: terms.pricePerGb.amountMinor.toString(),
    volumeAmount: terms.volumePrice.amountMinor.toString(),
    timeRuleId: terms.timeRuleId,
    timeRuleLevel: terms.timeRuleLevel,
    pricePerDayAmount: terms.pricePerDay.amountMinor.toString(),
    timeAmount: terms.timePrice.amountMinor.toString(),
    baseAmount: terms.basePrice.amountMinor.toString(),
    currency: terms.currency,
  };
}
