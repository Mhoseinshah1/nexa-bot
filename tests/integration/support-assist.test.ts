import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  SUPPORT_AI_DEFAULT_CONFIG,
  isNexaError,
  systemJobActor,
  type ActorContext,
  type BusinessBotRight,
  type CorrelationId,
  type SupportAiOutcome,
} from '@nexa/contracts';
import { SupportAssistService } from '../../apps/api/src/modules/control/support-ai/application/support-assist.service';
import { AssistantLoop } from '../../apps/api/src/modules/control/support-ai/application/assistant-loop';
import { DrizzleSupportAiJobRepository } from '../../apps/api/src/modules/control/support-ai/infrastructure/drizzle-support-ai-job.repository';
import { DrizzleSupportAiConfigRepository } from '../../apps/api/src/modules/control/support-ai/infrastructure/drizzle-support-ai.repository';
import {
  DrizzleBusinessConversationRepository,
  DrizzleBusinessMessageRepository,
} from '../../apps/api/src/modules/commerce/business-chats/infrastructure/drizzle-business-conversation.repository';
import {
  SEED_IDS,
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  type TestContext,
} from './harness';

/**
 * TB5 — Assist Mode against a real database (program §16, §35).
 *
 * The AI drafts; a person sends. Pinned here: a draft is never sent by itself; an invalid
 * decision is FAILED, not shown as advice; a citation the facts did not contain is dropped;
 * sending a draft goes through the ordinary lane as a human signal; a newer request discards
 * the older draft; mode OFF refuses; permissions.
 */

const BOT = SEED_IDS.botA1;
const scopeA = { ...tenantA, botInstanceId: BOT } as never;
const valid = {
  decision: 'REPLY',
  replyText: 'لطفاً برنامه را ببندید و دوباره باز کنید.',
  topic: 'CONNECTION_TROUBLESHOOTING',
  confidence: 'HIGH',
  factRefs: ['S1', 'Z9'],
  knowledgeRefs: [],
  ticketAction: 'NONE',
  summary: 'مشتری وصل نمی‌شود.',
  intent: 'اتصال',
};

