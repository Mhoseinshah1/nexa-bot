import { and, eq, ne, or } from 'drizzle-orm';
import {
  errors,
  type BotInstanceId,
  type SystemContext,
  type TenantContext,
} from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { botInstances } from '../../../../infrastructure/persistence/schema.js';
import type {
  BotBootstrapRepository,
  BotInstanceRepository,
} from '../../tenancy/application/ports.js';
import type { BotBootstrapService } from '../../tenancy/application/bot-bootstrap.service.js';
import type {
  HostedBotBinding,
  HostedBotRegistrar,
  HostedWebhookOutcome,
} from '../application/activation-ports.js';

function assertSystem(context: SystemContext): void {
  if (context.kind !== 'SYSTEM' || !context.reason.startsWith('hosting.')) {
    throw errors.internal(
      'platform.tenant_context_missing',
      'The hosting system path needs a SystemContext naming its hosting operation.',
    );
  }
}

const hostedScope = (hostedTenantId: string): TenantContext => ({
  tenantId: hostedTenantId as TenantContext['tenantId'],
  botInstanceId: null,
});

/**
 * Phase 6A PR-4 — what the creator's activation steps do INSIDE a hosted tenant
 * (`HostedBotRegistrar`), built on the code the installation's own bot already uses:
 *
 *   - the token is stored by `BotBootstrapRepository.createFromBootstrap` (the keyring's
 *     `bot_instance.token` purpose, bound to the row and the hosted tenant);
 *   - the webhook is registered by `BotBootstrapService.execute` with the token read from the
 *     row — per-bot secret, read-back verification, claim lease, all of it;
 *   - the stored token is read by `resolveToken`.
 *
 * Every method takes an explicit `SystemContext` (`hosting.activation_*`) and names the HOSTED
 * tenant in its scope: these are the statements that run in another tenant's rows, so at the
 * merge with RLS (ADR-0037) they are the ones the lead routes through the system path.
 */
export class DrizzleHostedBotRegistrar implements HostedBotRegistrar {
  constructor(
    private readonly db: Database,
    private readonly bots: BotBootstrapRepository & Pick<BotInstanceRepository, 'resolveToken'>,
    private readonly bootstrap: Pick<BotBootstrapService, 'execute'>,
  ) {}

  async identityHeldElsewhere(
    context: SystemContext,
    input: { telegramBotId: string; username: string; hostedTenantId: string },
  ): Promise<boolean> {
    assertSystem(context);
    const [row] = await this.db
      .select({ id: botInstances.id })
      .from(botInstances)
      .where(
        and(
          ne(botInstances.tenantId, input.hostedTenantId),
          or(
            eq(botInstances.telegramBotId, input.telegramBotId),
            eq(botInstances.username, input.username),
          ),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  async currentBot(
    context: SystemContext,
    hostedTenantId: string,
  ): Promise<HostedBotBinding | null> {
    assertSystem(context);
    const found = await this.bots.findBootstrapTarget(hostedScope(hostedTenantId));
    if (found === null) return null;
    return {
      botInstanceId: found.id,
      username: found.username,
      telegramBotId: found.telegramBotId ?? '',
    };
  }

  async bind(
    context: SystemContext,
    input: {
      hostedTenantId: string;
      botInstanceId: string;
      username: string;
      telegramBotId: string;
      token: string;
      now: Date;
    },
    tx: unknown,
  ) {
    assertSystem(context);
    const scope = hostedScope(input.hostedTenantId);
    // Serialises bot creation in the hosted tenant (the tenant row), like the installer.
    await this.bots.lockTenantForBotChange(scope, tx);
    const existing = await this.bots.findBootstrapTarget(scope, tx);
    if (existing !== null) {
      // Never repoints (ADR-0029): another Telegram bot — or a row that never recorded its
      // identity — is answered, not overwritten; the same bot is left exactly as it is.
      if (existing.telegramBotId !== input.telegramBotId) {
        return { outcome: 'OTHER_BOT' as const };
      }
      return {
        outcome: 'EXISTING' as const,
        binding: {
          botInstanceId: existing.id,
          username: existing.username,
          telegramBotId: input.telegramBotId,
        },
      };
    }
    await this.bots.createFromBootstrap(
      scope,
      {
        id: input.botInstanceId as BotInstanceId,
        username: input.username,
        telegramBotId: input.telegramBotId,
        token: input.token,
        now: input.now,
      },
      tx,
    );
    return {
      outcome: 'CREATED' as const,
      binding: {
        botInstanceId: input.botInstanceId,
        username: input.username,
        telegramBotId: input.telegramBotId,
      },
    };
  }

  async tokenOf(
    context: SystemContext,
    hostedTenantId: string,
    botInstanceId: string,
  ): Promise<string> {
    assertSystem(context);
    return this.bots.resolveToken(hostedScope(hostedTenantId), botInstanceId as BotInstanceId);
  }

  async registerWebhook(
    context: SystemContext,
    input: { hostedTenantId: string; origin: string },
  ): Promise<HostedWebhookOutcome> {
    assertSystem(context);
    try {
      await this.bootstrap.execute(hostedScope(input.hostedTenantId), {
        // The token is read from the row; a hosted bot always has one by now.
        token: null,
        publicBaseUrl: input.origin,
      });
      return { outcome: 'REGISTERED' };
    } catch (error) {
      // Telegram's refusal, an unreachable Telegram, a disabled webhook route: all the same
      // answer to the creator, with the cause kept for the audit trail's reader.
      return {
        outcome: 'FAILED',
        detail:
          error instanceof Error ? error.message.slice(0, 300) : 'webhook registration failed',
      };
    }
  }
}
