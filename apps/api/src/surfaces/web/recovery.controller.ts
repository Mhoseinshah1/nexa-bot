import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  BACKUP_ROUTES,
  CONTROL_ERROR_CODES,
  errors,
  isStorableInstant,
  PLATFORM_ERROR_CODES,
  RECOVERY_CONFIRMATION_PHRASE,
  RECOVERY_CONFIRMATION_TTL_MS,
  RECOVERY_ROUTES,
  recoveryConfirmationSchema,
  runBackupRequestSchema,
  uuidV7Schema,
  type BackupHistoryResponse,
  type BackupRunDetailResponse,
  type BackupRunSummary,
  type BackupStatusResponse,
  type RecoveryCapabilitiesResponse,
  type RecoveryDetailResponse,
  type RecoveryListResponse,
  type RecoveryRequestSummary,
  type RunBackupResponse,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, assertOriginAllowed, requireSessionToken } from './authenticated-request.js';
import { singleValued } from './query.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type { BackupRunView } from '../../modules/platform/recovery/application/backup-admin.service.js';
import type { RecoveryRequestRow } from '../../modules/platform/recovery/application/ports.js';

/**
 * Backup and disaster recovery over HTTP.
 *
 * Authentication happens here; AUTHORIZATION does not. Every method calls an
 * application service that checks the permission itself, so a second surface
 * cannot reach a different answer and no endpoint is protected merely by the Web
 * Admin not drawing a button for it.
 *
 * TWO THINGS IN THIS FILE ARE THE SECURITY BOUNDARY, and both are response
 * builders rather than guards.
 *
 * `toRunSummary` is the only thing that turns a backup run into JSON, and it
 * does NOT carry `failure_message`. That column holds an arbitrary
 * `error.message`, which is the same uncontrolled string Architecture Hardening
 * finding 18 kept out of the operator channel; the code and the stage are what
 * make a failure actionable, and the message is in the log with a correlation id
 * where shell access is needed to read it.
 *
 * `toRecoverySummary` is the only thing that turns a recovery into JSON, and it
 * does not carry `workspacePath`, `candidateDatabase`, `archiveKeyId` or the
 * confirmed session id. Two of those are paths and names on the operator's own
 * host and would be harmless; the key id names a KEK they hold, and a browser is
 * not a place where knowing it buys anything. `displacedDatabase` IS carried,
 * because after a cutover it is the one fact an operator needs and cannot derive.
 */
/*
 * The PARAMETERISED routes are literal strings, not `*_ROUTES.detail(':id')`.
 *
 * Those builders call `encodeURIComponent`, which is right for a client building
 * a URL and wrong for a route pattern: `detail(':id')` yields `/backups/%3Aid`,
 * which Nest registers verbatim and which nothing ever matches. Every endpoint
 * declared that way answered 404 while its contract route looked correct, and the
 * suite caught it on the first run. `panels.controller.ts` already does this and
 * says nothing about why; this is the note that was missing.
 *
 * The contract's builders are still the single source of truth for the SHAPE —
 * `tests/integration/web-disaster-recovery.test.ts` drives every endpoint through
 * them, so a literal here that drifts from the contract fails there.
 */
