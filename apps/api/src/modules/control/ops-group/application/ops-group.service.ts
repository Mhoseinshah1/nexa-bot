import {
  errors,
  issueOpsConnectCodeRequestSchema,
  normaliseOpsConnectCode,
  opsGroupActionRequestSchema,
  opsLogTopicForCode,
  OPS_CONNECT_ADMIN_RIGHTS,
  OPS_CONNECT_CODE_TTL_MINUTES,
  OPS_CONNECT_COMMAND,
  OPS_CONNECT_START_PREFIX,
  OPS_GROUP_ERROR_CODES,
  OPS_LOG_TOPIC_CATEGORIES,
  OPS_LOG_TOPIC_NAME_TEMPLATES,
  PLATFORM_ERROR_CODES,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdempotencyStore,
  type IdGenerator,
  type Logger,
  type OperationalEventRecorder,
  type OpsConnectCodeResponse,
  type OpsGroupRequeueResponse,
  type OpsGroupTestResponse,
  type OpsLogGroupHealth,
  type OpsLogGroupProblem,
  type OpsLogGroupView,
  type OpsLogTopicCategory,
  type PermissionKey,
  type ScopeContext,
  type SettingKey,
  type TemplateKey,
  type UnitOfWork,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
} from '../../../platform/access/application/authorized-mutation.js';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { FeatureFlagResolver } from '../../features/application/feature-flags.service.js';
import type { SettingsResolver } from '../../settings/application/settings-resolver.js';
import type { TemplateResolver } from '../../templates/application/template-resolver.js';
import type {
  NotificationRepository,
  OpsGroupDestinationReader,
  OpsTopicRoute,
  OpsTopicRouter,
} from '../../notifications/application/ports.js';
import { hashOpsConnectCode, newOpsConnectCode } from './connect-code.js';
import type {
  OpsGroupBots,
  OpsGroupRecord,
  OpsGroupRepository,
  OpsGroupTelegram,
} from './ports.js';
import type { OpsTopicProvisioner } from './topic-provisioner.js';
import { claimedBotId } from '../../../platform/tenancy/domain/bot-readiness.js';

/**
 * The permissions, each an existing key — the precedent WP13 set for bots, and for the same
 * reason: a new key needs a backfill, and these already mean exactly this. Configuring the
 * operations destination has always been `settings.edit` (the test send charges it);
 * reading its state is `settings.view`. Background work holds `maintenance.run` only.
 */
export const OPS_GROUP_VIEW_PERMISSION = 'settings.view' satisfies PermissionKey;
export const OPS_GROUP_MANAGE_PERMISSION = 'settings.edit' satisfies PermissionKey;
export const OPS_GROUP_SYSTEM_PERMISSION = 'maintenance.run' satisfies PermissionKey;

/** How long a group with a problem waits before the worker checks it again. */
export const OPS_GROUP_PROBLEM_RECHECK_MS = 5 * 60_000;

/** How many preserved notifications one requeue moves. The rest wait for the next one. */
export const OPS_GROUP_REQUEUE_LIMIT = 5_000;

/** Telegram member statuses that mean the bot is no longer in the chat. */
const GONE_STATUSES = new Set(['left', 'kicked']);

export interface OpsGroupServiceDeps {
  readonly repository: OpsGroupRepository;
  readonly telegram: OpsGroupTelegram;
  readonly bots: OpsGroupBots;
  readonly provisioner: OpsTopicProvisioner;
  readonly notifications: Pick<NotificationRepository, 'requeuePreserved' | 'opsQueueCounts'>;
  readonly templates: TemplateResolver;
  readonly features: FeatureFlagResolver;
  readonly settings: SettingsResolver;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  /** The RAW recorder, for denials: written after the transaction has unwound. */
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
}

/** What the worker's or an operator's permission check found. */
interface CheckFindings {
  readonly reached: boolean;
  readonly health: OpsLogGroupHealth;
  readonly problems: readonly OpsLogGroupProblem[];
  readonly botMemberStatus: string | null;
  readonly title: string | null;
}

/** What a binding attempt from the group decided. */
export type OpsBindOutcome = 'CONNECTED' | 'REFUSED' | 'NOT_FORUM';

/**
 * The Nexa-managed operations log group (WP-A4).
 *
 * Three callers, one service:
 *
 *   - the Web Admin panel «گروه گزارش‌های مدیریتی»: read the state, issue a connection code,
 *     check permissions, send a test, reconnect, disconnect, and retry preserved messages;
 *   - the Telegram webhook: a group that sent a valid code is bound, and a change to the
 *     bot's membership marks the group for a new check;
 *   - the worker: checks a newly bound or broken group, creates the topics Nexa owns, and
 *     retries the preserved messages once the group is healthy.
 *
 * And, through `OpsGroupRouter`, the notification dispatcher.
 */
export class OpsGroupService {
  constructor(private readonly deps: OpsGroupServiceDeps) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async view(scope: ScopeContext, actor: ActorContext): Promise<OpsLogGroupView> {
    await this.deps.guard.check(scope, actor, OPS_GROUP_VIEW_PERMISSION);
    return this.snapshot(scope);
  }

  // -------------------------------------------------------------------------
  // Web Admin actions
  // -------------------------------------------------------------------------

