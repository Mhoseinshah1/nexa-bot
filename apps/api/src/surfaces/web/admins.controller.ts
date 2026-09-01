import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  uuidV7Schema,
  type AdminId,
  type AdminListResponse,
  type AdminSummary,
  type RoleListResponse,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import { adminActor, assertOriginAllowed, requireSessionToken } from './authenticated-request.js';
import { toSummary } from './auth.controller.js';

/**
 * Administrator management over HTTP.
 *
 * Authentication happens here; AUTHORIZATION does not. Every method calls the
 * application service, which checks the permission itself — so the Telegram
 * admin surface added later cannot reach a different answer, and no endpoint
 * can be protected merely by not drawing a button for it. In the legacy system
 * "enforcement" may well have meant exactly that (`UNK-ADM-001`).
 */
@Controller(`${API_PREFIX}`)
export class AdminsController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get('admins')
  async list(@Req() request: FastifyRequest): Promise<AdminListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const found = await this.container.adminManagement.list(scope, actor);
    return { admins: found.map((entry) => toSummary(entry.admin, entry.roleKeys)) };
  }

  @Get('roles')
  async roles(@Req() request: FastifyRequest): Promise<RoleListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const found = await this.container.adminManagement.listRoles(scope, actor);
    return {
      roles: found.map((role) => ({
        key: role.key,
        name: role.name,
        isSystem: role.isSystem,
        permissions: [...role.permissions],
      })),
    };
  }

  @Post('admins')
  async create(@Req() request: FastifyRequest, @Body() body: unknown): Promise<AdminSummary> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const created = await this.container.adminManagement.create(scope, actor, body);
    return toSummary(created.admin, created.roleKeys);
  }

  @Post('admins/:id/status')
  async setStatus(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<AdminSummary> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const targetId = uuidV7Schema.parse(id) as AdminId;
    const updated = await this.container.adminManagement.setStatus(scope, actor, targetId, body);
    const roleKeys = await this.container.admins.roleKeysFor(scope, targetId);
    return toSummary(updated, roleKeys);
  }

  @Post('admins/:id/roles')
  async setRoles(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<AdminSummary> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const targetId = uuidV7Schema.parse(id) as AdminId;
    const updated = await this.container.adminManagement.setRoles(scope, actor, targetId, body);
    return toSummary(updated.admin, updated.roleKeys);
  }

  /**
   * Resolves the session into a scope and an actor.
   *
   * The tenant comes from the SESSION, never from the request: a caller-supplied
   * tenant id is how one administrator reads another tenant's data.
   */
  private async authenticate(
    request: FastifyRequest,
    options: { write?: boolean } = {},
  ): Promise<{ scope: TenantContext; actor: ReturnType<typeof adminActor> }> {
    const token = requireSessionToken(request);
    if (options.write) {
      assertOriginAllowed(request, this.container.config.WEB_ADMIN_ORIGINS);
    }

    const { admin } = await this.container.auth.authenticate(token);
    const correlationId = currentCorrelationId() ?? newCorrelationId(this.container.ids.uuid());

    return {
      scope: { tenantId: admin.tenantId, botInstanceId: null },
      actor: adminActor(admin, correlationId, request),
    };
  }
}
