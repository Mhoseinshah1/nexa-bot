import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  isNexaError,
  normaliseOpsConnectCode,
  systemJobActor,
  type ActorContext,
  type Clock,
  type CorrelationId,
  type OpsLogGroupProblem,
  type ScopeContext,
} from '@nexa/contracts';
import { NotificationDispatcher } from '../../apps/api/src/modules/control/notifications/application/notification-dispatcher';
import type {
  NotificationTransport,
  OutboundMessage,
  TransportResult,
} from '../../apps/api/src/modules/control/notifications/application/ports';
import {
  OpsGroupRouter,
  OpsGroupService,
} from '../../apps/api/src/modules/control/ops-group/application/ops-group.service';
import { OpsTopicProvisioner } from '../../apps/api/src/modules/control/ops-group/application/topic-provisioner';
import type { OpsGroupTelegram } from '../../apps/api/src/modules/control/ops-group/application/ports';
import { DrizzleOpsGroupRepository } from '../../apps/api/src/modules/control/ops-group/infrastructure/drizzle-ops-group.repository';
import { OpsGroupBotSource } from '../../apps/api/src/modules/control/ops-group/infrastructure/telegram-ops-group';
import {
  SEED_IDS,
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * WP-A4 — the Nexa-managed operations log group, against a real database.
 *
 * Telegram is a scripted fake of the `OpsGroupTelegram` port and of the notification
 * transport: what cannot be faked — the one-time code's single use, the topic registry's
 * unique key and claim, the queue's preservation and requeue — is what runs here.
 */

const GROUP_CHAT = '-1001234567890';
const OTHER_CHAT = '-1009999999999';

/** A controllable clock for the service, so code expiry is decided by the test. */
class TestClock implements Clock {
  /** Real time plus what the test advanced: the dispatcher runs on the real clock. */
  private offsetMs = 0;
  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }
  advance(ms: number): void {
    this.offsetMs += ms;
  }
}

/** The ops group's Telegram, scripted. */
class FakeOpsTelegram implements OpsGroupTelegram {
  chat = { type: 'supergroup', title: 'Nexa Ops', isForum: true };
  member: {
    status: string;
    isMember: boolean | null;
    canManageTopics: boolean | null;
    canSendMessages: boolean | null;
  } = {
    status: 'administrator',
    isMember: null,
    canManageTopics: true,
    canSendMessages: null,
  };
  nextThread = 100;
  created: { chatId: string; name: string; threadId: number }[] = [];
  sent: { chatId: string; threadId: number | null; text: string }[] = [];
  /** Delays `createTopic`, so concurrent callers overlap for real. */
  createDelayMs = 0;
  /** Threads Telegram no longer has: a send to one answers "message thread not found". */
  deletedThreads = new Set<number>();

  async botIdentity() {
    return { outcome: 'OK' as const, botId: '777000' };
  }
  /** Holds `describeChat` until released, so a check can be raced against a write. */
  chatGate: Promise<void> | null = null;
  describing: (() => void) | null = null;
  /** Delays `send`, so concurrent test sends overlap for real. */
  sendDelayMs = 0;
  /** Holds `send` until released, so a write can land while the sends are in flight. */
  sendGate: Promise<void> | null = null;
  sending: (() => void) | null = null;
  async describeChat() {
    this.describing?.();
    if (this.chatGate !== null) await this.chatGate;
    return { outcome: 'OK' as const, ...this.chat };
  }
  async botMembership() {
    return { outcome: 'OK' as const, ...this.member };
  }
  /** Refuses `createForumTopic`, as Telegram does for a bot without the right. */
  createRefused = false;
  async createTopic(_token: string, chatId: string, name: string) {
    if (this.createDelayMs > 0)
      await new Promise((resolve) => setTimeout(resolve, this.createDelayMs));
    if (this.createRefused) {
      return {
        outcome: 'FAILED' as const,
        retryable: false,
        errorCode: 'telegram.rejected.400',
        errorMessage: 'Bad Request: not enough rights to create a topic',
      };
    }
    this.nextThread += 1;
    this.created.push({ chatId, name, threadId: this.nextThread });
    return { outcome: 'OK' as const, threadId: this.nextThread };
  }
  async send(_token: string, chatId: string, threadId: number | null, text: string) {
    if (this.sendDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.sendDelayMs));
    this.sending?.();
    if (this.sendGate !== null) await this.sendGate;
    if (threadId !== null && this.deletedThreads.has(threadId)) {
      return {
        outcome: 'FAILED' as const,
        retryable: false,
        errorCode: 'telegram.rejected.400',
        errorMessage: 'Bad Request: message thread not found',
        topicMissing: true,
        chatProblem: null,
      };
    }
    this.sent.push({ chatId, threadId, text });
    return { outcome: 'OK' as const };
  }
}

/** The notification transport, scripted per call, recording every message it is handed. */
class ScriptedTransport implements NotificationTransport {
  readonly kind = 'TELEGRAM' as const;
  readonly messages: OutboundMessage[] = [];
  /** Answers for the next calls, in order; empty means "delivered". */
  script: TransportResult[] = [];
  /** A fixed answer for every call, when set. */
  always: TransportResult | null = null;
  /** Threads that answer "message thread not found", like the fake Telegram's. */
  deletedThreads = new Set<number>();

  async send(message: OutboundMessage): Promise<TransportResult> {
    this.messages.push(message);
    if (this.always) return this.always;
    const next = this.script.shift();
    if (next) return next;
    const topic = message.destination.transport === 'TELEGRAM' ? message.destination.topicId : null;
    if (topic !== null && this.deletedThreads.has(topic)) {
      return {
        outcome: 'FAILED_PERMANENT',
        errorCode: 'telegram.rejected.400',
        errorMessage: 'Bad Request: message thread not found',
        topicMissing: true,
      };
    }
    return { outcome: 'SUCCEEDED' };
  }
}

