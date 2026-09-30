import {
  BOT_ERROR_CODES,
  errors,
  type ActorContext,
  type AuditWriter,
  type BotCommandSyncView,
  type BotInstanceId,
  type BotMenuConfigResponse,
  type CheckBotMenuResponse,
  type Clock,
  type IdempotencyStore,
  type MainMenuGate,
  type MainMenuItem,
  type MainMenuItemView,
  type BotMenuButton,
  type PermissionKey,
  type ScopeContext,
  type SyncBotMenuResponse,
  type TemplateKey,
  type TemplateValues,
  type TenantContext,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../access/application/permission-guard.js';
import { recordMutationDenial } from '../../access/application/authorized-mutation.js';
import { hashRequest } from '../../idempotency/infrastructure/drizzle-idempotency-store.js';
import type { OperationalEventRecorder } from '@nexa/contracts';
import type { BotCommandSyncService } from './bot-command-sync.service.js';
import type { CommandMenu } from './command-menu.js';

export const BOT_MENU_VIEW_PERMISSION = 'settings.view' satisfies PermissionKey;
/** The two actions use the bot's credential, the line D5 draws for the live check. */
export const BOT_MENU_OPERATE_PERMISSION = 'settings.edit' satisfies PermissionKey;

/** The keyboard's evaluator, as `MainMenuLayout` implements it. Structural, so this module imports nothing from commerce. */
export interface MainMenuReader {
  describeFor(
    scope: ScopeContext,
    options?: { readonly gatesForHidden?: boolean },
  ): Promise<
    ReadonlyArray<{
      readonly item: MainMenuItem;
      readonly button: BotMenuButton;
      readonly gate: MainMenuGate | null;
      readonly gateOpen: boolean | null;
      readonly shown: boolean;
    }>
  >;
  rowsFor(scope: ScopeContext): Promise<string[][]>;
}

export interface BotMenuServiceDeps {
  readonly guard: PermissionGuard;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly idempotency: IdempotencyStore;
  readonly clock: Clock;
  readonly settings: {
    resolve(
      scope: ScopeContext,
      key: 'bot.main_menu',
    ): Promise<{ readonly version: number | null; readonly storedValueInvalid: boolean }>;
  };
  readonly mainMenu: MainMenuReader;
  readonly templates: {
    render(scope: ScopeContext, key: TemplateKey, values: TemplateValues): Promise<string>;
    resolve(
      scope: ScopeContext,
      key: TemplateKey,
    ): Promise<{ readonly source: 'DEFAULT' | 'TENANT' }>;
  };
  /** The shared catalogue's own text for a key, in the default locale. */
  readonly defaultLabel: (key: TemplateKey) => string;
  readonly commandMenu: Pick<CommandMenu, 'desiredFor'>;
  readonly commandSync: Pick<BotCommandSyncService, 'statusFor' | 'syncNow' | 'check'>;
}

/**
 * The Web Admin's view of the whole menu configuration, and its two actions (round P).
 *
 * A READ MODEL over what already exists — the `bot.main_menu` setting, the `bot.menu.*`
 * and `bot.command.*` texts, the feature flags, the panels' trial offers, and the sync
 * rows — assembled so the page shows, for each item, the answer the keyboard itself gives
 * (`MainMenuLayout.describeFor`, the one evaluator) and, for each bot, where its command
 * menu stands. It writes the arrangement through NO path of its own: the page saves
 * `bot.main_menu` through the settings endpoint, versioned and audited there.
 *
 * `resync` and `check` charge `settings.edit`, the permission the bots page's live check
 * charges, because both use the bot's credential.
 */
export class BotMenuService {
  constructor(private readonly deps: BotMenuServiceDeps) {}

  async config(scope: TenantContext, actor: ActorContext): Promise<BotMenuConfigResponse> {
    await this.deps.guard.check(scope, actor, BOT_MENU_VIEW_PERMISSION);
    const setting = await this.deps.settings.resolve(scope, 'bot.main_menu');
    // Gates read for switched-off items too: the page previews what switching one on does.
    const described = await this.deps.mainMenu.describeFor(scope, { gatesForHidden: true });
    const items: MainMenuItemView[] = await Promise.all(
      described.map(async ({ item, button, gate, gateOpen, shown }, order) => {
        const [label, resolved] = await Promise.all([
          this.deps.templates.render(scope, button.label, {}),
          this.deps.templates.resolve(scope, button.label),
        ]);
        return {
          id: item.button,
          order,
          enabled: item.enabled,
          target: item.target,
          label: label.trim(),
          defaultLabel: this.deps.defaultLabel(button.label).trim(),
          labelOverridden: resolved.source === 'TENANT',
          appearanceSlot: item.appearanceSlot,
          defaultAppearanceSlot: button.appearanceSlot,
          wide: button.wide,
          gate,
          gateOpen,
          shownNow: shown,
        };
      }),
    );
    const [keyboard, commands, bots] = await Promise.all([
      this.deps.mainMenu.rowsFor(scope),
      this.deps.commandMenu.desiredFor(scope),
      this.deps.commandSync.statusFor(scope),
    ]);
    return {
      layout: { version: setting.version, storedValueInvalid: setting.storedValueInvalid, items },
      keyboard,
      commands: { hash: commands.hash, entries: [...commands.entries] },
      bots,
    };
  }

  /** «همگام‌سازی دوباره»: one bot, or every ACTIVE bot. Idempotent under its key. */
  async resync(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly botInstanceId: string | null },
  ): Promise<SyncBotMenuResponse> {
    await this.authorize(scope, actor, 'bot_menu.sync', input.botInstanceId);
    const requestHash = hashRequest({
      action: 'bot_menu.sync',
      botInstanceId: input.botInstanceId,
    });
    const replayed = await this.deps.idempotency.find<SyncBotMenuResponse>(
      scope,
      'WEB',
      input.idempotencyKey,
      requestHash,
    );
    if (replayed !== null) return replayed.result;

    const targets = await this.targets(scope, input.botInstanceId);
    const results = [];
    for (const bot of targets) {
      results.push(await this.deps.commandSync.syncNow(scope, bot.botInstanceId as BotInstanceId));
    }
    const response: SyncBotMenuResponse = {
      results,
      bots: await this.deps.commandSync.statusFor(scope),
    };
    await this.deps.audit.record(scope, actor, {
      action: 'bot_menu.sync',
      entityType: 'BotInstance',
      entityId: input.botInstanceId,
      before: null,
      after: {
        results: results.map(({ botInstanceId, outcome, errorCode }) => ({
          botInstanceId,
          outcome,
          errorCode,
        })),
      },
      result: results.every((one) => one.outcome !== 'FAILED') ? 'SUCCESS' : 'FAILED',
    });
    await this.deps.idempotency.remember(scope, 'WEB', input.idempotencyKey, requestHash, response);
    return response;
  }

  /** «بررسی وضعیت»: a read of what Telegram holds. Nothing is stored. */
  async check(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly botInstanceId: string | null },
  ): Promise<CheckBotMenuResponse> {
    await this.authorize(scope, actor, 'bot_menu.check', input.botInstanceId);
    const targets = await this.targets(scope, input.botInstanceId);
    const { checks, desired } = await this.deps.commandSync.check(
      scope,
      input.botInstanceId === null ? null : (targets[0]?.botInstanceId as BotInstanceId),
    );
    return { checkedAt: this.deps.clock.now().toISOString(), checks, desired: [...desired] };
  }

  /** The tenant's bots the action applies to; a bot of another tenant is `bot.not_found`. */
  private async targets(
    scope: TenantContext,
    botInstanceId: string | null,
  ): Promise<readonly BotCommandSyncView[]> {
    const bots = await this.deps.commandSync.statusFor(scope);
    if (botInstanceId === null) return bots.filter((bot) => bot.botStatus === 'ACTIVE');
    const found = bots.find((bot) => bot.botInstanceId === botInstanceId);
    if (found === undefined) {
      throw errors.notFound(BOT_ERROR_CODES.BOT_NOT_FOUND, 'No bot with that id in this tenant.');
    }
    return [found];
  }

  private async authorize(
    scope: TenantContext,
    actor: ActorContext,
    action: string,
    entityId: string | null,
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, BOT_MENU_OPERATE_PERMISSION);
    } catch (error) {
      await recordMutationDenial(
        { guard: this.deps.guard, audit: this.deps.audit, opsLog: this.deps.opsLog },
        scope,
        actor,
        BOT_MENU_OPERATE_PERMISSION,
        { action, entityType: 'BotInstance', entityId },
        error,
      );
      throw error;
    }
  }
}
