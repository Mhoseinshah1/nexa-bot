import { Controller, Get, HttpCode, Inject, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  RESELLER_API_PREFIX,
  RESELLER_SELLING_ROUTES,
  type ResellerTierProgress,
  type ResellerTrialIssued,
  type ResellerTrialStatus,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { resellerCall, resellerKey } from './reseller-request.js';

/**
 * PR-5 §5.7 / §5.8 — the dashboard's «سرویس تست — امروز: x از N» card and its «ساخت تست», and
 * the «پیشرفت تا سطح بعد» card (display only).
 */
@Controller(RESELLER_API_PREFIX)
export class ResellerExtrasController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(RESELLER_SELLING_ROUTES.trial)
  async trial(@Req() request: FastifyRequest): Promise<ResellerTrialStatus> {
    const context = await resellerCall(this.container, request);
    return this.container.resellerWeb.trials.status(context);
  }

  @Post(RESELLER_SELLING_ROUTES.trial)
  @HttpCode(200)
  async createTrial(@Req() request: FastifyRequest): Promise<ResellerTrialIssued> {
    const context = await resellerCall(this.container, request);
    return this.container.resellerWeb.trials.issue(context, resellerKey(request, context, 'trial'));
  }

  @Get(RESELLER_SELLING_ROUTES.tierProgress)
  async tierProgress(@Req() request: FastifyRequest): Promise<ResellerTierProgress> {
    const context = await resellerCall(this.container, request);
    return this.container.resellerWeb.tierProgress.progress(context);
  }
}
