import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  TRIAL_OVERRIDE_PAGE_DEFAULT,
  TRIAL_RESET_PAGE_DEFAULT,
  executeTrialResetRequestSchema,
  removeTrialOverrideRequestSchema,
  setTrialOverrideRequestSchema,
  trialOverrideListQuerySchema,
  trialResetListQuerySchema,
  type CustomerTrialResponse,
  type TenantContext,
  type TrialOverrideListResponse,
  type TrialResetListResponse,
  type TrialResetPreviewResponse,
  type TrialResetResponse,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, assertOriginAllowed, requireSessionToken } from './authenticated-request.js';
import { singleValued } from './query.js';
import { decodeKeysetCursor, encodeKeysetCursor } from './keyset-cursor.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type { TrialAllowance } from '../../modules/commerce/trials/application/trial-allowance.js';
import type {
  TrialOverrideListRow,
  TrialResetPreview,
  TrialResetRecord,
} from '../../modules/commerce/trials/application/ports.js';

/**
 * Trials over HTTP for an operator (WP6-B, `docs/wp6-audit.md` §7).
 *
 * Authentication happens here and AUTHORIZATION does not: every method calls
 * `TrialAdminService`, which checks its own permission — `users.view` to read an
 * allowance, `users.trial.edit` to change one, `settings.destructive` for the reset and
 * its preview, `settings.view` for the reset history. No endpoint is protected by the
 * Web Admin not drawing a button.
 */
@Controller(`${API_PREFIX}`)
export class TrialsController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get('users/:id/trial')
  async allowance(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<CustomerTrialResponse> {
    const { scope, actor } = await this.authenticate(request);
    return { trial: toAllowance(await this.container.trialAdmin.allowance(scope, actor, id)) };
  }

  @Post('users/:id/trial/override')
  async setOverride(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CustomerTrialResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = setTrialOverrideRequestSchema.parse(body);
    const allowance = await this.container.trialAdmin.setOverride(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      customerId: id,
      limit: command.limit,
      reason: command.reason ?? null,
    });
    return { trial: toAllowance(allowance) };
  }

  @Post('users/:id/trial/override/remove')
  async removeOverride(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CustomerTrialResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = removeTrialOverrideRequestSchema.parse(body);
    const allowance = await this.container.trialAdmin.removeOverride(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      customerId: id,
      reason: command.reason ?? null,
    });
    return { trial: toAllowance(allowance) };
  }

  @Get('trials/overrides')
  async overrides(
    @Req() request: FastifyRequest,
    @Query() raw: Record<string, unknown>,
  ): Promise<TrialOverrideListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const query = singleValued(raw);
    const page = trialOverrideListQuerySchema.parse({
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
    const position = page.cursor === undefined ? null : decodeKeysetCursor(page.cursor);
    const result = await this.container.trialAdmin.listOverrides(scope, actor, {
      limit: page.limit ?? TRIAL_OVERRIDE_PAGE_DEFAULT,
      cursor: position === null ? null : { setAt: position.createdAt, customerId: position.id },
    });
    return {
      overrides: result.items.map(toOverrideRow),
      nextCursor:
        result.nextCursor === null
          ? null
          : encodeKeysetCursor({
              createdAt: result.nextCursor.setAt,
              id: result.nextCursor.customerId,
            }),
    };
  }

  /**
   * ADR-0010's dry run. A GET: it writes nothing. It still charges
   * `settings.destructive`, because a preview is only useful to someone who could act on
   * it, and the sample names customers.
   */
  @Get('trials/reset/preview')
  async preview(@Req() request: FastifyRequest): Promise<TrialResetPreviewResponse> {
    const { scope, actor } = await this.authenticate(request);
    return { preview: toPreview(await this.container.trialAdmin.previewReset(scope, actor)) };
  }

  @Post('trials/resets')
  async reset(@Req() request: FastifyRequest, @Body() body: unknown): Promise<TrialResetResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = executeTrialResetRequestSchema.parse(body);
    const recorded = await this.container.trialAdmin.executeReset(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      expectedGrants: command.expectedGrants,
      reason: command.reason,
    });
    return { reset: toReset(recorded) };
  }

  @Get('trials/resets')
  async resets(
    @Req() request: FastifyRequest,
    @Query() raw: Record<string, unknown>,
  ): Promise<TrialResetListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const query = singleValued(raw);
    const page = trialResetListQuerySchema.parse({
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
    const result = await this.container.trialAdmin.listResets(scope, actor, {
      limit: page.limit ?? TRIAL_RESET_PAGE_DEFAULT,
      cursor: page.cursor === undefined ? null : decodeKeysetCursor(page.cursor),
    });
    return {
      resets: result.items.map(toReset),
      nextCursor: result.nextCursor === null ? null : encodeKeysetCursor(result.nextCursor),
    };
  }

  private async authenticate(
    request: FastifyRequest,
    options: { write?: boolean } = {},
  ): Promise<{ scope: TenantContext; actor: ReturnType<typeof adminActor> }> {
    const token = requireSessionToken(request, this.container.config.NODE_ENV === 'production');
    if (options.write === true) {
      assertOriginAllowed(request, this.container.config.WEB_ADMIN_ORIGINS);
    }
    const { admin, session } = await this.container.auth.authenticate(token);
    const correlationId = currentCorrelationId() ?? newCorrelationId(this.container.ids.uuid());
    return {
      // A customer, and so a trial, belongs to the TENANT, not to a bot. See
      // `CustomersController.authenticate`.
      scope: { tenantId: admin.tenantId, botInstanceId: null },
      actor: adminActor(admin, correlationId, request, session.id),
    };
  }
}

function toAllowance(allowance: TrialAllowance): CustomerTrialResponse['trial'] {
  return {
    customerId: allowance.customerId,
    featureEnabled: allowance.featureEnabled,
    globalLimit: allowance.globalLimit,
    override:
      allowance.override === null
        ? null
        : { limit: allowance.override.limit, setAt: allowance.override.setAt.toISOString() },
    effectiveLimit: allowance.effectiveLimit,
    used: allowance.used,
    remaining: allowance.remaining,
  };
}

function toOverrideRow(row: TrialOverrideListRow): TrialOverrideListResponse['overrides'][number] {
  return {
    customer: row.customer,
    limit: row.limit,
    used: row.used,
    remaining: Math.max(0, row.limit - row.used),
    setAt: row.setAt.toISOString(),
  };
}

function toPreview(preview: TrialResetPreview): TrialResetPreviewResponse['preview'] {
  return {
    affectedGrants: preview.affectedGrants,
    affectedCustomers: preview.affectedCustomers,
    sample: preview.sample.map((entry) => ({ customer: entry.customer, grants: entry.grants })),
  };
}

function toReset(record: TrialResetRecord): TrialResetResponse['reset'] {
  return {
    id: record.id,
    actorAdminId: record.actorAdminId,
    reason: record.reason,
    affectedGrants: record.affectedGrants,
    affectedCustomers: record.affectedCustomers,
    createdAt: record.createdAt.toISOString(),
  };
}
