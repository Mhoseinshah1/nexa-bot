import type { BotInstanceId, DomainEvent, EventType, TenantContext } from '@nexa/contracts';
import type { EventConsumer } from '../../eventing/application/event-consumer.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { BotCommandSyncService } from './bot-command-sync.service.js';

/**
 * What queues a command sync (round P): the events after which the menu a tenant wants,
 * or the bots it wants it on, may have changed.
 *
 * A consumer, so the queueing commits with the relay's claim on the event: a DB write
 * and nothing else, which is what a consumer may do (`EventConsumer`: a transaction is
 * never held across a network call). The CALL is the lane's, on its own tick.
 *
 *  - `TemplateOverrideChanged` / `TemplateOverrideReverted` on a `bot.command.*` key —
 *    the descriptions are the tenant's texts, so this is the one event that changes
 *    what is sent; every other key is ignored here;
 *  - `SettingChanged` on `bot.main_menu` and `FeatureFlagChanged` — the brief's "menu
 *    settings change" and "feature availability change". Neither changes the command list
 *    today (`BOT_COMMANDS` is not feature-gated), so `requestSync` re-derives the digest
 *    and queues nothing when it is unchanged; if a later release gates a command, the
 *    trigger is already wired;
 *  - `BotInstanceStatusChanged` to ACTIVE and `BotInstanceRegistered` — the bot became one
 *    the lane may sync, and its registered menu is unknown or stale: queued NOW.
 *
 * A token replacement emits no event (R4: no state machine moved), so the replacement
 * queues and runs its own sync (`BotManagementService.replaceToken`).
 */
export class BotCommandSyncConsumer implements EventConsumer {
  readonly name = 'tenancy.bot_command_sync';
  readonly subscribesTo: readonly EventType[] = [
    'TemplateOverrideChanged',
    'TemplateOverrideReverted',
    'SettingChanged',
    'FeatureFlagChanged',
    'BotInstanceStatusChanged',
    'BotInstanceRegistered',
  ];

  constructor(private readonly sync: Pick<BotCommandSyncService, 'requestSync'>) {}

  async handle(event: DomainEvent, tx: TransactionScope): Promise<void> {
    if (event.tenantId === null) return;
    const scope: TenantContext = { tenantId: event.tenantId as never, botInstanceId: null };
    const payload = (event.payload ?? {}) as { key?: unknown; to?: unknown };
    switch (event.eventType) {
      case 'TemplateOverrideChanged':
      case 'TemplateOverrideReverted':
        if (typeof payload.key !== 'string' || !payload.key.startsWith('bot.command.')) return;
        await this.sync.requestSync(scope, null, { due: false }, tx);
        return;
      case 'SettingChanged':
        if (payload.key !== 'bot.main_menu') return;
        await this.sync.requestSync(scope, null, { due: false }, tx);
        return;
      case 'FeatureFlagChanged':
        await this.sync.requestSync(scope, null, { due: false }, tx);
        return;
      case 'BotInstanceStatusChanged':
        if (payload.to !== 'ACTIVE') return;
        await this.sync.requestSync(scope, event.aggregateId as BotInstanceId, { due: true }, tx);
        return;
      case 'BotInstanceRegistered':
        await this.sync.requestSync(scope, event.aggregateId as BotInstanceId, { due: true }, tx);
        return;
      default:
        return;
    }
  }
}
