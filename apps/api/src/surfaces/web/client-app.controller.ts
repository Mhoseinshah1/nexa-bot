import { Body, Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  CLIENT_APP_ROUTES,
  clearClientAppImageRequestSchema,
  createClientAppRequestSchema,
  deleteClientAppRequestSchema,
  routePattern,
  setClientAppStatusRequestSchema,
  updateClientAppRequestSchema,
  uploadClientAppImageRequestSchema,
  type ClientAppDeletedResponse,
  type ClientAppListResponse,
  type ClientAppResponse,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, assertOriginAllowed, requireSessionToken } from './authenticated-request.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type { ClientAppRecord } from '../../modules/control/client-apps/application/ports.js';

/**
 * The tenant's client apps over HTTP, at `/client-apps` (WP-A10).
 *
 * One read and four writes — create, edit, enable/disable and delete — for the reason the
 * FAQ controller gives: rewording an entry, hiding it and removing it are different
 * operator decisions with different audit rows. HF-A10 adds the picture: its bytes for
 * the preview, its upload and its removal.
 *
 * Authentication happens here; AUTHORIZATION does not — `ClientAppService` charges
 * `client_apps.view` and `client_apps.edit` itself.
 */
@Controller(`${API_PREFIX}`)
export class ClientAppController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(CLIENT_APP_ROUTES.list)
  async list(@Req() request: FastifyRequest): Promise<ClientAppListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const items = await this.container.clientApps.listForOperator(scope, actor);
    return { items: items.map(toView) };
  }

  @Post(CLIENT_APP_ROUTES.create)
  async create(@Req() request: FastifyRequest, @Body() body: unknown): Promise<ClientAppResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const input = createClientAppRequestSchema.parse(body);
    return toView(await this.container.clientApps.create(scope, actor, input));
  }

  @Post(routePattern(CLIENT_APP_ROUTES.update, 'id'))
  async update(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ClientAppResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const input = updateClientAppRequestSchema.parse(body);
    return toView(await this.container.clientApps.update(scope, actor, { ...input, id }));
  }

  @Post(routePattern(CLIENT_APP_ROUTES.status, 'id'))
  async setStatus(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ClientAppResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const input = setClientAppStatusRequestSchema.parse(body);
    return toView(await this.container.clientApps.setStatus(scope, actor, { ...input, id }));
  }

  @Post(routePattern(CLIENT_APP_ROUTES.remove, 'id'))
  async remove(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ClientAppDeletedResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const input = deleteClientAppRequestSchema.parse(body);
    return this.container.clientApps.remove(scope, actor, { ...input, id });
  }

  /**
   * HF-A10 — the stored picture's bytes, for the editor's preview (`<img src>` on this
   * origin, which the Web Admin's `img-src 'self'` admits).
   *
   * Served as the type the SERVICE verified against the file's magic number when it was
   * stored — PNG or JPEG, never a type the uploader chose — with `nosniff`, `inline`, and
   * this API's own `default-src 'none'` policy, so a file opened on its own is an image
   * and nothing else. `@Res()` because a returned `Buffer` would be JSON-serialised.
   */
  @Get(routePattern(CLIENT_APP_ROUTES.image, 'id'))
  async image(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param('id') id: string,
  ): Promise<void> {
    const { scope, actor } = await this.authenticate(request);
    const content = await this.container.clientApps.imageForOperator(scope, actor, id);
    await reply
      .header('content-type', content.mimeType)
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', 'inline')
      .header('content-length', String(content.bytes.byteLength))
      .header('cache-control', 'no-store')
      .send(Buffer.from(content.bytes));
  }

  @Post(routePattern(CLIENT_APP_ROUTES.image, 'id'))
  async uploadImage(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ClientAppResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const input = uploadClientAppImageRequestSchema.parse(body);
    return toView(await this.container.clientApps.uploadImage(scope, actor, { ...input, id }));
  }

  @Post(routePattern(CLIENT_APP_ROUTES.clearImage, 'id'))
  async clearImage(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ClientAppResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const input = clearClientAppImageRequestSchema.parse(body);
    return toView(await this.container.clientApps.clearImage(scope, actor, { ...input, id }));
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
    // `botInstanceId: null`: the apps belong to the TENANT; every bot it runs offers them.
    return {
      scope: { tenantId: admin.tenantId, botInstanceId: null },
      actor: adminActor(admin, correlationId, request, session.id),
    };
  }

  private get isProduction(): boolean {
    return this.container.config.NODE_ENV === 'production';
  }
}

/** The wire shape, `clientAppSchema`. A write answers with the ROW, unwrapped. */
function toView(row: ClientAppRecord): ClientAppResponse {
  return {
    id: row.id,
    platform: row.platform,
    name: row.name,
    icon: row.icon,
    description: row.description,
    officialUrl: row.officialUrl,
    alternativeUrl: row.alternativeUrl,
    helpUrl: row.helpUrl,
    guide: row.guide,
    deliveryKinds: [...row.deliveryKinds],
    protocols: [...row.protocols],
    providerTypes: [...row.providerTypes],
    status: row.status,
    sortOrder: row.sortOrder,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    image:
      row.image === null
        ? null
        : {
            mimeType: row.image.mimeType,
            byteLength: row.image.byteLength,
            width: row.image.width,
            height: row.image.height,
            sha256: row.image.sha256,
            updatedAt: row.image.updatedAt.toISOString(),
          },
  };
}