  /**
   * «اتصال گروه تلگرام»: a one-time code for one of the tenant's bots.
   *
   * The code is returned ONCE and stored only as a hash. The operator either opens the
   * deep link (Telegram adds the bot to a group they choose, asks for the admin rights,
   * and posts `/start ops-<code>` there) or types `/connect_ops <code>` in the group.
   */
  async issueConnectCode(
    scope: ScopeContext,
    actor: ActorContext,
    input: unknown,
  ): Promise<OpsConnectCodeResponse> {
    const denial = { action: 'ops_group.connect_code', entityType: 'OpsLogGroup', entityId: null };
    await this.authorize(scope, actor, OPS_GROUP_MANAGE_PERMISSION, denial);
    const command = issueOpsConnectCodeRequestSchema.parse(input);

    const requestHash = hashRequest({
      command: 'ops_group.connect_code',
      botInstanceId: command.botInstanceId,
    });
    const replay = await this.deps.idempotency.find<OpsConnectCodeResponse>(
      scope,
      actor.surface,
      command.idempotencyKey,
      requestHash,
    );
    if (replay) return replay.result;

    const bot = (await this.deps.bots.activeBots(scope)).find(
      (candidate) => candidate.id === command.botInstanceId,
    );
    if (bot === undefined) {
      throw errors.validation(
        OPS_GROUP_ERROR_CODES.BOT_NOT_AVAILABLE,
        'That is not one of this tenant’s active bots.',
      );
    }
    // The code records WHO issued it, and that is an administrator by construction: this
    // permission is held by no other actor type (SYSTEM_JOB holds `maintenance.run` only).
    const adminId = actor.id;
    if ((actor.type !== 'WEB_ADMIN' && actor.type !== 'TELEGRAM_ADMIN') || adminId === null) {
      throw errors.permissionDenied(
        PLATFORM_ERROR_CODES.PERMISSION_DENIED,
        'A connection code is issued to an administrator.',
        { permission: OPS_GROUP_MANAGE_PERMISSION },
      );
    }

    const code = newOpsConnectCode();
    const now = this.deps.clock.now();
    const expiresAt = new Date(now.getTime() + OPS_CONNECT_CODE_TTL_MINUTES * 60_000);
    const response: OpsConnectCodeResponse = {
      code,
      // Addressed to the bot by name: with privacy mode on, a group delivers a bare
      // command only to the last bot that spoke there.
      command: `/${OPS_CONNECT_COMMAND}@${bot.username} ${code}`,
      deepLink:
        `https://t.me/${bot.username}?startgroup=${OPS_CONNECT_START_PREFIX}${code}` +
        `&admin=${OPS_CONNECT_ADMIN_RIGHTS}`,
      expiresAt: expiresAt.toISOString(),
      botUsername: bot.username,
    };

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      OPS_GROUP_MANAGE_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const id = this.deps.ids.uuid();
        await this.deps.repository.insertCode(
          scope,
          {
            id,
            botInstanceId: bot.id,
            codeHash: hashOpsConnectCode(code),
            issuedByAdminId: adminId,
            issuedAt: now,
            expiresAt,
          },
          tx,
        );
        // The fact of the code, never the code.
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'ops_group.connect_code',
            entityType: 'OpsLogGroup',
            entityId: null,
            before: null,
            after: { codeId: id, botInstanceId: bot.id, expiresAt: expiresAt.toISOString() },
            result: 'SUCCESS',
          },
          tx,
        );
        // The replay answers with the same code for its ten minutes: a double-clicked
        // button must not leave two live codes and a screen showing the wrong one.
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          command.idempotencyKey,
          requestHash,
          response,
          tx,
        );
        return response;
      },
    );
  }

  /** «بررسی دسترسی‌ها»: ask Telegram, create any topic that is owed, record what is true. */
  async verify(scope: ScopeContext, actor: ActorContext, input: unknown): Promise<OpsLogGroupView> {
    const denial = { action: 'ops_group.verify', entityType: 'OpsLogGroup', entityId: null };
    await this.authorize(scope, actor, OPS_GROUP_MANAGE_PERMISSION, denial);
    const command = opsGroupActionRequestSchema.parse(input);
    const requestHash = hashRequest({ command: 'ops_group.verify' });
    const replay = await this.findReplay<OpsLogGroupView>(scope, actor, command, requestHash);
    if (replay !== null) return replay;

    const group = await this.requireConnected(scope);
    const findings = await this.check(scope, actor, group, OPS_GROUP_MANAGE_PERMISSION);
    await this.commitFindings(scope, actor, group, findings, OPS_GROUP_MANAGE_PERMISSION, {
      idempotencyKey: command.idempotencyKey,
      requestHash,
    });
    return this.remembered<OpsLogGroupView>(scope, actor, command, requestHash);
  }

  /** «ارسال پیام آزمایشی»: one message into each topic Nexa owns, recreating a missing one. */
  async sendTest(
    scope: ScopeContext,
    actor: ActorContext,
    input: unknown,
  ): Promise<OpsGroupTestResponse> {
    const denial = { action: 'ops_group.test', entityType: 'OpsLogGroup', entityId: null };
    await this.authorize(scope, actor, OPS_GROUP_MANAGE_PERMISSION, denial);
    const command = opsGroupActionRequestSchema.parse(input);
    const requestHash = hashRequest({ command: 'ops_group.test' });
    const replay = await this.findReplay<OpsGroupTestResponse>(scope, actor, command, requestHash);
    if (replay !== null) return replay;

    const group = await this.requireConnected(scope);
    if (!(await this.deps.scopeActivity.scopeIsActive(scope))) throw this.inactive();
    const token = await this.deps.bots.tokenFor(scope, group.botInstanceId);
    const results: OpsGroupTestResponse['results'][number][] = [];
    const now = this.deps.clock.now();
    for (const category of OPS_LOG_TOPIC_CATEGORIES) {
      if (token === null) {
        results.push({ category, outcome: 'FAILED', errorCode: 'telegram.no_bot_configured' });
        continue;
      }
      results.push(await this.sendTestInto(scope, actor, group, category, token, now));
    }

    const allSent = results.every((result) => result.outcome === 'SENT');
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      OPS_GROUP_MANAGE_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'ops_group.test',
            entityType: 'OpsLogGroup',
            entityId: group.id,
            before: null,
            after: { results },
            result: 'SUCCESS',
          },
          tx,
        );
        // A test that reached every topic proves the problem is fixed: what was preserved
        // unsent goes out again, which is the brief's "retry after a successful test".
        if (allSent) await this.requeueInside(scope, actor, group, tx, 'test');
        const response: OpsGroupTestResponse = {
          opsGroup: await this.snapshot(scope, tx),
          results,
        };
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          command.idempotencyKey,
          requestHash,
          response,
          tx,
        );
        return response;
      },
    );
  }

  /**
   * «اتصال مجدد»: bring the SAME group back — after a disconnect, after the bot was
   * re-added or its rights restored, or after a topic was deleted. Reactivates the binding
   * when it was disconnected, checks it, recreates any topic that is owed, and retries the
   * preserved messages once it is healthy. A different group needs a new connection code.
   */
  async reconnect(
    scope: ScopeContext,
    actor: ActorContext,
    input: unknown,
  ): Promise<OpsLogGroupView> {
    const denial = { action: 'ops_group.reconnect', entityType: 'OpsLogGroup', entityId: null };
    await this.authorize(scope, actor, OPS_GROUP_MANAGE_PERMISSION, denial);
    const command = opsGroupActionRequestSchema.parse(input);
    const requestHash = hashRequest({ command: 'ops_group.reconnect' });
    const replay = await this.findReplay<OpsLogGroupView>(scope, actor, command, requestHash);
    if (replay !== null) return replay;

    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      OPS_GROUP_MANAGE_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const locked = await this.deps.repository.lockGroup(scope, tx);
        if (locked === null) throw this.notConnected();
        if (locked.status === 'CONNECTED') return;
        const moved = await this.deps.repository.transitionGroup(
          scope,
          { from: 'DISCONNECTED', to: 'CONNECTED', now: this.deps.clock.now() },
          tx,
        );
        if (!moved) throw this.notConnected();
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'ops_group.reconnect',
            entityType: 'OpsLogGroup',
            entityId: locked.id,
            before: { status: 'DISCONNECTED' },
            after: { status: 'CONNECTED' },
            result: 'SUCCESS',
          },
          tx,
        );
        await this.deps.outbox.write(tx, actor, {
          eventType: 'OpsLogGroupChanged',
          aggregateType: 'OpsLogGroup',
          aggregateId: locked.id,
          payload: { change: 'RECONNECTED', botInstanceId: locked.botInstanceId },
        });
      },
    );

    const group = await this.requireConnected(scope);
    const findings = await this.check(scope, actor, group, OPS_GROUP_MANAGE_PERMISSION);
    await this.commitFindings(scope, actor, group, findings, OPS_GROUP_MANAGE_PERMISSION, {
      idempotencyKey: command.idempotencyKey,
      requestHash,
    });
    return this.remembered<OpsLogGroupView>(scope, actor, command, requestHash);
  }

  /**
   * «قطع اتصال»: stop posting to the group. The row, its topics and its history stay, so
   * «اتصال مجدد» can bring it back; messages queued meanwhile are kept and preserved, never
   * dropped.
   */
  async disconnect(
    scope: ScopeContext,
    actor: ActorContext,
    input: unknown,
  ): Promise<OpsLogGroupView> {
    const denial = { action: 'ops_group.disconnect', entityType: 'OpsLogGroup', entityId: null };
    await this.authorize(scope, actor, OPS_GROUP_MANAGE_PERMISSION, denial);
    const command = opsGroupActionRequestSchema.parse(input);
    const requestHash = hashRequest({ command: 'ops_group.disconnect' });
    const replay = await this.findReplay<OpsLogGroupView>(scope, actor, command, requestHash);
    if (replay !== null) return replay;

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      OPS_GROUP_MANAGE_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const locked = await this.deps.repository.lockGroup(scope, tx);
        if (locked === null) throw this.notConnected();
        if (locked.status === 'CONNECTED') {
          const moved = await this.deps.repository.transitionGroup(
            scope,
            { from: 'CONNECTED', to: 'DISCONNECTED', now: this.deps.clock.now() },
            tx,
          );
          if (!moved) throw this.notConnected();
          await this.deps.audit.record(
            scope,
            actor,
            {
              action: 'ops_group.disconnect',
              entityType: 'OpsLogGroup',
              entityId: locked.id,
              before: { status: 'CONNECTED' },
              after: { status: 'DISCONNECTED' },
              result: 'SUCCESS',
            },
            tx,
          );
          await this.deps.outbox.write(tx, actor, {
            eventType: 'OpsLogGroupChanged',
            aggregateType: 'OpsLogGroup',
            aggregateId: locked.id,
            payload: { change: 'DISCONNECTED', botInstanceId: locked.botInstanceId },
          });
        }
        const view = await this.snapshot(scope, tx);
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          command.idempotencyKey,
          requestHash,
          view,
          tx,
        );
        return view;
      },
    );
  }

  /**
   * «ارسال مجدد گزارش‌های ارسال‌نشده»: every preserved message back in the queue, each with a
   * fresh allowance. Nothing was deleted and nothing was filed as sent, so this is always
   * safe to press — at worst it spends ten more attempts on a group that is still broken.
   */
  async requeue(
    scope: ScopeContext,
    actor: ActorContext,
    input: unknown,
  ): Promise<OpsGroupRequeueResponse> {
    const denial = { action: 'ops_group.requeue', entityType: 'OpsLogGroup', entityId: null };
    await this.authorize(scope, actor, OPS_GROUP_MANAGE_PERMISSION, denial);
    const command = opsGroupActionRequestSchema.parse(input);
    const requestHash = hashRequest({ command: 'ops_group.requeue' });
    const replay = await this.findReplay<OpsGroupRequeueResponse>(
      scope,
      actor,
      command,
      requestHash,
    );
    if (replay !== null) return replay;

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      OPS_GROUP_MANAGE_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const group = await this.deps.repository.lockGroup(scope, tx);
        if (group === null || group.status !== 'CONNECTED') throw this.notConnected();
        const requeued = await this.requeueInside(scope, actor, group, tx, 'operator');
        const response: OpsGroupRequeueResponse = {
          opsGroup: await this.snapshot(scope, tx),
          requeued,
        };
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          command.idempotencyKey,
          requestHash,
          response,
          tx,
        );
        return response;
      },
    );
  }

  // -------------------------------------------------------------------------
  // The Telegram webhook
  // -------------------------------------------------------------------------

  /**
   * A group sent a connection code: `/start ops-<code>` from the deep link, or
   * `/connect_ops <code>`.
   *
   * The update arrived on THIS bot's authenticated webhook route, which is what supplies
   * the tenant and the bot; the code is looked up under both, so a code issued for another
   * bot or tenant is simply not found. The chat id is read from the update — nobody typed
   * it. The code is consumed by a conditional UPDATE, once; a redelivered update replays
   * the first answer under its update key.
   *
   * Answers in the group afterwards, outside the transaction. The same sentence for every
   * refusal, so the reply is not an oracle for which codes exist.
   */
  async bindFromTelegram(
    scope: ScopeContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: string;
      readonly chat: {
        readonly id: string;
        readonly type: string;
        readonly title: string | null;
        readonly isForum: boolean;
      };
      readonly rawCode: string;
    },
  ): Promise<OpsBindOutcome> {
    const denial = { action: 'ops_group.bind', entityType: 'OpsLogGroup', entityId: null };
    await this.authorize(scope, actor, OPS_GROUP_SYSTEM_PERMISSION, denial);

    const code = normaliseOpsConnectCode(input.rawCode);
    let outcome: OpsBindOutcome;
    let replayed = false;
    if (code === null) {
      outcome = 'REFUSED';
    } else if (input.chat.type !== 'supergroup' || !input.chat.isForum) {
      // The code is left UNUSED: the operator switches topics on and sends it again.
      outcome = 'NOT_FORUM';
    } else {
      const requestHash = hashRequest({
        command: 'ops_group.bind',
        chatId: input.chat.id,
        code: hashOpsConnectCode(code),
      });
      const replay = await this.deps.idempotency.find<{ outcome: OpsBindOutcome }>(
        scope,
        actor.surface,
        input.idempotencyKey,
        requestHash,
      );
      if (replay) {
        outcome = replay.result.outcome;
        replayed = true;
      } else {
        outcome = await runAuthorizedMutation(
          this.mutationDeps(),
          scope,
          actor,
          OPS_GROUP_SYSTEM_PERMISSION,
          denial,
          async (tx) => {
            await this.assertScopeActive(scope, tx);
            const now = this.deps.clock.now();
            const consumed = await this.deps.repository.consumeCode(
              scope,
              {
                botInstanceId: input.botInstanceId,
                codeHash: hashOpsConnectCode(code),
                chatId: input.chat.id,
                now,
              },
              tx,
            );
            if (consumed === null) {
              await rememberOnce(
                this.deps.idempotency,
                scope,
                actor.surface,
                input.idempotencyKey,
                requestHash,
                { outcome: 'REFUSED' as const },
                tx,
              );
              return 'REFUSED' as const;
            }
            const before = await this.deps.repository.lockGroup(scope, tx);
            const bound = await this.deps.repository.bindGroup(
              scope,
              {
                id: before?.id ?? this.deps.ids.uuid(),
                botInstanceId: input.botInstanceId,
                chatId: input.chat.id,
                title: input.chat.title ?? '',
                connectedByAdminId: consumed.issuedByAdminId,
                now,
              },
              tx,
            );
            await this.deps.audit.record(
              scope,
              actor,
              {
                action: 'ops_group.bind',
                entityType: 'OpsLogGroup',
                entityId: bound.id,
                before:
                  before === null
                    ? null
                    : {
                        chatId: before.chatId,
                        botInstanceId: before.botInstanceId,
                        status: before.status,
                      },
                after: {
                  chatId: bound.chatId,
                  botInstanceId: bound.botInstanceId,
                  status: bound.status,
                  connectedByAdminId: consumed.issuedByAdminId,
                },
                result: 'SUCCESS',
              },
              tx,
            );
            await this.deps.outbox.write(tx, actor, {
              eventType: 'OpsLogGroupChanged',
              aggregateType: 'OpsLogGroup',
              aggregateId: bound.id,
              payload: { change: 'CONNECTED', botInstanceId: bound.botInstanceId },
            });
            await rememberOnce(
              this.deps.idempotency,
              scope,
              actor.surface,
              input.idempotencyKey,
              requestHash,
              { outcome: 'CONNECTED' as const },
              tx,
            );
            return 'CONNECTED' as const;
          },
        );
      }
    }

    // A redelivered update already had its answer posted.
    if (!replayed) await this.replyInGroup(scope, input.botInstanceId, input.chat.id, outcome);
    return outcome;
  }

  /**
   * Telegram reported a change to the bot's own membership (`my_chat_member`) in a chat.
   *
   * Only the bound group of this bot matters. Removed or banned is a problem the panel
   * shows at once; any other change — promoted, demoted, rights edited — marks the group
   * for a fresh check, because only `getChatMember` says what the rights now are.
   */
  async membershipChanged(
    scope: ScopeContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: string;
      readonly chatId: string;
      readonly status: string;
    },
  ): Promise<boolean> {
    const denial = { action: 'ops_group.membership', entityType: 'OpsLogGroup', entityId: null };
    await this.authorize(scope, actor, OPS_GROUP_SYSTEM_PERMISSION, denial);
    const group = await this.deps.repository.findGroup(scope);
    if (group === null || group.chatId !== input.chatId) return false;
    if (group.botInstanceId !== input.botInstanceId) return false;

    const requestHash = hashRequest({ command: 'ops_group.membership', status: input.status });
    const replay = await this.deps.idempotency.find<{ changed: boolean }>(
      scope,
      actor.surface,
      input.idempotencyKey,
      requestHash,
    );
    if (replay) return replay.result.changed;

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      OPS_GROUP_SYSTEM_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const now = this.deps.clock.now();
        const changed = GONE_STATUSES.has(input.status)
          ? await this.deps.repository.recordHealth(
              scope,
              {
                chatId: input.chatId,
                health: 'PROBLEM',
                problems: ['BOT_REMOVED'],
                botMemberStatus: input.status,
                title: null,
                now,
              },
              tx,
            )
          : await this.deps.repository.markUnverified(
              scope,
              { chatId: input.chatId, botInstanceId: input.botInstanceId, now },
              tx,
            );
        if (changed) {
          await this.deps.audit.record(
            scope,
            actor,
            {
              action: 'ops_group.membership',
              entityType: 'OpsLogGroup',
              entityId: group.id,
              before: { botMemberStatus: group.botMemberStatus, health: group.health },
              after: { botMemberStatus: input.status },
              result: 'SUCCESS',
            },
            tx,
          );
        }
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          input.idempotencyKey,
          requestHash,
          { changed },
          tx,
        );
        return changed;
      },
    );
  }

  // -------------------------------------------------------------------------
  // The worker
  // -------------------------------------------------------------------------

  /**
   * One maintenance pass for the tenant: a group that is UNVERIFIED, or has had a problem
   * for five minutes, is checked; topics that are owed are created; and a group that is
   * healthy again gets its preserved messages back in the queue.
   */
  async maintain(scope: ScopeContext, actor: ActorContext): Promise<'CHECKED' | 'IDLE'> {
    await this.deps.guard.check(scope, actor, OPS_GROUP_SYSTEM_PERMISSION);
    const group = await this.deps.repository.findGroup(scope);
    if (group === null || group.status !== 'CONNECTED') return 'IDLE';
    const now = this.deps.clock.now();
    const due =
      group.health === 'UNVERIFIED' ||
      (group.health === 'PROBLEM' &&
        (group.checkedAt === null ||
          group.checkedAt.getTime() <= now.getTime() - OPS_GROUP_PROBLEM_RECHECK_MS));
    if (!due) return 'IDLE';
    if (!(await this.deps.scopeActivity.scopeIsActive(scope))) return 'IDLE';

    const findings = await this.check(scope, actor, group, OPS_GROUP_SYSTEM_PERMISSION);
    await this.commitFindings(scope, actor, group, findings, OPS_GROUP_SYSTEM_PERMISSION, null);
    return 'CHECKED';
  }

  // -------------------------------------------------------------------------
  // The dispatcher's router and the lane's destination reader
  // -------------------------------------------------------------------------

  /** Where the group is now, for snapshotting a new intent. Null when none is connected. */
  async currentDestination(
    scope: ScopeContext,
    category: OpsLogTopicCategory,
    tx?: unknown,
  ): Promise<{ readonly chatId: string; readonly topicId: number | null } | null> {
    const group = await this.deps.repository.findGroup(scope, tx);
    if (group === null || group.status !== 'CONNECTED') return null;
    const topics = await this.deps.repository.listTopics(scope, group.chatId, tx);
    const topic = topics.find((candidate) => candidate.category === category);
    return {
      chatId: group.chatId,
      topicId: topic?.state === 'READY' ? topic.messageThreadId : null,
    };
  }

  /** The dispatcher's send-time resolution, creating the topic if it is owed. */
  async route(
    scope: ScopeContext,
    actor: ActorContext,
    category: OpsLogTopicCategory,
    staleThreadId: number | null,
  ): Promise<OpsTopicRoute> {
    await this.deps.guard.check(scope, actor, OPS_GROUP_SYSTEM_PERMISSION);
    const group = await this.deps.repository.findGroup(scope);
    if (group === null || group.status !== 'CONNECTED') {
      return {
        kind: 'UNAVAILABLE',
        errorCode: OPS_GROUP_ERROR_CODES.NOT_CONNECTED,
        errorMessage: 'No operations log group is connected.',
      };
    }
    const topics = await this.deps.repository.listTopics(scope, group.chatId);
    const topic = topics.find((candidate) => candidate.category === category);
    if (staleThreadId === null && topic?.state === 'READY' && topic.messageThreadId !== null) {
      return {
        kind: 'ROUTED',
        chatId: group.chatId,
        topicId: topic.messageThreadId,
        botInstanceId: group.botInstanceId,
      };
    }
    // Creating a topic is new work for the tenant; a stopped one gets none.
    if (!(await this.deps.scopeActivity.scopeIsActive(scope))) {
      return {
        kind: 'UNAVAILABLE',
        errorCode: 'tenant.not_active',
        errorMessage: 'The tenant is not accepting work.',
      };
    }
    const token = await this.deps.bots.tokenFor(scope, group.botInstanceId);
    if (token === null) {
      return {
        kind: 'UNAVAILABLE',
        errorCode: 'telegram.no_bot_configured',
        errorMessage: 'The bot bound to the operations group is not active.',
      };
    }
    const ensured = await this.deps.provisioner.ensure(
      scope,
      actor,
      group,
      category,
      token,
      staleThreadId,
    );
    if (ensured.kind === 'READY') {
      return {
        kind: 'ROUTED',
        chatId: group.chatId,
        topicId: ensured.threadId,
        botInstanceId: group.botInstanceId,
      };
    }
    return ensured.kind === 'BUSY'
      ? {
          kind: 'UNAVAILABLE',
          errorCode: 'ops_group.topic_pending',
          errorMessage: 'The topic is being created by another sender.',
        }
      : { kind: 'UNAVAILABLE', errorCode: ensured.errorCode, errorMessage: ensured.errorMessage };
  }

  async noteDelivered(
    scope: ScopeContext,
    category: OpsLogTopicCategory,
    chatId: string,
    at: Date,
  ): Promise<void> {
    await this.deps.repository.noteDelivered(scope, { chatId, category, at });
  }

  async noteProblem(
    scope: ScopeContext,
    chatId: string,
    problem: OpsLogGroupProblem,
  ): Promise<void> {
    await this.deps.repository.addProblem(scope, { chatId, problem, now: this.deps.clock.now() });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * The permission check, with Telegram, outside every transaction.
   *
   * Healthy needs all of: the bot is active, the chat is a forum supergroup, the bot is
   * an administrator (or the creator) with the right to manage topics and not restricted
   * from sending, and every topic Nexa owns exists. A transient failure (a timeout, a 5xx)
   * decides nothing: `reached` is false and the recorded health stands.
   */
  private async check(
    scope: ScopeContext,
    actor: ActorContext,
    group: OpsGroupRecord,
    permission: PermissionKey,
  ): Promise<CheckFindings> {
    await this.deps.guard.check(scope, actor, permission);
    // A check may create topics, which is new work: a stopped tenant gets none. The write
    // that records the findings checks again, inside its transaction.
    if (!(await this.deps.scopeActivity.scopeIsActive(scope))) throw this.inactive();
    const unreached: CheckFindings = {
      reached: false,
      health: group.health,
      problems: group.problems,
      botMemberStatus: group.botMemberStatus,
      title: null,
    };
    const token = await this.deps.bots.tokenFor(scope, group.botInstanceId);
    if (token === null) {
      return { ...unreached, reached: true, health: 'PROBLEM', problems: ['BOT_INACTIVE'] };
    }

    // A bot token is `<bot id>:<secret>`, so the bot's own user id is read from it; getMe
    // only for a token that does not have that shape.
    let botUserId = claimedBotId(token);
    if (botUserId === null) {
      const identity = await this.deps.telegram.botIdentity(token);
      if (identity.outcome !== 'OK') {
        return identity.retryable
          ? unreached
          : { ...unreached, reached: true, health: 'PROBLEM', problems: ['BOT_INACTIVE'] };
      }
      botUserId = identity.botId;
    }

    const chat = await this.deps.telegram.describeChat(token, group.chatId);
    if (chat.outcome !== 'OK') {
      if (chat.retryable) return unreached;
      const problem = /kicked|not a member|forbidden/i.test(chat.errorMessage)
        ? 'BOT_REMOVED'
        : 'CHAT_UNREACHABLE';
      return { ...unreached, reached: true, health: 'PROBLEM', problems: [problem] };
    }

    const member = await this.deps.telegram.botMembership(token, group.chatId, botUserId);
    if (member.outcome !== 'OK') {
      if (member.retryable) return unreached;
      return { ...unreached, reached: true, health: 'PROBLEM', problems: ['BOT_REMOVED'] };
    }

    const problems: OpsLogGroupProblem[] = [];
    if (chat.type !== 'supergroup' || !chat.isForum) problems.push('NOT_FORUM');
    if (GONE_STATUSES.has(member.status)) {
      problems.push('BOT_REMOVED');
    } else if (member.status === 'creator') {
      // The creator holds every right.
    } else if (member.status === 'administrator') {
      if (member.canManageTopics !== true) problems.push('CANNOT_MANAGE_TOPICS');
    } else {
      problems.push('BOT_NOT_ADMIN');
      if (member.status === 'restricted' && member.canSendMessages === false) {
        problems.push('CANNOT_SEND');
      }
    }

    if (problems.length === 0) {
      for (const category of OPS_LOG_TOPIC_CATEGORIES) {
        const ensured = await this.deps.provisioner.ensure(scope, actor, group, category, token);
        if (ensured.kind === 'FAILED') {
          problems.push('TOPIC_CREATE_FAILED');
          break;
        }
      }
    }

    return {
      reached: true,
      health: problems.length === 0 ? 'HEALTHY' : 'PROBLEM',
      problems,
      botMemberStatus: member.status,
      title: chat.title,
    };
  }

  /**
   * Writes what a check found, audits it, and — when the group has just become healthy —
   * puts the preserved messages back in the queue. One transaction; the health write is
   * conditional on the group still naming the chat that was checked.
   */
  private async commitFindings(
    scope: ScopeContext,
    actor: ActorContext,
    group: OpsGroupRecord,
    findings: CheckFindings,
    permission: PermissionKey,
    remember: { readonly idempotencyKey: string; readonly requestHash: string } | null,
  ): Promise<void> {
    const denial = { action: 'ops_group.verify', entityType: 'OpsLogGroup', entityId: group.id };
    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      permission,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        if (findings.reached) {
          const recorded = await this.deps.repository.recordHealth(
            scope,
            {
              chatId: group.chatId,
              health: findings.health,
              problems: findings.problems,
              botMemberStatus: findings.botMemberStatus,
              title: findings.title,
              now: this.deps.clock.now(),
            },
            tx,
          );
          if (recorded) {
            await this.deps.audit.record(
              scope,
              actor,
              {
                action: 'ops_group.verify',
                entityType: 'OpsLogGroup',
                entityId: group.id,
                before: { health: group.health, problems: [...group.problems] },
                after: { health: findings.health, problems: [...findings.problems] },
                result: 'SUCCESS',
              },
              tx,
            );
            if (findings.health === 'HEALTHY') {
              await this.requeueInside(scope, actor, group, tx, 'healthy');
            }
          }
        }
        if (remember !== null) {
          await rememberOnce(
            this.deps.idempotency,
            scope,
            actor.surface,
            remember.idempotencyKey,
            remember.requestHash,
            await this.snapshot(scope, tx),
            tx,
          );
        }
      },
    );
  }

  /** The requeue itself, inside the caller's transaction, audited with its count. */
  private async requeueInside(
    scope: ScopeContext,
    actor: ActorContext,
    group: OpsGroupRecord,
    tx: TransactionScope,
    trigger: 'operator' | 'healthy' | 'test',
  ): Promise<number> {
    const allowance = await this.allowance(scope, tx);
    const requeued = await this.deps.notifications.requeuePreserved(
      scope,
      {
        now: this.deps.clock.now(),
        allowance,
        limit: OPS_GROUP_REQUEUE_LIMIT,
        routeOf: (row) =>
          row.templateKey.startsWith('ops.financial.')
            ? 'PAYMENTS'
            : opsLogTopicForCode(
                typeof row.payload['code'] === 'string' ? row.payload['code'] : '',
              ),
      },
      tx,
    );
    // An automatic requeue that found nothing is not a change worth a row.
    if (requeued > 0 || trigger === 'operator') {
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: 'ops_group.requeue',
          entityType: 'OpsLogGroup',
          entityId: group.id,
          before: null,
          after: { requeued, allowance, trigger },
          result: 'SUCCESS',
        },
        tx,
      );
    }
    return requeued;
  }

  /**
   * The fresh allowance a requeued message gets: the lane's own attempt ceiling (default
   * `OPS_NOTIFICATION_DEFAULT_MAX_ATTEMPTS`, ten), so a retry is exactly as patient as the
   * first delivery was.
   */
  private async allowance(scope: ScopeContext, tx: TransactionScope): Promise<number> {
    return this.deps.settings.valueOf<number>(
      scope,
      'ops.notifications.max_attempts' as SettingKey,
      tx,
    );
  }

  /** One test message into one topic, recreating the topic once if it was deleted. */
  private async sendTestInto(
    scope: ScopeContext,
    actor: ActorContext,
    group: OpsGroupRecord,
    category: OpsLogTopicCategory,
    token: string,
    now: Date,
  ): Promise<OpsGroupTestResponse['results'][number]> {
    let ensured = await this.deps.provisioner.ensure(scope, actor, group, category, token);
    if (ensured.kind !== 'READY') {
      return {
        category,
        outcome: 'FAILED',
        errorCode: ensured.kind === 'BUSY' ? 'ops_group.topic_pending' : ensured.errorCode,
      };
    }
    const topicName = await this.deps.templates.render(
      scope,
      OPS_LOG_TOPIC_NAME_TEMPLATES[category] as TemplateKey,
      {},
    );
    const text = await this.deps.templates.render(scope, 'ops.group.test' as TemplateKey, {
      topic: topicName,
      requestedBy: actor.label ?? actor.type,
      at: now,
    });
    let sent = await this.deps.telegram.send(token, group.chatId, ensured.threadId, text);
    if (sent.outcome !== 'OK' && sent.topicMissing) {
      ensured = await this.deps.provisioner.ensure(
        scope,
        actor,
        group,
        category,
        token,
        ensured.threadId,
      );
      if (ensured.kind !== 'READY') {
        return {
          category,
          outcome: 'FAILED',
          errorCode: ensured.kind === 'BUSY' ? 'ops_group.topic_pending' : ensured.errorCode,
        };
      }
      sent = await this.deps.telegram.send(token, group.chatId, ensured.threadId, text);
    }
    if (sent.outcome !== 'OK') {
      if (sent.chatProblem !== null) {
        await this.deps.repository.addProblem(scope, {
          chatId: group.chatId,
          problem: sent.chatProblem,
          now: this.deps.clock.now(),
        });
      }
      return { category, outcome: 'FAILED', errorCode: sent.errorCode };
    }
    await this.deps.repository.noteDelivered(scope, {
      chatId: group.chatId,
      category,
      at: this.deps.clock.now(),
    });
    return { category, outcome: 'SENT', errorCode: null };
  }

  private async replyInGroup(
    scope: ScopeContext,
    botInstanceId: string,
    chatId: string,
    outcome: OpsBindOutcome,
  ): Promise<void> {
    try {
      const token = await this.deps.bots.tokenFor(scope, botInstanceId);
      if (token === null) return;
      const key =
        outcome === 'CONNECTED'
          ? 'ops.group.connected'
          : outcome === 'NOT_FORUM'
            ? 'ops.group.connect_not_forum'
            : 'ops.group.connect_refused';
      const text = await this.deps.templates.render(scope, key as TemplateKey, {});
      await this.deps.telegram.send(token, chatId, null, text);
    } catch (error) {
      this.deps.logger.warn(
        { err: error instanceof Error ? error.message : String(error), outcome },
        'Could not answer a connection attempt in its group',
      );
    }
  }

  /** The panel's whole state, from the database. */
  private async snapshot(scope: ScopeContext, tx?: unknown): Promise<OpsLogGroupView> {
    const now = this.deps.clock.now();
    const group = await this.deps.repository.findGroup(scope, tx);
    const topics =
      group === null ? [] : await this.deps.repository.listTopics(scope, group.chatId, tx);
    const bots = await this.deps.bots.activeBots(scope);
    const queue = await this.deps.notifications.opsQueueCounts(scope, tx);
    const laneEnabled = await this.deps.features.isEnabled(scope, 'ops_notifications', tx);
    const pendingCode = await this.deps.repository.outstandingCodeExpiry(scope, now, tx);
    const manualChat = await this.deps.settings.valueOf<string>(
      scope,
      'ops.notifications.telegram_chat_id' as SettingKey,
      tx,
    );
    const manualConfigured = manualChat.trim() !== '';
    const connected = group?.status === 'CONNECTED';
    const botName =
      group === null
        ? null
        : (bots.find((bot) => bot.id === group.botInstanceId)?.username ??
          (await this.deps.bots.usernameOf(scope, group.botInstanceId)));

    return {
      connection: group === null ? 'NOT_CONFIGURED' : group.status,
      group:
        group === null
          ? null
          : {
              title: group.title,
              bot: { id: group.botInstanceId, username: botName ?? '' },
              connectedAt: group.connectedAt.toISOString(),
              disconnectedAt: group.disconnectedAt?.toISOString() ?? null,
            },
      health: group?.health ?? 'UNVERIFIED',
      problems: group === null ? [] : [...group.problems],
      checkedAt: group?.checkedAt?.toISOString() ?? null,
      lastDeliveredAt: group?.lastDeliveredAt?.toISOString() ?? null,
      topics: OPS_LOG_TOPIC_CATEGORIES.map((category) => {
        const topic = topics.find((candidate) => candidate.category === category);
        return {
          category,
          state: topic?.state ?? 'PENDING',
          lastDeliveredAt: topic?.lastDeliveredAt?.toISOString() ?? null,
          recreatedCount: topic?.recreatedCount ?? 0,
        };
      }),
      queue,
      laneEnabled,
      pendingCodeExpiresAt: pendingCode?.toISOString() ?? null,
      bots: bots.map((bot) => ({ id: bot.id, username: bot.username })),
      manual: { configured: manualConfigured, inUse: manualConfigured && !connected },
    };
  }

  private async findReplay<T>(
    scope: ScopeContext,
    actor: ActorContext,
    command: { readonly idempotencyKey: string },
    requestHash: string,
  ): Promise<T | null> {
    const found = await this.deps.idempotency.find<T>(
      scope,
      actor.surface,
      command.idempotencyKey,
      requestHash,
    );
    return found ? found.result : null;
  }

  /** The result a command just remembered — the first answer, which a replay returns. */
  private async remembered<T>(
    scope: ScopeContext,
    actor: ActorContext,
    command: { readonly idempotencyKey: string },
    requestHash: string,
  ): Promise<T> {
    const found = await this.findReplay<T>(scope, actor, command, requestHash);
    if (found === null) {
      throw new Error('An ops group command committed without remembering its answer.');
    }
    return found;
  }

  private async requireConnected(scope: ScopeContext): Promise<OpsGroupRecord> {
    const group = await this.deps.repository.findGroup(scope);
    if (group === null || group.status !== 'CONNECTED') throw this.notConnected();
    return group;
  }

  private notConnected() {
    return errors.preconditionFailed(
      OPS_GROUP_ERROR_CODES.NOT_CONNECTED,
      'No operations log group is connected. Connect one first.',
    );
  }

  private inactive() {
    return errors.notFound(
      PLATFORM_ERROR_CODES.TENANT_NOT_FOUND,
      'This scope is not accepting work.',
    );
  }

  private async assertScopeActive(scope: ScopeContext, tx: TransactionScope): Promise<void> {
    if (await this.deps.scopeActivity.scopeIsActive(scope, tx)) return;
    throw this.inactive();
  }

  private async authorize(
    scope: ScopeContext,
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

/**
 * The notification lane's two views of the group, over the service.
 *
 * A thin adapter so the notification module depends on its own ports and never on this
 * module's service. The dispatcher's calls run as a SYSTEM_JOB and carry the tenant the
 * intent belongs to.
 */
export class OpsGroupRouter implements OpsTopicRouter, OpsGroupDestinationReader {
  constructor(
    private readonly service: OpsGroupService,
    private readonly systemActor: () => ActorContext,
  ) {}

  current(
    scope: ScopeContext,
    category: OpsLogTopicCategory,
    tx?: unknown,
  ): Promise<{ readonly chatId: string; readonly topicId: number | null } | null> {
    return this.service.currentDestination(scope, category, tx);
  }

  resolve(tenantId: string, category: OpsLogTopicCategory): Promise<OpsTopicRoute> {
    return this.service.route(scopeOf(tenantId), this.systemActor(), category, null);
  }

  recover(
    tenantId: string,
    category: OpsLogTopicCategory,
    staleTopicId: number,
  ): Promise<OpsTopicRoute> {
    return this.service.route(scopeOf(tenantId), this.systemActor(), category, staleTopicId);
  }

  delivered(
    tenantId: string,
    category: OpsLogTopicCategory,
    chatId: string,
    at: Date,
  ): Promise<void> {
    return this.service.noteDelivered(scopeOf(tenantId), category, chatId, at);
  }

  problem(tenantId: string, chatId: string, problem: OpsLogGroupProblem): Promise<void> {
    return this.service.noteProblem(scopeOf(tenantId), chatId, problem);
  }
}

function scopeOf(tenantId: string): ScopeContext {
  return { tenantId: tenantId as never, botInstanceId: null };
}
