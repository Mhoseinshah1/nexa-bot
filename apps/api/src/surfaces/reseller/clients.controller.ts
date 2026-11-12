import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  RESELLER_API_PREFIX,
  RESELLER_SELLING_ROUTES,
  fromWire,
  resellerAutoRenewWriteSchema,
  resellerClientWriteSchema,
  resellerClientsQuerySchema,
  resellerServiceClientWriteSchema,
  type ResellerAutoRenew,
  type ResellerClient,
  type ResellerClientServicesResponse,
  type ResellerClientsResponse,
  type ResellerRenewAllQuote,
  type ResellerRenewAllResult,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { parseWith, resellerCall, resellerKey } from './reseller-request.js';

/**
 * PR-5 §5.6 — «مشتری‌ها» (the clients book), the «مشتری» of a service, «تمدید همهٔ سرویس‌های
 * او», and the per-service auto-renew switch. Ownership is the application's
 * (`ResellerWebClientsService`): another reseller's client or service is `reseller_web.not_found`.
 */
@Controller(RESELLER_API_PREFIX)
export class ResellerClientsController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(RESELLER_SELLING_ROUTES.clients)
  async list(
    @Req() request: FastifyRequest,
    @Query() query: unknown,
  ): Promise<ResellerClientsResponse> {
    const context = await resellerCall(this.container, request);
    const input = parseWith(resellerClientsQuerySchema, query);
    return this.container.resellerWeb.clients.list(context, {
      archived: input.archived,
      ...(input.q === undefined ? {} : { q: input.q }),
    });
  }

  @Post(RESELLER_SELLING_ROUTES.clients)
  @HttpCode(200)
  async create(@Req() request: FastifyRequest, @Body() body: unknown): Promise<ResellerClient> {
    const context = await resellerCall(this.container, request);
    const input = parseWith(resellerClientWriteSchema, body);
    return this.container.resellerWeb.clients.create(context, input);
  }

  @Put(RESELLER_SELLING_ROUTES.client)
  async update(
    @Req() request: FastifyRequest,
    @Param('clientId') clientId: string,
    @Body() body: unknown,
  ): Promise<ResellerClient> {
    const context = await resellerCall(this.container, request);
    const input = parseWith(resellerClientWriteSchema, body);
    return this.container.resellerWeb.clients.update(context, clientId, input);
  }

  @Post(RESELLER_SELLING_ROUTES.clientArchive)
  @HttpCode(200)
  async archive(
    @Req() request: FastifyRequest,
    @Param('clientId') clientId: string,
  ): Promise<ResellerClient> {
    const context = await resellerCall(this.container, request);
    return this.container.resellerWeb.clients.archive(context, clientId);
  }

  @Get(RESELLER_SELLING_ROUTES.clientServices)
  async services(
    @Req() request: FastifyRequest,
    @Param('clientId') clientId: string,
  ): Promise<ResellerClientServicesResponse> {
    const context = await resellerCall(this.container, request);
    return this.container.resellerWeb.clients.services(context, clientId);
  }

  @Get(RESELLER_SELLING_ROUTES.clientRenewAll)
  async renewAllQuote(
    @Req() request: FastifyRequest,
    @Param('clientId') clientId: string,
  ): Promise<ResellerRenewAllQuote> {
    const context = await resellerCall(this.container, request);
    return this.container.resellerWeb.clients.renewAllQuote(context, clientId);
  }

  @Post(RESELLER_SELLING_ROUTES.clientRenewAll)
  @HttpCode(200)
  async renewAll(
    @Req() request: FastifyRequest,
    @Param('clientId') clientId: string,
  ): Promise<ResellerRenewAllResult> {
    const context = await resellerCall(this.container, request);
    return this.container.resellerWeb.clients.renewAll(
      context,
      clientId,
      resellerKey(request, context, 'renew-all'),
    );
  }

  @Put(RESELLER_SELLING_ROUTES.serviceClient)
  async assign(
    @Req() request: FastifyRequest,
    @Param('serviceId') serviceId: string,
    @Body() body: unknown,
  ): Promise<{ clientId: string | null }> {
    const context = await resellerCall(this.container, request);
    const input = parseWith(resellerServiceClientWriteSchema, body);
    return this.container.resellerWeb.clients.assign(context, serviceId, input.clientId);
  }

  @Get(RESELLER_SELLING_ROUTES.serviceAutoRenew)
  async autoRenew(
    @Req() request: FastifyRequest,
    @Param('serviceId') serviceId: string,
  ): Promise<ResellerAutoRenew> {
    const context = await resellerCall(this.container, request);
    return this.container.resellerWeb.clients.autoRenew(context, serviceId);
  }

  @Put(RESELLER_SELLING_ROUTES.serviceAutoRenew)
  async setAutoRenew(
    @Req() request: FastifyRequest,
    @Param('serviceId') serviceId: string,
    @Body() body: unknown,
  ): Promise<ResellerAutoRenew> {
    const context = await resellerCall(this.container, request);
    const input = parseWith(resellerAutoRenewWriteSchema, body);
    return this.container.resellerWeb.clients.setAutoRenew(
      context,
      serviceId,
      {
        enabled: input.enabled,
        expected: input.expected === null ? null : fromWire(input.expected),
        planId: input.planId,
      },
      resellerKey(request, context, 'auto-renew'),
    );
  }
}