describe('the operations log group (WP-A4)', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let telegram: FakeOpsTelegram;
  let clock: TestClock;
  let service: OpsGroupService;
  let provisioner: OpsTopicProvisioner;
  let repository: DrizzleOpsGroupRepository;
  let transport: ScriptedTransport;
  let dispatcher: NotificationDispatcher;
  let keySeq = 0;
  const key = (label: string) => `${label}-${Date.now()}-${(keySeq += 1)}`;
  const system = () => systemJobActor('ops-group-test', 'test-correlation' as CorrelationId);

  beforeEach(async () => {
    ctx ??= await createTestContext({ NOTIFICATION_TRANSPORT: 'recording' });
    await ctx.reset();
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner', roleKeys: ['owner'] }),
    );
    await ctx.container.featureFlags.set(tenantA, owner, {
      key: 'ops_notifications',
      enabled: true,
      expectedVersion: null,
      idempotencyKey: key('flag'),
      confirmKey: 'ops_notifications',
      reason: 'Test setup.',
    });

    telegram = new FakeOpsTelegram();
    clock = new TestClock();
    repository = new DrizzleOpsGroupRepository(ctx.container.database.db);
    const c = ctx.container;
    provisioner = new OpsTopicProvisioner({
      repository,
      telegram,
      templates: c.templateResolver,
      audit: c.audit,
      opsLog: c.opsLogWriter,
      clock,
      ids: c.ids,
      logger: c.logger,
    });
    service = new OpsGroupService({
      repository,
      telegram,
      bots: new OpsGroupBotSource(c.botInstances),
      provisioner,
      notifications: c.notificationRepository,
      templates: c.templateResolver,
      features: c.featureFlagResolver,
      settings: c.settingsResolver,
      guard: c.guard,
      uow: c.uow,
      audit: c.audit,
      opsLog: c.opsLogWriter,
      sessions: c.sessions,
      idempotency: c.idempotency,
      scopeActivity: c.tenants,
      outbox: c.outbox,
      clock,
      ids: c.ids,
      logger: c.logger,
      // Small, so draining across passes is exercised with a handful of rows.
      requeueBatch: 2,
    });
    transport = new ScriptedTransport();
    dispatcher = new NotificationDispatcher(
      c.notificationRepository,
      transport,
      c.templateResolver,
      c.settingsResolver,
      c.clock,
      c.ids,
      c.logger,
      c.opsLogWriter,
      {
        pollIntervalMs: 1_000,
        batchSize: 10,
        leaseMs: 60_000,
        baseBackoffMs: 1_000,
        maxBackoffMs: 5_000,
      },
      new OpsGroupRouter(service, system),
    );
    dispatcher.setRateLimitScope(tenantA);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  async function issueCode(botInstanceId: string = SEED_IDS.botA1): Promise<string> {
    const issued = await service.issueConnectCode(tenantA, owner, {
      idempotencyKey: key('code'),
      botInstanceId,
    });
    return issued.code;
  }

  function botScope(tenant: { readonly tenantId: unknown }, botInstanceId: string): ScopeContext {
    return { tenantId: tenant.tenantId as never, botInstanceId: botInstanceId as never };
  }

  async function bind(
    code: string,
    options: {
      tenant?: { readonly tenantId: unknown };
      botInstanceId?: string;
      chatId?: string;
      isForum?: boolean;
      type?: string;
      updateKey?: string;
    } = {},
  ) {
    const botInstanceId = options.botInstanceId ?? SEED_IDS.botA1;
    return service.bindFromTelegram(
      botScope(options.tenant ?? tenantA, botInstanceId),
      systemJobActor(`telegram-update:${botInstanceId}`, 'test-correlation' as CorrelationId),
      {
        idempotencyKey: options.updateKey ?? key('update'),
        botInstanceId,
        chat: {
          id: options.chatId ?? GROUP_CHAT,
          type: options.type ?? 'supergroup',
          title: 'Nexa Ops',
          isForum: options.isForum ?? true,
        },
        rawCode: `ops-${code}`,
      },
    );
  }

  async function connectHealthy(): Promise<void> {
    expect(await bind(await issueCode())).toBe('CONNECTED');
    expect(await service.maintain(tenantA, system())).toBe('CHECKED');
    const view = await service.view(tenantA, owner);
    expect(view.health).toBe('HEALTHY');
  }

  async function makeDue(): Promise<void> {
    await ctx.container.database.db.execute(
      `UPDATE notifications SET next_attempt_at = now() - interval '1 second'
        WHERE status = 'PENDING'` as never,
    );
  }

  const raise = (dedupeKey: string, extra: Record<string, unknown> = {}) =>
    ctx.container.opsLog.record(tenantA, {
      code: 'panel.health.unreachable',
      severity: 'ERROR',
      message: 'The panel did not answer.',
      dedupeKey,
      context: extra,
    });

  // -------------------------------------------------------------------------
  // Binding
  // -------------------------------------------------------------------------

  describe('binding with a one-time code', () => {
    it('binds the group the code was sent from, discovering its chat id, and answers there', async () => {
      const code = await issueCode();
      expect(await bind(code)).toBe('CONNECTED');

      const view = await service.view(tenantA, owner);
      expect(view.connection).toBe('CONNECTED');
      expect(view.health).toBe('UNVERIFIED');
      expect(view.group?.bot).toEqual({ id: SEED_IDS.botA1, username: 'acme_store_bot' });
      const group = await repository.findGroup(tenantA);
      expect(group?.chatId).toBe(GROUP_CHAT);
      expect(group?.connectedByAdminId).toBe(owner.id);
      // The reply went to the group itself, not a topic.
      expect(telegram.sent.at(-1)).toMatchObject({ chatId: GROUP_CHAT, threadId: null });

      const audit = await ctx.container.database.db.execute(
        `SELECT action FROM audit_logs WHERE action = 'ops_group.bind'` as never,
      );
      expect((audit as unknown as { rows: unknown[] }).rows).toHaveLength(1);
    });

    it('stores the code only as a hash', async () => {
      const code = await issueCode();
      const stored = (await ctx.container.database.db.execute(
        `SELECT code_hash FROM ops_log_connect_codes` as never,
      )) as unknown as { rows: { code_hash: string }[] };
      expect(stored.rows).toHaveLength(1);
      expect(stored.rows[0]?.code_hash).not.toContain(code);
      expect(normaliseOpsConnectCode(`ops-${code.toLowerCase()}`)).toBe(code);
    });

    it('accepts a code once: a second group sending it is refused and binds nothing', async () => {
      const code = await issueCode();
      expect(await bind(code)).toBe('CONNECTED');
      expect(await bind(code, { chatId: OTHER_CHAT })).toBe('REFUSED');
      expect((await repository.findGroup(tenantA))?.chatId).toBe(GROUP_CHAT);
    });

    it('replays a redelivered update instead of refusing it, and answers the group once', async () => {
      const code = await issueCode();
      const updateKey = key('update');
      expect(await bind(code, { updateKey })).toBe('CONNECTED');
      const replies = telegram.sent.length;
      expect(await bind(code, { updateKey })).toBe('CONNECTED');
      expect(telegram.sent.length).toBe(replies);
    });

    it('refuses an expired code', async () => {
      const code = await issueCode();
      clock.advance(10 * 60_000 + 1);
      expect(await bind(code)).toBe('REFUSED');
      expect(await repository.findGroup(tenantA)).toBeNull();
    });

    it('refuses a code sent through another bot of the same tenant', async () => {
      // The seed's second bot is STOPPED, and a stopped bot's webhook is refused before
      // any of this runs; start it so the refusal tested here is the code's own.
      await ctx.container.database.db.execute(
        `UPDATE bot_instances SET status = 'ACTIVE' WHERE id = '${SEED_IDS.botA2}'` as never,
      );
      const code = await issueCode(SEED_IDS.botA1);
      expect(await bind(code, { botInstanceId: SEED_IDS.botA2 })).toBe('REFUSED');
      expect(await repository.findGroup(tenantA)).toBeNull();
      // Still usable through the bot it was issued for.
      expect(await bind(code)).toBe('CONNECTED');
    });

    it('refuses a code sent to another tenant’s bot, and binds nothing in either tenant', async () => {
      const code = await issueCode(SEED_IDS.botA1);
      expect(await bind(code, { tenant: tenantB, botInstanceId: SEED_IDS.botB1 })).toBe('REFUSED');
      expect(await repository.findGroup(tenantA)).toBeNull();
      expect(await repository.findGroup(tenantB)).toBeNull();
    });

    it('leaves the code unused for a group without topics, so it works once they are on', async () => {
      const code = await issueCode();
      expect(await bind(code, { isForum: false })).toBe('NOT_FORUM');
      expect(await bind(code, { type: 'group', isForum: false })).toBe('NOT_FORUM');
      expect(await repository.findGroup(tenantA)).toBeNull();
      expect(await bind(code)).toBe('CONNECTED');
    });

    it('refuses to issue a code without settings.edit, and records the denial', async () => {
      const observer = adminActorFor(
        await createAdmin(ctx.container, tenantA, { username: 'watcher', roleKeys: ['observer'] }),
      );
      await expect(
        service.issueConnectCode(tenantA, observer, {
          idempotencyKey: key('code'),
          botInstanceId: SEED_IDS.botA1,
        }),
      ).rejects.toSatisfy(
        (error: unknown) => isNexaError(error) && error.kind === 'PERMISSION_DENIED',
      );
      const denied = (await ctx.container.database.db.execute(
        `SELECT result FROM audit_logs WHERE action = 'ops_group.connect_code'` as never,
      )) as unknown as { rows: { result: string }[] };
      expect(denied.rows.map((row) => row.result)).toEqual(['DENIED']);
    });

    it('refuses a code for a bot that is not active', async () => {
      await expect(
        service.issueConnectCode(tenantA, owner, {
          idempotencyKey: key('code'),
          botInstanceId: SEED_IDS.botA2,
        }),
      ).rejects.toSatisfy(
        (error: unknown) => isNexaError(error) && error.code === 'ops_group.bot_not_available',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Permission verification
  // -------------------------------------------------------------------------

  describe('permission verification', () => {
    async function checkWith(
      configure: () => void,
    ): Promise<{ health: string; problems: readonly OpsLogGroupProblem[] }> {
      expect(await bind(await issueCode())).toBe('CONNECTED');
      configure();
      await service.maintain(tenantA, system());
      const view = await service.view(tenantA, owner);
      return { health: view.health, problems: view.problems };
    }

    it('declares a group healthy only after getChat and getChatMember agree, and then creates the topics', async () => {
      await connectHealthy();
      expect(telegram.created.map((topic) => topic.name).sort()).toEqual(
        ['⚙️ سیستم و خطاها', '💳 پرداخت‌ها'].sort(),
      );
      const view = await service.view(tenantA, owner);
      expect(view.topics.map((topic) => [topic.category, topic.state])).toEqual([
        ['SYSTEM', 'READY'],
        ['PAYMENTS', 'READY'],
      ]);
    });

    it('names a bot that is only a member', async () => {
      const found = await checkWith(() => {
        telegram.member = {
          status: 'member',
          isMember: null,
          canManageTopics: null,
          canSendMessages: null,
        };
      });
      expect(found).toEqual({ health: 'PROBLEM', problems: ['BOT_NOT_ADMIN'] });
      expect(telegram.created).toHaveLength(0);
    });

    it('names an administrator without the manage-topics right', async () => {
      const found = await checkWith(() => {
        telegram.member = {
          status: 'administrator',
          isMember: null,
          canManageTopics: false,
          canSendMessages: null,
        };
      });
      expect(found).toEqual({ health: 'PROBLEM', problems: ['CANNOT_MANAGE_TOPICS'] });
      expect(telegram.created).toHaveLength(0);
    });

    it('names a restricted bot that may not send', async () => {
      const found = await checkWith(() => {
        telegram.member = {
          status: 'restricted',
          isMember: true,
          canManageTopics: null,
          canSendMessages: false,
        };
      });
      expect(found.health).toBe('PROBLEM');
      expect(found.problems).toEqual(['BOT_NOT_ADMIN', 'CANNOT_SEND']);
    });

    it('names a restricted bot that is no longer in the group as removed (Codex review #2)', async () => {
      const found = await checkWith(() => {
        telegram.member = {
          status: 'restricted',
          isMember: false,
          canManageTopics: null,
          canSendMessages: true,
        };
      });
      expect(found).toEqual({ health: 'PROBLEM', problems: ['BOT_REMOVED'] });
    });

    it('names a group whose topics were switched off', async () => {
      const found = await checkWith(() => {
        telegram.chat = { ...telegram.chat, isForum: false };
      });
      expect(found).toEqual({ health: 'PROBLEM', problems: ['NOT_FORUM'] });
    });

    it('marks the group at once when Telegram says the bot was removed', async () => {
      await connectHealthy();
      const changed = await service.membershipChanged(botScope(tenantA, SEED_IDS.botA1), system(), {
        idempotencyKey: key('member'),
        botInstanceId: SEED_IDS.botA1,
        chatId: GROUP_CHAT,
        status: 'kicked',
      });
      expect(changed).toBe(true);
      const view = await service.view(tenantA, owner);
      expect(view).toMatchObject({ health: 'PROBLEM', problems: ['BOT_REMOVED'] });
    });

    it('ignores a membership change in a chat that is not the bound group', async () => {
      await connectHealthy();
      const changed = await service.membershipChanged(botScope(tenantA, SEED_IDS.botA1), system(), {
        idempotencyKey: key('member'),
        botInstanceId: SEED_IDS.botA1,
        chatId: OTHER_CHAT,
        status: 'left',
      });
      expect(changed).toBe(false);
      expect((await service.view(tenantA, owner)).health).toBe('HEALTHY');
    });
  });

  // -------------------------------------------------------------------------
  // Topics
  // -------------------------------------------------------------------------

  describe('topic creation is idempotent', () => {
    it('creates each topic once however often setup runs', async () => {
      await connectHealthy();
      expect(telegram.created).toHaveLength(2);
      await service.verify(tenantA, owner, { idempotencyKey: key('verify') });
      await service.reconnect(tenantA, owner, { idempotencyKey: key('reconnect') });
      expect(telegram.created).toHaveLength(2);
      const rows = (await ctx.container.database.db.execute(
        `SELECT category FROM ops_log_topics` as never,
      )) as unknown as { rows: unknown[] };
      expect(rows.rows).toHaveLength(2);
    });

    it('creates ONE topic when five callers race for it', async () => {
      expect(await bind(await issueCode())).toBe('CONNECTED');
      const group = await repository.findGroup(tenantA);
      telegram.createDelayMs = 50;
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          provisioner.ensure(tenantA, system(), group!, 'SYSTEM', 'token'),
        ),
      );
      expect(telegram.created).toHaveLength(1);
      const ready = results.filter((result) => result.kind === 'READY');
      expect(ready.length).toBeGreaterThanOrEqual(1);
      expect(results.every((result) => result.kind === 'READY' || result.kind === 'BUSY')).toBe(
        true,
      );
      const topics = await repository.listTopics(tenantA, GROUP_CHAT);
      expect(topics).toHaveLength(1);
      expect(topics[0]).toMatchObject({
        state: 'READY',
        messageThreadId: telegram.created[0]?.threadId,
      });
    });
  });

  describe('a deleted topic', () => {
    it('is recreated once and the event is resent there, not lost', async () => {
      await connectHealthy();
      const system_ = (await repository.listTopics(tenantA, GROUP_CHAT)).find(
        (topic) => topic.category === 'SYSTEM',
      );
      transport.deletedThreads.add(system_!.messageThreadId!);

      await raise('deleted-topic');
      const tick = await dispatcher.tick();
      expect(tick).toMatchObject({ claimed: 1, sent: 1 });

      // Two sends: the refused one and the resend into the recreated topic.
      expect(transport.messages).toHaveLength(2);
      const resentTo =
        transport.messages[1]!.destination.transport === 'TELEGRAM'
          ? transport.messages[1]!.destination.topicId
          : null;
      expect(resentTo).not.toBe(system_!.messageThreadId);
      const after = (await repository.listTopics(tenantA, GROUP_CHAT)).find(
        (topic) => topic.category === 'SYSTEM',
      );
      expect(after).toMatchObject({ state: 'READY', messageThreadId: resentTo, recreatedCount: 1 });
      // Only the SYSTEM topic was recreated.
      expect(telegram.created).toHaveLength(3);

      const [intent] = await ctx.container.notifications.list(tenantA, owner);
      const detail = await ctx.container.notifications.get(tenantA, owner, intent!.id);
      expect(detail.intent.status).toBe('SENT');
      expect(detail.attempts.map((attempt) => attempt.outcome)).toEqual(['SUCCEEDED']);
    });

    it('never loops: a topic that keeps vanishing costs one recreation per attempt and a retryable failure', async () => {
      await connectHealthy();
      transport.always = {
        outcome: 'FAILED_PERMANENT',
        errorCode: 'telegram.rejected.400',
        errorMessage: 'Bad Request: message thread not found',
        topicMissing: true,
      };
      await raise('vanishing');
      const before = telegram.created.length;
      await dispatcher.tick();
      expect(telegram.created.length - before).toBe(1);
      expect(transport.messages).toHaveLength(2);

      const [intent] = await ctx.container.notifications.list(tenantA, owner);
      const detail = await ctx.container.notifications.get(tenantA, owner, intent!.id);
      expect(detail.intent.status).toBe('PENDING');
      expect(detail.attempts[0]).toMatchObject({
        outcome: 'FAILED_RETRYABLE',
        errorCode: 'ops_group.topic_missing',
      });
    });
  });

  // -------------------------------------------------------------------------
  // Retry, exhaustion and requeue
  // -------------------------------------------------------------------------

  describe('ten attempts, then preserved', () => {
    it('keeps an event unsent after ten failures, and delivers it after a requeue', async () => {
      await connectHealthy();
      transport.always = {
        outcome: 'FAILED_RETRYABLE',
        errorCode: 'telegram.server_error.502',
        errorMessage: 'Bad Gateway',
      };
      await raise('exhaust');
      const [queued] = await ctx.container.notifications.list(tenantA, owner);
      expect(queued?.maxAttempts).toBe(10);

      for (let attempt = 1; attempt <= 10; attempt += 1) {
        await dispatcher.tick();
        await makeDue();
      }
      const [failed] = await ctx.container.notifications.list(tenantA, owner);
      const detail = await ctx.container.notifications.get(tenantA, owner, failed!.id);
      // Preserved: still there, FAILED, never filed as sent.
      expect(detail.intent.status).toBe('FAILED');
      expect(detail.attempts).toHaveLength(10);
      expect(detail.attempts.some((attempt) => attempt.outcome === 'SUCCEEDED')).toBe(false);
      expect((await service.view(tenantA, owner)).queue).toEqual({ pending: 0, preserved: 1 });

      // An eleventh tick claims nothing: bounded, not retried for ever.
      expect((await dispatcher.tick()).claimed).toBe(0);

      // The problem is fixed; the operator retries what was preserved.
      transport.always = null;
      const requeued = await service.requeue(tenantA, owner, { idempotencyKey: key('requeue') });
      expect(requeued.requeued).toBe(1);
      expect(requeued.opsGroup.queue).toEqual({ pending: 1, preserved: 0 });

      const sent = await dispatcher.tick();
      expect(sent).toMatchObject({ claimed: 1, sent: 1 });
      const final = await ctx.container.notifications.get(tenantA, owner, failed!.id);
      expect(final.intent.status).toBe('SENT');
      expect(final.intent.maxAttempts).toBe(20);
      expect(final.attempts.at(-1)).toMatchObject({ attemptNumber: 11, outcome: 'SUCCEEDED' });
    });

    it('replays a requeue under its key instead of requeueing twice', async () => {
      await connectHealthy();
      transport.always = { outcome: 'FAILED_PERMANENT', errorCode: 'x', errorMessage: 'no' };
      await raise('replay');
      await dispatcher.tick();
      const idempotencyKey = key('requeue');
      expect((await service.requeue(tenantA, owner, { idempotencyKey })).requeued).toBe(1);
      expect((await service.requeue(tenantA, owner, { idempotencyKey })).requeued).toBe(1);
      const [intent] = await ctx.container.notifications.list(tenantA, owner);
      expect(intent?.maxAttempts).toBe(11);
    });

    it('requeues preserved events automatically once the group is healthy again', async () => {
      await connectHealthy();
      transport.always = { outcome: 'FAILED_PERMANENT', errorCode: 'x', errorMessage: 'no' };
      await raise('auto');
      await dispatcher.tick();
      expect((await service.view(tenantA, owner)).queue.preserved).toBe(1);

      // Telegram reports a membership change; the worker checks and finds it healthy.
      await service.membershipChanged(botScope(tenantA, SEED_IDS.botA1), system(), {
        idempotencyKey: key('member'),
        botInstanceId: SEED_IDS.botA1,
        chatId: GROUP_CHAT,
        status: 'administrator',
      });
      expect(await service.maintain(tenantA, system())).toBe('CHECKED');
      expect((await service.view(tenantA, owner)).queue).toEqual({ pending: 1, preserved: 0 });
    });

    it('keeps what is raised while the group is disconnected, and delivers it once after a reconnect', async () => {
      await connectHealthy();
      await service.disconnect(tenantA, owner, { idempotencyKey: key('disconnect') });
      await raise('while-disconnected');
      // HF-A4 (the owner's rule): a disconnected group is not a reason to drop an event.
      // It is queued, still routed to the group, and waits.
      const [queued] = await ctx.container.notifications.list(tenantA, owner);
      expect(queued?.status).toBe('PENDING');
      expect(await dispatcher.tick()).toMatchObject({ claimed: 1, sent: 0, failed: 1 });
      expect(transport.messages).toHaveLength(0);
      const waiting = await ctx.container.notifications.get(tenantA, owner, queued!.id);
      expect(waiting.intent.status).toBe('PENDING');
      expect(waiting.attempts[0]).toMatchObject({
        outcome: 'FAILED_RETRYABLE',
        errorCode: 'ops_group.not_connected',
      });

      await service.reconnect(tenantA, owner, { idempotencyKey: key('reconnect') });
      expect((await service.view(tenantA, owner)).connection).toBe('CONNECTED');
      await raise('after-reconnect');
      await makeDue();
      expect(await dispatcher.tick()).toMatchObject({ claimed: 2, sent: 2 });
      // Each event once, and nothing left to send again.
      expect(transport.messages).toHaveLength(2);
      await makeDue();
      expect((await dispatcher.tick()).claimed).toBe(0);
      const statuses = (await ctx.container.notifications.list(tenantA, owner)).map(
        (n) => n.status,
      );
      expect(statuses).toEqual(['SENT', 'SENT']);
    });
  });

  // -------------------------------------------------------------------------
  // Rate limit
  // -------------------------------------------------------------------------

  describe('the per-minute ceiling is throughput, not a drop', () => {
    it('leaves events over the quota queued and sends them later', async () => {
      await connectHealthy();
      await ctx.container.settingsService.set(tenantA, owner, {
        key: 'ops.notifications.max_per_minute',
        value: 1,
        expectedVersion: null,
        idempotencyKey: key('rate'),
      });
      await raise('rate-1');
      await raise('rate-2');
      await raise('rate-3');

      expect((await dispatcher.tick()).sent).toBe(1);
      expect((await dispatcher.tick()).claimed).toBe(0);
      const statuses = (await ctx.container.notifications.list(tenantA, owner)).map(
        (n) => n.status,
      );
      expect(statuses.filter((status) => status === 'PENDING')).toHaveLength(2);
      expect(statuses).not.toContain('FAILED');

      // The next minute.
      dispatcher.resetRateWindow();
      expect((await dispatcher.tick()).sent).toBe(1);
      dispatcher.resetRateWindow();
      expect((await dispatcher.tick()).sent).toBe(1);
      const all = await ctx.container.notifications.list(tenantA, owner);
      expect(all.every((n) => n.status === 'SENT')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Routing and detail
  // -------------------------------------------------------------------------

  describe('routing and detail', () => {
    it('routes a payments event to the payments topic and everything else to the system topic', async () => {
      await connectHealthy();
      const topics = await repository.listTopics(tenantA, GROUP_CHAT);
      const thread = (category: string) =>
        topics.find((topic) => topic.category === category)?.messageThreadId;

      await ctx.container.opsLog.record(tenantA, {
        code: 'payments.gateway_misconfigured',
        severity: 'ERROR',
        message: 'The gateway refused its key.',
        dedupeKey: 'route-pay',
      });
      await raise('route-sys');
      await dispatcher.tick();
      const threads = transport.messages.map((message) =>
        message.destination.transport === 'TELEGRAM' ? message.destination.topicId : null,
      );
      expect(threads.sort()).toEqual([thread('PAYMENTS'), thread('SYSTEM')].sort());
      // Sent from the bot that was added to the group.
      expect(transport.messages.every((message) => message.botInstanceId === SEED_IDS.botA1)).toBe(
        true,
      );
    });

    it('addresses the financial log to the group’s payments topic, over the manual setting', async () => {
      await ctx.container.settingsService.set(tenantA, owner, {
        key: 'ops.notifications.telegram_chat_id',
        value: '-100555',
        expectedVersion: null,
        idempotencyKey: key('manual'),
      });
      // Before a group: the manual fallback.
      expect(await ctx.container.notifications.financialDestination(tenantA)).toMatchObject({
        chatId: '-100555',
      });
      await connectHealthy();
      const payments = (await repository.listTopics(tenantA, GROUP_CHAT)).find(
        (topic) => topic.category === 'PAYMENTS',
      );
      expect(await ctx.container.notifications.financialDestination(tenantA)).toEqual({
        transport: 'TELEGRAM',
        chatId: GROUP_CHAT,
        topicId: payments?.messageThreadId,
        opsTopic: 'PAYMENTS',
      });
    });

    it('prints the safe detail and never a secret', async () => {
      await connectHealthy();
      await ctx.container.opsLog.record(tenantA, {
        code: 'payments.gateway_create_unknown',
        severity: 'ERROR',
        message: 'The create answer was lost.',
        dedupeKey: 'secrets',
        correlationId: 'corr-1234' as CorrelationId,
        context: {
          paymentId: '01900000-0000-7000-8000-00000000fa11',
          orderId: '01900000-0000-7000-8000-00000000fa12',
          from: 'AWAITING_PAYMENT',
          to: 'PAID',
          reason: 'provider said 1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw was wrong',
          token: '1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
          apiKey: 'sk_live_supersecretvalue',
          subscriptionUrl: 'https://panel.example/sub/abcdefsecret',
          providerPayload: { card: '6037991234567890', cvv2: '123' },
        },
      });
      await dispatcher.tick();
      const text = transport.messages[0]?.text ?? '';
      expect(text).toContain('payments.gateway_create_unknown');
      expect(text).toContain('paymentId: 01900000-0000-7000-8000-00000000fa11');
      expect(text).toContain('orderId: 01900000-0000-7000-8000-00000000fa12');
      expect(text).toContain('from: AWAITING_PAYMENT');
      expect(text).toContain('to: PAID');
      expect(text).toContain(String(SEED_IDS.tenantA));
      expect(text).toContain('corr-1234');
      for (const secret of [
        'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
        'sk_live_supersecretvalue',
        'abcdefsecret',
        '6037991234567890',
        'cvv2',
      ]) {
        expect(text).not.toContain(secret);
      }
    });
  });

  describe('the status panel', () => {
    it('is per tenant', async () => {
      await connectHealthy();
      const otherOwner = adminActorFor(
        await createAdmin(ctx.container, tenantB, { username: 'b-owner', roleKeys: ['owner'] }),
      );
      const other = await service.view(tenantB, otherOwner);
      expect(other.connection).toBe('NOT_CONFIGURED');
      expect(other.group).toBeNull();
    });

    it('sends a test into every topic and records the last delivery', async () => {
      await connectHealthy();
      const tested = await service.sendTest(tenantA, owner, { idempotencyKey: key('test') });
      expect(tested.results.map((result) => [result.category, result.outcome])).toEqual([
        ['SYSTEM', 'SENT'],
        ['PAYMENTS', 'SENT'],
      ]);
      expect(tested.opsGroup.lastDeliveredAt).not.toBeNull();
      expect(tested.opsGroup.topics.every((topic) => topic.lastDeliveredAt !== null)).toBe(true);
    });

    it('recreates a deleted topic during a test send', async () => {
      await connectHealthy();
      const payments = (await repository.listTopics(tenantA, GROUP_CHAT)).find(
        (topic) => topic.category === 'PAYMENTS',
      );
      telegram.deletedThreads.add(payments!.messageThreadId!);
      const tested = await service.sendTest(tenantA, owner, { idempotencyKey: key('test') });
      expect(tested.results.every((result) => result.outcome === 'SENT')).toBe(true);
      expect(
        tested.opsGroup.topics.find((topic) => topic.category === 'PAYMENTS')?.recreatedCount,
      ).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Codex review #1 of PR #99
  // -------------------------------------------------------------------------

  describe('Codex review #1 of PR #99', () => {
    /** Preserves one unsent event per key, on a healthy group. */
    async function preserve(keys: readonly string[]): Promise<void> {
      transport.always = { outcome: 'FAILED_PERMANENT', errorCode: 'x', errorMessage: 'no' };
      for (const dedupe of keys) await raise(dedupe);
      await dispatcher.tick();
      transport.always = null;
      expect((await service.view(tenantA, owner)).queue.preserved).toBe(keys.length);
    }

    it('C1: a check that loses a race with a disconnect changes nothing', async () => {
      await connectHealthy();
      await preserve(['race']);
      // Telegram reports a change, so the group is checked again...
      await service.membershipChanged(botScope(tenantA, SEED_IDS.botA1), system(), {
        idempotencyKey: key('member'),
        botInstanceId: SEED_IDS.botA1,
        chatId: GROUP_CHAT,
        status: 'administrator',
      });
      let release!: () => void;
      telegram.chatGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        telegram.describing = resolve;
      });
      // ...and while that check waits on Telegram, the operator disconnects.
      const checking = service.verify(tenantA, owner, { idempotencyKey: key('verify') });
      await entered;
      await service.disconnect(tenantA, owner, { idempotencyKey: key('disconnect') });
      release();
      await checking;

      const group = await repository.findGroup(tenantA);
      expect(group?.status).toBe('DISCONNECTED');
      expect(group?.health).toBe('UNVERIFIED');
      // And nothing preserved was put back in the queue behind the operator's back.
      expect((await service.view(tenantA, owner)).queue).toEqual({ pending: 0, preserved: 1 });
    });

    it('C1: a check that began before a reconnect cannot record over it', async () => {
      await connectHealthy();
      await service.disconnect(tenantA, owner, { idempotencyKey: key('disconnect') });
      const before = await repository.findGroup(tenantA);
      await service.reconnect(tenantA, owner, { idempotencyKey: key('reconnect') });
      // The stale identity is the one the pre-reconnect check would carry.
      const recorded = await repository.recordHealth(tenantA, {
        chatId: GROUP_CHAT,
        botInstanceId: SEED_IDS.botA1,
        connectedAt: before!.connectedAt,
        health: 'PROBLEM',
        problems: ['BOT_NOT_ADMIN'],
        botMemberStatus: 'member',
        title: null,
        now: clock.now(),
      });
      expect(recorded).toBe(false);
      expect((await repository.findGroup(tenantA))?.health).toBe('HEALTHY');
    });

    it('C2: the resend into a recreated topic waits for the rate window instead of exceeding it', async () => {
      await connectHealthy();
      await ctx.container.settingsService.set(tenantA, owner, {
        key: 'ops.notifications.max_per_minute',
        value: 1,
        expectedVersion: null,
        idempotencyKey: key('rate'),
      });
      const systemTopic = (await repository.listTopics(tenantA, GROUP_CHAT)).find(
        (topic) => topic.category === 'SYSTEM',
      );
      transport.deletedThreads.add(systemTopic!.messageThreadId!);
      await raise('rate-recreate');

      await dispatcher.tick();
      // ONE send in this minute: the refused one. The topic is recreated, the resend waits.
      expect(transport.messages).toHaveLength(1);
      const [intent] = await ctx.container.notifications.list(tenantA, owner);
      const detail = await ctx.container.notifications.get(tenantA, owner, intent!.id);
      expect(detail.intent.status).toBe('PENDING');
      expect(detail.attempts[0]).toMatchObject({
        outcome: 'FAILED_RETRYABLE',
        errorCode: 'ops_group.resend_deferred',
      });
      const recreated = (await repository.listTopics(tenantA, GROUP_CHAT)).find(
        (topic) => topic.category === 'SYSTEM',
      );
      expect(recreated?.recreatedCount).toBe(1);

      // The next minute: delivered, into the recreated topic.
      dispatcher.resetRateWindow();
      await makeDue();
      expect((await dispatcher.tick()).sent).toBe(1);
      expect(transport.messages).toHaveLength(2);
      const last = transport.messages[1]!.destination;
      expect(last.transport === 'TELEGRAM' ? last.topicId : null).toBe(recreated?.messageThreadId);
    });

    it('C4: two presses of one test button send one set of messages', async () => {
      await connectHealthy();
      const before = telegram.sent.length;
      telegram.sendDelayMs = 50;
      const idempotencyKey = key('test');
      const outcomes = await Promise.allSettled([
        service.sendTest(tenantA, owner, { idempotencyKey }),
        service.sendTest(tenantA, owner, { idempotencyKey }),
      ]);
      // One set: one message per topic.
      expect(telegram.sent.length - before).toBe(2);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const refused = outcomes.find((outcome) => outcome.status === 'rejected');
      expect(
        refused?.status === 'rejected' &&
          isNexaError(refused.reason) &&
          refused.reason.code === 'platform.idempotency_in_flight',
      ).toBe(true);
      // Afterwards the key replays the first answer and still sends nothing.
      const replay = await service.sendTest(tenantA, owner, { idempotencyKey });
      expect(replay.results.every((result) => result.outcome === 'SENT')).toBe(true);
      expect(telegram.sent.length - before).toBe(2);
    });

    it('C5: the automatic requeue drains every preserved row across passes, and does not cycle one that fails again', async () => {
      await connectHealthy();
      await preserve(['d1', 'd2', 'd3', 'd4', 'd5']);
      await service.membershipChanged(botScope(tenantA, SEED_IDS.botA1), system(), {
        idempotencyKey: key('member'),
        botInstanceId: SEED_IDS.botA1,
        chatId: GROUP_CHAT,
        status: 'administrator',
      });
      // The check that finds it healthy moves the first batch of two...
      expect(await service.maintain(tenantA, system())).toBe('CHECKED');
      expect((await service.view(tenantA, owner)).queue).toEqual({ pending: 2, preserved: 3 });
      // ...and the next passes drain the rest.
      expect(await service.maintain(tenantA, system())).toBe('REQUEUED');
      expect(await service.maintain(tenantA, system())).toBe('REQUEUED');
      expect((await service.view(tenantA, owner)).queue).toEqual({ pending: 5, preserved: 0 });
      expect(await service.maintain(tenantA, system())).toBe('IDLE');

      // A row that fails AGAIN after its requeue is not requeued again by the drain.
      transport.always = { outcome: 'FAILED_PERMANENT', errorCode: 'x', errorMessage: 'no' };
      await makeDue();
      await dispatcher.tick();
      expect((await service.view(tenantA, owner)).queue.preserved).toBe(5);
      expect(await service.maintain(tenantA, system())).toBe('IDLE');
      expect((await service.view(tenantA, owner)).queue.preserved).toBe(5);
    });

    it('C6: a topic another creator holds keeps the group unverified until its lease lapses', async () => {
      expect(await bind(await issueCode())).toBe('CONNECTED');
      const group = await repository.findGroup(tenantA);
      // A creator that died holding the SYSTEM topic's claim.
      const row = await repository.ensureTopicRow(tenantA, {
        id: ctx.container.ids.uuid(),
        groupId: group!.id,
        chatId: GROUP_CHAT,
        category: 'SYSTEM',
        now: clock.now(),
      });
      await repository.claimTopicCreation(tenantA, {
        topicId: row.id,
        token: ctx.container.ids.uuid(),
        until: new Date(clock.now().getTime() + 60_000),
        now: clock.now(),
      });

      expect(await service.maintain(tenantA, system())).toBe('CHECKED');
      const held = await service.view(tenantA, owner);
      expect(held.health).toBe('UNVERIFIED');
      expect(held.topics.find((topic) => topic.category === 'SYSTEM')?.state).toBe('PENDING');

      // The lease lapses; the next pass creates the topic and only then calls it healthy.
      clock.advance(61_000);
      expect(await service.maintain(tenantA, system())).toBe('CHECKED');
      const done = await service.view(tenantA, owner);
      expect(done.health).toBe('HEALTHY');
      expect(done.topics.every((topic) => topic.state === 'READY')).toBe(true);
    });
  });

  describe('Codex review #2 of PR #99', () => {
    it('1: a deleted topic on the first claimed intent leaves no slot for the second', async () => {
      await connectHealthy();
      await ctx.container.settingsService.set(tenantA, owner, {
        key: 'ops.notifications.max_per_minute',
        value: 2,
        expectedVersion: null,
        idempotencyKey: key('rate'),
      });
      const systemTopic = (await repository.listTopics(tenantA, GROUP_CHAT)).find(
        (topic) => topic.category === 'SYSTEM',
      );
      transport.deletedThreads.add(systemTopic!.messageThreadId!);
      await raise('batch-1');
      await raise('batch-2');

      const first = await dispatcher.tick();
      // Two calls in the window: the refused send and the resend. The second intent was
      // claimed on the batch's budget and is handed back unsent.
      expect(transport.messages).toHaveLength(2);
      expect(first).toMatchObject({ claimed: 2, sent: 1, deferred: 1 });
      const pending = (await ctx.container.notifications.list(tenantA, owner)).find(
        (n) => n.status === 'PENDING',
      );
      const detail = await ctx.container.notifications.get(tenantA, owner, pending!.id);
      // No attempt spent: nothing reached the transport for it.
      expect(detail.attempts).toHaveLength(0);
      expect(detail.releasedClaims.map((claim) => claim.reason)).toEqual(['rate.window_full']);

      dispatcher.resetRateWindow();
      expect((await dispatcher.tick()).sent).toBe(1);
      expect(transport.messages).toHaveLength(3);
      const all = await ctx.container.notifications.list(tenantA, owner);
      expect(all.every((n) => n.status === 'SENT')).toBe(true);
    });

    it('4: a refusal is remembered under the update key, so a redelivery posts nothing', async () => {
      const updateKey = key('update');
      const malformed = () =>
        service.bindFromTelegram(
          botScope(tenantA, SEED_IDS.botA1),
          systemJobActor(`telegram-update:${SEED_IDS.botA1}`, 'test-correlation' as CorrelationId),
          {
            idempotencyKey: updateKey,
            botInstanceId: SEED_IDS.botA1,
            chat: { id: GROUP_CHAT, type: 'supergroup', title: 'Nexa Ops', isForum: true },
            rawCode: 'not-a-code',
          },
        );
      expect(await malformed()).toBe('REFUSED');
      expect(await malformed()).toBe('REFUSED');
      expect(telegram.sent).toHaveLength(1);

      const code = await issueCode();
      const notForumKey = key('update');
      expect(await bind(code, { isForum: false, updateKey: notForumKey })).toBe('NOT_FORUM');
      expect(await bind(code, { isForum: false, updateKey: notForumKey })).toBe('NOT_FORUM');
      expect(telegram.sent).toHaveLength(2);
      // Still unused: a new update from the group, with topics on, connects.
      expect(await bind(code)).toBe('CONNECTED');
    });

    it('6: a disconnect that lands while the test sends are in flight is not requeued behind', async () => {
      await connectHealthy();
      transport.always = { outcome: 'FAILED_PERMANENT', errorCode: 'x', errorMessage: 'no' };
      await raise('test-race');
      await dispatcher.tick();
      transport.always = null;
      expect((await service.view(tenantA, owner)).queue.preserved).toBe(1);

      let release!: () => void;
      telegram.sendGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        telegram.sending = resolve;
      });
      const testing = service.sendTest(tenantA, owner, { idempotencyKey: key('test') });
      await entered;
      await service.disconnect(tenantA, owner, { idempotencyKey: key('disconnect') });
      release();
      const tested = await testing;

      expect(tested.results.every((result) => result.outcome === 'SENT')).toBe(true);
      expect(tested.opsGroup.connection).toBe('DISCONNECTED');
      expect(tested.opsGroup.queue).toEqual({ pending: 0, preserved: 1 });
    });
  });

  // -------------------------------------------------------------------------
  // HF-A4: every event routed to the operations log is durable
  // -------------------------------------------------------------------------

  describe('HF-A4: nothing routed to the operations log is dropped', () => {
    const tooMany = {
      outcome: 'FAILED_RETRYABLE',
      errorCode: 'telegram.rate_limited',
      errorMessage: 'Too Many Requests: retry after 1',
      retryAfterMs: 1_000,
      rateLimited: true,
    } as const;

    const raiseNamed = (n: number) =>
      ctx.container.opsLog.record(tenantA, {
        code: 'panel.health.unreachable',
        severity: 'ERROR',
        message: `event ${n}`,
        dedupeKey: `named-${n}`,
      });
    const namesSent = () =>
      transport.messages.map((message) => /event (\d)/.exec(message.text)?.[1]);

    /** Ticks until the allowance is spent: ten attempts, each made due at once. */
    async function spendAllowance(): Promise<void> {
      for (let attempt = 1; attempt <= 10; attempt += 1) {
        await dispatcher.tick();
        await makeDue();
      }
    }

    async function onlyIntent() {
      const [intent] = await ctx.container.notifications.list(tenantA, owner);
      return ctx.container.notifications.get(tenantA, owner, intent!.id);
    }

    /** Whatever runs next — a requeue, a worker pass, a tick — sends nothing again. */
    async function expectNothingSentAgain(): Promise<void> {
      const before = transport.messages.length;
      const requeued = await service.requeue(tenantA, owner, { idempotencyKey: key('again') });
      expect(requeued.requeued).toBe(0);
      expect(await service.maintain(tenantA, system())).not.toBe('REQUEUED');
      await makeDue();
      expect((await dispatcher.tick()).claimed).toBe(0);
      expect(transport.messages).toHaveLength(before);
    }

    it('queues an event raised before any group exists, keeps it, and delivers it once the group is connected', async () => {
      await raise('before-any-group');
      // Recorded before any send is attempted: committed with the event, routed to its
      // topic, and with no chat to snapshot.
      const [queued] = await ctx.container.notifications.list(tenantA, owner);
      expect(queued).toMatchObject({ status: 'PENDING', attemptCount: 0, maxAttempts: 10 });
      expect(queued?.destination).toEqual({
        transport: 'TELEGRAM',
        chatId: null,
        topicId: null,
        opsTopic: 'SYSTEM',
      });

      await spendAllowance();
      const preserved = await onlyIntent();
      expect(preserved.intent.status).toBe('FAILED');
      expect(preserved.attempts).toHaveLength(10);
      expect(
        preserved.attempts.every(
          (attempt) =>
            attempt.outcome === 'FAILED_RETRYABLE' &&
            attempt.errorCode === 'ops_group.not_connected',
        ),
      ).toBe(true);
      expect(transport.messages).toHaveLength(0);
      expect((await service.view(tenantA, owner)).queue).toEqual({ pending: 0, preserved: 1 });

      // Connecting the group, and the check that finds it healthy, requeues it.
      await connectHealthy();
      expect((await service.view(tenantA, owner)).queue).toEqual({ pending: 1, preserved: 0 });
      expect(await dispatcher.tick()).toMatchObject({ claimed: 1, sent: 1 });
      const systemThread = (await repository.listTopics(tenantA, GROUP_CHAT)).find(
        (topic) => topic.category === 'SYSTEM',
      )?.messageThreadId;
      expect(transport.messages).toHaveLength(1);
      expect(transport.messages[0]!.destination).toMatchObject({
        chatId: GROUP_CHAT,
        topicId: systemThread,
      });
      expect((await onlyIntent()).intent.status).toBe('SENT');
      await expectNothingSentAgain();
    });

    it('never hands the transport a message with no chat, when nothing can route it', async () => {
      await raise('no-router');
      const c = ctx.container;
      const unrouted = new NotificationDispatcher(
        c.notificationRepository,
        transport,
        c.templateResolver,
        c.settingsResolver,
        c.clock,
        c.ids,
        c.logger,
        c.opsLogWriter,
        {
          pollIntervalMs: 1_000,
          batchSize: 10,
          leaseMs: 60_000,
          baseBackoffMs: 1_000,
          maxBackoffMs: 5_000,
        },
      );
      expect(await unrouted.tick()).toMatchObject({ claimed: 1, sent: 0, failed: 1 });
      expect(transport.messages).toHaveLength(0);
      const waiting = await onlyIntent();
      expect(waiting.intent.status).toBe('PENDING');
      expect(waiting.attempts[0]).toMatchObject({
        outcome: 'FAILED_RETRYABLE',
        errorCode: 'ops_group.not_connected',
      });
    });

    it('addresses the financial log to the payments topic before any group exists', async () => {
      expect(await ctx.container.notifications.financialDestination(tenantA)).toEqual({
        transport: 'TELEGRAM',
        chatId: null,
        topicId: null,
        opsTopic: 'PAYMENTS',
      });
    });

    it.each([
      [
        'the bot was removed',
        'telegram.rejected.403',
        'Forbidden: bot was kicked from the supergroup chat',
        'BOT_REMOVED',
      ],
      [
        'the bot lost the right to post',
        'telegram.rejected.400',
        'Bad Request: not enough rights to send text messages to the chat',
        'CANNOT_SEND',
      ],
    ] as const)(
      'keeps an event when %s, and delivers it once after the repair',
      async (_case, errorCode, errorMessage, chatProblem) => {
        await connectHealthy();
        transport.always = { outcome: 'FAILED_PERMANENT', errorCode, errorMessage, chatProblem };
        await raise('chat-refused');

        await dispatcher.tick();
        // Not failed on the first refusal: the problem is the group's, and a group is
        // repaired. The panel names it.
        const first = await onlyIntent();
        expect(first.intent.status).toBe('PENDING');
        expect(first.attempts[0]).toMatchObject({ outcome: 'FAILED_RETRYABLE', errorCode });
        expect((await service.view(tenantA, owner)).problems).toContain(chatProblem);

        await makeDue();
        await spendAllowance();
        const preserved = await onlyIntent();
        expect(preserved.intent.status).toBe('FAILED');
        expect(preserved.attempts).toHaveLength(10);
        expect(preserved.attempts.some((attempt) => attempt.outcome === 'SUCCEEDED')).toBe(false);

        // The operator fixes it; Telegram reports the membership change; the worker checks.
        transport.always = null;
        await service.membershipChanged(botScope(tenantA, SEED_IDS.botA1), system(), {
          idempotencyKey: key('member'),
          botInstanceId: SEED_IDS.botA1,
          chatId: GROUP_CHAT,
          status: 'administrator',
        });
        expect(await service.maintain(tenantA, system())).toBe('CHECKED');
        expect(await dispatcher.tick()).toMatchObject({ claimed: 1, sent: 1 });
        expect((await onlyIntent()).intent.status).toBe('SENT');
        await expectNothingSentAgain();
      },
    );

    it('keeps an event through a Telegram outage, and requeues it by itself once Telegram answers', async () => {
      await connectHealthy();
      // A timeout is an unknown outcome and IS counted: retried, never dropped.
      transport.always = {
        outcome: 'FAILED_RETRYABLE',
        errorCode: 'telegram.unreachable',
        errorMessage: 'The operation was aborted due to timeout',
      };
      await raise('outage');
      await spendAllowance();
      expect((await onlyIntent()).intent.status).toBe('FAILED');
      // Exhausted against a group recorded healthy: that record is no longer evidence.
      expect((await service.view(tenantA, owner)).health).toBe('UNVERIFIED');

      transport.always = null;
      expect(await service.maintain(tenantA, system())).toBe('CHECKED');
      expect((await service.view(tenantA, owner)).queue).toEqual({ pending: 1, preserved: 0 });
      expect(await dispatcher.tick()).toMatchObject({ claimed: 1, sent: 1 });
      const delivered = await onlyIntent();
      expect(delivered.intent.status).toBe('SENT');
      expect(delivered.attempts.map((attempt) => attempt.outcome)).toEqual([
        ...Array.from({ length: 10 }, () => 'FAILED_RETRYABLE'),
        'SUCCEEDED',
      ]);
      await expectNothingSentAgain();
    });

    it('keeps an event whose deleted topic cannot be recreated, and delivers it once the topic is back', async () => {
      await connectHealthy();
      const deleted = (await repository.listTopics(tenantA, GROUP_CHAT)).find(
        (topic) => topic.category === 'SYSTEM',
      );
      transport.deletedThreads.add(deleted!.messageThreadId!);
      telegram.createRefused = true;
      await raise('topic-gone');
      await spendAllowance();
      expect((await onlyIntent()).intent.status).toBe('FAILED');
      expect((await service.view(tenantA, owner)).health).toBe('UNVERIFIED');

      // The right is restored; the worker's check recreates the topic and requeues.
      telegram.createRefused = false;
      expect(await service.maintain(tenantA, system())).toBe('CHECKED');
      const recreated = (await repository.listTopics(tenantA, GROUP_CHAT)).find(
        (topic) => topic.category === 'SYSTEM',
      );
      expect(recreated).toMatchObject({ state: 'READY', recreatedCount: 1 });
      expect(await dispatcher.tick()).toMatchObject({ claimed: 1, sent: 1 });
      expect(transport.messages.at(-1)!.destination).toMatchObject({
        topicId: recreated!.messageThreadId,
      });
      await expectNothingSentAgain();
    });

    it('never counts a 429 against the allowance: more 429s than attempts, then delivered once', async () => {
      await connectHealthy();
      await raise('rate-limited');
      transport.script = Array.from({ length: 12 }, () => ({ ...tooMany }));
      for (let answer = 1; answer <= 12; answer += 1) {
        dispatcher.resetRateWindow();
        await makeDue();
        expect(await dispatcher.tick()).toMatchObject({ claimed: 1, failed: 1, abandoned: 0 });
      }
      const waiting = await onlyIntent();
      expect(waiting.intent.status).toBe('PENDING');
      expect(waiting.intent.maxAttempts).toBe(22);
      expect(waiting.attempts).toHaveLength(12);
      expect(
        waiting.attempts.every(
          (attempt) =>
            attempt.errorCode === 'telegram.rate_limited' && attempt.retryAfterMs === 1_000,
        ),
      ).toBe(true);
      // Telegram's wait is honoured before the next attempt.
      expect(waiting.intent.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
        waiting.attempts.at(-1)!.finishedAt.getTime() + 1_000,
      );

      dispatcher.resetRateWindow();
      await makeDue();
      expect(await dispatcher.tick()).toMatchObject({ claimed: 1, sent: 1 });
      expect((await onlyIntent()).intent.status).toBe('SENT');
    });

    it('holds every send behind a 429 until the wait is over, spending nothing for the rest', async () => {
      await connectHealthy();
      await raiseNamed(1);
      await raiseNamed(2);
      await raiseNamed(3);
      transport.script = [{ ...tooMany, retryAfterMs: 60_000 }];
      expect(await dispatcher.tick()).toMatchObject({
        claimed: 3,
        sent: 0,
        failed: 1,
        deferred: 2,
      });
      expect(transport.messages).toHaveLength(1);
      // Paused: nothing is claimed while Telegram's wait lasts.
      await makeDue();
      expect((await dispatcher.tick()).claimed).toBe(0);

      // The two behind it were handed back unsent: no attempt, their claims returned.
      const details = await Promise.all(
        (await ctx.container.notifications.list(tenantA, owner)).map((intent) =>
          ctx.container.notifications.get(tenantA, owner, intent.id),
        ),
      );
      expect(details.map((detail) => detail.attempts.length).sort()).toEqual([0, 0, 1]);
      expect(details.filter((detail) => detail.releasedClaims.length === 1)).toHaveLength(2);

      dispatcher.resetRateWindow();
      await makeDue();
      expect(await dispatcher.tick()).toMatchObject({ claimed: 3, sent: 3 });
    });

    it('drains a reconnect backlog within the per-minute ceiling, oldest first and each once', async () => {
      await connectHealthy();
      await service.disconnect(tenantA, owner, { idempotencyKey: key('disconnect') });
      for (const n of [1, 2, 3, 4, 5]) await raiseNamed(n);
      await spendAllowance();
      expect((await service.view(tenantA, owner)).queue).toEqual({ pending: 0, preserved: 5 });
      expect(transport.messages).toHaveLength(0);

      await ctx.container.settingsService.set(tenantA, owner, {
        key: 'ops.notifications.max_per_minute',
        value: 2,
        expectedVersion: null,
        idempotencyKey: key('rate'),
      });
      // The reconnect's check requeues one batch; the worker drains the rest.
      await service.reconnect(tenantA, owner, { idempotencyKey: key('reconnect') });
      expect(await service.maintain(tenantA, system())).toBe('REQUEUED');
      expect(await service.maintain(tenantA, system())).toBe('REQUEUED');
      expect((await service.view(tenantA, owner)).queue).toEqual({ pending: 5, preserved: 0 });

      // Two a minute, however large the backlog: no flood.
      const sentPerTick: number[] = [];
      for (let window = 1; window <= 3; window += 1) {
        dispatcher.resetRateWindow();
        sentPerTick.push((await dispatcher.tick()).sent);
        sentPerTick.push((await dispatcher.tick()).sent);
      }
      expect(sentPerTick).toEqual([2, 0, 2, 0, 1, 0]);
      expect(namesSent()).toEqual(['1', '2', '3', '4', '5']);
      await expectNothingSentAgain();
    });

    it('sends events that are due together oldest first', async () => {
      await connectHealthy();
      for (const n of [1, 2, 3, 4, 5]) await raiseNamed(n);
      // A requeue makes a backlog due at one instant. Rewritten newest first, so the rows'
      // physical order is the reverse of the order they were raised in.
      const newestFirst = await ctx.container.notifications.list(tenantA, owner);
      for (const intent of newestFirst) {
        await ctx.container.database.db.execute(
          `UPDATE notifications SET next_attempt_at = TIMESTAMPTZ '2020-01-01T00:00:00Z'
            WHERE id = '${intent.id}'` as never,
        );
      }
      expect(await dispatcher.tick()).toMatchObject({ claimed: 5, sent: 5 });
      expect(namesSent()).toEqual(['1', '2', '3', '4', '5']);
    });
  });
});
