import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  API_PREFIX,
  AUTH_ROUTES,
  BUSINESS_CHAT_ROUTES,
  SESSION_COOKIE_NAME,
  SUPPORT_ANALYTICS_ROUTES,
  businessChatListResponseSchema,
  isNexaError,
  supportAnalyticsResponseSchema,
  systemJobActor,
  type ActorContext,
  type BusinessBotRight,
  type CorrelationId,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import { DrizzleBusinessConversationRepository } from '../../apps/api/src/modules/commerce/business-chats/infrastructure/drizzle-business-conversation.repository';
import type { ParsedBusinessMessage } from '../../apps/api/src/modules/commerce/business-chats/domain/telegram-business';
import { DrizzleSupportAnalyticsReader } from '../../apps/api/src/modules/control/support-ai/infrastructure/drizzle-support-analytics.reader';
import { SUPPORT_AI_UNAVAILABLE_DEDUPE_KEY } from '../../apps/api/src/modules/control/support-ai/application/support-ai-chain';
import {
  SEED_IDS,
  adminActorFor,
  createAdmin,
  createTestContext,
  migrateOnce,
  resetDatabase,
  testConfig,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * TB10 against a real PostgreSQL: the support notifications produced by their real
 * producers and read through the real inbox; the inbox's handoffs-first keyset and the
 * customer's wait; the provider health panel; and the analytics counts over a half-open
 * window, tenant by tenant.
 */

const BOT = SEED_IDS.botA1;
const OWNER = '5000001';
const OUR_BOT = '9000001';
const scopeA = { ...tenantA, botInstanceId: BOT } as never;

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isNexaError(error)) return { kind: error.kind, code: error.code };
    throw error;
  }
  throw new Error('Expected a refusal.');
}

