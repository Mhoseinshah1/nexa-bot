import {
  APPEARANCE_EDIT_PERMISSION,
  APPEARANCE_ERROR_CODES,
  APPEARANCE_SLOTS,
  APPEARANCE_SLOT_FALLBACKS,
  APPEARANCE_VIEW_PERMISSION,
  CONTROL_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  appearanceTestRequestSchema,
  asId,
  errors,
  isAppearanceSlot,
  resetAppearanceSlotRequestSchema,
  saveAppearanceSlotRequestSchema,
  type ActorContext,
  type AppearanceBotView,
  type AppearanceResponse,
  type AppearanceSlot,
  type AppearanceSlotMutationResponse,
  type AppearanceSlotView,
  type AppearanceTestResponse,
  type AuditWriter,
  type BotInstanceId,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type PermissionKey,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
} from '../../../platform/access/application/authorized-mutation.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  APPEARANCE_DECORATION_FAILED_CODE,
  APPEARANCE_DECORATION_OK_CODE,
  appearanceDecorationConditionKey,
} from '../../../commerce/messaging/application/appearance-conditions.js';
import type { CustomerSendConditionReader } from '../../../commerce/messaging/application/ports.js';
import type {
  AppearanceAdminReader,
  AppearanceBotRecord,
  AppearanceProbeSender,
  AppearanceRepository,
  StoredAppearanceSlot,
} from './ports.js';

/** The template the test sends. Declared once, here; the page never names a key. */
export const APPEARANCE_TEST_TEMPLATE = 'bot.appearance.test_message' as const;

export interface AppearanceServiceDeps {
  readonly repository: AppearanceRepository;
  readonly probe: AppearanceProbeSender;
  readonly admins: AppearanceAdminReader;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  /** The RAW recorder, for denials: written after the transaction has unwound. */
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  /** Whether a bot's decoration-failure condition is still open, read from the row. */
  readonly conditions: CustomerSendConditionReader;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /**
   * Told after every committed write, so this process's messenger forgets its cached
   * decoration for the tenant at once rather than in thirty seconds. Another replica
   * learns at its cache's bound, which is the stated one.
   */
  readonly invalidate?: (scope: TenantContext) => void;
}

/**
 * «ظاهر ربات» (Premium UI, `docs/premium-ui-audit.md`).
 *
 * Three writes and one read. A slot is saved whole with the version it was read at, so a
 * colleague's change in between is a conflict, not an overwrite — the settings page's own
 * rule. The test is the one write that talks to Telegram, and it does so OUTSIDE any
 * transaction, between a committed claim and a committed result, exactly as the operations
 * group's test does (`OpsGroupService.sendTest`).
 *
 * Authorization happens here, on every call, never in the controller: `settings.view`
 * reads, `settings.edit` writes and tests.
 */
export class AppearanceService {
  constructor(private readonly deps: AppearanceServiceDeps) {}

  async view(scope: TenantContext, actor: ActorContext): Promise<AppearanceResponse> {
    await this.deps.guard.check(scope, actor, APPEARANCE_VIEW_PERMISSION);
    const [stored, bots, telegramUserId] = await Promise.all([
      this.deps.repository.listSlots(scope),
      this.deps.repository.listBots(scope),
      this.operatorTelegramId(scope, actor),
    ]);
    return {
      slots: this.slotViews(stored),
      bots: bots.map(botView),
      operatorTelegramBound: telegramUserId !== null,
    };
  }

