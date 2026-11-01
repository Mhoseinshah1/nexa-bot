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
import { SupportAutoEnqueuer } from '../../apps/api/src/modules/control/support-ai/application/support-auto-reply.service';
import { DrizzleSupportAiJobRepository } from '../../apps/api/src/modules/control/support-ai/infrastructure/drizzle-support-ai-job.repository';
import { DrizzleBusinessConversationRepository } from '../../apps/api/src/modules/commerce/business-chats/infrastructure/drizzle-business-conversation.repository';
import { SupportTestConsoleService } from '../../apps/api/src/modules/control/support-ai/application/support-test-console.service';
import type { SupportContextSource } from '../../apps/api/src/modules/control/support-ai/application/support-assist.service';
import { DrizzleSupportAiConfigRepository } from '../../apps/api/src/modules/control/support-ai/infrastructure/drizzle-support-ai.repository';
import {
  SEED_IDS,
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  type TestContext,
} from './harness';

/**
 * Phase 4 PR-5 — the Web Admin's support pages against a real database: the test console
 * (sends nothing, ever), the readiness card, the text behind handoffs, ASSIST_ONLY's automatic
 * drafts, and «بازگرداندن همه به هوش مصنوعی».
 */

const BOT = SEED_IDS.botA1;
const scopeA = { ...tenantA, botInstanceId: BOT } as never;
const OWNER_TG = '5000001';
const CUSTOMER_TG = '7000001';

const reply = {
  decision: 'REPLY',
  replyText: 'لطفاً برنامه را ببندید و دوباره باز کنید.',
  topic: 'CONNECTION_TROUBLESHOOTING',
  confidence: 'HIGH',
  factRefs: [],
  knowledgeRefs: ['K1'],
  ticketAction: 'NONE',
  summary: 'مشتری وصل نمی‌شود.',
  intent: 'اتصال',
};