describe('TB10 — support polish against the database', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let support: ActorContext;
  let finance: ActorContext;
  let messageSeq = 100;
  let keySeq = 0;
  const key = (label: string) => `${label}-${Date.now()}-${(keySeq += 1)}`;
  const system = () => systemJobActor('tb10-test', 'tb10-correlation' as CorrelationId);

  const message = (
    chatId: string,
    overrides: Partial<ParsedBusinessMessage> = {},
  ): ParsedBusinessMessage => {
    messageSeq += 1;
    return {
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
      text: 'سلام، اینترنتم وصل نمی‌شود',
      photo: null,
      ...overrides,
    };
  };
  const record = (m: ParsedBusinessMessage) =>
    ctx.container.businessConversations.recordMessage(scopeA, system(), {
      idempotencyKey: key('update'),
      botInstanceId: BOT,
      message: m,
      edited: false,
    });
  /** A customer writes; the conversation it lands in. */
  const customerWrites = async (chatId: string, sentAt = new Date()) =>
    (await record(message(chatId, { sentAt })))!.conversationId;
  const handOff = (conversationId: string) =>
    ctx.container.uow.run(scopeA, (tx) =>
      ctx.container.businessConversations.handOff(
        scopeA,
        conversationId,
        'HANDOFF_TOPIC',
        new Date(),
        tx,
      ),
    );
  const inbox = (actor: ActorContext) =>
    ctx.container.notificationCenter.list(tenantA, actor, {
      limit: 50,
      unreadOnly: false,
      before: null,
    });
  const connect = (rights: BusinessBotRight[]) =>
    ctx.container.businessConnections.applyReport(scopeA, system(), {
      idempotencyKey: key('connect'),
      botInstanceId: BOT,
      report: {
        connectionId: 'conn-1',
        ownerTelegramUserId: OWNER,
        ownerUserChatId: OWNER,
        isEnabled: true,
        rights,
        connectedAt: new Date('2026-10-01T00:00:00Z'),
      },
    });

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);
  afterAll(async () => {
    await ctx?.close();
  });
  beforeEach(async () => {
    await ctx.reset();
    const c = ctx.container;
    await c.database.db.execute(
      sql`UPDATE bot_instances SET telegram_bot_id = ${OUR_BOT} WHERE id = ${BOT}`,
    );
    await connect(['can_reply']);
    owner = adminActorFor(await createAdmin(c, tenantA, { username: 'own', roleKeys: ['owner'] }));
    support = adminActorFor(
      await createAdmin(c, tenantA, { username: 'sup', roleKeys: ['support'] }),
    );
    finance = adminActorFor(
      await createAdmin(c, tenantA, { username: 'fin', roleKeys: ['finance'] }),
    );
  });

  // -------------------------------------------------------------------------------------
  // Notification center
  // -------------------------------------------------------------------------------------

  describe('the support notifications', () => {
    it('a handoff reaches support’s inbox, linked to the conversation, and a takeover resolves it', async () => {
      const conversationId = await customerWrites('7000001');
      expect(await handOff(conversationId)).toBe(true);

      const [item] = await inbox(support);
      expect(item).toMatchObject({
        code: 'support.handoff_required',
        category: 'SUPPORT',
        severity: 'WARN',
        resolvedAt: null,
        link: { target: 'BUSINESS_CHAT', id: conversationId },
      });
      // Finance reads payments, not conversations.
      expect(await inbox(finance)).toEqual([]);
      expect((await ctx.container.notificationCenter.summary(tenantA, support)).unread).toBe(1);

      await ctx.container.businessConversations.takeOver(scopeA, support, {
        conversationId,
        idempotencyKey: key('takeover'),
      });
      const [after] = await inbox(support);
      expect(after?.resolvedAt).not.toBeNull();
    });

    it('a second handoff of the same conversation is the same notification, recurring', async () => {
      const conversationId = await customerWrites('7000002');
      await handOff(conversationId);
      await ctx.container.businessConversations.takeOver(scopeA, support, {
        conversationId,
        idempotencyKey: key('takeover'),
      });
      await ctx.container.businessConversations.resume(scopeA, support, {
        conversationId,
        idempotencyKey: key('resume'),
      });
      await handOff(conversationId);
      const open = (await inbox(support)).filter((one) => one.resolvedAt === null);
      expect(open).toHaveLength(1);
      expect(open[0]?.link).toEqual({ target: 'BUSINESS_CHAT', id: conversationId });
    });

    it('a connection that lost the right to reply reaches support, linked to the inbox', async () => {
      await connect(['can_read_messages']);
      const items = await inbox(support);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        code: 'support.business_connection.unusable',
        category: 'SUPPORT',
        link: { target: 'BUSINESS_CHATS', id: null },
      });
      // The recovery closes it and is no notification of its own.
      await connect(['can_reply']);
      const closed = await inbox(support);
      expect(closed).toHaveLength(1);
      expect(closed[0]?.resolvedAt).not.toBeNull();
    });

    it('a rejected key and a silent chain reach support_ai.configure holders only', async () => {
      await ctx.container.opsLog.record(tenantA, {
        code: 'support.ai_provider.credential_rejected',
        severity: 'ERROR',
        message: 'An AI provider rejected its key.',
        dedupeKey: 'support.ai_provider.credential_rejected:OPENAI',
        context: { provider: 'OPENAI' },
      });
      await ctx.container.opsLog.record(tenantA, {
        code: 'support.ai_provider.unavailable',
        severity: 'WARN',
        message: 'No configured AI provider could answer.',
        dedupeKey: SUPPORT_AI_UNAVAILABLE_DEDUPE_KEY,
      });
      const mine = await inbox(owner);
      expect(mine.map((one) => one.code).sort()).toEqual([
        'support.ai_provider.credential_rejected',
        'support.ai_provider.unavailable',
      ]);
      expect(mine.every((one) => one.category === 'SUPPORT_AI')).toBe(true);
      expect(mine.every((one) => one.link.target === 'SUPPORT_AI')).toBe(true);
      // Support answers customers; it cannot act on a key, so it is not told about one.
      expect(await inbox(support)).toEqual([]);
      expect(
        (
          await refusal(
            ctx.container.notificationCenter.markAll(tenantA, support, { category: 'SUPPORT_AI' }),
          )
        ).kind,
      ).toBe('PERMISSION_DENIED');
    });
  });

  // -------------------------------------------------------------------------------------
  // The inbox
  // -------------------------------------------------------------------------------------

  describe('the inbox', () => {
    const list = (input: Parameters<DrizzleBusinessConversationRepository['list']>[1]) =>
      new DrizzleBusinessConversationRepository(ctx.container.database.db).list(scopeA, input);

    it('lists conversations waiting for a person first, then newest, and pages without a gap or a repeat', async () => {
      const t0 = Date.now() - 60 * 60_000;
      const ids: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        ids.push(await customerWrites(`70001${i}`, new Date(t0 + i * 60_000)));
      }
      // The two OLDEST are handed off: they still come first.
      await handOff(ids[0]!);
      await handOff(ids[1]!);

      const all = await list({ limit: 50 });
      expect(all.map((item) => item.conversation.id)).toEqual([
        ids[1],
        ids[0],
        ids[5],
        ids[4],
        ids[3],
        ids[2],
      ]);

      // Page by two through the three-key keyset.
      const seen: string[] = [];
      let before: { priority: 0 | 1; at: Date; id: string } | undefined;
      for (let page = 0; page < 5; page += 1) {
        const rows = await list({ limit: 2, ...(before === undefined ? {} : { before }) });
        if (rows.length === 0) break;
        seen.push(...rows.map((row) => row.conversation.id));
        const last = rows[rows.length - 1]!;
        before = {
          priority: last.conversation.state === 'HANDOFF_REQUIRED' ? 1 : 0,
          at: last.activityAt,
          id: last.conversation.id,
        };
      }
      expect(seen).toEqual(all.map((item) => item.conversation.id));

      // The state filter still works, and only the handed-off ones are HANDOFF_REQUIRED.
      const handoffs = await list({ state: 'HANDOFF_REQUIRED', limit: 50 });
      expect(handoffs.map((item) => item.conversation.id)).toEqual([ids[1], ids[0]]);
      const ai = await list({ state: 'AI_ACTIVE', limit: 50 });
      expect(ai).toHaveLength(4);
    });

    it('reads the customer’s wait from the oldest unanswered message, and clears it on a reply', async () => {
      const first = new Date(Date.now() - 10 * 60_000);
      const conversationId = await customerWrites('7000201', first);
      await record(message('7000201', { sentAt: new Date(Date.now() - 5 * 60_000) }));
      let [item] = await list({ limit: 50 });
      expect(item?.firstUnansweredAt?.toISOString()).toBe(first.toISOString());

      // The owner answers from the phone: nobody owes the customer anything.
      await record(
        message('7000201', { fromUserId: OWNER, text: 'بررسی می‌کنم', sentAt: new Date() }),
      );
      [item] = await list({ limit: 50 });
      expect(item?.conversation.id).toBe(conversationId);
      expect(item?.firstUnansweredAt).toBeNull();
    });
  });

  // -------------------------------------------------------------------------------------
  // Provider health
  // -------------------------------------------------------------------------------------

  describe('the provider health panel', () => {
    it('reports each breaker as of the read, the failures, a rejected key and the chain', async () => {
      const service = ctx.container.supportAiConfig;
      for (const provider of ['OPENAI', 'ANTHROPIC', 'ZAI'] as const) {
        await service.setCredential(tenantA, owner, provider, {
          idempotencyKey: key(provider),
          apiKey: `sk-test-${provider}-0123456789`,
          ...(provider === 'ZAI' ? { region: 'INTERNATIONAL' } : {}),
        });
      }
      await ctx.container.database.db.execute(sql`
        UPDATE support_ai_provider_credentials
           SET consecutive_failures = 3, tripped_until = now() + interval '5 minutes'
         WHERE tenant_id = ${SEED_IDS.tenantA} AND provider = 'ANTHROPIC'`);
      await ctx.container.database.db.execute(sql`
        UPDATE support_ai_provider_credentials
           SET consecutive_failures = 3, tripped_until = now() - interval '1 second',
               rejected_at = now()
         WHERE tenant_id = ${SEED_IDS.tenantA} AND provider = 'ZAI'`);

      let view = await service.view(tenantA, owner);
      const by = (provider: string) => view.credentials.find((one) => one.provider === provider)!;
      expect(by('OPENAI')).toMatchObject({
        breaker: 'CLOSED',
        consecutiveFailures: 0,
        rejectedAt: null,
      });
      expect(by('ANTHROPIC')).toMatchObject({ breaker: 'OPEN', consecutiveFailures: 3 });
      expect(by('ZAI').breaker).toBe('HALF_OPEN');
      expect(by('ZAI').rejectedAt).not.toBeNull();
      expect(view.chainUnavailable).toBe(false);

      await ctx.container.opsLog.record(tenantA, {
        code: 'support.ai_provider.unavailable',
        severity: 'WARN',
        message: 'No configured AI provider could answer.',
        dedupeKey: SUPPORT_AI_UNAVAILABLE_DEDUPE_KEY,
      });
      view = await service.view(tenantA, owner);
      expect(view.chainUnavailable).toBe(true);
      // Another tenant's outage is not this tenant's.
      await ctx.container.opsLog.record(tenantB, {
        code: 'support.ai_provider.available',
        severity: 'INFO',
        message: 'x',
        recoversCode: 'support.ai_provider.unavailable',
        recoversDedupeKey: SUPPORT_AI_UNAVAILABLE_DEDUPE_KEY,
      });
      expect((await service.view(tenantA, owner)).chainUnavailable).toBe(true);
      await ctx.container.opsLog.record(tenantA, {
        code: 'support.ai_provider.available',
        severity: 'INFO',
        message: 'A provider answered again.',
        recoversCode: 'support.ai_provider.unavailable',
        recoversDedupeKey: SUPPORT_AI_UNAVAILABLE_DEDUPE_KEY,
      });
      expect((await service.view(tenantA, owner)).chainUnavailable).toBe(false);
    });
  });

  // -------------------------------------------------------------------------------------
  // Analytics
  // -------------------------------------------------------------------------------------

  describe('the analytics', () => {
    const start = new Date('2026-09-01T00:00:00.000Z');
    const end = new Date('2026-09-08T00:00:00.000Z');
    const inside = new Date('2026-09-03T12:00:00.000Z');
    const atStart = start;
    const atEnd = end;
    const before = new Date('2026-08-31T23:59:59.999Z');

    /** A conversation of `tenantId` written straight in, with its own connection. */
    async function conversationIn(tenantId: string, bot: string, state = 'AI_ACTIVE') {
      const db = ctx.container.database.db;
      const connectionRowId = randomUUID();
      await db.execute(sql`
        INSERT INTO telegram_business_connections
          (id, tenant_id, bot_instance_id, connection_id, owner_telegram_user_id,
           owner_user_chat_id, is_enabled, rights, connected_at, last_confirmed_at)
        VALUES (${connectionRowId}, ${tenantId}, ${bot}, ${`plan-${connectionRowId}`}, '5000009',
                '5000009', true, ARRAY['can_reply'], now(), now())`);
      const id = randomUUID();
      const chat = String(7_100_000 + Math.floor(Math.random() * 800_000));
      await db.execute(sql`
        INSERT INTO business_conversations
          (id, tenant_id, bot_instance_id, owner_telegram_user_id, chat_id, connection_row_id,
           peer_telegram_user_id, state, control_epoch, handoff_reason)
        VALUES (${id}, ${tenantId}, ${bot}, '5000009', ${chat}, ${connectionRowId}, ${chat},
                ${state}, 1, ${state === 'HANDOFF_REQUIRED' ? 'HANDOFF_TOPIC' : null})`);
      return id;
    }

    async function escalation(tenantId: string, conversationId: string, epoch: number, at: Date) {
      await ctx.container.database.db.execute(sql`
        INSERT INTO business_conversation_escalations
          (id, tenant_id, conversation_id, control_epoch, reason, ticket_outcome, created_at)
        VALUES (${randomUUID()}, ${tenantId}, ${conversationId}, ${epoch}, 'LOW_CONFIDENCE',
                'NO_CUSTOMER', ${at.toISOString()}::timestamptz)`);
    }

    async function job(
      tenantId: string,
      conversationId: string,
      kind: 'ASSIST_DRAFT' | 'AUTO_DECISION',
      state: string,
      outcome: string | null,
      at: Date,
    ) {
      const auto = kind === 'AUTO_DECISION';
      const sent = state === 'SENT';
      await ctx.container.database.db.execute(sql`
        INSERT INTO support_ai_jobs
          (id, tenant_id, kind, conversation_id, idempotency_key, state, decision,
           sent_outbound_id, trigger_telegram_message_id, trigger_content_version,
           control_epoch, due_at, outcome, created_at)
        VALUES (${randomUUID()}, ${tenantId}, ${kind}, ${conversationId}, ${key('job')},
                ${state}, ${sent ? 'REPLY' : null}, ${sent ? randomUUID() : null},
                ${auto ? 1 : null}, ${auto ? 1 : null}, ${auto ? 1 : null},
                ${auto ? at.toISOString() : null}::timestamptz, ${outcome},
                ${at.toISOString()}::timestamptz)`);
    }

    async function run(
      tenantId: string,
      provider: string,
      outcome: string,
      latencyMs: number,
      tokens: [number | null, number | null],
      at: Date,
    ) {
      await ctx.container.database.db.execute(sql`
        INSERT INTO support_ai_runs
          (id, tenant_id, operation, provider, model, attempt_index, latency_ms,
           input_tokens, output_tokens, outcome, created_at)
        VALUES (${randomUUID()}, ${tenantId}, 'ASSIST_DRAFT', ${provider}, 'model-x', 0,
                ${latencyMs}, ${tokens[0]}, ${tokens[1]}, ${outcome},
                ${at.toISOString()}::timestamptz)`);
    }

    async function candidate(tenantId: string, conversationId: string, state: string, at: Date) {
      const title = `درس ${randomUUID()}`;
      await ctx.container.database.db.execute(sql`
        INSERT INTO support_learning_candidates
          (id, tenant_id, state, title, normalized_title, body, category, confidence,
           reject_reason, conversation_id, source_outbound_id, job_id, reviewed_at, created_at)
        VALUES (${randomUUID()}, ${tenantId}, ${state}, ${title}, ${title}, 'متن', 'CONNECTION',
                'HIGH', ${state === 'REJECTED' ? 'REVIEWER' : null}, ${conversationId},
                ${randomUUID()}, ${randomUUID()},
                ${state === 'PENDING' ? null : at.toISOString()}::timestamptz,
                ${at.toISOString()}::timestamptz)`);
    }

    async function article(tenantId: string, state: string, enabled: boolean) {
      await ctx.container.database.db.execute(sql`
        INSERT INTO support_knowledge_articles
          (id, tenant_id, source, state, enabled, title, body, category, revision)
        VALUES (${randomUUID()}, ${tenantId}, 'MANUAL', ${state}, ${enabled},
                ${`مقاله ${randomUUID()}`}, 'متن', 'CONNECTION', ${state === 'DRAFT' ? 0 : 1})`);
    }

    async function seedTenant(tenantId: string, bot: string) {
      const one = await conversationIn(tenantId, bot, 'HANDOFF_REQUIRED');
      const two = await conversationIn(tenantId, bot);
      await escalation(tenantId, one, 1, atStart);
      await escalation(tenantId, one, 2, inside);
      await escalation(tenantId, one, 3, atEnd); // excluded: the window is half-open
      await escalation(tenantId, two, 1, before); // excluded: before the window
      await job(tenantId, one, 'AUTO_DECISION', 'SENT', 'sent', inside);
      await job(tenantId, one, 'AUTO_DECISION', 'DISCARDED', 'guard_topic_allowlist', inside);
      await job(tenantId, one, 'AUTO_DECISION', 'DISCARDED', 'dropped_epoch', atStart);
      await job(tenantId, two, 'AUTO_DECISION', 'QUEUED', null, inside);
      await job(tenantId, two, 'AUTO_DECISION', 'SENT', 'sent', atEnd); // excluded
      await job(tenantId, one, 'ASSIST_DRAFT', 'SENT', null, inside);
      await job(tenantId, one, 'ASSIST_DRAFT', 'DISCARDED', null, inside);
      await job(tenantId, two, 'ASSIST_DRAFT', 'FAILED', null, inside);
      await job(tenantId, two, 'ASSIST_DRAFT', 'QUEUED', null, before); // excluded
      for (const latency of [100, 200, 300, 400, 1000]) {
        await run(tenantId, 'OPENAI', 'OK', latency, [1000, 100], inside);
      }
      await run(tenantId, 'OPENAI', 'TIMEOUT', 20000, [null, null], inside);
      await run(tenantId, 'OPENAI', 'OK', 5, [9999, 9999], atEnd); // excluded
      await candidate(tenantId, one, 'PENDING', inside);
      await candidate(tenantId, one, 'REJECTED', inside);
      await candidate(tenantId, two, 'PENDING', before); // excluded
      await article(tenantId, 'APPROVED', true);
      await article(tenantId, 'APPROVED', true);
      await article(tenantId, 'APPROVED', false);
      await article(tenantId, 'DRAFT', true);
    }

    it('counts each figure in [start, end), tenant by tenant', async () => {
      await seedTenant(SEED_IDS.tenantA, SEED_IDS.botA1);
      await seedTenant(SEED_IDS.tenantB, SEED_IDS.botB1);
      // Tenant B has more of everything; none of it may reach tenant A's figures.
      await seedTenant(SEED_IDS.tenantB, SEED_IDS.botB1);

      const facts = await new DrizzleSupportAnalyticsReader(ctx.container.database.db).read(
        tenantA,
        { start, end },
      );
      const conversations = Object.fromEntries(facts.conversations.map((r) => [r.state, r.count]));
      expect(conversations).toEqual({ HANDOFF_REQUIRED: 1, AI_ACTIVE: 1 });
      expect(facts.handoffs).toEqual([{ reason: 'LOW_CONFIDENCE', count: 2 }]);

      const jobs = (kind: string) =>
        facts.jobs
          .filter((row) => row.kind === kind)
          .map((row) => `${row.state}/${row.outcome ?? '-'}=${row.count}`)
          .sort();
      expect(jobs('AUTO_DECISION')).toEqual([
        'DISCARDED/dropped_epoch=1',
        'DISCARDED/guard_topic_allowlist=1',
        'QUEUED/-=1',
        'SENT/sent=1',
      ]);
      expect(jobs('ASSIST_DRAFT')).toEqual(['DISCARDED/-=1', 'FAILED/-=1', 'SENT/-=1']);

      const ok = facts.runs.find((row) => row.provider === 'OPENAI' && row.outcome === 'OK')!;
      // percentile_cont over 100, 200, 300, 400, 1000: the median and the 95th, continuous.
      expect(ok).toMatchObject({
        runs: 5,
        p50LatencyMs: 300,
        p95LatencyMs: 880,
        inputTokens: 5000,
        outputTokens: 500,
      });
      // A run that reported no tokens counts as zero, not as a missing group.
      expect(
        facts.runs.find((row) => row.provider === 'OPENAI' && row.outcome === 'TIMEOUT'),
      ).toMatchObject({ runs: 1, inputTokens: 0, outputTokens: 0 });

      const candidates = Object.fromEntries(facts.candidates.map((r) => [r.state, r.count]));
      expect(candidates).toEqual({ PENDING: 1, REJECTED: 1 });
      const articles = facts.articles
        .map((row) => `${row.source}/${row.state}/${String(row.enabled)}=${row.count}`)
        .sort();
      expect(articles).toEqual([
        'MANUAL/APPROVED/false=1',
        'MANUAL/APPROVED/true=2',
        'MANUAL/DRAFT/true=1',
      ]);
    });

    it('is charged support_ai.configure before anything is read, and answers in the reports’ range', async () => {
      expect(
        (
          await refusal(
            ctx.container.supportAnalytics.analytics(tenantA, support, { range: 'LAST_7_DAYS' }),
          )
        ).kind,
      ).toBe('PERMISSION_DENIED');
      // The refusal is recorded, naming the key it lacked.
      const denied = await ctx.container.database.db.execute(sql`
        SELECT count(*)::int AS n FROM operational_events
         WHERE tenant_id = ${SEED_IDS.tenantA} AND code = 'access.permission_denied'
           AND context->>'permission' = 'support_ai.configure'`);
      expect((denied.rows[0] as { n: number }).n).toBe(1);

      const conversationId = await customerWrites('7000301');
      await handOff(conversationId);
      const answer = await ctx.container.supportAnalytics.analytics(tenantA, owner, {
        range: 'TODAY',
      });
      expect(supportAnalyticsResponseSchema.safeParse(answer).success).toBe(true);
      expect(answer.period.range).toBe('TODAY');
      expect(Date.parse(answer.period.start)).toBeLessThanOrEqual(Date.now());
      expect(Date.parse(answer.period.end)).toBeGreaterThan(Date.now());
      expect(answer.conversationsNow.find((r) => r.state === 'HANDOFF_REQUIRED')?.count).toBe(1);
      expect(answer.handoffsByReason).toEqual([{ reason: 'HANDOFF_TOPIC', count: 1 }]);
    });
  });
});

