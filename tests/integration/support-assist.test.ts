import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  PLATFORM_ERROR_CODES,
  SUPPORT_AI_DEFAULT_CONFIG,
  SUPPORT_AI_DRAFT_UNCLAIMED_SECONDS,
  isNexaError,
  systemJobActor,
  type ActorContext,
  type BusinessBotRight,
  type CorrelationId,
  type SupportAiOutcome,
} from '@nexa/contracts';
import {
  SUPPORT_ASSIST_ERROR_CODES,
  SupportAssistService,
  type SupportAssistServiceDeps,
} from '../../apps/api/src/modules/control/support-ai/application/support-assist.service';
import {
  ASSISTANT_JOB_WORST_CASE_MS,
  ASSISTANT_LEASE_MS,
  ASSISTANT_MAX_ATTEMPTS,
  AssistantLoop,
} from '../../apps/api/src/modules/control/support-ai/application/assistant-loop';
import { BUSINESS_CHAT_ERROR_CODES } from '../../apps/api/src/modules/commerce/business-chats/application/business-conversation.service';
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
  /** Every provider call the chain was asked for, by conversation. */
  let chainCalls: string[];
  /** Runs inside the fake provider call, before it answers. */
  let duringCall: ((conversationId: string) => Promise<void>) | null;
  let build: (overrides?: Partial<SupportAssistServiceDeps>) => SupportAssistService;
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
    conversationId = await newConversation('7000001');
    chainCalls = [];
    duringCall = null;
    next = {
      outcome: 'OK',
      output: valid,
      usage: { inputTokens: 10, outputTokens: 10 },
      model: 'gpt-5.5',
    };
    jobs = new DrizzleSupportAiJobRepository(c.database.db);
    build = (overrides = {}) =>
      new SupportAssistService({
        jobs,
        configs: new DrizzleSupportAiConfigRepository(c.database.db),
        chain: {
          generate: async (_scope, input) => {
            chainCalls.push(input.conversationId ?? '');
            if (duringCall !== null) await duringCall(input.conversationId ?? '');
            return {
              outcome: next,
              step: { provider: 'OPENAI', model: 'gpt-5.5' },
              attempts: 1,
              exhausted: null,
              imagesSent: 0,
            };
          },
          visionStepConfigured: () => false,
        },
        images: {
          load: async () => {
            throw new Error('TB5 tests carry no image');
          },
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
        ...overrides,
      });
    service = build();
    loop = new AssistantLoop(service, {
      scope: () => scopeA,
      intervalMs: 1000,
      now: () => c.clock.now(),
      logger: c.logger,
    });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  async function newConversation(chatId: string): Promise<string> {
    const recorded = await ctx.container.businessConversations.recordMessage(scopeA, system(), {
      idempotencyKey: key('msg'),
      botInstanceId: BOT,
      edited: false,
      message: {
        connectionId: 'conn-1',
        chatId,
        chatType: 'private',
        messageId: 11,
        fromUserId: chatId,
        senderBusinessBotId: null,
        isFromOffline: false,
        sentAt: new Date(),
        editedAt: null,
        kind: 'TEXT',
        text: 'سلام، اینترنتم وصل نمی‌شود',
        photo: null,
      },
    });
    return recorded!.conversationId;
  }

  async function stopTenant() {
    await ctx.container.database.db.execute(
      sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${SEED_IDS.tenantA}`,
    );
  }

  /** A clock the test moves by hand. */
  function manualClock(start = Date.now()) {
    const clock = { ms: start, now: () => new Date(clock.ms) };
    return clock;
  }

  function codeOf(error: unknown): string | null {
    return isNexaError(error) ? error.code : null;
  }

  async function readyDraft(svc = service, lp = loop) {
    const job = await svc.request(scopeA, operator, { conversationId, idempotencyKey: key('d') });
    await lp.tick();
    expect((await jobs.findById(scopeA, job.id))?.state).toBe('READY');
    return job;
  }

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

  // Shapes no database CHECK would refuse: only the decision schema and the reply bound do.
  it('records an over-long reply, or a decision with an extra key, as FAILED', async () => {
    for (const output of [
      { ...valid, replyText: 'ب'.repeat(SUPPORT_AI_DEFAULT_CONFIG.maxOutputChars + 1) },
      { ...valid, refund: true },
    ]) {
      next = { outcome: 'OK', output, usage: { inputTokens: 1, outputTokens: 1 }, model: 'm' };
      const job = await service.request(scopeA, operator, {
        conversationId,
        idempotencyKey: key('draft'),
      });
      await loop.tick();
      expect(await jobs.findById(scopeA, job.id)).toMatchObject({
        state: 'FAILED',
        failureCode: 'decision.invalid',
      });
    }
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
    ).rejects.toMatchObject({ code: SUPPORT_ASSIST_ERROR_CODES.NOT_READY });
    expect(await outboundCount()).toBe(0);
  });

  it('a draft discarded while it was being produced is not resurrected', async () => {
    const job = await service.request(scopeA, operator, {
      conversationId,
      idempotencyKey: key('a'),
    });
    const claimed = await service.claimNext(scopeA, new Date(), new Date(Date.now() + 60_000));
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

  // ---------------------------------------------------------------------------------------
  // Substitute review of PR #200
  // ---------------------------------------------------------------------------------------

  describe('B1: a stopped scope', () => {
    it("never leases a stopped tenant's queued draft, and never sends its transcript to a provider", async () => {
      const job = await service.request(scopeA, operator, {
        conversationId,
        idempotencyKey: key('d'),
      });
      await stopTenant();
      await loop.tick();
      expect(chainCalls).toEqual([]);
      // Not leased either: the claim is a write, and it checks activity in its transaction.
      expect(await jobs.findById(scopeA, job.id)).toMatchObject({ state: 'QUEUED', attempts: 0 });
    });

    it('a stop between the claim and the call: produce calls no provider and writes nothing', async () => {
      const job = await service.request(scopeA, operator, {
        conversationId,
        idempotencyKey: key('d'),
      });
      const claimed = await service.claimNext(scopeA, new Date(), new Date(Date.now() + 60_000));
      expect(claimed?.id).toBe(job.id);
      await stopTenant();
      expect(await service.produce(scopeA, claimed!)).toBe('INACTIVE');
      expect(chainCalls).toEqual([]);
      expect((await jobs.findById(scopeA, job.id))?.state).toBe('QUEUED');
    });

    it('a stop during the provider call: the result is not recorded', async () => {
      const job = await service.request(scopeA, operator, {
        conversationId,
        idempotencyKey: key('d'),
      });
      duringCall = stopTenant;
      await loop.tick();
      expect(chainCalls).toHaveLength(1);
      expect(await jobs.findById(scopeA, job.id)).toMatchObject({
        state: 'QUEUED',
        suggestedReply: null,
      });
    });
  });

  describe('B2: a draft is sent at most once', () => {
    it('two concurrent sends under different keys: one outbound row, and the other is NOT_READY', async () => {
      const job = await readyDraft();
      // Both sends pass the unlocked read before either reaches the lane.
      let arrived = 0;
      let release!: () => void;
      const bothArrived = new Promise<void>((resolve) => (release = resolve));
      const racing = build({
        sender: {
          enqueueHumanSend: async (...args) => {
            arrived += 1;
            if (arrived === 2) release();
            await bothArrived;
            return ctx.container.businessConversations.enqueueHumanSend(...args);
          },
        },
      });
      const results = await Promise.allSettled([
        racing.send(scopeA, operator, job.id, { idempotencyKey: key('s1'), text: 'یک' }),
        racing.send(scopeA, operator, job.id, { idempotencyKey: key('s2'), text: 'دو' }),
      ]);
      const sent = results.filter((r) => r.status === 'fulfilled');
      const refused = results.filter((r) => r.status === 'rejected');
      expect(sent).toHaveLength(1);
      expect(refused.map((r) => codeOf(r.reason))).toEqual([SUPPORT_ASSIST_ERROR_CODES.NOT_READY]);
      expect(await outboundCount()).toBe(1);
      expect(await jobs.findById(scopeA, job.id)).toMatchObject({
        state: 'SENT',
        sentOutboundId: (sent[0] as PromiseFulfilledResult<{ outboundId: string }>).value
          .outboundId,
      });
    });

    it('a send racing a discard: discard first means no outbound row and no human signal', async () => {
      const job = await readyDraft();
      const racing = build({
        sender: {
          enqueueHumanSend: async (...args) => {
            // The discard commits after the send's unlocked read and before the lane runs.
            await service.discard(scopeA, operator, job.id);
            return ctx.container.businessConversations.enqueueHumanSend(...args);
          },
        },
      });
      await expect(
        racing.send(scopeA, operator, job.id, { idempotencyKey: key('s'), text: 'x' }),
      ).rejects.toMatchObject({ code: SUPPORT_ASSIST_ERROR_CODES.NOT_READY });
      expect(await outboundCount()).toBe(0);
      expect((await jobs.findById(scopeA, job.id))?.state).toBe('DISCARDED');
      // The rollback took the human signal with it.
      const conversation = await new DrizzleBusinessConversationRepository(
        ctx.container.database.db,
      ).findById(scopeA, conversationId);
      expect(conversation?.state).not.toBe('HUMAN_ACTIVE');
    });

    it("a replay of the operator's key goes through the lane's replay: same id, and a changed text is refused", async () => {
      const job = await readyDraft();
      const sendKey = key('s');
      const sent = await service.send(scopeA, operator, job.id, {
        idempotencyKey: sendKey,
        text: 'متن',
      });
      expect(
        await service.send(scopeA, operator, job.id, { idempotencyKey: sendKey, text: 'متن' }),
      ).toEqual(sent);
      // Only the lane's replay checks the payload; an early return on SENT would not.
      await expect(
        service.send(scopeA, operator, job.id, { idempotencyKey: sendKey, text: 'دیگر' }),
      ).rejects.toMatchObject({ code: BUSINESS_CHAT_ERROR_CODES.IDEMPOTENCY_MISMATCH });
      // A new key on a SENT draft is refused, and its rollback leaves no row.
      await expect(
        service.send(scopeA, operator, job.id, { idempotencyKey: key('s2'), text: 'متن' }),
      ).rejects.toMatchObject({ code: SUPPORT_ASSIST_ERROR_CODES.NOT_READY });
      expect(await outboundCount()).toBe(1);
    });

    it("the same key used on a different draft is refused, never answered with the first draft's row", async () => {
      const first = await readyDraft();
      const sendKey = key('s');
      await service.send(scopeA, operator, first.id, { idempotencyKey: sendKey, text: 'متن' });
      const second = await readyDraft();
      await expect(
        service.send(scopeA, operator, second.id, { idempotencyKey: sendKey, text: 'متن' }),
      ).rejects.toMatchObject({ code: PLATFORM_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH });
      expect((await jobs.findById(scopeA, second.id))?.state).toBe('READY');
      expect(await outboundCount()).toBe(1);
    });
  });

  describe('S4: the lease covers the worst case, one job at a time', () => {
    it('two assistant replicas sharing a clock and a slow provider: each job reaches the provider once', async () => {
      const clock = manualClock();
      const slow = build({ clock });
      const options = {
        scope: () => scopeA,
        intervalMs: 2_000,
        now: clock.now,
        logger: ctx.container.logger,
      };
      const replicaA = new AssistantLoop(slow, options);
      const replicaB = new AssistantLoop(slow, options);
      const second = await newConversation('7000002');
      const jobA = await slow.request(scopeA, operator, {
        conversationId,
        idempotencyKey: key('a'),
      });
      const jobB = await slow.request(scopeA, operator, {
        conversationId: second,
        idempotencyKey: key('b'),
      });
      // Every call takes the worst case the chain allows. During A's SECOND call, B runs a pass.
      duringCall = async () => {
        clock.ms += ASSISTANT_JOB_WORST_CASE_MS;
        if (chainCalls.length === 2) await replicaB.tick();
      };
      await replicaA.tick();
      expect([...chainCalls].sort()).toEqual([conversationId, second].sort());
      expect((await jobs.findById(scopeA, jobA.id))?.state).toBe('READY');
      expect((await jobs.findById(scopeA, jobB.id))?.state).toBe('READY');
    });

    it('the lease predicate: a job is claimable only once its lease has run out', async () => {
      await service.request(scopeA, operator, { conversationId, idempotencyKey: key('d') });
      const t0 = Date.now();
      const lease = new Date(t0 + ASSISTANT_LEASE_MS);
      expect(await service.claimNext(scopeA, new Date(t0), lease)).not.toBeNull();
      expect(
        await service.claimNext(
          scopeA,
          new Date(t0 + ASSISTANT_LEASE_MS - 1),
          new Date(t0 + 2 * ASSISTANT_LEASE_MS),
        ),
      ).toBeNull();
      const again = await service.claimNext(
        scopeA,
        new Date(t0 + ASSISTANT_LEASE_MS),
        new Date(t0 + 2 * ASSISTANT_LEASE_MS),
      );
      expect(again?.attempts).toBe(2);
    });
  });

  describe('S5: a request key is bound to its conversation', () => {
    it('the same key with another conversation is refused; with the same one it replays', async () => {
      const other = await newConversation('7000003');
      const requestKey = key('r');
      const job = await service.request(scopeA, operator, {
        conversationId,
        idempotencyKey: requestKey,
      });
      expect(
        await service.request(scopeA, operator, { conversationId, idempotencyKey: requestKey }),
      ).toMatchObject({ id: job.id });
      await expect(
        service.request(scopeA, operator, { conversationId: other, idempotencyKey: requestKey }),
      ).rejects.toMatchObject({ code: PLATFORM_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH });
      expect(await service.drafts(scopeA, operator, other)).toEqual([]);
    });
  });

  describe('S6: a draft nothing claims does not wait for ever', () => {
    const bound = SUPPORT_AI_DRAFT_UNCLAIMED_SECONDS * 1_000;

    it('the listing fails a QUEUED draft unclaimed for the bound, and not a moment before', async () => {
      const clock = manualClock();
      const svc = build({ clock });
      const job = await svc.request(scopeA, operator, { conversationId, idempotencyKey: key('d') });
      clock.ms += bound - 1_000;
      expect((await svc.drafts(scopeA, operator, conversationId))[0]?.state).toBe('QUEUED');
      clock.ms += 1_000;
      expect((await svc.drafts(scopeA, operator, conversationId))[0]).toMatchObject({
        id: job.id,
        state: 'FAILED',
        failureCode: 'job.unclaimed',
      });
    });

    it('a draft being produced (a live lease) is never failed as unclaimed', async () => {
      const clock = manualClock();
      const svc = build({ clock });
      const job = await svc.request(scopeA, operator, { conversationId, idempotencyKey: key('d') });
      clock.ms += bound;
      // Claimed at the last moment; its lease runs well past the bound.
      await svc.claimNext(scopeA, clock.now(), new Date(clock.ms + ASSISTANT_LEASE_MS));
      clock.ms += bound;
      expect((await jobs.findById(scopeA, job.id))?.state).toBe('QUEUED');
      expect((await svc.drafts(scopeA, operator, conversationId))[0]?.state).toBe('QUEUED');
      // Abandoned: its lease ran out, and the bound runs from there.
      clock.ms += ASSISTANT_LEASE_MS;
      expect((await svc.drafts(scopeA, operator, conversationId))[0]?.state).toBe('FAILED');
    });

    it('a new request fails the old unclaimed draft as unclaimed, rather than discarding it', async () => {
      const clock = manualClock();
      const svc = build({ clock });
      const old = await svc.request(scopeA, operator, { conversationId, idempotencyKey: key('a') });
      clock.ms += bound;
      await svc.request(scopeA, operator, { conversationId, idempotencyKey: key('b') });
      expect(await jobs.findById(scopeA, old.id)).toMatchObject({
        state: 'FAILED',
        failureCode: 'job.unclaimed',
      });
    });
  });

  describe('S7: rules that had no test', () => {
    it(`a job claimed more than ${ASSISTANT_MAX_ATTEMPTS} times fails without a provider call`, async () => {
      const job = await service.request(scopeA, operator, {
        conversationId,
        idempotencyKey: key('d'),
      });
      // The next claim is attempt MAX + 1.
      await ctx.container.database.db.execute(
        sql`UPDATE support_ai_jobs SET attempts = ${ASSISTANT_MAX_ATTEMPTS} WHERE id = ${job.id}`,
      );
      await loop.tick();
      expect(chainCalls).toEqual([]);
      expect(await jobs.findById(scopeA, job.id)).toMatchObject({
        state: 'FAILED',
        failureCode: 'job.attempts_exhausted',
      });
    });

    it(`attempt ${ASSISTANT_MAX_ATTEMPTS} is still produced`, async () => {
      const job = await service.request(scopeA, operator, {
        conversationId,
        idempotencyKey: key('d'),
      });
      await ctx.container.database.db.execute(
        sql`UPDATE support_ai_jobs SET attempts = ${ASSISTANT_MAX_ATTEMPTS - 1} WHERE id = ${job.id}`,
      );
      await loop.tick();
      expect((await jobs.findById(scopeA, job.id))?.state).toBe('READY');
    });

    it("purges a draft's text after 30 days, and not before", async () => {
      const old = await readyDraft();
      const recent = await readyDraft();
      await ctx.container.database.db.execute(
        sql`UPDATE support_ai_jobs SET created_at = now() - interval '31 days' WHERE id = ${old.id}`,
      );
      await ctx.container.database.db.execute(
        sql`UPDATE support_ai_jobs SET created_at = now() - interval '29 days' WHERE id = ${recent.id}`,
      );
      expect(await service.purgeExpired(scopeA, new Date())).toBe(1);
      expect(await jobs.findById(scopeA, old.id)).toMatchObject({
        suggestedReply: null,
        summary: null,
      });
      expect((await jobs.findById(scopeA, recent.id))?.suggestedReply).toBe(valid.replyText);
    });

    it('sending needs business_chats.reply as well as support_ai.assist', async () => {
      const job = await readyDraft();
      await ctx.container.database.db.execute(sql`
        DELETE FROM role_permissions rp USING roles r
         WHERE r.id = rp.role_id AND r.tenant_id = rp.tenant_id
           AND r.key = 'support' AND rp.permission_key = 'business_chats.reply'`);
      await expect(
        service.send(scopeA, operator, job.id, { idempotencyKey: key('s'), text: 'x' }),
      ).rejects.toMatchObject({ kind: 'PERMISSION_DENIED' });
      expect(await outboundCount()).toBe(0);
      expect((await jobs.findById(scopeA, job.id))?.state).toBe('READY');
    });

    it('discard is idempotent, and never discards a sent draft', async () => {
      const job = await readyDraft();
      expect(await service.discard(scopeA, operator, job.id)).toEqual({ discarded: true });
      expect(await service.discard(scopeA, operator, job.id)).toEqual({ discarded: false });
      expect((await jobs.findById(scopeA, job.id))?.state).toBe('DISCARDED');
      const sent = await readyDraft();
      await service.send(scopeA, operator, sent.id, { idempotencyKey: key('s'), text: 'x' });
      expect(await service.discard(scopeA, operator, sent.id)).toEqual({ discarded: false });
      expect((await jobs.findById(scopeA, sent.id))?.state).toBe('SENT');
    });
  });
});
