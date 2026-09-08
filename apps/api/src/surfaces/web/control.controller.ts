import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  CONTROL_ERROR_CODES,
  errors,
  type FeatureFlagListResponse,
  type FeatureFlagResponse,
  type NotificationDetailResponse,
  type SendTestNotificationResponse,
  type NotificationListResponse,
  type OperationalEventListResponse,
  type PreviewTemplateResponse,
  type FeatureFlagWriteResponse,
  type ResolvedSettingResponse,
  type SettingListResponse,
  type SettingWriteResponse,
  type TemplateListResponse,
  type TemplateRevisionListResponse,
  type TemplateViewResponse,
  type TemplateWriteResponse,
  type SystemReadinessResponse,
  type MonitorProfileResponse,
  type TenantContext,
  uuidV7Schema,
  notificationListQuerySchema,
  NOTIFICATION_PAGE_DEFAULT,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { singleValued } from './query.js';
import { ReadinessProbe } from './readiness.probe.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import { adminActor, assertOriginAllowed, requireSessionToken } from './authenticated-request.js';
import type { ResolvedSetting } from '../../modules/control/settings/application/settings-resolver.js';
import type { ResolvedFeatureFlag } from '../../modules/control/features/application/feature-flags.service.js';
import type { TemplateView } from '../../modules/control/templates/application/template-management.service.js';
import type { OperationalEventRow } from '../../modules/platform/opslog/application/ports.js';
import {
  OPS_LOG_PAGE_DEFAULT,
  openFlag,
  opsLogPageSize,
} from '../../modules/platform/opslog/application/opslog.service.js';
import type {
  DeliveryAttemptRecord,
  NotificationIntent,
  ReleasedClaimRecord,
} from '../../modules/control/notifications/application/ports.js';

/**
 * The control plane over HTTP.
 *
 * Authentication happens here; AUTHORIZATION does not. Every method calls an
 * application service that checks the permission itself, so a Telegram admin
 * surface added later cannot reach a different answer, and no endpoint is
 * protected merely by the web app not drawing a button for it.
 *
 * There is no read that is answered from a cache and no write that reports
 * success without returning the persisted row.
 */
@Controller(`${API_PREFIX}`)
export class ControlController {
  constructor(
    @Inject(CONTAINER) private readonly container: Container,
    // Explicitly injected by token rather than by parameter type. A
    // type-only import would satisfy the lint rule and emit no runtime value
    // for `design:paramtypes`, so Nest would have nothing to resolve — the
    // fix the linter suggests here is the one that breaks dependency
    // injection at boot.
    @Inject(ReadinessProbe) private readonly probe: ReadinessProbe,
  ) {}

  private get isProduction(): boolean {
    return this.container.config.NODE_ENV === 'production';
  }

  // --- Settings ------------------------------------------------------------

