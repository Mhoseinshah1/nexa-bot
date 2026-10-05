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
import { SupportLearningService } from '../../apps/api/src/modules/control/support-knowledge/application/support-learning.service';
import { DrizzleSupportKnowledgeRepository } from '../../apps/api/src/modules/control/support-knowledge/infrastructure/drizzle-support-knowledge.repository';
import { DrizzleSupportAiConfigRepository } from '../../apps/api/src/modules/control/support-ai/infrastructure/drizzle-support-ai.repository';
import { AssistantLoop } from '../../apps/api/src/modules/control/support-ai/application/assistant-loop';
import {
  DrizzleBusinessConversationRepository,
  DrizzleBusinessMessageRepository,
  DrizzleBusinessOutboundRepository,
} from '../../apps/api/src/modules/commerce/business-chats/infrastructure/drizzle-business-conversation.repository';
import type { SupportAiRequest } from '../../apps/api/src/modules/control/support-ai/application/ports';
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
 * TB8 — controlled learning against a real database (program §29, §38; ADR-0035).
 *
 * Pinned here: nothing becomes knowledge without a reviewer's approval; reject and «edit then
 * approve»; an idempotent replay publishes once; the review permission; tenant isolation; a
 * scrubber hit in the model's output is rejected automatically and stored redacted; the
 * provider never sees the customer's data; AI OFF learns nothing; the TB3 context carries
 * approved knowledge only; duplicates merge; the per-conversation window.
 */

const BOT = SEED_IDS.botA1;
const BOT_B = SEED_IDS.botB1;
const scopeA = { ...tenantA, botInstanceId: BOT } as never;
const scopeB = { ...tenantB, botInstanceId: BOT_B } as never;

const lesson = {
  proposal: 'CANDIDATE',
  title: 'چطور لینک اشتراک را در v2rayNG وارد کنم؟',
  body: 'لینک اشتراک را از منوی «سرویس‌های من» در ربات کپی کنید، در v2rayNG علامت + را بزنید و «وارد کردن از کلیپ‌بورد» را انتخاب کنید.',
  category: 'APPS',
  tags: ['v2rayNG', 'اندروید'],
  rationale: 'این مراحل برای همه مشتریان اندروید یکسان است.',
  confidence: 'HIGH',
};

