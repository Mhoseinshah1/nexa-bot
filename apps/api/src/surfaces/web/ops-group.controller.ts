import { Body, Controller, Get, Inject, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  OPS_GROUP_ROUTES,
  type OpsConnectCodeResponse,
  type OpsGroupRequeueResponse,
  type OpsGroupTestResponse,
  type OpsLogGroupResponse,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { authenticateAdmin } from './authenticated-request.js';

/**
 * «گروه گزارش‌های مدیریتی» over HTTP (WP-A4), at `/ops-group`.
 *
 * One read and six acts. Authentication happens here; AUTHORIZATION does not —
 * `OpsGroupService` charges `settings.view` and `settings.edit` itself. What this surface
 * deliberately cannot do is type a chat id: the group's identity comes from the update it
 * sends with a one-time code, never from a request body.
 */
@Controller(`${API_PREFIX}`)
export class OpsGroupController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(OPS_GROUP_ROUTES.status)
  async status(@Req() request: FastifyRequest): Promise<OpsLogGroupResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return { opsGroup: await this.container.opsGroups.view(scope, actor) };
  }

  @Post(OPS_GROUP_ROUTES.connectCode)
  async connectCode(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<OpsConnectCodeResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.opsGroups.issueConnectCode(scope, actor, body);
  }

  @Post(OPS_GROUP_ROUTES.verify)
  async verify(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<OpsLogGroupResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return { opsGroup: await this.container.opsGroups.verify(scope, actor, body) };
  }

  /** A POST because it sends to Telegram and records what happened. */
  @Post(OPS_GROUP_ROUTES.test)
  async test(@Req() request: FastifyRequest, @Body() body: unknown): Promise<OpsGroupTestResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.opsGroups.sendTest(scope, actor, body);
  }

  @Post(OPS_GROUP_ROUTES.reconnect)
  async reconnect(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<OpsLogGroupResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return { opsGroup: await this.container.opsGroups.reconnect(scope, actor, body) };
  }

  @Post(OPS_GROUP_ROUTES.disconnect)
  async disconnect(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<OpsLogGroupResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return { opsGroup: await this.container.opsGroups.disconnect(scope, actor, body) };
  }

  @Post(OPS_GROUP_ROUTES.requeue)
  async requeue(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<OpsGroupRequeueResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.opsGroups.requeue(scope, actor, body);
  }
}