@Controller(`${API_PREFIX}`)
export class RecoveryController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  private get isProduction(): boolean {
    return this.container.config.NODE_ENV === 'production';
  }

  // --- Backups -------------------------------------------------------------

  @Get(BACKUP_ROUTES.status)
  async backupStatus(@Req() request: FastifyRequest): Promise<BackupStatusResponse> {
    const { scope, actor } = await this.authenticate(request);
    const status = await this.container.backupAdmin.status(scope, actor);
    return {
      scheduleEnabled: status.scheduleEnabled,
      intervalMs: status.intervalMs,
      lastSucceededAt: status.lastSucceededAt?.toISOString() ?? null,
      running: status.running === null ? null : toRunSummary(status.running),
      unknownDeliveries: status.unknownDeliveries,
      quiesced: status.quiesced,
    };
  }

  @Get(BACKUP_ROUTES.history)
  async backupHistory(
    @Req() request: FastifyRequest,
    @Query() query: unknown,
  ): Promise<BackupHistoryResponse> {
    const { scope, actor } = await this.authenticate(request);
    // `singleValued` first, for every parameter at once: Fastify yields an ARRAY
    // when a key repeats, and a repeated key is a malformed request rather than
    // something to pick a value out of.
    const params = singleValued(query as Record<string, unknown>);
    const page = await this.container.backupAdmin.history(scope, actor, {
      limit: pageLimit(params),
      cursor: decodeRunCursor(params.cursor),
    });
    return {
      runs: page.runs.map(toRunSummary),
      nextCursor: page.nextCursor === null ? null : encodeOpaque(page.nextCursor),
    };
  }

  @Get('backups/:id')
  async backupDetail(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<BackupRunDetailResponse> {
    const { scope, actor } = await this.authenticate(request);
    return { run: toRunSummary(await this.container.backupAdmin.detail(scope, actor, id)) };
  }

  @Post(BACKUP_ROUTES.run)
  async runBackup(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<RunBackupResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = runBackupRequestSchema.parse(body);
    const outcome = await this.container.backupAdmin.run(scope, actor, command);
    return { outcome: outcome.outcome, run: toRunSummary(outcome.run) };
  }

  /**
   * Streams the ENCRYPTED archive. Never a plaintext dump.
   *
   * The only thing on disk this endpoint can address is
   * `<BACKUP_WORK_DIR>/<run id>/archive.nxb`, and the run id is validated as a
   * UUIDv7 by the service before the path is built — so there is no argument a
   * caller can aim elsewhere, which is a property of the construction rather than
   * of a sanitiser somebody has to get right.
   *
   * `@Res()` rather than returning a value, because Nest would buffer a returned
   * stream's contents into memory and the whole point of the archive's streaming
   * format is that a database does not fit there.
   */
  @Get('backups/:id/archive')
  async downloadArchive(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param('id') id: string,
  ): Promise<void> {
    const { scope, actor } = await this.authenticate(request);
    const artifact = await this.container.backupAdmin.archivePath(scope, actor, id);
    await reply
      .header('content-type', 'application/octet-stream')
      // The filename is built from a validated uuid by the service, so it cannot
      // carry a quote, a newline or a semicolon — which is what makes this header
      // safe to assemble rather than something to escape.
      .header('content-disposition', `attachment; filename="${artifact.filename}"`)
      .header('content-length', String(artifact.bytes))
      // An encrypted database must not sit in a proxy or a browser cache.
      .header('cache-control', 'no-store')
      .send(createReadStream(artifact.path));
  }

  // --- Recovery ------------------------------------------------------------

  @Get(RECOVERY_ROUTES.capabilities)
  async capabilities(@Req() request: FastifyRequest): Promise<RecoveryCapabilitiesResponse> {
    // Authenticated, but not permission-gated: this document says what the
    // SERVER can do, not what this actor may do, and the Web Admin needs it to
    // render the refusals truthfully even for an actor who may do none of it.
    await this.authenticate(request);
    return {
      uploadEnabled: this.container.config.RECOVERY_UPLOAD_ENABLED,
      maxUploadBytes: this.container.config.RECOVERY_UPLOAD_MAX_BYTES,
      // Reported as false rather than omitted, so the Web Admin says
      // «پشتیبانی نمی‌شود» where an operator looks for it instead of leaving the
      // absence to read as an oversight. ADR-0028 § 10.
      foreignInstallationSupported: false,
      confirmationPhrase: RECOVERY_CONFIRMATION_PHRASE,
      confirmationTtlMs: RECOVERY_CONFIRMATION_TTL_MS,
    };
  }

  @Get(RECOVERY_ROUTES.list)
  async recoveries(
    @Req() request: FastifyRequest,
    @Query() query: unknown,
  ): Promise<RecoveryListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const params = singleValued(query as Record<string, unknown>);
    const page = await this.container.recoveryService.list(scope, actor, {
      limit: pageLimit(params),
      cursor: decodeRecoveryCursor(params.cursor),
    });
    return {
      recoveries: page.rows.map(toRecoverySummary),
      nextCursor: page.nextCursor === null ? null : encodeOpaque(page.nextCursor),
    };
  }

  @Get('recoveries/:id')
  async recovery(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<RecoveryDetailResponse> {
    const { scope, actor } = await this.authenticate(request);
    return {
      recovery: toRecoverySummary(await this.container.recoveryService.get(scope, actor, id)),
    };
  }

  /**
   * Receives an encrypted archive as a raw `application/octet-stream` body.
   *
   * NOT multipart. This endpoint takes exactly one file and no fields, so a
   * multipart parser would be a dependency and a parsing surface bought to decode
   * a wrapper around the only thing being sent.
   *
   * THE CEILING IS COUNTED, not declared. `content-length` is absent on a chunked
   * request, so a header check would be advisory; this counts what it writes and
   * destroys the stream the moment the limit is passed. The route's own
   * `bodyLimit` is raised to match in `bootstrap.ts`, which is what stops Fastify
   * refusing the request before the handler sees it.
   *
   * Nothing the client sent reaches a path. The directory is random and the
   * filename inside it is a constant; `x-nexa-filename` is recorded for an
   * operator to recognise their own file and is sanitised because it is rendered.
   */
  @Post(RECOVERY_ROUTES.upload)
  async upload(@Req() request: FastifyRequest): Promise<RecoveryDetailResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    if (!this.container.config.RECOVERY_UPLOAD_ENABLED) {
      throw errors.validation(
        PLATFORM_ERROR_CODES.RECOVERY_REFUSED,
        'Uploading a backup archive is disabled on this installation.',
      );
    }

    const declared = request.headers['x-nexa-filename'];
    const { request: created, workspace } = await this.container.recoveryService.beginUpload(
      scope,
      actor,
      { clientFilename: typeof declared === 'string' ? declared : 'upload.nxb' },
    );

    const limit = this.container.config.RECOVERY_UPLOAD_MAX_BYTES;
    let received = 0;
    const digest = createHash('sha256');
    try {
      await pipeline(
        request.raw,
        async function* (chunks: AsyncIterable<Buffer>) {
          for await (const chunk of chunks) {
            received += chunk.length;
            if (received > limit) {
              // Thrown from INSIDE the pipeline so `pipeline` destroys both ends:
              // returning early would leave the socket draining into nothing and
              // the partial file open, which is how an oversized upload still
              // costs what it was refused for.
              throw errors.validation(
                PLATFORM_ERROR_CODES.RECOVERY_REFUSED,
                'The uploaded archive is larger than this installation accepts.',
              );
            }
            digest.update(chunk);
            yield chunk;
          }
        },
        // 0600, and `wx` so an existing file is never overwritten: the directory
        // is freshly created and random, so a collision would mean something
        // unexpected, and silently appending to it would be worse than failing.
        createWriteStream(workspace.archivePath, { mode: 0o600, flags: 'wx' }),
      );
    } catch (error) {
      await this.container.recoveryService.failUpload(
        scope,
        created.id,
        'recovery.upload_rejected',
      );
      throw error;
    }

    if (received === 0) {
      await this.container.recoveryService.failUpload(
        scope,
        created.id,
        'recovery.upload_rejected',
      );
      throw errors.validation(
        PLATFORM_ERROR_CODES.RECOVERY_REFUSED,
        'The upload contained no bytes.',
      );
    }

    await this.container.recoveryService.completeUpload(scope, created.id, {
      sizeBytes: received,
      archiveSha256: digest.digest('hex'),
    });
    return {
      recovery: toRecoverySummary(
        await this.container.recoveryService.get(scope, actor, created.id),
      ),
    };
  }

  /**
   * Verifies the uploaded archive and restore-tests it, in one call.
   *
   * A POST with no body. It changes durable state — the request's own row — so it
   * takes the Origin check every other write takes.
   */
  @Post('recoveries/:id/verify')
  async verify(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<RecoveryDetailResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const outcome = await this.container.recoveryService.verifyAndTest(scope, actor, id);
    // A failed verification is a 200 with a FAILED row, not a 4xx. The request
    // was well-formed and the server did what was asked; what it learned is the
    // answer, and it is on the row with a safe code. A 4xx here would make the
    // Web Admin render a request failure for a successful check of a bad archive.
    return { recovery: toRecoverySummary(outcome.request) };
  }

  @Post('recoveries/:id/confirm')
  async confirm(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<RecoveryDetailResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = recoveryConfirmationSchema.parse(body);
    const confirmed = await this.container.recoveryService.confirm(scope, actor, id, {
      phrase: command.phrase,
      artifactChecksum: command.artifactChecksum,
    });
    return { recovery: toRecoverySummary(confirmed) };
  }

  /**
   * Authentication, and the scope every method here runs in.
   *
   * The INSTALLATION's primary tenant is what the session resolves to — the same
   * `admin.tenantId` every other controller uses — and the services refuse a
   * non-primary scope by returning not-found. Deciding that here would put a
   * scoping rule in a surface; the repository's predicate is what enforces it.
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

/**
 * A backup run as JSON.
 *
 * `failureMessage` is absent and that is the point — see the class docblock. The
 * `bigint` columns become strings because JSON has no bigint, and a `number`
 * would silently lose precision above 2^53 on a dump that is genuinely that
 * large.
 */
