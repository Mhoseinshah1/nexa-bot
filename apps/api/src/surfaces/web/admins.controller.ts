import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  uuidV7Schema,
  type AdminId,
  type AdminListResponse,
  type AdminSessionListResponse,
  type AdminSummary,
  type ResetAdminPasswordResponse,
  type RevokeAdminSessionsResponse,
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

  /** Whether only the `__Host-` session cookie may be presented. */
  private get isProduction(): boolean {
    return this.container.config.NODE_ENV === 'production';
  }

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
    return toSummary(updated.admin, updated.roleKeys);
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
   * Connect, replace or remove an administrator's Telegram binding.
   *
   * The same `setTelegramBinding` the Telegram `/link` command uses, reached
   * from a surface that does not first require a bound administrator — which is
   * what lets an installation whose owner was created unbound (v0.2.5 did that)
   * get its first Telegram administrator without a database UPDATE. The body
   * goes over UNPARSED, as `setStatus` and `setRoles` send theirs: the service
   * authorizes first and parses second, so a malformed body from a caller
   * without `admins.edit` still leaves the denial record.
   */
  @Post('admins/:id/telegram')
  async setTelegramBinding(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<AdminSummary> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const targetId = uuidV7Schema.parse(id) as AdminId;
    const updated = await this.container.adminManagement.setTelegramBinding(
      scope,
      actor,
      targetId,
      body,
    );
    return toSummary(updated.admin, updated.roleKeys);
  }

  /**
   * Sets a new password for an administrator who is not the caller.
   *
   * A WRITE, so it takes the origin check, and the body travels unparsed for the
   * reason the three above it give: the service authorizes before it parses, so a
   * malformed body from a caller without `admins.edit` still leaves the denial
   * record rather than a bare 400 with nothing behind it.
   *
   * The response carries no credential — not the new password, not a hash, not a
   * confirmation of what it was set to. What comes back is the administrator as
   * anybody may see them, plus how many sessions ended.
   */
  @Post('admins/:id/password')
  async resetPassword(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ResetAdminPasswordResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const targetId = uuidV7Schema.parse(id) as AdminId;
    const result = await this.container.adminManagement.resetPassword(scope, actor, targetId, body);
    return {
      admin: toSummary(result.admin, result.roleKeys),
      sessionsRevoked: result.sessionsRevoked,
    };
  }

  /** The live sessions one administrator holds. A read: `admins.view`, no origin check. */
  @Get('admins/:id/sessions')
  async sessions(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<AdminSessionListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const targetId = uuidV7Schema.parse(id) as AdminId;
    return {
      sessions: [...(await this.container.adminManagement.listSessions(scope, actor, targetId))],
    };
  }

  /** Ends every session an administrator holds, without changing their password. */
  @Post('admins/:id/sessions/revoke')
  async revokeSessions(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<RevokeAdminSessionsResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const targetId = uuidV7Schema.parse(id) as AdminId;
    return {
      revoked: await this.container.adminManagement.revokeSessions(scope, actor, targetId, body),
    };
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
    const token = requireSessionToken(request, this.isProduction);
    if (options.write) {
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
