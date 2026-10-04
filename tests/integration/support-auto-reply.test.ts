import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  SUPPORT_AI_DEFAULT_CONFIG,
  isNexaError,
  systemJobActor,
  type ActorContext,
  type BusinessBotRight,
  type CorrelationId,
  type SupportAiConfigInput,
  type SupportAiOutcome,
} from '@nexa/contracts';
import { AssistantLoop } from '../../apps/api/src/modules/control/support-ai/application/assistant-loop';
import {
  SupportAutoEnqueuer,
  SupportAutoReplyService,
} from '../../apps/api/src/modules/control/support-ai/application/support-auto-reply.service';
import type { AutoContextFlags } from '../../apps/api/src/modules/control/support-ai/domain/auto-reply-guards';
import { DrizzleSupportAiJobRepository } from '../../apps/api/src/modules/control/support-ai/infrastructure/drizzle-support-ai-job.repository';
import { DrizzleSupportAiConfigRepository } from '../../apps/api/src/modules/control/support-ai/infrastructure/drizzle-support-ai.repository';
import { BusinessOutboundService } from '../../apps/api/src/modules/commerce/business-chats/application/business-outbound.service';
import type { BusinessSendOutcome } from '../../apps/api/src/modules/commerce/business-chats/application/business-transport';
import type { ParsedBusinessMessage } from '../../apps/api/src/modules/commerce/business-chats/domain/telegram-business';
import {
  DrizzleBusinessConversationRepository,
  DrizzleBusinessEscalationRepository,
  DrizzleBusinessMessageRepository,
  DrizzleBusinessOutboundRepository,
} from '../../apps/api/src/modules/commerce/business-chats/infrastructure/drizzle-business-conversation.repository';
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
 * TB7 — AUTO_REPLY_SAFE, handoff and tickets against a real database (program §25–§27, §37).
 *
 * What runs for real: the webhook's transaction (record + enqueue), the coalescing, the job's
 * conditional writes, the deterministic guards, the handoff with its escalation and ticket,
 * and TB2's lane with its final check. The provider is a scripted chain and Telegram a
 * scripted transport; the clock the loop claims by is shifted to step over the settle delay.
 */

const BOT = SEED_IDS.botA1;
const OWNER = '5000001';
const CUSTOMER = '7000001';
const OUR_BOT = '9000001';
const scopeA = { ...tenantA, botInstanceId: BOT } as never;
const DUE = 120_000; // comfortably past the settle delay (≤ 30 s) and the cooldown (20 s)

const grounded = {
  decision: 'REPLY',
  replyText: 'لطفاً برنامه را ببندید و دوباره باز کنید.',
  topic: 'CONNECTION_TROUBLESHOOTING',
  confidence: 'HIGH',
  factRefs: ['S1'],
  knowledgeRefs: [],
  ticketAction: 'NONE',
  summary: 'مشتری وصل نمی‌شود.',
  intent: 'اتصال',
};

class ScriptedTransport {
  sent: { chatId: string; text: string }[] = [];
  next: BusinessSendOutcome[] = [];
  nextMessageId = 900;
  async sendText(_scope: unknown, _actor: unknown, input: { chatId: string; text: string }) {
    this.sent.push({ chatId: input.chatId, text: input.text });
    const scripted = this.next.shift();
    if (scripted !== undefined) return scripted;
    this.nextMessageId += 1;
    return { outcome: 'DELIVERED' as const, messageId: this.nextMessageId };
  }
}

