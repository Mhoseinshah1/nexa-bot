import {
  HOSTING_ACTIVATION_ERROR_CODES as CODES,
  HOSTING_ERROR_CODES,
  isNexaError,
  type ActorContext,
  type Clock,
  type IdGenerator,
  type TenantContext,
  type TenantId,
} from '@nexa/contracts';
import type { TenantRepository } from '../../tenancy/application/ports.js';
import type { HostedActivationService } from './hosted-activation.service.js';
import { activationError } from './hosted-activation.service.js';
import type { HostingSectionService } from './hosting-section.service.js';
import type { HostedBotRow, HostingRepository } from './ports.js';

export interface HostedRecoveryPreview {
  readonly count: number;
  readonly through: string | null;
}

export interface HostedRecoveryCandidates {
  preview(scope: TenantContext): Promise<HostedRecoveryPreview>;
  page(
    scope: TenantContext,
    after: string | null,
    through: string,
  ): Promise<readonly HostedBotRow[]>;
}

export interface HostedRecoveryResult {
  readonly hostedTenantId: string;
  readonly outcome: 'READY' | 'SKIPPED' | 'FAILED';
  readonly code: string | null;
}

const SAFE_CODES = new Set<string>([
  ...Object.values(CODES),
  ...Object.values(HOSTING_ERROR_CODES),
]);

/** Owner-authorized recovery; one bot at a time, bounded keyset pages, no new credentials. */
export class HostedWebhookRecoveryService {
  constructor(
    private readonly deps: {
      readonly candidates: HostedRecoveryCandidates;
      readonly hosting: Pick<HostingRepository, 'findHosted' | 'replaceInProgress'>;
      readonly tenants: Pick<TenantRepository, 'findById'>;
      readonly section: Pick<HostingSectionService, 'requireSection'>;
      readonly activation: Pick<HostedActivationService, 'recoverWebhook'>;
      readonly clock: Clock;
      readonly ids: IdGenerator;
    },
  ) {}

  async preview(
    scope: TenantContext,
    actor: ActorContext,
    token: string,
  ): Promise<HostedRecoveryPreview> {
    await this.deps.section.requireSection(scope, actor, token, 'hosting.activation_status');
    return this.deps.candidates.preview(scope);
  }

  async run(
    scope: TenantContext,
    actor: ActorContext,
    token: string,
    preview: HostedRecoveryPreview,
    report: (result: HostedRecoveryResult) => void,
  ): Promise<{ ready: number; skipped: number; failed: number }> {
    await this.deps.section.requireSection(scope, actor, token, 'hosting.activation_webhook');
    const totals = { ready: 0, skipped: 0, failed: 0 };
    if (preview.through === null) return totals;
    const runId = this.deps.ids.uuid();
    let after: string | null = null;
    for (;;) {
      // Revocation stops enumeration too, not just the next network step.
      await this.deps.section.requireSection(scope, actor, token, 'hosting.activation_webhook');
      const page = await this.deps.candidates.page(scope, after, preview.through);
      if (page.length === 0) return totals;
      for (const candidate of page) {
        const id = candidate.hostedTenantId;
        try {
          const eligible = () => this.requireEligible(scope, id);
          await eligible();
          await this.deps.activation.recoverWebhook(scope, actor, token, id, runId, eligible);
          await eligible();
          report({ hostedTenantId: id, outcome: 'READY', code: null });
          totals.ready += 1;
        } catch (error) {
          // Closed codes only. Telegram exceptions can contain token-bearing URLs, and even
          // a NexaError's free-form message/details are not safe terminal output.
          const code =
            isNexaError(error) && SAFE_CODES.has(error.code) ? error.code : 'CHECK_FAILED';
          const skipped = code === CODES.BOT_NOT_ACTIVE;
          report({ hostedTenantId: id, outcome: skipped ? 'SKIPPED' : 'FAILED', code });
          totals[skipped ? 'skipped' : 'failed'] += 1;
        }
      }
      after = page[page.length - 1]!.hostedTenantId;
    }
  }

  private async requireEligible(scope: TenantContext, id: string): Promise<void> {
    if (id === scope.tenantId) throw activationError(CODES.BOT_NOT_ACTIVE, 'Not a hosted tenant.');
    const row = await this.deps.hosting.findHosted(scope, id);
    if (
      row === null ||
      row.tenantId !== scope.tenantId ||
      row.state !== 'ACTIVE' ||
      row.deletedAt !== null ||
      row.purgedAt !== null ||
      (row.expiresAt !== null && row.expiresAt.getTime() <= this.deps.clock.now().getTime())
    )
      throw activationError(CODES.BOT_NOT_ACTIVE, 'The hosted bot is not eligible.');
    const tenant = await this.deps.tenants.findById(id as TenantId);
    if (
      tenant?.kind !== 'HOSTED' ||
      tenant.parentTenantId !== scope.tenantId ||
      tenant.status !== 'ACTIVE'
    ) {
      throw activationError(CODES.BOT_NOT_ACTIVE, 'The hosted tenant is not active here.');
    }
    if (await this.deps.hosting.replaceInProgress(scope, id)) {
      throw activationError(CODES.BOT_NOT_ACTIVE, 'The hosted tenant is being restored.');
    }
  }
}