function toRunSummary(view: BackupRunView): BackupRunSummary {
  const run = view.run;
  return {
    id: run.id,
    trigger: run.trigger,
    state: run.state,
    stage: run.stage,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    dumpBytes: run.dumpBytes === null ? null : String(run.dumpBytes),
    archiveBytes: run.archiveBytes === null ? null : String(run.archiveBytes),
    checksum: run.checksum,
    verifiedAt: run.verifiedAt?.toISOString() ?? null,
    deliveryState: run.deliveryState,
    deliveryAttemptedAt: run.deliveryAttemptedAt?.toISOString() ?? null,
    /*
     * WHETHER there is a delivery detail, never the detail.
     *
     * `deliveryDetail` is an `Error.message` from the Telegram transport, which
     * for the commonest failure is `ENOENT: no such file or directory, open
     * '/var/lib/nexa/backups/<id>/archive.nxb'` — an absolute path to an
     * encrypted archive, handed to every LOW `backup.view` holder. It is the same
     * uncontrolled-message class this builder already excludes `failureMessage`
     * for; the exclusion was applied to one column and not to the one beside it.
     * The detail stays on the row and in the operational log, where
     * `opslog.view` is the permission that governs it.
     */
    deliveryDetailPresent: run.deliveryDetail !== null,
    failureCode: run.failureCode,
    cleanupOk: run.cleanupOk,
    /*
     * The COUNT of things cleanup could not remove, never their paths.
     *
     * `cleanupDetail` is the survivor list from the workspace — absolute paths to
     * UNDELETED PLAINTEXT DATABASE DUMPS. An operator needs to know some remain,
     * which the count and the flag say; where they are is an answer for the
     * operational log and the host, not for a JSON body readable with the lowest
     * permission in the catalogue and rendered into a browser.
     */
    cleanupLeftovers: run.cleanupDetail === null ? 0 : run.cleanupDetail.split(', ').length,
    archiveAvailable: view.archiveAvailable,
  };
}