describe('AUTO_REPLY_SAFE, handoff and tickets (TB7)', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let operator: ActorContext;
  let jobs: DrizzleSupportAiJobRepository;
  let conversations: DrizzleBusinessConversationRepository;
  let outbound: DrizzleBusinessOutboundRepository;
  let auto: SupportAutoReplyService;
  let loop: AssistantLoop;
  let lane: BusinessOutboundService;
  let transport: ScriptedTransport;
  let next: SupportAiOutcome;
  let calls: number;
  let duringCall: (() => Promise<void>) | null;
  let flags: AutoContextFlags;
  let offset: number;
  let messageSeq = 100;
  let keySeq = 0;
  const key = (label: string) => `${label}-${Date.now()}-${(keySeq += 1)}`;
  const system = () => systemJobActor('auto-test', 'c' as CorrelationId);
  const db = () => ctx.container.database.db;

  function message(overrides: Partial<ParsedBusinessMessage> = {}): ParsedBusinessMessage {
    messageSeq += 1;
    return {
      connectionId: 'conn-1',
      chatId: CUSTOMER,
      chatType: 'private',
      messageId: messageSeq,
      fromUserId: CUSTOMER,
      senderBusinessBotId: null,
      isFromOffline: false,
      sentAt: new Date(),
      editedAt: null,
      kind: 'TEXT',
      text: 'سلام، اینترنتم وصل نمی‌شود',
      ...overrides,
    };
  }

  const record = async (
    m: ParsedBusinessMessage,
    k = key('update'),
    scope = scopeA,
    bot: string = BOT,
  ) =>
    (await ctx.container.businessConversations.recordMessage(scope, system(), {
      idempotencyKey: k,
      botInstanceId: bot,
      message: m,
      edited: false,
    }))!;

  async function configure(
    change: Partial<SupportAiConfigInput>,
    actor: ActorContext = owner,
    scope: never = tenantA as never,
  ) {
    const current = await ctx.container.supportAiConfig.view(scope, actor);
    return ctx.container.supportAiConfig.update(scope, actor, {
      idempotencyKey: key('cfg'),
      expectedVersion: current.version === 0 ? null : current.version,
      config: { ...current.config, ...change },
    });
  }

  async function conversation(id: string) {
    const found = await conversations.findById(scopeA, id);
    if (found === null) throw new Error('conversation missing');
    return found;
  }

  async function autoJobs(conversationId: string) {
    const rows = await db().execute(
      sql`SELECT id, state, outcome, handoff_reason FROM support_ai_jobs
          WHERE kind = 'AUTO_DECISION' AND conversation_id = ${conversationId}
          ORDER BY created_at, id`,
    );
    return rows.rows as {
      id: string;
      state: string;
      outcome: string | null;
      handoff_reason: string | null;
    }[];
  }

  async function autoRows(conversationId: string) {
    const rows = await db().execute(
      sql`SELECT id, state, control_epoch, body, failure_code FROM business_outbound_messages
          WHERE origin = 'AUTO' AND conversation_id = ${conversationId} ORDER BY created_at`,
    );
    return rows.rows as {
      id: string;
      state: string;
      control_epoch: number;
      body: string;
      failure_code: string | null;
    }[];
  }

  async function count(table: string) {
    const rows = await db().execute(sql.raw(`SELECT count(*)::int AS n FROM ${table}`));
    return (rows.rows[0] as { n: number }).n;
  }

  /** One assistant pass, with the clock shifted past the settle delay (or not). */
  const tick = async (shift = DUE) => {
    offset = shift;
    await loop.tick();
  };
  const deliver = () => lane.deliverDue(scopeA);
  const resume = (conversationId: string) =>
    ctx.container.businessConversations.resume(scopeA, operator, {
      conversationId,
      idempotencyKey: key('resume'),
    });

  beforeEach(async () => {
    ctx ??= await createTestContext();
    await ctx.reset();
    const c = ctx.container;
    await db().execute(
      sql`UPDATE bot_instances SET telegram_bot_id = ${OUR_BOT} WHERE id = ${BOT}`,
    );
    owner = adminActorFor(
      await createAdmin(c, tenantA, { username: 'owner', roleKeys: ['owner'] }),
    );
    operator = adminActorFor(
      await createAdmin(c, tenantA, { username: 'support1', roleKeys: ['support'] }),
    );
    await c.businessConnections.applyReport(scopeA, system(), {
      idempotencyKey: key('conn'),
      botInstanceId: BOT,
      report: {
        connectionId: 'conn-1',
        ownerTelegramUserId: OWNER,
        ownerUserChatId: OWNER,
        isEnabled: true,
        rights: ['can_reply'] as BusinessBotRight[],
        connectedAt: new Date('2026-10-01T00:00:00Z'),
      },
    });
    // The customer is a linked NEXA customer of tenant A (exact Telegram id).
    await db().execute(
      sql`INSERT INTO customers (id, tenant_id, telegram_user_id, status)
          VALUES (${c.ids.uuid()}, ${SEED_IDS.tenantA}, ${CUSTOMER}, 'ACTIVE')`,
    );
    await configure({
      mode: 'AUTO_REPLY_SAFE',
      primary: { provider: 'OPENAI', model: 'gpt-5.5' },
      autoTopics: ['CONNECTION_TROUBLESHOOTING', 'GREETING', 'SERVICE_INFO'],
    });

    next = {
      outcome: 'OK',
      output: grounded,
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'gpt-5.5',
    };
    calls = 0;
    duringCall = null;
    offset = 0;
    flags = {
      identityLinked: true,
      customerBlocked: false,
      hasUnderReviewPayment: false,
      hasUnreconciledService: false,
    };
    jobs = new DrizzleSupportAiJobRepository(c.database.db);
    conversations = new DrizzleBusinessConversationRepository(c.database.db);
    outbound = new DrizzleBusinessOutboundRepository(c.database.db);
    const configs = new DrizzleSupportAiConfigRepository(c.database.db);
    auto = new SupportAutoReplyService({
      jobs,
      configs,
      chain: {
        generate: async () => {
          calls += 1;
          if (duringCall !== null) await duringCall();
          return {
            outcome: next,
            step: { provider: 'OPENAI', model: 'gpt-5.5' },
            attempts: 1,
            exhausted: null,
          };
        },
      },
      context: {
        build: async () => ({
          json: '{"services":[{"alias":"S1"}]}',
          aliases: new Map([['S1', 'سرویس user123']]),
          linked: flags.identityLinked,
          flags,
        }),
      },
      conversations,
      messages: new DrizzleBusinessMessageRepository(c.database.db),
      outbound,
      control: c.businessConversations,
      uow: c.uow,
      scopeActivity: c.tenants,
      clock: c.clock,
    });
    loop = new AssistantLoop({ produce: async () => 'GONE' as const }, jobs, {
      auto,
      scope: () => scopeA,
      intervalMs: 1000,
      now: () => new Date(Date.now() + offset),
      logger: c.logger,
    });
    transport = new ScriptedTransport();
    lane = new BusinessOutboundService({
      outbound,
      conversations,
      messages: new DrizzleBusinessMessageRepository(c.database.db),
      control: c.businessConversations,
      transport,
      autoMode: new SupportAutoEnqueuer({ configs, jobs, ids: c.ids }),
      escalations: new DrizzleBusinessEscalationRepository(c.database.db),
      uow: c.uow,
      scopeActivity: c.tenants,
      clock: c.clock,
      ids: c.ids,
      logger: c.logger,
    });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  // --- the happy path, and what defaults leave off ---------------------------------------

  it('answers an allowlisted, grounded, confident question once, under the captured epoch', async () => {
    const first = await record(message());
    const before = await conversation(first.conversationId);
    await tick();
    expect(await autoJobs(first.conversationId)).toMatchObject([
      { state: 'SENT', outcome: 'sent' },
    ]);
    const [row] = await autoRows(first.conversationId);
    expect(row).toMatchObject({
      state: 'PENDING',
      control_epoch: before.controlEpoch,
      body: grounded.replyText,
    });
    await deliver();
    expect(transport.sent).toEqual([{ chatId: CUSTOMER, text: grounded.replyText }]);
    expect(await count('tickets')).toBe(0); // an ordinary answered question opens no ticket
    expect(await count('business_conversation_escalations')).toBe(0);
  });

  it('waits the settle delay: a job is not claimed before it is due', async () => {
    const first = await record(message());
    await tick(0);
    expect(calls).toBe(0);
    expect(await autoJobs(first.conversationId)).toMatchObject([{ state: 'QUEUED' }]);
    await tick();
    expect(calls).toBe(1);
  });

  it('a fresh tenant is OFF with an empty allowlist, and OFF enqueues nothing', async () => {
    const view = await ctx.container.supportAiConfig.view(
      tenantB as never,
      adminActorFor(
        await createAdmin(ctx.container, tenantB, { username: 'bowner', roleKeys: ['owner'] }),
      ),
    );
    expect(view.config).toMatchObject({ mode: 'OFF', autoTopics: [], autoMinConfidence: 'HIGH' });
    await configure({ mode: 'ASSIST_ONLY' });
    const first = await record(message());
    expect(await autoJobs(first.conversationId)).toEqual([]);
  });

  it('an empty allowlist means no automatic reply is ever sent', async () => {
    await configure({ autoTopics: [] });
    const first = await record(message());
    await tick();
    await deliver();
    expect(await autoJobs(first.conversationId)).toMatchObject([
      { state: 'FAILED', outcome: 'guard_topic_allowlist', handoff_reason: 'TOPIC_NOT_ALLOWED' },
    ]);
    expect(await autoRows(first.conversationId)).toEqual([]);
    expect(transport.sent).toEqual([]);
  });

  it('widening the allowlist is the CRITICAL permission; narrowing is not', async () => {
    // An operator granted `support_ai.configure` but not the CRITICAL `support_ai.auto_reply`.
    await db().execute(
      sql`INSERT INTO role_permissions (tenant_id, role_id, permission_key)
          SELECT tenant_id, id, 'support_ai.configure' FROM roles
          WHERE tenant_id = ${SEED_IDS.tenantA} AND key = 'operator'`,
    );
    const admin = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'admin1', roleKeys: ['operator'] }),
    );
    await expect(
      configure(
        { autoTopics: ['CONNECTION_TROUBLESHOOTING', 'GREETING', 'SERVICE_INFO', 'PLAN_INFO'] },
        admin,
      ),
    ).rejects.toSatisfy(isNexaError);
    await expect(configure({ autoMinConfidence: 'MEDIUM' }, admin)).rejects.toSatisfy(isNexaError);
    await configure({ autoTopics: ['GREETING'] }, admin);
    expect(
      (await ctx.container.supportAiConfig.view(tenantA as never, owner)).config.autoTopics,
    ).toEqual(['GREETING']);
  });

  // --- the human wins every race detectable before the send ------------------------------

  it('a human message during the settle delay: no provider call and no AUTO send', async () => {
    const first = await record(message());
    await record(message({ fromUserId: OWNER, text: 'سلام، من پشتیبان هستم' }));
    await tick();
    await deliver();
    expect(calls).toBe(0);
    expect(await autoJobs(first.conversationId)).toMatchObject([
      { state: 'DISCARDED', outcome: 'dropped_epoch' },
    ]);
    expect(await autoRows(first.conversationId)).toEqual([]);
    expect(transport.sent).toEqual([]);
  });

  it('a human message during the provider call: the reply is never enqueued', async () => {
    const first = await record(message());
    duringCall = async () => {
      await record(message({ fromUserId: OWNER, text: 'من جواب می‌دهم' }));
    };
    await tick();
    await deliver();
    expect(calls).toBe(1);
    expect(await autoJobs(first.conversationId)).toMatchObject([
      { state: 'DISCARDED', outcome: 'dropped_epoch' },
    ]);
    expect(await autoRows(first.conversationId)).toEqual([]);
    expect(transport.sent).toEqual([]);
  });

  it('a human message after the reply was enqueued: superseded at the final check', async () => {
    const first = await record(message());
    await tick();
    expect(await autoRows(first.conversationId)).toMatchObject([{ state: 'PENDING' }]);
    await record(message({ fromUserId: OWNER, text: 'من جواب می‌دهم' }));
    // Undo TB2's eager supersede, so the FINAL check alone has to refuse it.
    await db().execute(
      sql`UPDATE business_outbound_messages SET state = 'PENDING', resolved_at = NULL, failure_code = NULL
          WHERE origin = 'AUTO' AND conversation_id = ${first.conversationId}`,
    );
    await deliver();
    expect(transport.sent).toEqual([]);
    expect(await autoRows(first.conversationId)).toMatchObject([
      { state: 'SUPERSEDED', failure_code: 'conversation.moved_on' },
    ]);
  });

  it('a mode switched OFF while a job is pending drops it; while a row is queued, the lane refuses it', async () => {
    const first = await record(message());
    await configure({ mode: 'ASSIST_ONLY' });
    await tick();
    expect(calls).toBe(0);
    expect(await autoJobs(first.conversationId)).toMatchObject([
      { state: 'DISCARDED', outcome: 'dropped_mode' },
    ]);

    await configure({ mode: 'AUTO_REPLY_SAFE' });
    const second = await record(message({ text: 'هنوز وصل نمی‌شود' }));
    await tick();
    expect(await autoRows(second.conversationId)).toMatchObject([{ state: 'PENDING' }]);
    await configure({ mode: 'OFF', primary: null, fallbacks: [] });
    await deliver();
    expect(transport.sent).toEqual([]);
    expect(await autoRows(second.conversationId)).toMatchObject([
      { state: 'SUPERSEDED', failure_code: 'support_ai.mode_off' },
    ]);
  });

  it('two inbound messages coalesce into one job and one reply', async () => {
    const first = await record(message({ text: 'سلام' }));
    await record(message({ text: 'اینترنتم وصل نمی‌شود' }));
    expect(await autoJobs(first.conversationId)).toMatchObject([
      { state: 'DISCARDED', outcome: 'dropped_coalesced' },
      { state: 'QUEUED' },
    ]);
    await tick();
    await deliver();
    expect(calls).toBe(1);
    expect(transport.sent).toHaveLength(1);
  });

  it('a job replaced while its provider call is in flight writes nothing: one reply in all', async () => {
    const first = await record(message({ text: 'سلام' }));
    duringCall = async () => {
      duringCall = null;
      await record(message({ text: 'اینترنتم وصل نمی‌شود' }));
    };
    await tick();
    expect(await autoJobs(first.conversationId)).toMatchObject([
      { state: 'DISCARDED', outcome: 'dropped_coalesced' },
      { state: 'QUEUED' },
    ]);
    expect(await autoRows(first.conversationId)).toEqual([]);
    await tick();
    await deliver();
    expect(transport.sent).toHaveLength(1);
  });

  it('a redelivered inbound message enqueues no second job', async () => {
    const m = message();
    const first = await record(m, key('update'));
    await record(m, key('update-again'));
    // Still the one job, still pending: a redelivery neither duplicates nor replaces it.
    expect(await autoJobs(first.conversationId)).toMatchObject([
      { state: 'QUEUED', outcome: null },
    ]);
  });

  it('our own echo, an away message and the owner never start automatic work', async () => {
    const first = await record(message());
    await tick();
    await deliver();
    const [row] = await autoRows(first.conversationId);
    const sentId = (
      await db().execute(
        sql`SELECT telegram_message_id FROM business_outbound_messages WHERE id = ${row!.id}`,
      )
    ).rows[0] as { telegram_message_id: number };
    // The echo of our own reply, by both proofs, and an away message.
    await record(
      message({
        messageId: Number(sentId.telegram_message_id),
        fromUserId: OWNER,
        senderBusinessBotId: OUR_BOT,
        text: grounded.replyText,
      }),
    );
    await record(message({ fromUserId: OWNER, isFromOffline: true, text: 'در دسترس نیستیم' }));
    expect(await autoJobs(first.conversationId)).toHaveLength(1);
    expect((await conversation(first.conversationId)).state).toBe('AI_ACTIVE');
  });

  // --- the loop guard ----------------------------------------------------------------------

  it('stops after N consecutive automatic replies with no person, before any provider cost', async () => {
    await configure({ maxConsecutiveReplies: 1 });
    const first = await record(message());
    await tick();
    await deliver();
    expect(transport.sent).toHaveLength(1);
    await record(message({ text: 'باز هم وصل نشد' }));
    await tick();
    expect(calls).toBe(1);
    expect((await autoJobs(first.conversationId))[1]).toMatchObject({
      state: 'FAILED',
      outcome: 'guard_consecutive',
      handoff_reason: 'LOOP_GUARD',
    });
    expect(await conversation(first.conversationId)).toMatchObject({
      state: 'HANDOFF_REQUIRED',
      handoffReason: 'LOOP_GUARD',
    });
    // A person resuming the AI resets the count: the epoch moved.
    await resume(first.conversationId);
    await record(message({ text: 'دوباره سلام' }));
    await tick();
    expect((await autoJobs(first.conversationId))[2]).toMatchObject({ outcome: 'sent' });
  });

  it('caps automatic replies per window whatever the epoch', async () => {
    const first = await record(message());
    const convo = await conversation(first.conversationId);
    // Ten AUTO replies in the last hour, all under OLDER epochs (a person resumed in between).
    for (let i = 0; i < 10; i += 1) {
      await db().execute(
        sql`INSERT INTO business_outbound_messages
              (id, tenant_id, conversation_id, origin, body, control_epoch, idempotency_key, request_hash, state, resolved_at)
            VALUES (${ctx.container.ids.uuid()}, ${SEED_IDS.tenantA}, ${convo.id}, 'AUTO', 'x', 0,
                    ${key('old')}, 'h', 'DELIVERED', now())`,
      );
    }
    await db().execute(
      sql`UPDATE business_conversations SET control_epoch = 7 WHERE id = ${convo.id}`,
    );
    await db().execute(
      sql`UPDATE support_ai_jobs SET control_epoch = 7 WHERE conversation_id = ${convo.id}`,
    );
    await tick();
    expect(calls).toBe(0);
    expect(await autoJobs(first.conversationId)).toMatchObject([
      { outcome: 'guard_window', handoff_reason: 'LOOP_GUARD' },
    ]);
  });

  // --- each guard, alone, blocks the send and hands off ----------------------------------

  it('each guard individually blocks the reply and hands off with its own reason', async () => {
    type Case = {
      readonly name: string;
      readonly output?: Record<string, unknown>;
      readonly outcome?: SupportAiOutcome;
      readonly flags?: Partial<AutoContextFlags>;
      readonly message?: Partial<ParsedBusinessMessage>;
      readonly expected: { outcome: string; reason: string };
    };
    const cases: Case[] = [
      {
        name: 'model hands off',
        output: { decision: 'HANDOFF', replyText: '' },
        expected: { outcome: 'handoff_ai_requested', reason: 'AI_REQUESTED' },
      },
      {
        name: 'ticket suggestion',
        output: { decision: 'CREATE_OR_LINK_TICKET' },
        expected: { outcome: 'handoff_ai_requested', reason: 'AI_REQUESTED' },
      },
      {
        name: 'hard topic',
        output: { topic: 'REFUND' },
        expected: { outcome: 'guard_handoff_topic', reason: 'HANDOFF_TOPIC' },
      },
      {
        name: 'human requested',
        output: { topic: 'HUMAN_REQUESTED' },
        expected: { outcome: 'guard_human_requested', reason: 'HUMAN_REQUESTED' },
      },
      {
        name: 'not REPLY',
        output: { decision: 'ASK_CLARIFYING_QUESTION' },
        expected: { outcome: 'guard_decision', reason: 'DECISION_NOT_REPLY' },
      },
      {
        name: 'off the allowlist',
        output: { topic: 'PLAN_INFO' },
        expected: { outcome: 'guard_topic_allowlist', reason: 'TOPIC_NOT_ALLOWED' },
      },
      {
        name: 'unlinked, account topic',
        output: { topic: 'SERVICE_INFO', factRefs: [] },
        flags: { identityLinked: false },
        expected: { outcome: 'guard_identity', reason: 'IDENTITY_UNVERIFIED' },
      },
      {
        name: 'payment under review',
        flags: { hasUnderReviewPayment: true },
        expected: { outcome: 'guard_account_review', reason: 'ACCOUNT_UNDER_REVIEW' },
      },
      {
        name: 'unreconciled service',
        flags: { hasUnreconciledService: true },
        expected: { outcome: 'guard_account_review', reason: 'ACCOUNT_UNDER_REVIEW' },
      },
      {
        name: 'medium confidence',
        output: { confidence: 'MEDIUM' },
        expected: { outcome: 'guard_confidence', reason: 'LOW_CONFIDENCE' },
      },
      {
        name: 'empty reply',
        output: { replyText: '   ' },
        expected: { outcome: 'guard_reply_bounds', reason: 'REPLY_OUT_OF_BOUNDS' },
      },
      {
        name: 'over the configured bound',
        output: { replyText: 'ب'.repeat(SUPPORT_AI_DEFAULT_CONFIG.maxOutputChars + 1) },
        expected: { outcome: 'guard_reply_bounds', reason: 'REPLY_OUT_OF_BOUNDS' },
      },
      {
        name: 'ungrounded citation',
        output: { factRefs: ['S1', 'Z9'] },
        expected: { outcome: 'guard_grounding', reason: 'INSUFFICIENT_GROUNDING' },
      },
      {
        name: 'blocked customer',
        flags: { customerBlocked: true },
        expected: { outcome: 'guard_customer_blocked', reason: 'CUSTOMER_BLOCKED' },
      },
      {
        name: 'an image',
        message: { kind: 'PHOTO', text: null },
        expected: { outcome: 'guard_content', reason: 'UNSUPPORTED_CONTENT' },
      },
      {
        name: 'invalid output',
        output: { refund: true },
        expected: { outcome: 'handoff_output_invalid', reason: 'AI_OUTPUT_INVALID' },
      },
      {
        name: 'provider refusal',
        outcome: { outcome: 'REFUSED_BY_PROVIDER', code: 'refusal' },
        expected: { outcome: 'handoff_output_invalid', reason: 'AI_OUTPUT_INVALID' },
      },
      {
        name: 'chain failure',
        outcome: { outcome: 'TEMPORARY', code: 'overloaded' },
        expected: { outcome: 'handoff_ai_unavailable', reason: 'AI_UNAVAILABLE' },
      },
    ];
    let conversationId: string | null = null;
    for (const item of cases) {
      if (conversationId !== null) await resume(conversationId);
      next = item.outcome ?? {
        outcome: 'OK',
        output: { ...grounded, ...item.output },
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'gpt-5.5',
      };
      flags = {
        identityLinked: true,
        customerBlocked: false,
        hasUnderReviewPayment: false,
        hasUnreconciledService: false,
        ...item.flags,
      };
      const recorded = await record(message(item.message ?? {}));
      conversationId = recorded.conversationId;
      await tick();
      const latest = (await autoJobs(conversationId)).at(-1);
      expect(latest, item.name).toMatchObject({
        state: 'FAILED',
        outcome: item.expected.outcome,
        handoff_reason: item.expected.reason,
      });
      expect(await conversation(conversationId), item.name).toMatchObject({
        state: 'HANDOFF_REQUIRED',
        handoffReason: item.expected.reason,
      });
    }
    await deliver();
    expect(await autoRows(conversationId!)).toEqual([]);
    expect(transport.sent).toEqual([]);
  });

  it('a job retried out hands off as unavailable, never loops', async () => {
    const first = await record(message());
    await db().execute(
      sql`UPDATE support_ai_jobs SET attempts = 3 WHERE conversation_id = ${first.conversationId}`,
    );
    await tick();
    expect(calls).toBe(0);
    expect(await autoJobs(first.conversationId)).toMatchObject([
      { outcome: 'handoff_ai_unavailable', handoff_reason: 'AI_UNAVAILABLE' },
    ]);
  });

  // --- the handoff: one ticket, linked on repeat, and a signal -----------------------------

  it('a handoff opens exactly one ticket, links it on the next handoff, and signals an operator', async () => {
    next = {
      outcome: 'OK',
      output: { ...grounded, topic: 'REFUND', summary: 'مشتری بازپرداخت می‌خواهد.' },
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'm',
    };
    const first = await record(message({ text: 'پولم را پس بدهید' }));
    await tick();
    const handed = await conversation(first.conversationId);
    expect(handed.state).toBe('HANDOFF_REQUIRED');
    expect(handed.ticketId).not.toBeNull();
    const tickets = await db().execute(sql`SELECT id, origin, status, opening_key FROM tickets`);
    expect(tickets.rows).toMatchObject([
      { id: handed.ticketId, origin: 'BUSINESS_CHAT', status: 'OPEN' },
    ]);
    const signal = await db().execute(
      sql`SELECT code, resolved_at FROM operational_events WHERE code = 'support.handoff_required'`,
    );
    expect(signal.rows).toHaveLength(1);
    // The operator reads the AI's note on the ticket; the customer's bot shows only a fact.
    const detail = await ctx.container.tickets.detail(tenantA as never, owner, handed.ticketId!);
    expect(detail.escalations).toMatchObject([
      { reason: 'HANDOFF_TOPIC', summary: 'مشتری بازپرداخت می‌خواهد.' },
    ]);
    expect(detail.messages).toMatchObject([
      {
        message: { senderType: 'SYSTEM', systemEvent: 'ESCALATED_FROM_BUSINESS_CHAT', body: null },
      },
    ]);

    // Resume, and hand off again: the same ticket, linked — never a duplicate.
    await resume(first.conversationId);
    const resolved = await db().execute(
      sql`SELECT count(*)::int AS n FROM operational_events WHERE code = 'support.handoff_resolved'`,
    );
    expect((resolved.rows[0] as { n: number }).n).toBe(1);
    await record(message({ text: 'هنوز پولم را نگرفتم' }));
    await tick();
    expect(await count('tickets')).toBe(1);
    const escalations = await db().execute(
      sql`SELECT ticket_id, ticket_outcome FROM business_conversation_escalations ORDER BY created_at`,
    );
    expect(escalations.rows).toMatchObject([
      { ticket_id: handed.ticketId, ticket_outcome: 'CREATED' },
      { ticket_id: handed.ticketId, ticket_outcome: 'LINKED' },
    ]);
    expect(
      (await ctx.container.tickets.detail(tenantA as never, owner, handed.ticketId!)).messages,
    ).toHaveLength(2);
  });

  it("links the customer's existing active ticket instead of opening another", async () => {
    const customer = (
      await db().execute(sql`SELECT id FROM customers WHERE telegram_user_id = ${CUSTOMER}`)
    ).rows[0] as { id: string };
    await ctx.container.ticketCategories.ensureSeeded(tenantA as never);
    const category = (
      await db().execute(
        sql`SELECT id FROM ticket_categories WHERE tenant_id = ${SEED_IDS.tenantA} LIMIT 1`,
      )
    ).rows[0] as { id: string };
    const existing = await ctx.container.tickets.openByCustomer(tenantA as never, system(), {
      customerId: customer.id as never,
      botInstanceId: SEED_IDS.botA2 as never,
      categoryId: category.id,
      text: 'سرویسم کار نمی‌کند',
      file: null,
      idempotencyKey: key('open'),
    });
    next = {
      outcome: 'OK',
      output: { ...grounded, decision: 'HANDOFF', replyText: '' },
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'm',
    };
    const first = await record(message());
    await tick();
    expect(await count('tickets')).toBe(1);
    expect((await conversation(first.conversationId)).ticketId).toBe(existing.ticket.id);
  });

  it('an unlinked customer is handed off and recorded with no ticket', async () => {
    await db().execute(sql`DELETE FROM customers WHERE telegram_user_id = ${CUSTOMER}`);
    next = {
      outcome: 'OK',
      output: { ...grounded, decision: 'HANDOFF', replyText: '' },
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'm',
    };
    const first = await record(message());
    await tick();
    expect(await conversation(first.conversationId)).toMatchObject({
      state: 'HANDOFF_REQUIRED',
      ticketId: null,
    });
    expect(await count('tickets')).toBe(0);
    const escalations = await db().execute(
      sql`SELECT ticket_outcome FROM business_conversation_escalations`,
    );
    expect(escalations.rows).toEqual([{ ticket_outcome: 'NO_CUSTOMER' }]);
  });

  // --- the send's unknown outcome --------------------------------------------------------

  it('an UNKNOWN send is UNCONFIRMED, never resent, and hands off with a ticket', async () => {
    const first = await record(message());
    await tick();
    transport.next.push({ outcome: 'UNKNOWN', errorCode: 'telegram.unreachable' });
    await deliver();
    expect(await autoRows(first.conversationId)).toMatchObject([{ state: 'UNCONFIRMED' }]);
    const handed = await conversation(first.conversationId);
    expect(handed).toMatchObject({
      state: 'HANDOFF_REQUIRED',
      handoffReason: 'SEND_OUTCOME_UNKNOWN',
    });
    expect(handed.ticketId).not.toBeNull();
    await deliver();
    expect(transport.sent).toHaveLength(1);
  });

  // --- tenants ---------------------------------------------------------------------------

  it("one tenant's loop never touches another tenant's jobs, and each tenant's mode is its own", async () => {
    const scopeB = { ...tenantB, botInstanceId: SEED_IDS.botB1 } as never;
    const bOwner = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'bowner', roleKeys: ['owner'] }),
    );
    await ctx.container.businessConnections.applyReport(scopeB, system(), {
      idempotencyKey: key('conn-b'),
      botInstanceId: SEED_IDS.botB1,
      report: {
        connectionId: 'conn-b',
        ownerTelegramUserId: '5000002',
        ownerUserChatId: '5000002',
        isEnabled: true,
        rights: ['can_reply'] as BusinessBotRight[],
        connectedAt: new Date('2026-10-01T00:00:00Z'),
      },
    });
    // Tenant B is OFF: its inbound message enqueues nothing.
    const b1 = await record(message({ connectionId: 'conn-b' }), key('b'), scopeB, SEED_IDS.botB1);
    expect(await count('support_ai_jobs')).toBe(0);
    // Tenant B in AUTO: its job exists, and tenant A's loop does not claim it.
    await configure(
      {
        mode: 'AUTO_REPLY_SAFE',
        primary: { provider: 'OPENAI', model: 'm' },
        autoTopics: ['CONNECTION_TROUBLESHOOTING'],
      },
      bOwner,
      tenantB as never,
    );
    await record(message({ connectionId: 'conn-b' }), key('b'), scopeB, SEED_IDS.botB1);
    await tick();
    expect(calls).toBe(0);
    const bJobs = await db().execute(
      sql`SELECT state, tenant_id FROM support_ai_jobs WHERE conversation_id = ${b1.conversationId}`,
    );
    expect(bJobs.rows).toEqual([{ state: 'QUEUED', tenant_id: SEED_IDS.tenantB }]);
  });
});
