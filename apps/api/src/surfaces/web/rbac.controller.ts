import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  roleKeySchema,
  type DeleteRoleResponse,
  type RoleMutationResponse,
  type RoleViewListResponse,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { authenticateAdmin } from './authenticated-request.js';

/**
 * Role management over HTTP (Phase D3). Routes in `RBAC_ROUTES`.
 *
 * Presentation only: every rule — who may edit roles, the immutable owner role,
 * coherence, the amplification bound, the typed confirmation for a CRITICAL change, the
 * version check — is `AdminManagementService`'s. A page that hides a button has
 * authorized nothing.
 */
@Controller(`${API_PREFIX}/rbac`)
export class RbacController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get('roles')
  async roles(@Req() request: FastifyRequest): Promise<RoleViewListResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return { roles: await this.container.adminManagement.listManagedRoles(scope, actor) };
  }

  @Post('roles')
  async create(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<RoleMutationResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return { role: await this.container.adminManagement.createRole(scope, actor, body) };
  }

  @Post('roles/:key')
  @HttpCode(200)
  async update(
    @Req() request: FastifyRequest,
    @Param('key') key: string,
    @Body() body: unknown,
  ): Promise<RoleMutationResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const roleKey = roleKeySchema.parse(key);
    return { role: await this.container.adminManagement.updateRole(scope, actor, roleKey, body) };
  }

  @Post('roles/:key/delete')
  @HttpCode(200)
  async remove(
    @Req() request: FastifyRequest,
    @Param('key') key: string,
    @Body() body: unknown,
  ): Promise<DeleteRoleResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const roleKey = roleKeySchema.parse(key);
    return this.container.adminManagement.deleteRole(scope, actor, roleKey, body);
  }
}
