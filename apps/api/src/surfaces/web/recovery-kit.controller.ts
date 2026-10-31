import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  RECOVERY_KIT_ROUTES,
  type ImportRecoveryKitResponse,
  type InstallationKeysResponse,
  type RemoveInstallationKeyResponse,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { authenticateAdmin } from './authenticated-request.js';
import { ipThrottleSubject } from '../../infrastructure/trusted-proxy.js';

/**
 * The Recovery Kit over HTTP (ADR-0032).
 *
 * Authentication and the Origin check happen here; AUTHORIZATION does not —
 * `InstallationKeyService` checks every permission itself, so no endpoint is
 * protected merely by the Web Admin not drawing a button.
 *
 * WHAT NEVER CROSSES THIS BOUNDARY. A key's bytes in a response (the export is
 * the kit, sealed, and nothing else); a passphrase or a password in a URL (both
 * travel in a POST body, which this server does not log); a kit or a key in an
 * error body (the service raises its refusals with codes and fixed sentences,
 * never with the request echoed back).
 */
@Controller(`${API_PREFIX}`)
export class RecoveryKitController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(RECOVERY_KIT_ROUTES.keys)
  async keys(@Req() request: FastifyRequest): Promise<InstallationKeysResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return { keys: await this.container.installationKeys.list(scope, actor) };
  }

  /**
   * The kit, as a download. A POST, because it carries a password and a
   * passphrase and those never go in a URL.
   *
   * `@Res()` so the bytes go out as an attachment rather than as JSON, and
   * `no-store` so neither a proxy nor the browser cache keeps a copy of a file
   * that holds every key this installation has.
   */
  @Post(RECOVERY_KIT_ROUTES.export)
  // 200: a download creates nothing on the server.
  @HttpCode(200)
  async exportKit(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Body() body: unknown,
  ): Promise<void> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const kit = await this.container.installationKeys.exportKit(scope, actor, body, {
      ip: ipThrottleSubject(request.ip, this.container.config.TRUSTED_PROXY_IPS),
    });
    await reply
      .header('content-type', 'application/octet-stream')
      // Built by the service from a date and a constant: no quote, newline or
      // semicolon can reach this header.
      .header('content-disposition', `attachment; filename="${kit.filename}"`)
      .header('cache-control', 'no-store')
      .header('x-nexa-kit-id', kit.kitId)
      .header('x-nexa-kit-keys', String(kit.keyCount))
      .send(kit.bytes);
  }

  @Post(RECOVERY_KIT_ROUTES.import)
  async importKit(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<ImportRecoveryKitResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.installationKeys.importKit(scope, actor, body, {
      ip: ipThrottleSubject(request.ip, this.container.config.TRUSTED_PROXY_IPS),
    });
  }

  @Post(RECOVERY_KIT_ROUTES.remove)
  async remove(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<RemoveInstallationKeyResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.installationKeys.removeKey(scope, actor, body);
  }
}
