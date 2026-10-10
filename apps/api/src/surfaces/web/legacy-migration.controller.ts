import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  errors,
  LEGACY_MIGRATION_DECISIONS_MAX_BYTES,
  LEGACY_MIGRATION_HTTP_ERROR_CODES,
  LEGACY_MIGRATION_ROUTES,
  legacyMigrationListQuerySchema,
  routePattern,
  type LegacyMigrationCapabilitiesResponse,
  type LegacyMigrationImportListResponse,
  type LegacyMigrationImportResponse,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, assertOriginAllowed, requireSessionToken } from './authenticated-request.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';

/**
 * Mirza `.nxpkg` importer over HTTP — the Web Admin «مهاجرت از میرزا»
 * (`docs/legacy-migration/nxpkg-importer.md` §8).
 *
 * Authentication here; AUTHORIZATION in `LegacyMigrationService`, which checks
 * `legacy.migration.view` / `.manage` / the CRITICAL `.apply` itself and again inside each
 * write's transaction. The views are built by the service's `legacyMigrationView`, which
 * carries no key, no path on this installation's disk and no package content.
 *
 * NO REQUEST OPENS A PACKAGE. The uploads stream bytes to disk and count them; the commands
 * move a row. Verification, the dry run and the import are the `migration` process role's.
 *
 * Both uploads are a raw `application/octet-stream` body, never multipart, streamed exactly
 * as the recovery upload is: the ceiling is COUNTED (a chunked request declares no length),
 * the stream is destroyed the moment it is passed, the file is opened `wx` with mode 0600 in
 * a 0700 directory named by the server. `bootstrap.ts` raises each route's `bodyLimit` to
 * match so Fastify does not refuse first with a 413 that names a different limit.
 */