  async saveSlot(
    scope: TenantContext,
    actor: ActorContext,
    candidateSlot: string,
    input: unknown,
  ): Promise<AppearanceSlotMutationResponse> {
    const slot = this.slot(candidateSlot);
    const denial = { action: 'appearance.slot.set', entityType: 'AppearanceSlot', entityId: slot };
    await this.authorize(scope, actor, APPEARANCE_EDIT_PERMISSION, denial);
    const command = saveAppearanceSlotRequestSchema.parse(input);
    const requestHash = hashRequest({
      slot,
      customEmojiId: command.customEmojiId,
      enabled: command.enabled,
      expectedVersion: command.expectedVersion,
    });
    const replayed = await this.findReplay<AppearanceSlotMutationResponse>(
      scope,
      actor,
      command.idempotencyKey,
      requestHash,
    );
    if (replayed !== null) return replayed;

    const now = this.deps.clock.now();
    const result = await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      APPEARANCE_EDIT_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const before = await this.deps.repository.findSlot(scope, slot, tx, true);
        if ((before?.version ?? null) !== command.expectedVersion) {
          throw errors.conflict(
            CONTROL_ERROR_CODES.VERSION_CONFLICT,
            `The ${slot} icon changed while you were editing it. Reload and reapply your change.`,
            { slot, expectedVersion: command.expectedVersion },
          );
        }
        // Saving what is stored is not a change: no version bump, no audit row, no
        // colleague's expectation invalidated for nothing.
        if (
          before !== null &&
          before.customEmojiId === command.customEmojiId &&
          before.enabled === command.enabled
        ) {
          const answer = { slot: slotView(slot, before), changed: false };
          await this.remember(scope, actor, command.idempotencyKey, requestHash, answer, tx);
          return answer;
        }
        /*
         * The write carries its own predicate: an insert that DOES NOTHING on conflict, an
         * update WHERE the version is still the one read. A row that did not exist locks
         * nothing above, so two first saves both pass the check and meet here — the second
         * is a conflict, never an overwrite (Codex, PR #121, finding 3).
         */
        const fields = {
          slot,
          customEmojiId: command.customEmojiId,
          enabled: command.enabled,
          now,
          updatedByAdminId: actor.type === 'WEB_ADMIN' ? actor.id : null,
        };
        const after =
          before === null
            ? await this.deps.repository.insertSlot(
                scope,
                { id: this.deps.ids.uuid(), ...fields },
                tx,
              )
            : await this.deps.repository.updateSlot(
                scope,
                { expectedVersion: before.version, ...fields },
                tx,
              );
        if (after === null) {
          throw errors.conflict(
            CONTROL_ERROR_CODES.VERSION_CONFLICT,
            `The ${slot} icon was changed by another request. Reload and reapply your change.`,
            { slot, expectedVersion: command.expectedVersion },
          );
        }
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: denial.action,
            entityType: denial.entityType,
            entityId: slot,
            before: before === null ? null : auditFields(before),
            after: auditFields(after),
            result: 'SUCCESS',
          },
          tx,
        );
        const answer = { slot: slotView(slot, after), changed: true };
        await this.remember(scope, actor, command.idempotencyKey, requestHash, answer, tx);
        return answer;
      },
    );
    this.deps.invalidate?.(scope);
    await this.closeConditionsWhenNothingIsConfigured(scope);
    return result;
  }

  async resetSlot(
    scope: TenantContext,
    actor: ActorContext,
    candidateSlot: string,
    input: unknown,
  ): Promise<AppearanceSlotMutationResponse> {
    const slot = this.slot(candidateSlot);
    const denial = {
      action: 'appearance.slot.reset',
      entityType: 'AppearanceSlot',
      entityId: slot,
    };
    await this.authorize(scope, actor, APPEARANCE_EDIT_PERMISSION, denial);
    const command = resetAppearanceSlotRequestSchema.parse(input);
    const requestHash = hashRequest({
      slot,
      reset: true,
      expectedVersion: command.expectedVersion,
    });
    const replayed = await this.findReplay<AppearanceSlotMutationResponse>(
      scope,
      actor,
      command.idempotencyKey,
      requestHash,
    );
    if (replayed !== null) return replayed;

    const result = await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      APPEARANCE_EDIT_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const before = await this.deps.repository.findSlot(scope, slot, tx, true);
        // The version the operator read, or a stale reset would delete a colleague's newer
        // row (Codex, PR #121, finding 5). The delete carries the same predicate.
        if ((before?.version ?? null) !== command.expectedVersion) {
          throw errors.conflict(
            CONTROL_ERROR_CODES.VERSION_CONFLICT,
            `The ${slot} icon changed while you were editing it. Reload and reapply your change.`,
            { slot, expectedVersion: command.expectedVersion },
          );
        }
        const changed =
          before === null
            ? false
            : await this.deps.repository.deleteSlot(scope, slot, before.version, tx);
        if (before !== null && !changed) {
          throw errors.conflict(
            CONTROL_ERROR_CODES.VERSION_CONFLICT,
            `The ${slot} icon was changed by another request. Reload and reapply your change.`,
            { slot, expectedVersion: command.expectedVersion },
          );
        }
        if (changed && before !== null) {
          await this.deps.audit.record(
            scope,
            actor,
            {
              action: denial.action,
              entityType: denial.entityType,
              entityId: slot,
              before: auditFields(before),
              after: null,
              result: 'SUCCESS',
            },
            tx,
          );
        }
        const answer = { slot: slotView(slot, null), changed };
        await this.remember(scope, actor, command.idempotencyKey, requestHash, answer, tx);
        return answer;
      },
    );
    this.deps.invalidate?.(scope);
    await this.closeConditionsWhenNothingIsConfigured(scope);
    return result;
  }

  /**
   * «ارسال پیام آزمایشی»: ONE real message through the chosen bot to the signed-in
   * administrator's own chat, carrying every configured custom emoji, and Telegram's
   * answer recorded on that bot. Never assumed: an untested bot decorates nothing, and so
   * does one whose last test was refused.
   *
   * The request's key is CLAIMED before anything is sent and the answer stored under a key
   * of its own — two presses of one button must not send two messages, and a claim whose
   * sender died answers "in flight" for that key; a new press is a new key.
   */
  async sendTest(
    scope: TenantContext,
    actor: ActorContext,
    input: unknown,
  ): Promise<AppearanceTestResponse> {
    const denial = { action: 'appearance.test', entityType: 'BotInstance', entityId: null };
    await this.authorize(scope, actor, APPEARANCE_EDIT_PERMISSION, denial);
    const command = appearanceTestRequestSchema.parse(input);
    const botInstanceId = asId<'BotInstanceId'>(command.botInstanceId) as BotInstanceId;
    const requestHash = hashRequest({ command: 'appearance.test', botInstanceId });
    const resultKey = `${command.idempotencyKey}#result`;
    const claimed = await this.findReplay<AppearanceTestResponse | { claimed: true }>(
      scope,
      actor,
      command.idempotencyKey,
      requestHash,
    );
    if (claimed !== null) {
      const answer = await this.findReplay<AppearanceTestResponse>(
        scope,
        actor,
        resultKey,
        requestHash,
      );
      if (answer !== null) return answer;
      throw this.testInFlight(command.idempotencyKey);
    }

    const chatId = await this.operatorTelegramId(scope, actor);
    if (chatId === null) {
      throw errors.preconditionFailed(
        APPEARANCE_ERROR_CODES.ADMIN_NOT_BOUND,
        'Your administrator account has no Telegram account bound, so there is no chat to send the test to.',
      );
    }
    const bot = (await this.deps.repository.listBots(scope)).find(
      (one) => one.id === botInstanceId,
    );
    if (bot === undefined || bot.status !== 'ACTIVE') {
      throw errors.preconditionFailed(
        APPEARANCE_ERROR_CODES.BOT_NOT_ACTIVE,
        'Only an active bot of this tenant can send the test message.',
        { botInstanceId },
      );
    }
    const configured = (await this.deps.repository.listSlots(scope)).filter(
      (slot) => slot.enabled && slot.customEmojiId !== null,
    );
    if (configured.length === 0) {
      throw errors.preconditionFailed(
        APPEARANCE_ERROR_CODES.NOTHING_TO_TEST,
        'No slot carries a custom emoji yet, so a test would prove nothing. Set one first.',
      );
    }

    // The claim, committed BEFORE the Telegram call.
    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      APPEARANCE_EDIT_PERMISSION,
      { ...denial, entityId: botInstanceId },
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const stored = await this.deps.idempotency.remember(
          scope,
          actor.surface,
          command.idempotencyKey,
          requestHash,
          { claimed: true },
          tx,
        );
        if (!stored) throw this.testInFlight(command.idempotencyKey);
      },
    );

    const probed = await this.deps.probe.sendAppearanceProbe(scope, {
      chatId,
      botInstanceId,
      templateKey: APPEARANCE_TEST_TEMPLATE,
    });
    const testedAt = this.deps.clock.now();
    // A message that carried no custom emoji proves nothing — refused above, and guarded
    // here again in case the slots changed between the check and the send.
    const outcome =
      probed.outcome === 'SENT' && probed.decoratedSlots === 0
        ? { outcome: 'REJECTED' as const, errorCode: 'appearance.telegram_rejected' as const }
        : { outcome: probed.outcome, errorCode: probed.errorCode };

    const answer = await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      APPEARANCE_EDIT_PERMISSION,
      { ...denial, entityId: botInstanceId },
      async (tx) => {
        /*
         * The verdict this write replaces is read UNDER THE LOCK, here — not the `bot` read
         * before the claim and the Telegram call, which another test or a runtime refusal
         * may have moved on since (Codex, PR #121, finding 7).
         */
        const locked = await this.deps.repository.lockBot(scope, botInstanceId, tx);
        if (locked === null) {
          throw errors.preconditionFailed(
            APPEARANCE_ERROR_CODES.BOT_NOT_ACTIVE,
            'The bot is no longer this tenant\u2019s.',
            { botInstanceId },
          );
        }
        await this.deps.repository.recordTest(scope, botInstanceId, { testedAt, ...outcome }, tx);
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: denial.action,
            entityType: denial.entityType,
            entityId: botInstanceId,
            before:
              locked.test === null
                ? null
                : {
                    outcome: locked.test.outcome,
                    errorCode: locked.test.errorCode,
                    testedAt: locked.test.testedAt.toISOString(),
                  },
            after: { ...outcome, testedAt: testedAt.toISOString() },
            result: outcome.outcome === 'SENT' ? 'SUCCESS' : 'FAILED',
          },
          tx,
        );
        const response: AppearanceTestResponse = {
          bot: botView({ ...locked, test: { testedAt, ...outcome } }),
          decoratedSlots: probed.decoratedSlots,
        };
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          resultKey,
          requestHash,
          response,
          tx,
        );
        return response;
      },
    );
    this.deps.invalidate?.(scope);
    return answer;
  }

  // -------------------------------------------------------------------------

  /**
   * A runtime refusal opens one condition per bot and switches its decoration off; the
   * next accepted test closes it. With the last custom emoji removed there is nothing
   * left to test — the probe refuses `NOTHING_TO_TEST` — so the condition would stay
   * open for ever (Codex, PR #121, finding 8). When no slot carries a custom emoji any
   * more, every open one is closed here, with the same recovery the probe records: the
   * operator resolved it by taking the decoration away, which is a resolution.
   */
  private async closeConditionsWhenNothingIsConfigured(scope: TenantContext): Promise<void> {
    const configured = (await this.deps.repository.listSlots(scope)).some(
      (slot) => slot.enabled && slot.customEmojiId !== null,
    );
    if (configured) return;
    for (const bot of await this.deps.repository.listBots(scope)) {
      const dedupeKey = appearanceDecorationConditionKey(bot.id);
      if (!(await this.deps.conditions.conditionIsOpen(scope, dedupeKey))) continue;
      await this.deps.opsLog.record(scope, {
        code: APPEARANCE_DECORATION_OK_CODE,
        severity: 'INFO',
        message:
          'Every custom emoji was removed; this bot\u2019s refused decoration no longer applies.',
        context: { botInstanceId: bot.id },
        recoversCode: APPEARANCE_DECORATION_FAILED_CODE,
        recoversDedupeKey: dedupeKey,
      });
    }
  }

  private slot(candidate: string): AppearanceSlot {
    if (isAppearanceSlot(candidate)) return candidate;
    throw errors.notFound(
      APPEARANCE_ERROR_CODES.SLOT_UNKNOWN,
      `No appearance slot is called "${candidate}".`,
      { slots: APPEARANCE_SLOTS },
    );
  }

  /** Every catalogue slot, in catalogue order, with its stored row where one exists. */
  private slotViews(stored: readonly StoredAppearanceSlot[]): AppearanceSlotView[] {
    return APPEARANCE_SLOTS.map((slot) =>
      slotView(slot, stored.find((one) => one.slot === slot) ?? null),
    );
  }

  private async operatorTelegramId(
    scope: TenantContext,
    actor: ActorContext,
  ): Promise<string | null> {
    if (actor.type !== 'WEB_ADMIN' || actor.id === null) return null;
    return this.deps.admins.telegramUserIdOf(scope, actor.id);
  }

  private testInFlight(key: string) {
    return errors.conflict(
      APPEARANCE_ERROR_CODES.TEST_IN_FLIGHT,
      'A test message with this key is still being sent. Ask again for its answer.',
      { key },
    );
  }

  private async findReplay<T>(
    scope: TenantContext,
    actor: ActorContext,
    key: string,
    requestHash: string,
  ): Promise<T | null> {
    const found = await this.deps.idempotency.find<T>(scope, actor.surface, key, requestHash);
    return found ? found.result : null;
  }

  private async remember<T>(
    scope: TenantContext,
    actor: ActorContext,
    key: string,
    requestHash: string,
    result: T,
    tx: unknown,
  ): Promise<void> {
    await rememberOnce(this.deps.idempotency, scope, actor.surface, key, requestHash, result, tx);
  }

  private async assertScopeActive(scope: TenantContext, tx: TransactionScope): Promise<void> {
    if (await this.deps.scopeActivity.scopeIsActive(scope, tx)) return;
    // The ops group's answer to the same question: a stopped scope is not found.
    throw errors.notFound(
      PLATFORM_ERROR_CODES.TENANT_NOT_FOUND,
      'This scope is not accepting work.',
    );
  }

  private async authorize(
    scope: TenantContext,
    actor: ActorContext,
    permission: PermissionKey,
    denial: { action: string; entityType: string; entityId: string | null },
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, permission);
    } catch (error) {
      await recordMutationDenial(this.mutationDeps(), scope, actor, permission, denial, error);
      throw error;
    }
  }

  private mutationDeps() {
    return {
      uow: this.deps.uow,
      guard: this.deps.guard,
      audit: this.deps.audit,
      opsLog: this.deps.opsLog,
      sessions: this.deps.sessions,
      clock: this.deps.clock,
    };
  }
}

function slotView(slot: AppearanceSlot, stored: StoredAppearanceSlot | null): AppearanceSlotView {
  return {
    slot,
    fallback: APPEARANCE_SLOT_FALLBACKS[slot],
    customEmojiId: stored?.customEmojiId ?? null,
    enabled: stored?.enabled ?? true,
    version: stored?.version ?? null,
    updatedAt: stored?.updatedAt.toISOString() ?? null,
  };
}

function botView(bot: AppearanceBotRecord): AppearanceBotView {
  return {
    id: bot.id,
    username: bot.username,
    status: bot.status,
    customEmojiTest:
      bot.test === null
        ? null
        : {
            testedAt: bot.test.testedAt.toISOString(),
            outcome: bot.test.outcome,
            errorCode: bot.test.errorCode,
          },
  };
}

function auditFields(slot: StoredAppearanceSlot): Record<string, unknown> {
  return { customEmojiId: slot.customEmojiId, enabled: slot.enabled, version: slot.version };
}