describe('controlled learning (TB8)', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let support: ActorContext;
  let ownerB: ActorContext;
  let next: SupportAiOutcome;
  let requests: (Omit<SupportAiRequest, 'model' | 'timeoutMs'> & { operation: string })[];
  let learning: SupportLearningService;
  let loop: AssistantLoop;
  let repo: DrizzleSupportKnowledgeRepository;
  let keySeq = 0;
  const key = (label: string) => `${label}-${Date.now()}-${(keySeq += 1)}`;
  const system = () => systemJobActor('learning-test', 'c' as CorrelationId);

  async function configure(actor: ActorContext, scope: never, mode: 'OFF' | 'ASSIST_ONLY') {
    const current = await ctx.container.supportAiConfig.view(scope, actor);
    await ctx.container.supportAiConfig.update(scope, actor, {
      idempotencyKey: key('cfg'),
      expectedVersion: current.version === 0 ? null : current.version,
      config: {
        ...SUPPORT_AI_DEFAULT_CONFIG,
        mode,
        primary: mode === 'OFF' ? null : { provider: 'OPENAI', model: 'gpt-5.5' },
      },
    });
  }

  /** A conversation with a customer question and a DELIVERED operator reply. */
  async function conversationWithReply(
    scope: never,
    bot: string,
    operator: ActorContext,
    chat: string,
    reply: string,
  ): Promise<{ conversationId: string; outboundId: string }> {
    const c = ctx.container;
    await c.businessConnections.applyReport(scope, system(), {
      idempotencyKey: key('conn'),
      botInstanceId: bot,
      report: {
        connectionId: `conn-${bot}`,
        ownerTelegramUserId: '5000001',
        ownerUserChatId: '5000001',
        isEnabled: true,
        rights: ['can_reply'] as BusinessBotRight[],
        connectedAt: new Date('2026-10-01T00:00:00Z'),
      },
    });
    const recorded = await c.businessConversations.recordMessage(scope, system(), {
      idempotencyKey: key('msg'),
      botInstanceId: bot,
      edited: false,
      message: {
        connectionId: `conn-${bot}`,
        chatId: chat,
        chatType: 'private',
        messageId: 11,
        fromUserId: chat,
        senderBusinessBotId: null,
        isFromOffline: false,
        sentAt: new Date(),
        editedAt: null,
        kind: 'TEXT',
        text: 'سلام، شماره من ۰۹۱۲۱۲۳۴۵۶۷ است؛ لینک را کجا وارد کنم؟',
        photo: null,
      },
    });
    const conversationId = recorded!.conversationId;
    const row = await c.businessConversations.send(scope, operator, {
      conversationId,
      idempotencyKey: key('send'),
      text: reply,
    });
    await c.database.db.execute(
      sql`UPDATE business_outbound_messages SET state = 'DELIVERED', resolved_at = now(), telegram_message_id = 900 WHERE id = ${row.id}`,
    );
    return { conversationId, outboundId: row.id };
  }

  async function handBack(scope: never, operator: ActorContext, conversationId: string) {
    await ctx.container.businessConversations.resume(scope, operator, {
      conversationId,
      idempotencyKey: key('resume'),
    });
  }

  async function jobCount(): Promise<number> {
    const rows = await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM support_learning_jobs`,
    );
    return (rows.rows[0] as { n: number }).n;
  }

  async function knowledgeInContext(scope: never) {
    const built = await ctx.container.supportContext.build(scope, null);
    return built.payload.knowledge.filter((entry) => entry.source === 'KNOWLEDGE');
  }

  async function expectCode(promise: Promise<unknown>, code: string) {
    try {
      await promise;
    } catch (error) {
      expect(isNexaError(error) ? error.code : error).toBe(code);
      return;
    }
    throw new Error(`expected ${code}, nothing was thrown`);
  }

  beforeEach(async () => {
    ctx ??= await createTestContext();
    await ctx.reset();
    const c = ctx.container;
    owner = adminActorFor(
      await createAdmin(c, tenantA, { username: 'owner', roleKeys: ['owner'] }),
    );
    support = adminActorFor(
      await createAdmin(c, tenantA, { username: 'support1', roleKeys: ['support'] }),
    );
    ownerB = adminActorFor(
      await createAdmin(c, tenantB, { username: 'ownerb', roleKeys: ['owner'] }),
    );
    await configure(owner, tenantA as never, 'ASSIST_ONLY');
    next = {
      outcome: 'OK',
      output: lesson,
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'gpt-5.5',
    };
    requests = [];
    repo = new DrizzleSupportKnowledgeRepository(c.database.db);
    learning = new SupportLearningService({
      repository: repo,
      configs: new DrizzleSupportAiConfigRepository(c.database.db),
      chain: {
        generate: async (_scope, input) => {
          requests.push({ ...input.request, operation: input.operation });
          return {
            outcome: next,
            step: { provider: 'OPENAI', model: 'gpt-5.5' },
            attempts: 1,
            exhausted: null,
            imagesSent: 0,
          };
        },
      },
      conversations: new DrizzleBusinessConversationRepository(c.database.db),
      messages: new DrizzleBusinessMessageRepository(c.database.db),
      outbound: new DrizzleBusinessOutboundRepository(c.database.db),
      guard: c.guard,
      uow: c.uow,
      audit: c.audit,
      opsLog: c.opsLogWriter,
      sessions: c.sessions,
      scopeActivity: c.tenants,
      clock: c.clock,
      ids: c.ids,
    });
    loop = new AssistantLoop(
      {
        claimNext: async () => null,
        produce: async () => 'GONE' as const,
        abandon: async () => 'GONE' as const,
        purgeExpired: async () => 0,
      },
      {
        learning,
        scope: () => scopeA,
        intervalMs: 1000,
        now: () => c.clock.now(),
        logger: c.logger,
      },
    );
  });

  afterAll(async () => {
    await ctx?.close();
  });

  async function pendingCandidate() {
    const { conversationId } = await conversationWithReply(
      scopeA,
      BOT,
      support,
      '7000001',
      'سلام. لینک را از «سرویس‌های من» کپی کنید و در v2rayNG با + وارد کنید.',
    );
    await handBack(scopeA, support, conversationId);
    expect(await jobCount()).toBe(1);
    await loop.tick();
    const [candidate] = await ctx.container.supportKnowledge.listCandidates(tenantA, owner, {});
    return { candidate: candidate!, conversationId };
  }

  it('a handback learns a PENDING candidate, and nothing is knowledge until it is approved', async () => {
    const { candidate } = await pendingCandidate();
    expect(candidate).toMatchObject({
      state: 'PENDING',
      title: lesson.title,
      category: 'APPS',
      confidence: 'HIGH',
      sourceCount: 1,
    });
    expect(await ctx.container.supportKnowledge.listArticles(tenantA, owner, {})).toEqual([]);
    expect(await knowledgeInContext(tenantA as never)).toEqual([]);
    // A candidate is never reachable by the agent's retrieval, whatever its state.
    expect(await repo.activeForContext(tenantA, 20)).toEqual([]);
  });

  it('the provider never reads the customer’s phone, and the job ran as LEARNING_EXTRACT', async () => {
    await pendingCandidate();
    expect(requests).toHaveLength(1);
    const text = JSON.stringify(requests[0]);
    expect(text).not.toMatch(/0912|۰۹۱۲|1234567|۱۲۳۴۵۶۷/u);
    expect(text).toContain('[REDACTED:PHONE]');
    expect(requests[0]?.operation).toBe('LEARNING_EXTRACT');
  });

  it('approve publishes ONE article with revision 1, the context carries it, and a replay publishes once', async () => {
    const { candidate } = await pendingCandidate();
    const body = { idempotencyKey: key('approve'), expectedVersion: candidate.version, edit: null };
    const approved = await ctx.container.supportKnowledge.approveCandidate(
      tenantA,
      owner,
      candidate.id,
      body,
    );
    const replay = await ctx.container.supportKnowledge.approveCandidate(
      tenantA,
      owner,
      candidate.id,
      body,
    );
    expect(approved.state).toBe('APPROVED');
    expect(replay.articleId).toBe(approved.articleId);
    const articles = await ctx.container.supportKnowledge.listArticles(tenantA, owner, {});
    expect(articles).toHaveLength(1);
    expect(articles[0]).toMatchObject({
      source: 'LEARNED',
      state: 'APPROVED',
      revision: 1,
      title: lesson.title,
    });
    const revisions = await ctx.container.supportKnowledge.revisions(
      tenantA,
      owner,
      articles[0]!.id,
    );
    expect(revisions).toMatchObject([{ revision: 1, origin: 'CANDIDATE' }]);
    expect(await knowledgeInContext(tenantA as never)).toEqual([
      { source: 'KNOWLEDGE', question: lesson.title, answer: lesson.body },
    ]);
    // A second decision under a new key is refused: the candidate is no longer PENDING.
    await expectCode(
      ctx.container.supportKnowledge.rejectCandidate(tenantA, owner, candidate.id, {
        idempotencyKey: key('reject'),
        expectedVersion: approved.version,
      }),
      'support_knowledge.not_in_state',
    );
    const audits = await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'support_knowledge.candidate.approve' AND result = 'SUCCESS'`,
    );
    expect((audits.rows[0] as { n: number }).n).toBe(1);
  });

  it('edit then approve publishes the EDITED text; reject publishes nothing', async () => {
    const { candidate } = await pendingCandidate();
    const edit = {
      title: 'وارد کردن لینک اشتراک در v2rayNG',
      body: 'در ربات «سرویس‌های من» را باز کنید، لینک را کپی کنید و در برنامه با + وارد کنید.',
      category: 'APPS' as const,
      tags: ['v2rayNG'],
    };
    await ctx.container.supportKnowledge.approveCandidate(tenantA, owner, candidate.id, {
      idempotencyKey: key('approve'),
      expectedVersion: candidate.version,
      edit,
    });
    expect(await knowledgeInContext(tenantA as never)).toEqual([
      { source: 'KNOWLEDGE', question: edit.title, answer: edit.body },
    ]);

    // A second lesson, rejected: no article, no context entry.
    next = {
      ...next,
      output: { ...lesson, title: 'سیاست بازگشت وجه چیست؟', body: 'پاسخ عمومی.' },
    } as SupportAiOutcome;
    const second = await conversationWithReply(
      scopeA,
      BOT,
      support,
      '7000002',
      'پاسخ عمومی درباره قوانین.',
    );
    await handBack(scopeA, support, second.conversationId);
    await loop.tick();
    const pending = await ctx.container.supportKnowledge.listCandidates(tenantA, owner, {
      state: 'PENDING',
    });
    expect(pending).toHaveLength(1);
    const rejected = await ctx.container.supportKnowledge.rejectCandidate(
      tenantA,
      owner,
      pending[0]!.id,
      {
        idempotencyKey: key('reject'),
        expectedVersion: pending[0]!.version,
        note: 'یک تصمیم موردی بود',
      },
    );
    expect(rejected).toMatchObject({
      state: 'REJECTED',
      rejectReason: 'REVIEWER',
      articleId: null,
    });
    expect(await ctx.container.supportKnowledge.listArticles(tenantA, owner, {})).toHaveLength(1);
  });

  it('a stale version is refused and publishes nothing', async () => {
    const { candidate } = await pendingCandidate();
    await expectCode(
      ctx.container.supportKnowledge.approveCandidate(tenantA, owner, candidate.id, {
        idempotencyKey: key('approve'),
        expectedVersion: candidate.version + 1,
        edit: null,
      }),
      'support_knowledge.version_conflict',
    );
    expect(await ctx.container.supportKnowledge.listArticles(tenantA, owner, {})).toEqual([]);
  });

  it('an approval whose text still holds personal data is refused, edited or not', async () => {
    const { candidate } = await pendingCandidate();
    await expectCode(
      ctx.container.supportKnowledge.approveCandidate(tenantA, owner, candidate.id, {
        idempotencyKey: key('approve'),
        expectedVersion: candidate.version,
        edit: { title: 'تماس', body: 'با ۰۹۱۲۱۲۳۴۵۶۷ تماس بگیرید', category: 'GENERAL', tags: [] },
      }),
      'support_knowledge.sensitive_content',
    );
    expect(await ctx.container.supportKnowledge.listArticles(tenantA, owner, {})).toEqual([]);
  });

  it('a scrubber hit in the model’s output is rejected automatically and stored redacted', async () => {
    next = {
      ...next,
      output: {
        ...lesson,
        title: 'کارت برای واریز',
        body: 'مبلغ را به کارت ۶۰۳۷-۹۹۱۲-۳۴۵۶-۷۸۹۰ واریز و به @pay_admin1 خبر دهید.',
      },
    } as SupportAiOutcome;
    await pendingCandidate();
    const [candidate] = await ctx.container.supportKnowledge.listCandidates(tenantA, owner, {});
    expect(candidate).toMatchObject({
      state: 'REJECTED',
      rejectReason: 'SENSITIVE_CONTENT',
      sensitiveKinds: ['CARD', 'USERNAME'],
      articleId: null,
    });
    const raw = await ctx.container.database.db.execute(
      sql`SELECT title, body, rationale, tags::text AS tags, source_refs::text AS refs FROM support_learning_candidates`,
    );
    expect(JSON.stringify(raw.rows)).not.toMatch(/6037|۶۰۳۷|pay_admin1/u);
    const job = await ctx.container.database.db.execute(
      sql`SELECT outcome FROM support_learning_jobs`,
    );
    expect(job.rows).toEqual([{ outcome: 'auto_rejected' }]);
    expect(await knowledgeInContext(tenantA as never)).toEqual([]);
  });

  it('AI OFF: a handback enqueues nothing, a proposal is refused, and a queued job extracts nothing', async () => {
    const { conversationId, outboundId } = await conversationWithReply(
      scopeA,
      BOT,
      support,
      '7000003',
      'برای اتصال برنامه را دوباره باز کنید.',
    );
    await configure(owner, tenantA as never, 'OFF');
    await handBack(scopeA, support, conversationId);
    expect(await jobCount()).toBe(0);
    await expectCode(
      learning.propose(tenantA, support, conversationId, { idempotencyKey: key('p'), outboundId }),
      'support_knowledge.ai_off',
    );
    // Queued while ON, produced after OFF: dropped, and the provider is never asked.
    await configure(owner, tenantA as never, 'ASSIST_ONLY');
    await learning.propose(tenantA, support, conversationId, {
      idempotencyKey: key('p'),
      outboundId,
    });
    await configure(owner, tenantA as never, 'OFF');
    await loop.tick();
    expect(requests).toHaveLength(0);
    const job = await ctx.container.database.db.execute(
      sql`SELECT state, outcome FROM support_learning_jobs`,
    );
    expect(job.rows).toEqual([{ state: 'DONE', outcome: 'dropped_mode' }]);
  });

  it('an explicit proposal is idempotent on the reply, and the 24-hour window refuses a second', async () => {
    const { conversationId, outboundId } = await conversationWithReply(
      scopeA,
      BOT,
      support,
      '7000004',
      'برای اتصال برنامه را دوباره باز کنید.',
    );
    const first = await learning.propose(tenantA, support, conversationId, {
      idempotencyKey: key('p'),
      outboundId,
    });
    const again = await learning.propose(tenantA, support, conversationId, {
      idempotencyKey: key('p'),
      outboundId,
    });
    expect(again.id).toBe(first.id);
    // The handback of the same reply coincides with the proposal's job.
    await handBack(scopeA, support, conversationId);
    expect(await jobCount()).toBe(1);
    // Another reply in the same conversation within 24 hours: refused.
    const row = await ctx.container.businessConversations.send(scopeA, support, {
      conversationId,
      idempotencyKey: key('send'),
      text: 'یک پاسخ دیگر',
    });
    await ctx.container.database.db.execute(
      sql`UPDATE business_outbound_messages SET state = 'DELIVERED', resolved_at = now(), telegram_message_id = 901 WHERE id = ${row.id}`,
    );
    await expectCode(
      learning.propose(tenantA, support, conversationId, {
        idempotencyKey: key('p'),
        outboundId: row.id,
      }),
      'support_knowledge.learning_rate_limited',
    );
  });

  it('only a DELIVERED reply an operator wrote, in that conversation, can be proposed', async () => {
    const { conversationId } = await conversationWithReply(scopeA, BOT, support, '7000005', 'پاسخ');
    const pending = await ctx.container.businessConversations.send(scopeA, support, {
      conversationId,
      idempotencyKey: key('send'),
      text: 'هنوز ارسال نشده',
    });
    await expectCode(
      learning.propose(tenantA, support, conversationId, {
        idempotencyKey: key('p'),
        outboundId: pending.id,
      }),
      'support_knowledge.source_not_eligible',
    );
    await expectCode(
      learning.propose(tenantA, support, conversationId, {
        idempotencyKey: key('p'),
        outboundId: '01900000-0000-7000-8000-0000000000ff',
      }),
      'support_knowledge.source_not_eligible',
    );
  });

  it('a lesson proposed again — even one already rejected — merges as an extra source', async () => {
    const { candidate } = await pendingCandidate();
    await ctx.container.supportKnowledge.rejectCandidate(tenantA, owner, candidate.id, {
      idempotencyKey: key('reject'),
      expectedVersion: candidate.version,
    });
    // Same lesson from another conversation, worded with Arabic letters and punctuation.
    next = {
      ...next,
      output: { ...lesson, title: `${lesson.title.replace('ی', 'ي')}!!` },
    } as SupportAiOutcome;
    const other = await conversationWithReply(scopeA, BOT, support, '7000006', 'همان پاسخ.');
    await handBack(scopeA, support, other.conversationId);
    await loop.tick();
    const all = await ctx.container.supportKnowledge.listCandidates(tenantA, owner, {});
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ state: 'REJECTED', sourceCount: 2 });
    const job = await ctx.container.database.db.execute(
      sql`SELECT outcome FROM support_learning_jobs ORDER BY created_at DESC LIMIT 1`,
    );
    expect(job.rows).toEqual([{ outcome: 'merged' }]);
  });

  it('the model declining, or an invalid output, creates no candidate', async () => {
    next = {
      ...next,
      output: { ...lesson, proposal: 'NONE', title: '', body: '' },
    } as SupportAiOutcome;
    await pendingCandidate().catch(() => undefined);
    next = { ...next, output: { ...lesson, extra: 'x' } } as SupportAiOutcome;
    const other = await conversationWithReply(scopeA, BOT, support, '7000007', 'پاسخ');
    await handBack(scopeA, support, other.conversationId);
    await loop.tick();
    const jobs = await ctx.container.database.db.execute(
      sql`SELECT state, outcome FROM support_learning_jobs ORDER BY created_at`,
    );
    expect(jobs.rows).toEqual([
      { state: 'DONE', outcome: 'declined' },
      { state: 'FAILED', outcome: 'output_invalid' },
    ]);
    expect(await ctx.container.supportKnowledge.listCandidates(tenantA, owner, {})).toEqual([]);
  });

  it('permissions: support views and proposes but cannot review; the denial is audited', async () => {
    const { candidate } = await pendingCandidate();
    expect(await ctx.container.supportKnowledge.listCandidates(tenantA, support, {})).toHaveLength(
      1,
    );
    await expectCode(
      ctx.container.supportKnowledge.approveCandidate(tenantA, support, candidate.id, {
        idempotencyKey: key('approve'),
        expectedVersion: candidate.version,
        edit: null,
      }),
      'platform.permission_denied',
    );
    await expectCode(
      ctx.container.supportKnowledge.createArticle(tenantA, support, {
        idempotencyKey: key('create'),
        content: { title: 't', body: 'b', category: 'GENERAL', tags: [] },
        publish: true,
      }),
      'platform.permission_denied',
    );
    const denied = await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'support_knowledge.candidate.approve' AND result = 'DENIED'`,
    );
    expect((denied.rows[0] as { n: number }).n).toBe(1);
    expect(await ctx.container.supportKnowledge.listArticles(tenantA, owner, {})).toEqual([]);
  });

  it('tenant isolation: another tenant cannot see, approve or read tenant A’s knowledge', async () => {
    const { candidate } = await pendingCandidate();
    expect(await ctx.container.supportKnowledge.listCandidates(tenantB, ownerB, {})).toEqual([]);
    await expectCode(
      ctx.container.supportKnowledge.approveCandidate(tenantB, ownerB, candidate.id, {
        idempotencyKey: key('approve'),
        expectedVersion: candidate.version,
        edit: null,
      }),
      'support_knowledge.candidate_not_found',
    );
    await ctx.container.supportKnowledge.approveCandidate(tenantA, owner, candidate.id, {
      idempotencyKey: key('approve'),
      expectedVersion: candidate.version,
      edit: null,
    });
    expect(await knowledgeInContext(tenantA as never)).toHaveLength(1);
    expect(await knowledgeInContext(tenantB as never)).toEqual([]);
    expect(await ctx.container.supportKnowledge.listArticles(tenantB, ownerB, {})).toEqual([]);
    void scopeB;
  });

  it('a draft, a disabled and a retired article never reach the context; an edit is a new revision', async () => {
    const k = ctx.container.supportKnowledge;
    const content = (title: string) => ({
      title,
      body: `${title} body`,
      category: 'GENERAL' as const,
      tags: [],
    });
    const draft = await k.createArticle(tenantA, owner, {
      idempotencyKey: key('c'),
      content: content('draft'),
      publish: false,
    });
    const live = await k.createArticle(tenantA, owner, {
      idempotencyKey: key('c'),
      content: content('live'),
      publish: true,
    });
    const off = await k.createArticle(tenantA, owner, {
      idempotencyKey: key('c'),
      content: content('off'),
      publish: true,
    });
    const gone = await k.createArticle(tenantA, owner, {
      idempotencyKey: key('c'),
      content: content('gone'),
      publish: true,
    });
    await k.setEnabled(tenantA, owner, off.id, {
      idempotencyKey: key('e'),
      expectedVersion: off.version,
      enabled: false,
    });
    await k.retireArticle(tenantA, owner, gone.id, {
      idempotencyKey: key('r'),
      expectedVersion: gone.version,
    });
    expect(draft).toMatchObject({ state: 'DRAFT', revision: 0 });
    expect((await knowledgeInContext(tenantA as never)).map((e) => e.question)).toEqual(['live']);

    const edited = await k.updateArticle(tenantA, owner, live.id, {
      idempotencyKey: key('u'),
      expectedVersion: live.version,
      content: content('live v2'),
    });
    expect(edited).toMatchObject({ revision: 2, version: 2 });
    expect((await k.revisions(tenantA, owner, live.id)).map((r) => [r.revision, r.title])).toEqual([
      [2, 'live v2'],
      [1, 'live'],
    ]);
    // Editing a draft publishes nothing; publishing it does.
    const draftEdited = await k.updateArticle(tenantA, owner, draft.id, {
      idempotencyKey: key('u'),
      expectedVersion: draft.version,
      content: content('draft v2'),
    });
    expect(draftEdited).toMatchObject({ state: 'DRAFT', revision: 0 });
    expect(await k.revisions(tenantA, owner, draft.id)).toEqual([]);
    await k.publishArticle(tenantA, owner, draft.id, {
      idempotencyKey: key('p'),
      expectedVersion: draftEdited.version,
    });
    expect((await knowledgeInContext(tenantA as never)).map((e) => e.question).sort()).toEqual([
      'draft v2',
      'live v2',
    ]);
    // A stale editor is refused rather than overwriting.
    await expectCode(
      k.updateArticle(tenantA, owner, live.id, {
        idempotencyKey: key('u'),
        expectedVersion: live.version,
        content: content('lost'),
      }),
      'support_knowledge.version_conflict',
    );
    // Revisions are append-only, in the database.
    const refused = await ctx.container.database.db
      .execute(sql`UPDATE support_knowledge_revisions SET title = 'x'`)
      .then(
        () => null,
        (error: unknown) => error as { cause?: { message?: string } },
      );
    expect(refused?.cause?.message).toMatch(/append-only/u);
  });

  it('a NEAR duplicate (trigram) merges too, without the exact-title backstop', async () => {
    await pendingCandidate();
    next = {
      ...next,
      output: { ...lesson, title: `${lesson.title} لطفا` },
    } as SupportAiOutcome;
    const other = await conversationWithReply(scopeA, BOT, support, '7000008', 'همان پاسخ.');
    await handBack(scopeA, support, other.conversationId);
    await loop.tick();
    const all = await ctx.container.supportKnowledge.listCandidates(tenantA, owner, {});
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ title: lesson.title, sourceCount: 2 });
  });

  it('the retention purges the text of candidates never approved, keeping the title', async () => {
    const { candidate } = await pendingCandidate();
    const now = ctx.container.clock.now();
    // Not yet due: nothing is purged.
    expect(await learning.purge(tenantA, now)).toBe(0);
    await ctx.container.database.db.execute(
      sql`UPDATE support_learning_candidates SET created_at = now() - interval '31 days'`,
    );
    expect(await learning.purge(tenantA, now)).toBe(1);
    const [purged] = await ctx.container.supportKnowledge.listCandidates(tenantA, owner, {});
    expect(purged).toMatchObject({
      id: candidate.id,
      title: lesson.title,
      body: null,
      rationale: null,
    });
    // A purged candidate cannot be approved as proposed: there is nothing to publish.
    await expectCode(
      ctx.container.supportKnowledge.approveCandidate(tenantA, owner, candidate.id, {
        idempotencyKey: key('approve'),
        expectedVersion: purged!.version,
        edit: null,
      }),
      'support_knowledge.not_in_state',
    );
  });

  it('a stopped tenant takes no review', async () => {
    const { candidate } = await pendingCandidate();
    await ctx.container.database.db.execute(
      sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}`,
    );
    await expectCode(
      ctx.container.supportKnowledge.approveCandidate(tenantA, owner, candidate.id, {
        idempotencyKey: key('approve'),
        expectedVersion: candidate.version,
        edit: null,
      }),
      'support_knowledge.scope_stopped',
    );
  });
});