describe('Assist Mode (TB5)', () => {
  let ctx: TestContext;
  let operator: ActorContext;
  let next: SupportAiOutcome;
  let service: SupportAssistService;
  let loop: AssistantLoop;
  let jobs: DrizzleSupportAiJobRepository;
  let conversationId: string;
  let keySeq = 0;
  const key = (label: string) => `${label}-${Date.now()}-${(keySeq += 1)}`;
  const system = () => systemJobActor('assist-test', 'c' as CorrelationId);

  beforeEach(async () => {
    ctx ??= await createTestContext();
    await ctx.reset();
    const c = ctx.container;
    operator = adminActorFor(
      await createAdmin(c, tenantA, { username: 'support1', roleKeys: ['support'] }),
    );
    const owner = adminActorFor(
      await createAdmin(c, tenantA, { username: 'owner', roleKeys: ['owner'] }),
    );
    await c.supportAiConfig.update(tenantA, owner, {
      idempotencyKey: key('cfg'),
      expectedVersion: null,
      config: {
        ...SUPPORT_AI_DEFAULT_CONFIG,
        mode: 'ASSIST_ONLY',
        primary: { provider: 'OPENAI', model: 'gpt-5.5' },
      },
    });
    await c.businessConnections.applyReport(scopeA, system(), {
      idempotencyKey: key('conn'),
      botInstanceId: BOT,
      report: {
        connectionId: 'conn-1',
        ownerTelegramUserId: '5000001',
        ownerUserChatId: '5000001',
        isEnabled: true,
        rights: ['can_reply'] as BusinessBotRight[],
        connectedAt: new Date('2026-10-01T00:00:00Z'),
      },
    });
    const recorded = await c.businessConversations.recordMessage(scopeA, system(), {
      idempotencyKey: key('msg'),
      botInstanceId: BOT,
      edited: false,
      message: {
        connectionId: 'conn-1',
        chatId: '7000001',
        chatType: 'private',
        messageId: 11,
        fromUserId: '7000001',
        senderBusinessBotId: null,
        isFromOffline: false,
        sentAt: new Date(),
        editedAt: null,
        kind: 'TEXT',
        text: 'سلام، اینترنتم وصل نمی‌شود',
      },
    });
    conversationId = recorded!.conversationId;
    next = {
      outcome: 'OK',
      output: valid,
      usage: { inputTokens: 10, outputTokens: 10 },
      model: 'gpt-5.5',
    };
    jobs = new DrizzleSupportAiJobRepository(c.database.db);
    service = new SupportAssistService({
      jobs,
      configs: new DrizzleSupportAiConfigRepository(c.database.db),
      chain: {
        generate: async () => ({
          outcome: next,
          step: { provider: 'OPENAI', model: 'gpt-5.5' },
          attempts: 1,
          exhausted: null,
        }),
      },
      context: {
        build: async () => ({
          json: '{"services":[{"alias":"S1"}]}',
          aliases: new Map([['S1', 'سرویس user123']]),
          linked: true,
        }),
      },
      conversations: new DrizzleBusinessConversationRepository(c.database.db),
      messages: new DrizzleBusinessMessageRepository(c.database.db),
      sender: c.businessConversations,
      guard: c.guard,
      uow: c.uow,
      audit: c.audit,
      opsLog: c.opsLogWriter,
      sessions: c.sessions,
      scopeActivity: c.tenants,
      clock: c.clock,
      ids: c.ids,
    });
    loop = new AssistantLoop(service, jobs, {
      scope: () => scopeA,
      intervalMs: 1000,
      now: () => c.clock.now(),
      logger: c.logger,
    });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  async function outboundCount() {
    const rows = await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM business_outbound_messages`,
    );
    return (rows.rows[0] as { n: number }).n;
  }

  it('produces a draft and sends nothing by itself', async () => {
    const job = await service.request(scopeA, operator, {
      conversationId,
      idempotencyKey: key('draft'),
    });
    expect(job.state).toBe('QUEUED');
    await loop.tick();
    const ready = await jobs.findById(scopeA, job.id);
    expect(ready).toMatchObject({
      state: 'READY',
      suggestedReply: valid.replyText,
      topic: 'CONNECTION_TROUBLESHOOTING',
    });
    // The citation the facts contained is resolved; the one they did not (Z9) is dropped.
    expect(ready?.factLabels).toEqual(['سرویس user123']);
    expect(await outboundCount()).toBe(0);
  });

  it('records an invalid decision as FAILED, never as advice', async () => {
    next = {
      outcome: 'OK',
      output: { ...valid, decision: 'REFUND_NOW' },
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'm',
    };
    const job = await service.request(scopeA, operator, {
      conversationId,
      idempotencyKey: key('draft'),
    });
    await loop.tick();
    expect(await jobs.findById(scopeA, job.id)).toMatchObject({
      state: 'FAILED',
      failureCode: 'decision.invalid',
      suggestedReply: null,
    });
  });

  it('records a chain failure as FAILED', async () => {
    next = { outcome: 'REFUSED_BY_PROVIDER', code: 'openai.refusal' };
    const job = await service.request(scopeA, operator, {
      conversationId,
      idempotencyKey: key('draft'),
    });
    await loop.tick();
    expect((await jobs.findById(scopeA, job.id))?.state).toBe('FAILED');
  });

  it('sends a draft only by the operator, edited, through the lane — and that takes the conversation', async () => {
    const job = await service.request(scopeA, operator, {
      conversationId,
      idempotencyKey: key('draft'),
    });
    await loop.tick();
    const sendKey = key('send');
    const sent = await service.send(scopeA, operator, job.id, {
      idempotencyKey: sendKey,
      text: 'متن ویرایش‌شده',
    });
    // A retry sends once.
    expect(
      await service.send(scopeA, operator, job.id, {
        idempotencyKey: sendKey,
        text: 'متن ویرایش‌شده',
      }),
    ).toEqual(sent);
    const row = await ctx.container.database.db.execute(
      sql`SELECT origin, body, state FROM business_outbound_messages WHERE id = ${sent.outboundId}`,
    );
    expect(row.rows[0]).toMatchObject({
      origin: 'ASSIST',
      body: 'متن ویرایش‌شده',
      state: 'PENDING',
    });
    const conversation = await new DrizzleBusinessConversationRepository(
      ctx.container.database.db,
    ).findById(scopeA, conversationId);
    expect(conversation?.state).toBe('HUMAN_ACTIVE');
    expect((await jobs.findById(scopeA, job.id))?.state).toBe('SENT');
  });

  it('a newer request discards the older draft, and a discarded draft cannot be sent', async () => {
    const first = await service.request(scopeA, operator, {
      conversationId,
      idempotencyKey: key('a'),
    });
    await loop.tick();
    await service.request(scopeA, operator, { conversationId, idempotencyKey: key('b') });
    expect((await jobs.findById(scopeA, first.id))?.state).toBe('DISCARDED');
    await expect(
      service.send(scopeA, operator, first.id, { idempotencyKey: key('s'), text: 'x' }),
    ).rejects.toSatisfy(isNexaError);
  });

  it('a draft discarded while it was being produced is not resurrected', async () => {
    const job = await service.request(scopeA, operator, {
      conversationId,
      idempotencyKey: key('a'),
    });
    const [claimed] = await jobs.claimDue(scopeA, new Date(), new Date(Date.now() + 60_000), 1);
    await service.discard(scopeA, operator, job.id);
    expect(await service.produce(scopeA, claimed!)).toBe('GONE');
    expect((await jobs.findById(scopeA, job.id))?.state).toBe('DISCARDED');
  });

  it('refuses a draft while the support AI is OFF', async () => {
    await ctx.container.database.db.execute(sql`UPDATE support_ai_configs SET mode = 'OFF'`);
    await expect(
      service.request(scopeA, operator, { conversationId, idempotencyKey: key('a') }),
    ).rejects.toSatisfy(isNexaError);
  });

  it('refuses a draft to a role without support_ai.assist', async () => {
    const finance = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'fin', roleKeys: ['finance'] }),
    );
    await expect(
      service.request(scopeA, finance, { conversationId, idempotencyKey: key('a') }),
    ).rejects.toSatisfy(isNexaError);
  });
});