/** A recovery request as JSON. See the class docblock for what is left out. */
function toRecoverySummary(row: RecoveryRequestRow): RecoveryRequestSummary {
  return {
    id: row.id,
    source: row.source,
    state: row.state,
    stage: row.stage,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    requestedBy: row.requestedByLabel,
    backupId: row.backupId,
    artifactChecksum: row.artifactChecksum,
    failureCode: row.failureCode,
    correlationId: row.correlationId,
    upload:
      row.uploadBytes === null || row.uploadSha256 === null
        ? null
        : {
            sizeBytes: Number(row.uploadBytes),
            archiveSha256: row.uploadSha256,
            clientFilename: row.clientFilename ?? '',
          },
    verification: row.verification,
    restoreTest: row.restoreTest,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    confirmationExpiresAt: row.confirmationExpiresAt?.toISOString() ?? null,
    preRestoreBackupId: row.preRestoreBackupId,
    cutoverAt: row.cutoverAt?.toISOString() ?? null,
    displacedDatabase: row.displacedDatabase,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

/**
 * The page size, parsed rather than clamped.
 *
 * Clamping rewrites a request nobody made: `limit=0` and `limit=abc` both became
 * a silent 50, so a caller could not tell a misspelled parameter from an honoured
 * one. That exact defect has a named regression on `/notifications`.
 */
const PAGE_DEFAULT = 25;
const PAGE_MAX = 100;

function pageLimit(params: Record<string, string | undefined>): number {
  const raw = params.limit;
  if (raw === undefined) return PAGE_DEFAULT;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX) {
    throw errors.validation(
      CONTROL_ERROR_CODES.INVALID_VALUE,
      `The \`limit\` must be an integer between 1 and ${String(PAGE_MAX)}.`,
    );
  }
  return limit;
}

/** Opaque across the wire, for the reason the panels cursor is. */
function encodeOpaque(raw: string): string {
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/**
 * A cursor this server did not mint is a 400, never a silent restart.
 *
 * The house rule, settled by the owner and shared with `/panels`, `/ops-log` and
 * `/notifications`: absent means the first page, valid means the next page, and
 * anything else is `control.invalid_value`. A cursor that dropped its predicate
 * would answer **200 with page one**, so a client that truncated or invented one
 * would loop on the first page for ever and never be told.
 *
 * Every component is validated because the decoded values reach a query that
 * casts them — an unvalidated id arrives at PostgreSQL as 22P02 and comes back as
 * a 500, which lets any caller turn text into an internal error by base64ing it.
 */
function decodeCursorParts(raw: string | undefined): { at: Date; id: string } | null {
  if (raw === undefined) return null;
  const bad = (why: string): Error =>
    errors.validation(CONTROL_ERROR_CODES.INVALID_VALUE, `The \`cursor\` ${why}.`, {
      // TRUNCATED. A 400 body is not a place to reflect an unbounded string the
      // caller controls.
      cursor: raw.length > 64 ? `${raw.slice(0, 64)}…` : raw,
    });
  if (raw.length > 512) throw bad('is too long');
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const separator = decoded.indexOf('|');
  if (separator <= 0) throw bad('is not a cursor this server issued');
  const at = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  // `Number.isNaN` is not the whole test: a JavaScript Date spans ±271821 years
  // and `timestamptz` does not, so `+275760-09-13T00:00:00.000Z` parses, reaches
  // the driver and raises 22008. The range rule is in the contract, shared with
  // three other cursors that each grew their own almost-right copy of it.
  if (Number.isNaN(at.getTime()) || !isStorableInstant(at)) throw bad('carries no usable instant');
  if (!uuidV7Schema.safeParse(id).success) throw bad('carries no usable id');
  return { at, id };
}

function decodeRunCursor(raw: string | undefined): { startedAt: Date; id: string } | null {
  const parts = decodeCursorParts(raw);
  return parts === null ? null : { startedAt: parts.at, id: parts.id };
}

function decodeRecoveryCursor(raw: string | undefined): { createdAt: Date; id: string } | null {
  const parts = decodeCursorParts(raw);
  return parts === null ? null : { createdAt: parts.at, id: parts.id };
}