  @Get('settings')
  async settings(@Req() request: FastifyRequest): Promise<SettingListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const settings = await this.container.settingsService.list(scope, actor);
    return { settings: settings.map(toSettingResponse) };
  }

  @Post('settings/:key')
  async setSetting(
    @Req() request: FastifyRequest,
    @Param('key') key: string,
    @Body() body: unknown,
  ): Promise<SettingWriteResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const result = await this.container.settingsService.set(scope, actor, {
      ...(body as Record<string, unknown>),
      key,
    });
    // The PERSISTED row, re-read inside the transaction, and whether it changed
    // anything. A response built from the request would report success for a
    // write that may not have happened — which three unrelated legacy
    // subsystems do.
    return { setting: toSettingResponse(result.setting), changed: result.changed };
  }

  // --- Feature flags -------------------------------------------------------

  @Get('features')
  async features(@Req() request: FastifyRequest): Promise<FeatureFlagListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const flags = await this.container.featureFlags.list(scope, actor);
    return { flags: flags.map(toFlagResponse) };
  }

  @Post('features/:key')
  async setFeature(
    @Req() request: FastifyRequest,
    @Param('key') key: string,
    @Body() body: unknown,
  ): Promise<FeatureFlagWriteResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const result = await this.container.featureFlags.set(scope, actor, {
      ...(body as Record<string, unknown>),
      key,
    });
    return { flag: toFlagResponse(result.flag), changed: result.changed };
  }

  // --- Templates -----------------------------------------------------------

  @Get('templates')
  async templates(@Req() request: FastifyRequest): Promise<TemplateListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const templates = await this.container.templatesService.list(scope, actor);
    return { templates: templates.map(toTemplateResponse) };
  }

  @Get('templates/:key')
  async template(
    @Req() request: FastifyRequest,
    @Param('key') key: string,
  ): Promise<TemplateViewResponse> {
    const { scope, actor } = await this.authenticate(request);
    return toTemplateResponse(await this.container.templatesService.get(scope, actor, key));
  }

  @Get('templates/:key/revisions')
  async revisions(
    @Req() request: FastifyRequest,
    @Param('key') key: string,
  ): Promise<TemplateRevisionListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const revisions = await this.container.templatesService.revisions(scope, actor, key);
    return {
      revisions: revisions.map((revision) => ({
        revision: revision.revision,
        action: revision.action,
        body: revision.body,
        createdAt: revision.createdAt.toISOString(),
        createdByAdminId: revision.createdByAdminId,
      })),
    };
  }

  @Post('templates/:key')
  async setTemplate(
    @Req() request: FastifyRequest,
    @Param('key') key: string,
    @Body() body: unknown,
  ): Promise<TemplateWriteResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const result = await this.container.templatesService.set(scope, actor, {
      ...(body as Record<string, unknown>),
      key,
    });
    return {
      template: toTemplateResponse(result.template),
      revision: result.revision,
      changed: result.changed,
    };
  }

  @Post('templates/:key/revert')
  async revertTemplate(
    @Req() request: FastifyRequest,
    @Param('key') key: string,
    @Body() body: unknown,
  ): Promise<TemplateWriteResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const result = await this.container.templatesService.revert(scope, actor, {
      ...(body as Record<string, unknown>),
      key,
    });
    return {
      template: toTemplateResponse(result.template),
      revision: result.revision,
      changed: result.changed,
    };
  }

  /**
   * Renders a body with caller-supplied sample values and stores nothing.
   *
   * A POST because it carries a body, not because it changes anything. The
   * values come from the request; they are never taken from the acting
   * administrator's own account, which is the difference between this and the
   * legacy edit screen that renders `{first_name}` as the viewer's own name.
   */
  @Post('templates/:key/preview')
  async previewTemplate(
    @Req() request: FastifyRequest,
    @Param('key') key: string,
    @Body() body: unknown,
  ): Promise<PreviewTemplateResponse> {
    // The Origin check applies even though this changes nothing. It is a POST
    // carrying a session cookie, and the cost of exempting it is a route that
    // has to be re-reasoned about every time somebody asks whether the CSRF
    // rule is "writes only" or "POSTs".
    const { scope, actor } = await this.authenticate(request, { write: true });
    const result = await this.container.templatesService.preview(scope, actor, {
      ...(body as Record<string, unknown>),
      key,
    });
    return { rendered: result.rendered, unresolved: [...result.unresolved] };
  }

  // --- System ---------------------------------------------------------------

  /**
   * Readiness with its reasons, for a signed-in administrator.
   *
   * The anonymous `/health/ready` answers with a status code and a word: it is
   * asked by a load balancer, which needs neither dependency names nor
   * latencies nor how far behind the relay is. This is where that detail went.
   *
   * It shares `ReadinessProbe` with the anonymous endpoint rather than
   * reimplementing the checks, because two readiness computations would
   * eventually disagree and the disagreement would be the outage nobody could
   * explain.
   */
  @Get('system/readiness')
  async systemReadiness(@Req() request: FastifyRequest): Promise<SystemReadinessResponse> {
    await this.authenticate(request);
    const { degraded, dependencies } = await this.probe.run();
    // 200 even when degraded. A 503 here would be a broken API call to the
    // screen asking the question, and that screen's job is to display the bad
    // news rather than to fail with it — the verdict is in the body.
    return { status: degraded ? 'degraded' : 'ok', dependencies };
  }

  /**
   * What the background panel monitor is configured to do.
   *
   * Read-only. The cadence and the two capacity ceilings come from the
   * application service, which computes them with the same functions the
   * monitor's own capacity conditions use — so the screen and the alarm cannot
   * disagree about whether a fleet fits.
   */
  @Get('system/monitor')
  async systemMonitor(@Req() request: FastifyRequest): Promise<MonitorProfileResponse> {
    const { scope, actor } = await this.authenticate(request);
    return { monitor: await this.container.monitorProfileService.read(scope, actor) };
  }

  // --- Operational events --------------------------------------------------

  @Get('ops-log')
  async opsLog(
    @Req() request: FastifyRequest,
    @Query() raw: Record<string, unknown>,
  ): Promise<OperationalEventListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const query = singleValued(raw);
    // The size the caller asked for, so the OVER-FETCH below can tell a full
    // last page from a full page with more behind it. Kept in one place: a
    // second spelling of the default would make the pager offer a page that is
    // not there, or hide one that is.
    // `=== undefined`, like every filter below it. `?limit=` is an empty
    // string and was falsy, so it answered 200 with the default page while
    // `?limit=0`, `?limit=-1` and `?limit=many` were all 400 — the same
    // parameter on the same call, an empty value treated as unsent. It is the
    // sixth sibling of the five corrected a round earlier, and the
    // `notifications` reader below already spelled it this way.
    const size =
      query.limit === undefined ? OPS_LOG_PAGE_DEFAULT : opsLogPageSize.parse(query.limit);
    const found = await this.container.opsLogService.list(scope, actor, {
      // ONE MORE than the caller wants. `found.length === size` cannot
      // distinguish "exactly a page" from "a page and more"; asking for
      // `size + 1` and returning `size` makes `nextCursor` mean what it says.
      limit: size + 1,
      /*
       * PRESENT or ABSENT, never "truthy or absent".
       *
       * `?code=` is an empty string, which is falsy, so every one of these
       * dropped the key and the read widened to the whole log — a malformed
       * filter answering 200 with MORE than was asked for. The `open`
       * parameter below was moved to `=== undefined` for exactly this reason
       * one round earlier and these four were left behind, which is this
       * branch's own recurring defect: the rule applied where the author was
       * looking and absent four lines up.
       *
       * `severity=` now reaches the enum and is refused; `code=` reaches
       * `min(1)` and is refused; the two timestamps are parsed here rather
       * than handed to `new Date('')`, which is an Invalid Date and a 500.
       */
      ...(query.code === undefined ? {} : { code: query.code }),
      ...(query.severity === undefined ? {} : { severities: query.severity.split(',') }),
      ...dateParam('since', query.since),
      ...dateParam('until', query.until),
      // The cursor: the `lastSeenAt` of the oldest row already shown, plus its
      // id. Rows are ordered by that pair descending, so "older than this" is
      // the next page. An offset would have skipped and duplicated rows as
      // events were recorded underneath the reader; the id breaks ties, without
      // which a group of rows sharing one timestamp is split across the
      // boundary and its tail appears on no page at all.
      //
      // PARSED, not cast. `new Date('x')` is an Invalid Date that reaches the
      // driver and answers 500 where the caller sent a bad query parameter and
      // deserves a 400.
      ...cursorFrom(query.before, query.beforeId),
      // An explicit true/false, REFUSED otherwise. `query.open === 'true'`
      // silently turned `open=tru`, `open=TRUE` and `open=1` into `false`, so a
      // malformed filter answered 200 with the opposite of what was asked for.
      ...(query.open === undefined ? {} : { open: openFlag.parse(query.open) }),
      // Narrows to the management-facing codes. Passed straight through and
      // validated by the service's enum, so an unknown value is a 400 rather
      // than a silent fall back to the whole log — which would show an alerts
      // page the routine stream it exists to exclude.
      // `?scope=` was falsy, so the key was dropped and the schema's `ALL`
      // default applied: `?scope=BOGUS` was a 400 and `?scope=` a 200 carrying
      // the routine stream, one line below a comment promising it could not be.
      ...(query.scope === undefined ? {} : { scope: query.scope }),
    });
    const events = found.slice(0, size);
    const oldest = found.length > size ? events[events.length - 1] : undefined;
    return {
      events: events.map(toEventResponse),
      nextCursor:
        oldest === undefined ? null : { at: oldest.lastSeenAt.toISOString(), id: oldest.id },
    };
  }

  // --- Notifications -------------------------------------------------------

  @Get('notifications')
  async notifications(
    @Req() request: FastifyRequest,
    @Query() raw: Record<string, unknown>,
  ): Promise<NotificationListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const query = singleValued(raw);
    // Parsed, not coerced-then-clamped. `Number('abc')` is NaN, and the
    // service's `Math.min(Math.max(NaN, 1), 200)` is still NaN, which reached
    // the SQL LIMIT and came back as an internal error instead of a bad
    // request; fractional, infinite, zero and negative spellings were silently
    // rewritten rather than refused.
    const { limit, before, beforeId } = notificationListQuerySchema.parse({
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.before === undefined ? {} : { before: query.before }),
      ...(query.beforeId === undefined ? {} : { beforeId: query.beforeId }),
    });
    // The page size the caller actually gets, so `nextCursor` below can say
    // whether there is another page rather than leaving the surface to guess.
    const size = limit ?? NOTIFICATION_PAGE_DEFAULT;
    const found = await this.container.notifications.list(scope, actor, {
      // ONE MORE than the caller wants — see the ops-log reader above for why
      // `found.length === size` cannot answer this question.
      limit: size + 1,
      // Both halves or neither: a timestamp without its tie-break is the
      // cursor bug this pair exists to avoid.
      ...(before !== undefined && beforeId !== undefined
        ? { before: { at: new Date(before), id: beforeId } }
        : {}),
    });
    const page = found.slice(0, size);
    const oldest = found.length > size ? page[page.length - 1] : undefined;
    return {
      notifications: page.map(toNotificationResponse),
      nextCursor:
        oldest === undefined ? null : { at: oldest.createdAt.toISOString(), id: oldest.id },
    };
  }

  @Get('notifications/:id')
  async notification(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<NotificationDetailResponse> {
    const { scope, actor } = await this.authenticate(request);
    // Validated before it can reach a UUID column. An arbitrary string was
    // compared against `notifications.id`, PostgreSQL rejected it with 22P02,
    // and a malformed identifier surfaced as a 500 rather than a bad request.
    const notificationId = uuidV7Schema.parse(id);
    const { intent, attempts, releasedClaims } = await this.container.notifications.get(
      scope,
      actor,
      notificationId,
    );
    return {
      notification: toNotificationResponse(intent),
      attempts: attempts.map(toAttemptResponse),
      releasedClaims: releasedClaims.map(toReleasedClaimResponse),
    };
  }

  /**
   * Sends a test message to the configured operations destination.
   *
   * The legacy log group has no test-send and no way to discover whether its
   * forum topic id is right — the id was never captured anywhere at all
   * (`UNK-GS-002`) — so a misconfigured destination was only found during an
   * incident.
   */
  @Post('notifications/test')
  async testNotification(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<SendTestNotificationResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    // The command returns its own attempts. Reading them through `get` here
    // needed `opslog.view`, which this endpoint does not require — so an
    // administrator holding only `settings.edit` had their test queued and was
    // then answered 403 about it, every time they retried.
    const { intent, attempts, releasedClaims, created, replayed } =
      await this.container.notifications.sendTest(scope, actor, body);
    return {
      notification: toNotificationResponse(intent),
      attempts: attempts.map(toAttemptResponse),
      releasedClaims: releasedClaims.map(toReleasedClaimResponse),
      created,
      replayed,
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

/**
 * The operational-log cursor, or a refusal.
 *
 * A query parameter is caller-controlled text; turning it into a Date without
 * checking hands the driver an Invalid Date and turns a bad request into a 500.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A timestamp query parameter: absent, or parsed and refused if malformed.
 *
 * Shares the rule `cursorFrom` applies to `before`. Written once because the
 * two call sites are adjacent and were both wrong in the same way.
 */
function dateParam(name: string, value: string | undefined): Record<string, Date> {
  if (value === undefined) return {};
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) {
    throw errors.validation(
      CONTROL_ERROR_CODES.INVALID_VALUE,
      `The \`${name}\` filter is not a timestamp.`,
      { [name]: value },
    );
  }
  return { [name]: at };
}

function cursorFrom(
  before: string | undefined,
  beforeId: string | undefined,
): { before?: Date; beforeId?: string } {
  // BOTH halves or neither, and this is checked before either is parsed. A
  // lone `before` walked the keyset with no tie-break — the exact defect the
  // pair exists to prevent — and a lone `beforeId` was dropped entirely and
  // answered with the newest page, so a client whose cursor was truncated
  // looped on page one with a 200 instead of being told.
  if ((before === undefined) !== (beforeId === undefined)) {
    throw errors.validation(
      CONTROL_ERROR_CODES.INVALID_VALUE,
      'The `before` and `beforeId` cursor halves must be supplied together.',
      { before, beforeId },
    );
  }
  if (before === undefined) return {};
  const at = new Date(before);
  if (Number.isNaN(at.getTime())) {
    throw errors.validation(
      CONTROL_ERROR_CODES.INVALID_VALUE,
      'The `before` cursor is not a timestamp.',
      { before },
    );
  }
  // The id too. `operational_events.id` is a Postgres `uuid`, so `beforeId=oops`
  // is a driver error and a 500 — in the function whose sibling line exists
  // precisely to stop a bad query parameter becoming one.
  if (beforeId !== undefined && !UUID.test(beforeId)) {
    throw errors.validation(
      CONTROL_ERROR_CODES.INVALID_VALUE,
      'The `beforeId` cursor is not an identifier.',
      { beforeId },
    );
  }
  return { before: at, ...(beforeId ? { beforeId } : {}) };
}

function toSettingResponse(setting: ResolvedSetting): ResolvedSettingResponse {
  return {
    key: setting.key,
    value: setting.value,
    source: setting.source,
    version: setting.version,
    updatedAt: setting.updatedAt?.toISOString() ?? null,
    updatedByAdminId: setting.updatedByAdminId,
    description: setting.description,
    zeroMeaning: setting.zeroMeaning,
    mutability: setting.mutability,
    classification: setting.classification,
    configures: setting.configures,
    consumer: setting.consumer,
    storedValueInvalid: setting.storedValueInvalid,
  };
}

function toFlagResponse(flag: ResolvedFeatureFlag): FeatureFlagResponse {
  return {
    key: flag.key,
    enabled: flag.enabled,
    source: flag.source,
    version: flag.version,
    updatedAt: flag.updatedAt?.toISOString() ?? null,
    updatedByAdminId: flag.updatedByAdminId,
    reason: flag.reason,
    description: flag.description,
    blastRadius: flag.blastRadius,
    configuration: flag.configuration.map((setting) => ({
      ...toSettingResponse(setting),
      inert: setting.inert,
    })),
  };
}

function toTemplateResponse(template: TemplateView): TemplateViewResponse {
  return {
    key: template.key,
    locale: template.locale,
    description: template.description,
    format: template.format,
    placeholders: template.placeholders.map((placeholder) => ({ ...placeholder })),
    maxLength: template.maxLength,
    body: template.body,
    overrideBody: template.overrideBody,
    defaultBody: template.defaultBody,
    source: template.source,
    overrideSuppressed: template.overrideSuppressed,
    version: template.version,
    revision: template.revision,
    updatedAt: template.updatedAt?.toISOString() ?? null,
    updatedByAdminId: template.updatedByAdminId,
  };
}

function toEventResponse(
  event: OperationalEventRow,
): OperationalEventListResponse['events'][number] {
  return {
    id: event.id,
    code: event.code,
    severity: event.severity,
    message: event.message,
    context: event.context,
    occurrenceCount: event.occurrenceCount,
    firstSeenAt: event.firstSeenAt.toISOString(),
    lastSeenAt: event.lastSeenAt.toISOString(),
    correlationId: event.correlationId,
    recoversCode: event.recoversCode,
    resolvedAt: event.resolvedAt?.toISOString() ?? null,
    resolvedByEventId: event.resolvedByEventId,
  };
}

/**
 * A notification as a surface may see it.
 *
 * Deliberately WITHOUT the destination and the payload. The destination
 * identifies an internal operations channel and the payload is an event's
 * message with whatever context it carried; neither is needed to answer "did
 * this go out, and if not why not", which is what this screen is for.
 */
function toNotificationResponse(
  intent: NotificationIntent,
): NotificationListResponse['notifications'][number] {
  return {
    id: intent.id,
    kind: intent.kind,
    status: intent.status,
    templateKey: intent.templateKey,
    attemptCount: intent.attemptCount,
    maxAttempts: intent.maxAttempts,
    createdAt: intent.createdAt.toISOString(),
    lastAttemptAt: intent.lastAttemptAt?.toISOString() ?? null,
    completedAt: intent.completedAt?.toISOString() ?? null,
    correlationId: intent.correlationId,
  };
}

function toReleasedClaimResponse(
  claim: ReleasedClaimRecord,
): NotificationDetailResponse['releasedClaims'][number] {
  return {
    attemptNumber: claim.attemptNumber,
    releasedAt: claim.releasedAt.toISOString(),
    reason: claim.reason,
  };
}

function toAttemptResponse(
  attempt: DeliveryAttemptRecord,
): NotificationDetailResponse['attempts'][number] {
  return {
    attemptNumber: attempt.attemptNumber,
    transport: attempt.transport,
    outcome: attempt.outcome,
    startedAt: attempt.startedAt.toISOString(),
    finishedAt: attempt.finishedAt.toISOString(),
    errorCode: attempt.errorCode,
    errorMessage: attempt.errorMessage,
    retryAfterMs: attempt.retryAfterMs,
  };
}