describe('support admin UX (Phase 4 PR-5)', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let supportStaff: ActorContext;
  let observer: ActorContext;
  /** Holds support_ai.configure by a grant, and neither users.view nor business_chats.view. */
  let configOnly: ActorContext;
  let console_: SupportTestConsoleService;
  let next: SupportAiOutcome;
  let chainCalls: number;
  let linked: boolean;
  let contextJson: string;
  let keySeq = 0;
  let messageSeq = 100;
  const key = (label: string) => `${label}-${Date.now()}-${(keySeq += 1)}`;
  const system = () => systemJobActor('ux-test', 'c' as CorrelationId);
  const db = () => ctx.container.database.db;

  async function configure(change: Partial<SupportAiConfigInput>) {
    const c = ctx.container;
    const current = await c.supportAiConfig.view(tenantA, owner);
    return c.supportAiConfig.update(tenantA, owner, {
      idempotencyKey: key('cfg'),
      expectedVersion: current.version === 0 ? null : current.version,
      config: { ...current.config, ...change },
    });
  }

  async function inbound(chatId = CUSTOMER_TG, text = 'سلام، اینترنتم وصل نمی‌شود') {
    messageSeq += 1;
    return (await ctx.container.businessConversations.recordMessage(scopeA, system(), {
      idempotencyKey: key('msg'),
      botInstanceId: BOT,
      edited: false,
      message: {
        connectionId: 'conn-1',
        chatId,
        chatType: 'private',
        messageId: messageSeq,
        fromUserId: chatId,
        senderBusinessBotId: null,
        isFromOffline: false,
        sentAt: new Date(),
        editedAt: null,
        kind: 'TEXT',
        text,
        photo: null,
      },
    }))!;
  }

  const count = async (table: string) =>
    (
      (await db().execute(sql.raw(`SELECT count(*)::int AS n FROM ${table}`))).rows[0] as {
        n: number;
      }
    ).n;

  /** Every table a customer-visible message, a handoff or a conversation change would touch. */
  async function snapshot() {
    return {
      outbound: await count('business_outbound_messages'),
      jobs: await count('support_ai_jobs'),
      escalations: await count('business_conversation_escalations'),
      tickets: await count('tickets'),
      outbox: await count('outbox_messages'),
      conversations: (
        await db().execute(
          sql`SELECT id, state, control_epoch, last_ai_at, version FROM business_conversations ORDER BY id`,
        )
      ).rows,
    };
  }

  const codeOf = (error: unknown) => (isNexaError(error) ? error.code : null);

  beforeEach(async () => {
    ctx ??= await createTestContext();
    await ctx.reset();
    const c = ctx.container;
    owner = adminActorFor(
      await createAdmin(c, tenantA, { username: 'owner', roleKeys: ['owner'] }),
    );
    supportStaff = adminActorFor(
      await createAdmin(c, tenantA, { username: 'support1', roleKeys: ['support'] }),
    );
    observer = adminActorFor(
      await createAdmin(c, tenantA, { username: 'observer1', roleKeys: ['observer'] }),
    );
    const bare = await createAdmin(c, tenantA, {
      username: 'bare1',
      roleKeys: ['receipt_reviewer'],
    });
    await c.database.db.execute(
      sql`INSERT INTO admin_permission_overrides (tenant_id, admin_id, permission_key, effect, reason)
          VALUES (${SEED_IDS.tenantA}, ${bare.id}, 'support_ai.configure', 'GRANT', 'test')`,
    );
    configOnly = adminActorFor(bare);
    await c.businessConnections.applyReport(scopeA, system(), {
      idempotencyKey: key('conn'),
      botInstanceId: BOT,
      report: {
        connectionId: 'conn-1',
        ownerTelegramUserId: OWNER_TG,
        ownerUserChatId: OWNER_TG,
        isEnabled: true,
        rights: ['can_reply'] as BusinessBotRight[],
        connectedAt: new Date('2026-10-01T00:00:00Z'),
      },
    });
    await db().execute(
      sql`INSERT INTO customers (id, tenant_id, telegram_user_id, status)
          VALUES (${c.ids.uuid()}, ${SEED_IDS.tenantA}, ${CUSTOMER_TG}, 'ACTIVE')`,
    );
    await configure({
      mode: 'AUTO_REPLY_SAFE',
      primary: { provider: 'OPENAI', model: 'gpt-5.5' },
      autoTopics: ['CONNECTION_TROUBLESHOOTING', 'GREETING'],
    });
    next = {
      outcome: 'OK',
      output: reply,
      usage: { inputTokens: 11, outputTokens: 7 },
      model: 'gpt-5.5',
    };
    chainCalls = 0;
    linked = true;
    contextJson = '{"knowledge":[{"alias":"K1"}]}';
    const build = async () => ({
      json: contextJson,
      aliases: new Map<string, string>(),
      knowledgeAliases: new Map([['K1', 'خطای اتصال']]),
      linked,
      flags: {
        identityLinked: linked,
        customerBlocked: false,
        hasUnderReviewPayment: false,
        hasUnreconciledService: false,
      },
      knowledge: { sent: 1, available: 4 },
    });
    console_ = new SupportTestConsoleService({
      configs: new DrizzleSupportAiConfigRepository(c.database.db),
      chain: {
        generate: async () => {
          chainCalls += 1;
          return {
            outcome: next,
            step: { provider: 'OPENAI', model: 'gpt-5.5' },
            attempts: 1,
            exhausted: null,
            imagesSent: 0,
            sight: { seen: [], unseen: new Map() },
          };
        },
      },
      context: { build } as SupportContextSource,
      guard: c.guard,
      uow: c.uow,
      audit: c.audit,
      opsLog: c.opsLogWriter,
      idempotency: c.idempotency,
      scopeActivity: c.tenants,
      clock: c.clock,
    });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const ask = (question: string, over: Record<string, unknown> = {}, actor = owner) =>
    console_.run(tenantA, actor, {
      idempotencyKey: key('console'),
      question,
      customerId: null,
      ...over,
    });

  describe('test console', () => {
    it('shows what would be sent and leaves every customer-facing table exactly as it was', async () => {
      const conversation = await inbound();
      const before = await snapshot();
      const answer = await ask('اینترنتم وصل نمیشه');
      expect(answer).toMatchObject({
        verdict: 'WOULD_SEND',
        mode: 'AUTO_REPLY_SAFE',
        decision: 'REPLY',
        topic: 'CONNECTION_TROUBLESHOOTING',
        confidence: 'HIGH',
        answer: reply.replyText,
        knowledgeUsed: ['خطای اتصال'],
        guard: null,
        outputPolicyRefused: false,
        inputTokens: 11,
        outputTokens: 7,
        provider: 'OPENAI',
      });
      expect(chainCalls).toBe(1);
      const after = await snapshot();
      // No outbound row, no job, no handoff, no ticket, no event, no conversation change.
      expect(after).toEqual({ ...before, outbox: after.outbox });
      expect(after.outbox).toBe(before.outbox);
      expect(after.conversations).toEqual(before.conversations);
      expect(
        (
          await db().execute(
            sql`SELECT state FROM business_conversations WHERE id = ${conversation.conversationId}`,
          )
        ).rows[0],
      ).toEqual({ state: 'AI_ACTIVE' });
      // The audit says who ran it and what came of it - never the question.
      const audit = await db().execute(
        sql`SELECT action, after FROM audit_logs WHERE action = 'support_ai.test_console.run'`,
      );
      expect(audit.rows).toHaveLength(1);
      expect(JSON.stringify(audit.rows[0])).not.toContain('اینترنتم');
      expect(audit.rows[0]).toMatchObject({
        after: { verdict: 'WOULD_SEND', topic: 'CONNECTION_TROUBLESHOOTING', customerLinked: true },
      });
    });

    it('names the guard that would block it, with the handoff reason and kind', async () => {
      next = { ...next, output: { ...reply, topic: 'PLAN_INFO' } } as SupportAiOutcome;
      const answer = await ask('قیمت سه ماهه چنده؟');
      expect(answer.verdict).toBe('WOULD_HAND_OFF');
      expect(answer.guard).toEqual({
        outcome: 'guard_topic_allowlist',
        reason: 'TOPIC_NOT_ALLOWED',
        kind: 'SOFT',
      });
      // The reply the model wrote is still shown, so the owner sees what was held back.
      expect(answer.answer).toBe(reply.replyText);
    });

    it('a hard topic is a HARD handoff', async () => {
      next = { ...next, output: { ...reply, topic: 'REFUND' } } as SupportAiOutcome;
      const answer = await ask('پولم رو پس بدید');
      // Money in the question stops it before the model is asked.
      expect(answer.verdict).toBe('NOT_ASKED');
      expect(answer.guard).toMatchObject({ kind: 'HARD' });
      expect(chainCalls).toBe(0);
    });

    it('a hard topic the model names is a HARD handoff, with the guard and reason', async () => {
      next = { ...next, output: { ...reply, topic: 'WALLET' } } as SupportAiOutcome;
      const answer = await ask('موجودی من چنده؟');
      expect(answer.verdict).toBe('WOULD_HAND_OFF');
      expect(answer.guard).toEqual({
        outcome: 'guard_handoff_topic',
        reason: 'HANDOFF_TOPIC',
        kind: 'HARD',
      });
    });

    it('an unlinked customer asking about an account would get the start link', async () => {
      linked = false;
      next = { ...next, output: { ...reply, topic: 'SERVICE_INFO' } } as SupportAiOutcome;
      await configure({ autoTopics: ['CONNECTION_TROUBLESHOOTING', 'SERVICE_INFO'] });
      const answer = await ask('سرویسم چقدر مونده؟');
      expect(answer.verdict).toBe('WOULD_SEND_LINK');
      expect(answer.customerLinked).toBe(false);
    });

    it('a reply the output validator refuses would be handed off', async () => {
      next = {
        ...next,
        output: { ...reply, replyText: 'برید به https://evil.example/pay' },
      } as SupportAiOutcome;
      const answer = await ask('سلام');
      expect(answer).toMatchObject({
        verdict: 'WOULD_HAND_OFF',
        outputPolicyRefused: true,
        guard: { outcome: 'guard_output_policy', reason: 'OUTPUT_POLICY' },
      });
    });

    it('a provider failure is reported, not thrown', async () => {
      next = { outcome: 'TEMPORARY', code: 'x' } as SupportAiOutcome;
      const answer = await ask('سلام');
      expect(answer.verdict).toBe('NO_ANSWER');
      expect(answer.answer).toBeNull();
    });

    it('is refused while the AI is off, and calls no provider', async () => {
      await configure({ mode: 'OFF' });
      const error = await ask('سلام').catch((e: unknown) => e);
      expect(codeOf(error)).toBe('support_ai.test_console_off');
      expect(chainCalls).toBe(0);
    });

    it('needs support_ai.configure, and a denial is audited; a customer needs users.view too', async () => {
      const error = await ask('سلام', {}, supportStaff).catch((e: unknown) => e);
      expect(isNexaError(error) && error.kind).toBe('PERMISSION_DENIED');
      expect(chainCalls).toBe(0);
      const denial = await db().execute(
        sql`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'support_ai.test_console.run' AND result <> 'SUCCESS'`,
      );
      expect((denial.rows[0] as { n: number }).n).toBeGreaterThan(0);
    });

    it('a run on a real customer also needs users.view; without a customer it does not', async () => {
      const denied = await ask('سلام', { customerId: ctx.container.ids.uuid() }, configOnly).catch(
        (e: unknown) => e,
      );
      expect(isNexaError(denied) && denied.kind).toBe('PERMISSION_DENIED');
      expect((await ask('سلام', {}, configOnly)).verdict).toBe('WOULD_SEND');
    });

    it('a double click with the same key runs once', async () => {
      const k = key('dbl');
      const first = await ask('سلام', { idempotencyKey: k });
      expect(first.verdict).toBe('WOULD_SEND');
      const second = await ask('سلام', { idempotencyKey: k }).catch((e: unknown) => e);
      expect(codeOf(second)).toBe('support_ai.test_console_replay');
      expect(chainCalls).toBe(1);
    });

    it('an unknown customer is refused rather than tested as someone else', async () => {
      linked = false;
      const error = await ask('سلام', { customerId: ctx.container.ids.uuid() }).catch(
        (e: unknown) => e,
      );
      expect(codeOf(error)).toBe('users.not_found');
    });
  });

  describe('readiness card', () => {
    it('reads the facts, charged support_ai.configure', async () => {
      const response = await ctx.container.supportInsights.readiness(tenantA, owner);
      const by = Object.fromEntries(response.checks.map((line) => [line.check, line]));
      expect(by['BUSINESS_CONNECTION']).toMatchObject({ status: 'OK', detail: 'CONNECTED' });
      expect(by['PROVIDER_KEY']).toMatchObject({ status: 'WARN', detail: 'NO_KEY' });
      expect(by['TOPICS']).toMatchObject({ status: 'OK', count: 2 });
      expect(by['KNOWLEDGE']).toMatchObject({ status: 'WARN', detail: 'NO_KNOWLEDGE' });
      expect(by['ASSISTANT_ROLE']).toMatchObject({ status: 'WARN', detail: 'NEVER_STARTED' });
      const denied = await ctx.container.supportInsights
        .readiness(tenantA, supportStaff)
        .catch((e: unknown) => e);
      expect(isNexaError(denied) && denied.kind).toBe('PERMISSION_DENIED');
    });

    it('sees the assistant role from its process_runs row and the approved knowledge count', async () => {
      await db().execute(
        sql`INSERT INTO process_runs (role, run_id, started_at, stable_at, restarts)
            VALUES ('assistant', ${ctx.container.ids.uuid()}, now() - interval '1 hour',
                    now() - interval '59 minutes', 0)`,
      );
      const response = await ctx.container.supportInsights.readiness(tenantA, owner);
      expect(response.checks.find((line) => line.check === 'ASSISTANT_ROLE')).toMatchObject({
        status: 'OK',
        detail: 'RUNNING',
      });
    });

    it('verifies the support handle against the connected account when the bot knows its username', async () => {
      await db().execute(
        sql`INSERT INTO customers (id, tenant_id, telegram_user_id, username, status)
            VALUES (${ctx.container.ids.uuid()}, ${SEED_IDS.tenantA}, ${OWNER_TG}, 'MyShop', 'ACTIVE')`,
      );
      const response = await ctx.container.supportInsights.readiness(tenantA, owner);
      // `support.accounts` is empty on a fresh tenant: the fix is to set it.
      expect(response.checks.find((line) => line.check === 'SUPPORT_HANDLE')?.detail).toBe(
        'HANDLE_MISSING',
      );
    });
  });

  describe('the text behind a handoff', () => {
    async function handoff(
      reason: string,
      topic: string | null,
      intent: string | null,
      text: string,
    ) {
      const recorded = await inbound(CUSTOMER_TG, text);
      await db().execute(
        sql`INSERT INTO business_conversation_escalations
              (id, tenant_id, conversation_id, control_epoch, reason, topic, intent, ticket_outcome, handoff_kind, created_at)
            VALUES (${ctx.container.ids.uuid()}, ${SEED_IDS.tenantA}, ${recorded.conversationId},
                    ${Math.floor(Math.random() * 1_000_000)}, ${reason}, ${topic}, ${intent},
                    'NO_CATEGORY', 'SOFT', now())`,
      );
      return recorded.conversationId;
    }

    it('lists the customer questions behind one reason, and nothing of other reasons', async () => {
      await handoff('LOW_CONFIDENCE', 'PLAN_INFO', 'قیمت', 'قیمت چنده؟');
      await handoff('LOOP_GUARD', null, null, 'سلام سلام سلام');
      const result = await ctx.container.supportInsights.handoffQuestions(tenantA, owner, {
        reason: 'LOW_CONFIDENCE',
      });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        question: 'قیمت چنده؟',
        topic: 'PLAN_INFO',
        kind: 'SOFT',
      });
    });

    it("needs both support_ai.configure and business_chats.view (the customers' words)", async () => {
      for (const actor of [supportStaff, observer, configOnly]) {
        const error = await ctx.container.supportInsights
          .handoffQuestions(tenantA, actor, { reason: 'LOW_CONFIDENCE' })
          .catch((e: unknown) => e);
        expect(isNexaError(error) && error.kind).toBe('PERMISSION_DENIED');
      }
      const gaps = await ctx.container.supportInsights
        .knowledgeGaps(tenantA, supportStaff)
        .catch((e: unknown) => e);
      expect(isNexaError(gaps) && gaps.kind).toBe('PERMISSION_DENIED');
    });

    it('clusters knowledge gaps and leaves out a hard-topic request for a person', async () => {
      await handoff('INSUFFICIENT_GROUNDING', 'PLAN_INFO', 'قیمت سه ماهه', 'سه ماهه چنده؟');
      await handoff('INSUFFICIENT_GROUNDING', 'PLAN_INFO', 'قیمت سه ماهه', 'قیمت سه ماه؟');
      await handoff('AI_REQUESTED', 'REFUND', 'بازپرداخت', 'پولم رو می‌خوام');
      await handoff('AI_REQUESTED', 'PURCHASE_INFO', 'خرید', 'چطور بخرم؟');
      const { gaps } = await ctx.container.supportInsights.knowledgeGaps(tenantA, owner);
      expect(gaps.map((gap) => [gap.topic, gap.count])).toEqual([
        ['PLAN_INFO', 2],
        ['PURCHASE_INFO', 1],
      ]);
      expect(gaps[0]!.examples).toHaveLength(2);
    });
  });

  describe('ASSIST_ONLY drafts every inbound message', () => {
    const drafts = async () =>
      (
        await db().execute(
          sql`SELECT state, requested_by_admin_id, due_at, kind FROM support_ai_jobs
              WHERE kind = 'ASSIST_DRAFT' ORDER BY created_at, id`,
        )
      ).rows as { state: string; requested_by_admin_id: string | null; due_at: unknown }[];

    it('queues one draft per message, replacing the open one, and sends nothing', async () => {
      await configure({ mode: 'ASSIST_ONLY' });
      await inbound();
      let rows = await drafts();
      expect(rows).toEqual([
        { state: 'QUEUED', requested_by_admin_id: null, due_at: null, kind: 'ASSIST_DRAFT' },
      ]);
      await inbound();
      rows = await drafts();
      expect(rows.map((row) => row.state)).toEqual(['DISCARDED', 'QUEUED']);
      expect(await count('business_outbound_messages')).toBe(0);
    });

    it('is idempotent on a redelivered message', async () => {
      await configure({ mode: 'ASSIST_ONLY' });
      messageSeq += 1;
      const input = {
        idempotencyKey: key('same'),
        botInstanceId: BOT,
        edited: false,
        message: {
          connectionId: 'conn-1',
          chatId: CUSTOMER_TG,
          chatType: 'private' as const,
          messageId: messageSeq,
          fromUserId: CUSTOMER_TG,
          senderBusinessBotId: null,
          isFromOffline: false,
          sentAt: new Date(),
          editedAt: null,
          kind: 'TEXT' as const,
          text: 'سلام',
          photo: null,
        },
      };
      await ctx.container.businessConversations.recordMessage(scopeA, system(), input);
      // The same Telegram message under another update key (Telegram redelivers with new ids).
      await ctx.container.businessConversations.recordMessage(scopeA, system(), {
        ...input,
        idempotencyKey: key('again'),
      });
      expect(await drafts()).toEqual([expect.objectContaining({ state: 'QUEUED' })]);
    });

    it('the enqueuer itself is idempotent on the message and its version', async () => {
      await configure({ mode: 'ASSIST_ONLY' });
      const recorded = await inbound();
      const enqueuer = new SupportAutoEnqueuer({
        configs: new DrizzleSupportAiConfigRepository(db()),
        jobs: new DrizzleSupportAiJobRepository(db()),
        ids: ctx.container.ids,
      });
      const conversation = (await new DrizzleBusinessConversationRepository(db()).findById(
        scopeA,
        recorded.conversationId,
      ))!;
      const again = () =>
        ctx.container.uow.run(scopeA, (tx) =>
          enqueuer.onInbound(
            scopeA,
            {
              conversation,
              telegramMessageId: 999,
              contentVersion: 1,
              edited: false,
              now: new Date(),
            },
            tx,
          ),
        );
      await again();
      await again();
      // One draft for message 999 on top of the one the first message made, which it replaced.
      expect((await drafts()).map((row) => row.state)).toEqual(['DISCARDED', 'QUEUED']);
    });

    it('prepares nothing when the AI is off or automatic', async () => {
      await inbound();
      expect(await drafts()).toHaveLength(0);
      await configure({ mode: 'OFF' });
      await inbound();
      expect(await drafts()).toHaveLength(0);
    });

    it('drafts even while a person holds the conversation', async () => {
      await configure({ mode: 'ASSIST_ONLY' });
      const recorded = await inbound();
      await ctx.container.businessConversations.takeOver(scopeA, supportStaff, {
        conversationId: recorded.conversationId,
        idempotencyKey: key('take'),
      });
      await inbound();
      expect((await drafts()).map((row) => row.state)).toEqual(['DISCARDED', 'QUEUED']);
    });
  });

  describe('«بازگرداندن همه به هوش مصنوعی»', () => {
    async function soft(chatId: string) {
      const recorded = await inbound(chatId);
      await ctx.container.uow.run(scopeA, (tx) =>
        ctx.container.businessConversations.handOff(
          scopeA,
          recorded.conversationId,
          'LOW_CONFIDENCE',
          new Date(),
          tx,
        ),
      );
      return recorded.conversationId;
    }
    async function hard(chatId: string) {
      const recorded = await inbound(chatId);
      await ctx.container.businessConversations.takeOver(scopeA, supportStaff, {
        conversationId: recorded.conversationId,
        idempotencyKey: key('take'),
      });
      return recorded.conversationId;
    }
    const stateOf = async (id: string) =>
      (
        (await db().execute(sql`SELECT state FROM business_conversations WHERE id = ${id}`))
          .rows[0] as { state: string }
      ).state;

    it('returns soft holds only unless the operator includes the hard ones, via the one resume path', async () => {
      const a = await soft('7100001');
      const b = await hard('7100002');
      const first = await ctx.container.businessConversations.resumeAll(scopeA, supportStaff, {
        idempotencyKey: key('bulk'),
        includeHard: false,
      });
      expect(first).toEqual({ resumed: 1, skippedHard: 1, failed: 0, more: false });
      expect(await stateOf(a)).toBe('AI_ACTIVE');
      expect(await stateOf(b)).toBe('HUMAN_ACTIVE');
      // Each conversation went through `resume`: its own audit entry.
      const audited = await db().execute(
        sql`SELECT entity_id FROM audit_logs WHERE action = 'business_chat.resume'`,
      );
      expect(audited.rows).toEqual([{ entity_id: a }]);

      const second = await ctx.container.businessConversations.resumeAll(scopeA, supportStaff, {
        idempotencyKey: key('bulk'),
        includeHard: true,
      });
      expect(second).toMatchObject({ resumed: 1, skippedHard: 0, failed: 0 });
      expect(await stateOf(b)).toBe('AI_ACTIVE');
    });

    it('a replay of the same bulk key changes nothing more', async () => {
      const a = await soft('7100003');
      const k = key('bulk');
      await ctx.container.businessConversations.resumeAll(scopeA, supportStaff, {
        idempotencyKey: k,
        includeHard: false,
      });
      await ctx.container.businessConversations.resumeAll(scopeA, supportStaff, {
        idempotencyKey: k,
        includeHard: false,
      });
      const audited = await db().execute(
        sql`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'business_chat.resume' AND entity_id = ${a}`,
      );
      expect((audited.rows[0] as { n: number }).n).toBe(1);
    });

    it('needs business_chats.reply, like the per-conversation return', async () => {
      await soft('7100004');
      const error = await ctx.container.businessConversations
        .resumeAll(scopeA, observer, { idempotencyKey: key('bulk'), includeHard: true })
        .catch((e: unknown) => e);
      expect(isNexaError(error) && error.kind).toBe('PERMISSION_DENIED');
    });
  });

  describe('inbox projection', () => {
    it('carries the stored AI mode', async () => {
      expect(await ctx.container.supportInsights.aiMode(tenantA)).toBe('AUTO_REPLY_SAFE');
      await configure({ mode: 'ASSIST_ONLY' });
      expect(await ctx.container.supportInsights.aiMode(tenantA)).toBe('ASSIST_ONLY');
      expect(SUPPORT_AI_DEFAULT_CONFIG.mode).toBe('OFF');
    });
  });
});