@Controller(`${API_PREFIX}`)
export class LegacyMigrationController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(LEGACY_MIGRATION_ROUTES.capabilities)
  async capabilities(@Req() request: FastifyRequest): Promise<LegacyMigrationCapabilitiesResponse> {
    const { scope, actor } = await this.authenticate(request);
    return this.service.capabilities(scope, actor);
  }

  @Get(LEGACY_MIGRATION_ROUTES.list)
  async list(
    @Req() request: FastifyRequest,
    @Query() query: unknown,
  ): Promise<LegacyMigrationImportListResponse> {
    const { scope, actor } = await this.authenticate(request);
    return this.service.list(scope, actor, legacyMigrationListQuerySchema.parse(query ?? {}));
  }

  @Get(routePattern(LEGACY_MIGRATION_ROUTES.detail, 'id'))
  async detail(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<LegacyMigrationImportResponse> {
    const { scope, actor } = await this.authenticate(request);
    return { import: await this.service.detail(scope, actor, id) };
  }

  /** The package. Nothing the client sent reaches a path; the file name is a label. */
  @Post(LEGACY_MIGRATION_ROUTES.upload)
  async upload(@Req() request: FastifyRequest): Promise<LegacyMigrationImportResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const pending = await this.service.beginUpload(scope, actor, {
      fileName: declaredFileName(request.headers['x-nexa-filename']),
    });
    let received: { bytes: number; sha256: string };
    try {
      received = await receive(
        request,
        pending.packagePath,
        this.container.config.LEGACY_MIGRATION_UPLOAD_MAX_BYTES,
        'The package is larger than this installation accepts.',
      );
    } catch (error) {
      await this.service.failUpload(pending);
      throw error;
    }
    return { import: await this.service.completeUpload(scope, actor, pending, received) };
  }

  /** The key or passphrase, once. Never echoed: the answer says only that one is held. */
  @Post(routePattern(LEGACY_MIGRATION_ROUTES.key, 'id'))
  async key(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<LegacyMigrationImportResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    return { import: await this.service.setKey(scope, actor, id, body) };
  }

  @Post(routePattern(LEGACY_MIGRATION_ROUTES.panelBindings, 'id'))
  async panelBindings(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<LegacyMigrationImportResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    return { import: await this.service.setPanelBindings(scope, actor, id, body) };
  }

  /** The converter's `ownership-decisions.json`, raw. Verified by the `migration` role only. */
  @Post(routePattern(LEGACY_MIGRATION_ROUTES.decisions, 'id'))
  async decisions(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<LegacyMigrationImportResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const pending = await this.service.beginDecisionsUpload(scope, actor, id);
    let received: { bytes: number; sha256: string };
    try {
      received = await receive(
        request,
        pending.uploadPath,
        LEGACY_MIGRATION_DECISIONS_MAX_BYTES,
        'The decisions file is larger than this installation accepts.',
      );
    } catch (error) {
      await this.service.failDecisionsUpload(pending);
      throw error;
    }
    return {
      import: await this.service.completeDecisionsUpload(scope, actor, pending, received),
    };
  }

  @Post(routePattern(LEGACY_MIGRATION_ROUTES.dryRun, 'id'))
  async dryRun(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<LegacyMigrationImportResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    return { import: await this.service.requestDryRun(scope, actor, id, body) };
  }

  @Post(routePattern(LEGACY_MIGRATION_ROUTES.approve, 'id'))
  async approve(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<LegacyMigrationImportResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    return { import: await this.service.approve(scope, actor, id, body) };
  }

  @Post(routePattern(LEGACY_MIGRATION_ROUTES.cancel, 'id'))
  async cancel(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<LegacyMigrationImportResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    return { import: await this.service.cancel(scope, actor, id, body) };
  }

  private get service() {
    return this.container.legacyMigration;
  }

  private async authenticate(
    request: FastifyRequest,
    options: { write?: boolean } = {},
  ): Promise<{ scope: TenantContext; actor: ReturnType<typeof adminActor> }> {
    const token = requireSessionToken(request, this.container.config.NODE_ENV === 'production');
    if (options.write) assertOriginAllowed(request, this.container.config.WEB_ADMIN_ORIGINS);
    const { admin, session } = await this.container.auth.authenticate(token);
    const correlationId = currentCorrelationId() ?? newCorrelationId(this.container.ids.uuid());
    return {
      scope: { tenantId: admin.tenantId, botInstanceId: null },
      actor: adminActor(admin, correlationId, request, session.id),
    };
  }
}

/** The browser's file name, URI-decoded if it can be. The service sanitises and bounds it. */
function declaredFileName(header: string | string[] | undefined): string {
  if (typeof header !== 'string') return 'package.nxpkg';
  try {
    return decodeURIComponent(header);
  } catch {
    return header;
  }
}

/**
 * Streams the request body to `path`, counting and hashing it. The SERVER's count and digest,
 * never a client's. Throws past `limit` from INSIDE the pipeline, so `pipeline` destroys both
 * ends rather than draining the socket into nothing with the partial file open.
 */
async function receive(
  request: FastifyRequest,
  path: string,
  limit: number,
  tooLarge: string,
): Promise<{ bytes: number; sha256: string }> {
  let bytes = 0;
  const digest = createHash('sha256');
  await pipeline(
    request.raw,
    async function* (chunks: AsyncIterable<Buffer>) {
      for await (const chunk of chunks) {
        bytes += chunk.length;
        if (bytes > limit) {
          throw errors.validation(LEGACY_MIGRATION_HTTP_ERROR_CODES.UPLOAD_TOO_LARGE, tooLarge);
        }
        digest.update(chunk);
        yield chunk;
      }
    },
    createWriteStream(path, { mode: 0o600, flags: 'wx' }),
  );
  if (bytes === 0) {
    throw errors.validation(
      LEGACY_MIGRATION_HTTP_ERROR_CODES.UPLOAD_EMPTY,
      'The upload was empty.',
    );
  }
  return { bytes, sha256: digest.digest('hex') };
}