// ---------------------------------------------------------------------------------------
// Over HTTP
// ---------------------------------------------------------------------------------------

describe('TB10 — over HTTP', () => {
  const ORIGIN = 'https://admin.example.test';
  let api: ApiApp;
  let cookie: string;
  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  beforeAll(async () => {
    const config = testConfig({ WEB_ADMIN_ORIGINS: ORIGIN });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  }, 120_000);
  afterAll(async () => {
    await api?.close();
  });
  beforeEach(async () => {
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    await createAdmin(api.container, tenantA, {
      username: 'owner-tb10-http',
      password: 'the-owners-real-password',
      roleKeys: ['owner'],
    });
    const login = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username: 'owner-tb10-http', password: 'the-owners-real-password' },
    });
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(
      String(login.headers['set-cookie'] ?? ''),
    );
    if (match === null) throw new Error('No session cookie.');
    cookie = `${SESSION_COOKIE_NAME}=${match[1] as string}`;
  });

  it('answers the analytics for a preset, and refuses a malformed range with a 400', async () => {
    const ok = await inject({
      method: 'GET',
      url: `${API_PREFIX}${SUPPORT_ANALYTICS_ROUTES.analytics}?range=LAST_30_DAYS`,
      headers: { cookie },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(supportAnalyticsResponseSchema.safeParse(ok.json()).success).toBe(true);
    for (const query of ['range=CUSTOM', 'range=LAST_7_DAYS&from=1405-07-01', 'range=EVER', '']) {
      const bad = await inject({
        method: 'GET',
        url: `${API_PREFIX}${SUPPORT_ANALYTICS_ROUTES.analytics}?${query}`,
        headers: { cookie },
      });
      expect(bad.statusCode, query).toBe(400);
    }
  });

  it('pages the inbox by the cursor it issued, and refuses one it did not', async () => {
    const first = await inject({
      method: 'GET',
      url: `${API_PREFIX}${BUSINESS_CHAT_ROUTES.list}`,
      headers: { cookie },
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(businessChatListResponseSchema.safeParse(first.json()).success).toBe(true);
    const id = randomUUID();
    const good = await inject({
      method: 'GET',
      url: `${API_PREFIX}${BUSINESS_CHAT_ROUTES.list}?cursor=${encodeURIComponent(`1|2026-10-01T10:00:00.000Z|${id}`)}`,
      headers: { cookie },
    });
    expect(good.statusCode, good.body).toBe(200);
    for (const cursor of [
      `2026-10-01T10:00:00.000Z|${id}`, // TB2's two-key form
      `2|2026-10-01T10:00:00.000Z|${id}`,
      `1|yesterday|${id}`,
      `1|2026-10-01T10:00:00.000Z|not-a-uuid`,
    ]) {
      const bad = await inject({
        method: 'GET',
        url: `${API_PREFIX}${BUSINESS_CHAT_ROUTES.list}?cursor=${encodeURIComponent(cursor)}`,
        headers: { cookie },
      });
      expect(bad.statusCode, cursor).toBe(400);
    }
  });
});
