import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  SUPPORT_AI_AUTO_STALE_SECONDS,
  SUPPORT_AI_DEFAULT_CONFIG,
  SUPPORT_AI_DRAFT_UNCLAIMED_SECONDS,
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
import type { SupportImageLoad } from '../../apps/api/src/modules/control/support-ai/application/ports';
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
import { DrizzleSupportContextReader } from '../../apps/api/src/modules/commerce/support-context/infrastructure/drizzle-support-context.reader';
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
    return { outcome: 'DELIVERED' as const, messageId: this.nextMessageId, sentAt: null };
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
  /** D7: the transcript each provider call was given, as role and text. */
  let requests: { role: string; text: string }[][];
  /** D2: the query the context was built with, last call. */
  let contextQuery: string | null | undefined;
  let duringCall: (() => Promise<void>) | null;
  let flags: AutoContextFlags;
  /** The knowledge aliases (`K…`) the scripted context carries, as the real source builds them. */
  let knowledgeAliases: Map<string, string>;
  let offset: number;
  // TB6: what the image source returns, whether a configured step can see, and whether the
  // step that answered was actually given the images.
  let imageLoad: SupportImageLoad;
  let visionStep: boolean;
  let modelSees: boolean;
  let visionCalls: number[];
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
      photo: null,
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

  /** The whole AUTO job row, to prove a stopped scope left it untouched. */
  async function jobRow(conversationId: string) {
    const rows = await db().execute(
      sql`SELECT to_jsonb(j) AS row FROM support_ai_jobs j
          WHERE kind = 'AUTO_DECISION' AND conversation_id = ${conversationId}`,
    );
    return rows.rows.map((r) => (r as { row: unknown }).row);
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
    requests = [];
    duringCall = null;
    visionStep = true;
    modelSees = true;
    visionCalls = [];
    imageLoad = {
      outcome: 'LOADED',
      image: { mediaType: 'image/png', base64: 'iVBORw0KGgo=' },
      byteSize: 8,
    };
    offset = 0;
    knowledgeAliases = new Map([['K1', 'خطای اتصال در Sing-box']]);
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
        generate: async (_scope, input) => {
          calls += 1;
          requests.push(input.request.messages.map((m) => ({ role: m.role, text: m.text })));
          if (duringCall !== null) await duringCall();
          // The step is given every image of the variant, or (modelSees = false) none of them,
          // as TB6's `stepSight` reports it.
          const ids = (input.vision?.images ?? []).map(({ id }) => id);
          const seen = modelSees ? ids : [];
          const imagesSent = (input.vision?.render(new Set(seen)) ?? []).reduce(
            (sum, m) => sum + (m.images?.length ?? 0),
            0,
          );
          visionCalls.push(imagesSent);
          return {
            outcome: next,
            step: { provider: 'OPENAI', model: 'gpt-5.5' },
            attempts: 1,
            exhausted: null,
            imagesSent,
            sight: {
              seen,
              unseen: new Map(
                modelSees ? [] : ids.map((id) => [id, 'NO_VISION_CAPABILITY' as const]),
              ),
            },
          };
        },
        visionStepConfigured: () => visionStep,
      },
      images: {
        load: async () => imageLoad,
      },
      ids: c.ids,
      context: {
        build: async (_scope, _customer, options) => {
          contextQuery = options?.query;
          return {
            json: '{"services":[{"alias":"S1"}]}',
            aliases: new Map([['S1', 'سرویس user123']]),
            knowledgeAliases,
            linked: flags.identityLinked,
            flags,
            knowledge: { sent: 3, available: 4 },
          };
        },
      },
      conversations,
      messages: new DrizzleBusinessMessageRepository(c.database.db),
      outbound,
      facts: new DrizzleSupportContextReader(c.database.db),
      control: c.businessConversations,
      uow: c.uow,
      scopeActivity: c.tenants,
      clock: c.clock,
    });
    // TB5's loop claims through the service (one job at a time, under the scope check); the
    // container's own Assist service claims here, and no ASSIST draft is produced by it.
    loop = new AssistantLoop(c.supportAssist, {
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
    // D2: the knowledge is chosen by the customer's own words.
    expect(contextQuery).toBe('سلام، اینترنتم وصل نمی‌شود');
    // D2 telemetry, recorded with the job's result.
    const telemetry = await db().execute(
      sql`SELECT knowledge_sent, knowledge_available FROM support_ai_jobs
          WHERE conversation_id = ${first.conversationId}`,
    );
    expect(telemetry.rows).toEqual([{ knowledge_sent: 3, knowledge_available: 4 }]);
    expect(await count('business_conversation_escalations')).toBe(0);
  });

  it('D9: «وصل نمیشه، پولمو پس بدید» never auto-replies, whatever topic the model picks', async () => {
    // The model would label it a safe, confident, grounded connection answer.
    const first = await record(message({ text: 'وصل نمیشه، پولمو پس بدید' }));
    await tick();
    await deliver();
    expect(calls).toBe(0); // decided before any provider is asked
    expect(await autoJobs(first.conversationId)).toMatchObject([
      { state: 'FAILED', outcome: 'guard_handoff_topic', handoff_reason: 'HANDOFF_TOPIC' },
    ]);
    expect(await conversation(first.conversationId)).toMatchObject({
      state: 'HANDOFF_REQUIRED',
      handoffReason: 'HANDOFF_TOPIC',
    });
    expect(await autoRows(first.conversationId)).toEqual([]);
    expect(transport.sent).toEqual([]);
    expect(await count('tickets')).toBe(1); // the refund path: escalation and ticket
  });

  it('D9: an earlier refund line still counts when a newer message is the trigger', async () => {
    await record(message({ text: 'پول‌مو پس بدین' }));
    const second = await record(message({ text: 'سرویسم هم وصل نمیشه' }));
    await tick();
    expect(calls).toBe(0);
    expect((await autoJobs(second.conversationId)).at(-1)).toMatchObject({
      state: 'FAILED',
      outcome: 'guard_handoff_topic',
    });
    expect(await autoRows(second.conversationId)).toEqual([]);
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
    // TB5's loop claims ONE job at a time, so the same pass goes on to claim the replacement
    // (already due at the shifted clock) and answers it. The replaced job wrote nothing: there
    // is exactly one AUTO row, the replacement's.
    const [replaced, replacement] = await autoJobs(first.conversationId);
    expect(replaced).toMatchObject({ state: 'DISCARDED', outcome: 'dropped_coalesced' });
    expect(replacement).toMatchObject({ state: 'SENT', outcome: 'sent' });
    expect(await autoRows(first.conversationId)).toHaveLength(1);
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

  // --- D7: the model reads its own delivered replies ------------------------------------

  it('D7: with NO echo from Telegram, the next call still reads the reply it sent', async () => {
    const first = await record(message({ text: 'سلام، سرویسم وصل نمیشه' }));
    await tick();
    await deliver();
    expect(transport.sent).toHaveLength(1);
    // Telegram does not echo the bot's own send: nothing is recorded for it.
    await record(message({ text: 'باز کردم، هنوز وصل نمیشه' }));
    await tick();
    expect(calls).toBe(2);
    expect(requests[1]).toEqual([
      { role: 'user', text: 'سلام، سرویسم وصل نمیشه' },
      { role: 'assistant', text: grounded.replyText },
      { role: 'user', text: 'باز کردم، هنوز وصل نمیشه' },
    ]);
    expect((await autoJobs(first.conversationId))[1]).toMatchObject({ outcome: 'sent' });
  });

  it('D7: WITH the echo, the reply is read once, not twice', async () => {
    const first = await record(message({ text: 'سلام، سرویسم وصل نمیشه' }));
    await tick();
    await deliver();
    const [row] = await autoRows(first.conversationId);
    const sentId = (
      await db().execute(
        sql`SELECT telegram_message_id FROM business_outbound_messages WHERE id = ${row!.id}`,
      )
    ).rows[0] as { telegram_message_id: number };
    // Telegram echoes the bot's own send back; it is recorded as ours.
    await record(
      message({
        messageId: Number(sentId.telegram_message_id),
        fromUserId: OWNER,
        senderBusinessBotId: OUR_BOT,
        text: grounded.replyText,
      }),
    );
    await record(message({ text: 'باز کردم، هنوز وصل نمیشه' }));
    await tick();
    expect(calls).toBe(2);
    expect(requests[1]).toEqual([
      { role: 'user', text: 'سلام، سرویسم وصل نمیشه' },
      { role: 'assistant', text: grounded.replyText },
      { role: 'user', text: 'باز کردم، هنوز وصل نمیشه' },
    ]);
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
        // Hotfix 2026-10-06: a clarifying question is sent now; NO_ACTION still never is.
        name: 'no action',
        output: { decision: 'NO_ACTION', replyText: '' },
        expected: { outcome: 'guard_decision', reason: 'DECISION_NOT_REPLY' },
      },
      {
        name: 'a knowledge citation the payload did not carry',
        output: { knowledgeRefs: ['K9'] },
        expected: { outcome: 'guard_grounding', reason: 'INSUFFICIENT_GROUNDING' },
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

  // --- Program §A3 / §12: the handoff stays coarse for the customer; the class says why -----

  const failureClassOf = async (conversationId: string) =>
    (
      (
        await db().execute(
          sql`SELECT failure_class FROM support_ai_jobs
              WHERE kind = 'AUTO_DECISION' AND conversation_id = ${conversationId}`,
        )
      ).rows[0] as { failure_class: string | null }
    ).failure_class;

  it('a provider rejection hands off as AI_OUTPUT_INVALID, recording the class for the operator', async () => {
    next = {
      outcome: 'INVALID_OUTPUT',
      code: 'openai.http_400',
      detail: {
        failureClass: 'unsupported_capability',
        httpStatus: 400,
        providerErrorCode: null,
        providerErrorType: 'invalid_request_error',
        providerErrorParam: 'response_format',
      },
    };
    const first = await record(message());
    await tick();
    expect(await autoJobs(first.conversationId)).toMatchObject([
      { outcome: 'handoff_output_invalid', handoff_reason: 'AI_OUTPUT_INVALID' },
    ]);
    expect(await failureClassOf(first.conversationId)).toBe('unsupported_capability');
    // The customer is told nothing different: no automatic row at all.
    expect(await autoRows(first.conversationId)).toEqual([]);
    // The conversation screen's handoff carries the diagnosis.
    const detail = await ctx.container.businessConversations.detail(
      scopeA,
      owner,
      first.conversationId,
    );
    const jobIds = detail.escalations.flatMap((e) => (e.jobId === null ? [] : [e.jobId]));
    const diagnostics = await ctx.container.supportAssist.failureDiagnostics(scopeA, jobIds);
    expect([...diagnostics.values()]).toMatchObject([{ failureClass: 'unsupported_capability' }]);
  });

  it('an answer that fails the decision schema hands off with schema_invalid', async () => {
    next = {
      outcome: 'OK',
      output: { ...grounded, factRefs: ['the customer’s service'] },
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'gpt-5.5',
    };
    const first = await record(message());
    await tick();
    expect(await autoJobs(first.conversationId)).toMatchObject([
      { outcome: 'handoff_output_invalid', handoff_reason: 'AI_OUTPUT_INVALID' },
    ]);
    expect(await failureClassOf(first.conversationId)).toBe('schema_invalid');
  });

  it('an unavailable chain hands off as AI_UNAVAILABLE with its own class', async () => {
    next = { outcome: 'TIMEOUT' };
    const first = await record(message());
    await tick();
    expect(await autoJobs(first.conversationId)).toMatchObject([
      { outcome: 'handoff_ai_unavailable', handoff_reason: 'AI_UNAVAILABLE' },
    ]);
    expect(await failureClassOf(first.conversationId)).toBe('timeout');
  });

  // ADR-0034 §1 (lead decision on this branch): an automatic reply is held to the decision
  // schema EXACTLY. Assist tolerates an over-long note or a non-alias citation; this does not.
  it.each([
    ['an over-long intent', { intent: 'ا'.repeat(121) }],
    ['a non-alias knowledge citation', { knowledgeRefs: ['FAQ'] }],
  ] as const)('%s hands off as AI_OUTPUT_INVALID, never sent', async (_what, change) => {
    next = {
      outcome: 'OK',
      output: { ...grounded, ...change },
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'gpt-5.5',
    };
    const first = await record(message());
    await tick();
    expect(await autoJobs(first.conversationId)).toMatchObject([
      { outcome: 'handoff_output_invalid', handoff_reason: 'AI_OUTPUT_INVALID' },
    ]);
    expect(await autoRows(first.conversationId)).toEqual([]);
    expect(await failureClassOf(first.conversationId)).toBe('schema_invalid');
  });

  it('a correct reply citing a knowledge alias is sent', async () => {
    next = {
      outcome: 'OK',
      output: { ...grounded, knowledgeRefs: ['K1'] },
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'gpt-5.5',
    };
    const first = await record(message());
    await tick();
    expect(await autoJobs(first.conversationId)).toMatchObject([
      { state: 'SENT', outcome: 'sent' },
    ]);
    expect(await failureClassOf(first.conversationId)).toBeNull();
  });

  // Agent audit D6: a connection without the reply right never gets a transcript sent to a
  // provider, nor a provider paid, for a reply it could not send.
  it('a connection without can_reply: no provider call, no AUTO row', async () => {
    const first = await record(message());
    await ctx.container.businessConnections.applyReport(scopeA, system(), {
      idempotencyKey: key('conn-read-only'),
      botInstanceId: BOT,
      report: {
        connectionId: 'conn-1',
        ownerTelegramUserId: OWNER,
        ownerUserChatId: OWNER,
        isEnabled: true,
        rights: [] as BusinessBotRight[],
        connectedAt: new Date('2026-10-01T00:00:00Z'),
      },
    });
    await tick();
    expect(calls).toBe(0);
    expect(await autoJobs(first.conversationId)).toMatchObject([
      { state: 'DISCARDED', outcome: 'dropped_connection' },
    ]);
    expect(await autoRows(first.conversationId)).toEqual([]);
  });

  // --- TB6 × TB7: an image the reply would be about must be SEEN ---------------------------

  const photo = () => message({ kind: 'PHOTO', text: null });
  const imageOutcomes = async () =>
    (
      await db().execute(
        sql`SELECT outcome, reason FROM support_ai_image_outcomes ORDER BY created_at, id`,
      )
    ).rows;

  it('a photo the model can see may be answered automatically, and is recorded PROCESSED', async () => {
    await configure({ visionEnabled: true });
    const first = await record(photo());
    await tick();
    expect(visionCalls).toEqual([1]);
    expect(await autoJobs(first.conversationId)).toMatchObject([{ outcome: 'sent' }]);
    expect(await imageOutcomes()).toEqual([{ outcome: 'PROCESSED', reason: null }]);
  });

  it('a photo with vision off is never answered: no provider call, a handoff', async () => {
    const first = await record(photo());
    await tick();
    expect(calls).toBe(0);
    expect(await autoJobs(first.conversationId)).toMatchObject([
      { state: 'FAILED', outcome: 'guard_content', handoff_reason: 'UNSUPPORTED_CONTENT' },
    ]);
    expect(await imageOutcomes()).toEqual([{ outcome: 'SKIPPED', reason: 'VISION_DISABLED' }]);
    expect(await autoRows(first.conversationId)).toEqual([]);
  });

  it('a photo that cannot be fetched or read hands off before any provider call', async () => {
    await configure({ visionEnabled: true });
    for (const reason of ['DOWNLOAD_FAILED', 'UNSUPPORTED_TYPE', 'TOO_LARGE'] as const) {
      imageLoad = { outcome: 'SKIPPED', reason };
      const recorded = await record(photo());
      await tick();
      expect((await autoJobs(recorded.conversationId)).at(-1), reason).toMatchObject({
        state: 'FAILED',
        outcome: 'guard_content',
        handoff_reason: 'UNSUPPORTED_CONTENT',
      });
      await resume(recorded.conversationId);
    }
    expect(calls).toBe(0);
  });

  it('a photo the answering step was not given hands off, even with a valid REPLY', async () => {
    await configure({ visionEnabled: true });
    modelSees = false;
    const first = await record(photo());
    await tick();
    expect(calls).toBe(1);
    expect(await autoJobs(first.conversationId)).toMatchObject([
      { state: 'FAILED', outcome: 'guard_content', handoff_reason: 'UNSUPPORTED_CONTENT' },
    ]);
    expect(await autoRows(first.conversationId)).toEqual([]);
  });

  it('an AUTO job replaced during its provider call records no image outcome (TB6 review, S1)', async () => {
    await configure({ visionEnabled: true });
    const first = await record(photo());
    duringCall = async () => {
      duringCall = null;
      await record(message({ text: 'اینترنتم وصل نمی‌شود' }));
    };
    await tick();
    const [replaced, replacement] = await autoJobs(first.conversationId);
    expect(replaced).toMatchObject({ state: 'DISCARDED', outcome: 'dropped_coalesced' });
    expect(replacement).toMatchObject({ state: 'SENT' });
    // Its own transition never happened, so its telemetry was never written; only the
    // replacement, which answered with the same photo in view, recorded a row.
    const rows = await db().execute(
      sql`SELECT job_id, outcome FROM support_ai_image_outcomes ORDER BY created_at, id`,
    );
    expect(rows.rows).toEqual([{ job_id: replacement!.id, outcome: 'PROCESSED' }]);
  });

  // --- the handoff: one ticket, linked on repeat, and a signal -----------------------------

  it('a handoff opens exactly one ticket, links it on the next handoff, and signals an operator', async () => {
    next = {
      outcome: 'OK',
      output: { ...grounded, topic: 'REFUND', summary: 'مشتری بازپرداخت می‌خواهد.' },
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'm',
    };
    // Not money in the customer's words (D9 would hand off before the model and leave no AI
    // note): the MODEL's topic is what hands this one off.
    const first = await record(message({ text: 'سرویسم رو نمی‌خوام، لغوش کنید' }));
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
  describe('TB7 on the reviewed TB5: the AUTO kind with claimNext, the lease and the unclaimed rule', () => {
    const BOTH = ['ASSIST_DRAFT', 'AUTO_DECISION'] as const;

    it('a claimer without the AUTO producer never claims an AUTO job, and its due_at holds', async () => {
      const first = await record(message());
      const due = new Date(Date.now() + DUE);
      const lease = new Date(due.getTime() + 60_000);
      const assist = ctx.container.supportAssist;
      // The default kinds are ASSIST only: an AUTO job is invisible to a loop with no producer.
      expect(await assist.claimNext(scopeA, due, lease)).toBeNull();
      // Not before its settle delay, whatever the kinds.
      expect(await assist.claimNext(scopeA, new Date(), lease, BOTH)).toBeNull();
      const claimed = await assist.claimNext(scopeA, due, lease, BOTH);
      expect(claimed).toMatchObject({
        kind: 'AUTO_DECISION',
        conversationId: first.conversationId,
        attempts: 1,
        requestHash: null, // an AUTO job is keyed on its message, not on an operator's request
      });
      // One job at a time, under its lease: a second claim finds nothing.
      expect(await assist.claimNext(scopeA, due, lease, BOTH)).toBeNull();
    });

    it("a stopped tenant's AUTO job is not claimed", async () => {
      await record(message());
      await db().execute(sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${SEED_IDS.tenantA}`);
      const due = new Date(Date.now() + DUE);
      expect(
        await ctx.container.supportAssist.claimNext(scopeA, due, new Date(due.getTime() + 1), BOTH),
      ).toBeNull();
      await db().execute(sql`UPDATE tenants SET status = 'ACTIVE' WHERE id = ${SEED_IDS.tenantA}`);
    });

    it('the unclaimed rule fails a waiting ASSIST draft and never an AUTO job', async () => {
      const first = await record(message());
      const draft = await ctx.container.supportAssist.request(scopeA, owner, {
        conversationId: first.conversationId,
        idempotencyKey: key('draft'),
      });
      // Long past the bound, neither job ever claimed: only the draft is an operator's wait.
      const later = new Date(Date.now() + 10 * SUPPORT_AI_DRAFT_UNCLAIMED_SECONDS * 1000);
      const failed = await ctx.container.uow.run(scopeA, (tx) =>
        jobs.failUnclaimed(scopeA, null, later, later, tx),
      );
      expect(failed).toBe(1);
      expect(await jobs.findById(scopeA, draft.id)).toMatchObject({
        state: 'FAILED',
        failureCode: 'job.unclaimed',
      });
      expect(await autoJobs(first.conversationId)).toMatchObject([{ state: 'QUEUED' }]);
      // The operator's listing applies the rule too, and still leaves the AUTO job alone.
      await ctx.container.supportAssist.drafts(scopeA, owner, first.conversationId);
      expect(await autoJobs(first.conversationId)).toMatchObject([{ state: 'QUEUED' }]);
      // Its own producer answers it.
      await tick();
      expect(await autoJobs(first.conversationId)).toMatchObject([
        { state: 'SENT', outcome: 'sent' },
      ]);
    });

    it('an AUTO job claimed while the tenant is active and produced after a stop asks no provider', async () => {
      const first = await record(message());
      const due = new Date(Date.now() + DUE);
      const claimed = await ctx.container.supportAssist.claimNext(
        scopeA,
        due,
        new Date(due.getTime() + 60_000),
        BOTH,
      );
      expect(claimed).not.toBeNull();
      const before = await jobRow(first.conversationId);
      await db().execute(sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${SEED_IDS.tenantA}`);
      try {
        // A stopped scope takes no writes, ours included: the job is left exactly as it was.
        expect(await auto.produce(scopeA, claimed!)).toBe('INACTIVE');
        expect(calls).toBe(0);
        expect(await autoRows(first.conversationId)).toEqual([]);
        expect(await jobRow(first.conversationId)).toEqual(before);
      } finally {
        await db().execute(
          sql`UPDATE tenants SET status = 'ACTIVE' WHERE id = ${SEED_IDS.tenantA}`,
        );
      }
    });
  });

  // ===========================================================================================
  // Substitute review of PR #202 (docs/support-agent/tb7-falsification.md)
  // ===========================================================================================
  describe('substitute review of PR #202', () => {
    const stop = () =>
      db().execute(sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${SEED_IDS.tenantA}`);
    const start = () =>
      db().execute(sql`UPDATE tenants SET status = 'ACTIVE' WHERE id = ${SEED_IDS.tenantA}`);
    const customerId = async () =>
      (
        (await db().execute(sql`SELECT id FROM customers WHERE telegram_user_id = ${CUSTOMER}`))
          .rows[0] as { id: string }
      ).id;
    const recordEdit = (m: ParsedBusinessMessage, text: string) =>
      ctx.container.businessConversations.recordMessage(scopeA, system(), {
        idempotencyKey: key('edit'),
        botInstanceId: BOT,
        message: { ...m, text, editedAt: new Date() },
        edited: true,
      });
    const recordDeletion = (messageIds: number[]) =>
      ctx.container.businessConversations.recordDeletion(scopeA, system(), {
        idempotencyKey: key('delete'),
        botInstanceId: BOT,
        deletion: { connectionId: 'conn-1', chatId: CUSTOMER, messageIds },
      });
    const takeOver = (conversationId: string) =>
      ctx.container.businessConversations.takeOver(scopeA, operator, {
        conversationId,
        idempotencyKey: key('take'),
      });
    const decide = (output: Record<string, unknown>) => {
      next = {
        outcome: 'OK',
        output: { ...grounded, ...output },
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'm',
      };
    };
    const escalationRows = async () =>
      (
        await db().execute(
          sql`SELECT reason, ticket_outcome, summary, text_purged_at FROM business_conversation_escalations
              ORDER BY created_at`,
        )
      ).rows as {
        reason: string;
        ticket_outcome: string;
        summary: string | null;
        text_purged_at: Date | null;
      }[];

    // --- finding 1: the guards decide again, in the enqueue transaction -------------------

    it('finding 1: a topic removed from the allowlist during the provider call hands off, no AUTO row', async () => {
      const first = await record(message());
      duringCall = async () => {
        await configure({ autoTopics: ['GREETING'] });
      };
      await tick();
      expect(calls).toBe(1);
      expect(await autoJobs(first.conversationId)).toMatchObject([
        { state: 'FAILED', outcome: 'guard_topic_allowlist', handoff_reason: 'TOPIC_NOT_ALLOWED' },
      ]);
      expect(await autoRows(first.conversationId)).toEqual([]);
      expect(await conversation(first.conversationId)).toMatchObject({
        state: 'HANDOFF_REQUIRED',
        handoffReason: 'TOPIC_NOT_ALLOWED',
      });
    });

    it('finding 1: a customer blocked during the provider call is handed off, never answered', async () => {
      const first = await record(message());
      duringCall = async () => {
        await db().execute(
          sql`UPDATE customers SET status = 'BLOCKED', blocked_at = now() WHERE telegram_user_id = ${CUSTOMER}`,
        );
      };
      await tick();
      expect(await autoJobs(first.conversationId)).toMatchObject([
        { state: 'FAILED', outcome: 'guard_customer_blocked', handoff_reason: 'CUSTOMER_BLOCKED' },
      ]);
      expect(await autoRows(first.conversationId)).toEqual([]);
      expect((await conversation(first.conversationId)).state).toBe('HANDOFF_REQUIRED');
    });

    it('finding 1: a payment put under review during the provider call hands off, no AUTO row', async () => {
      const first = await record(message());
      const customer = await customerId();
      duringCall = async () => {
        // The Payment Operations Center's UNKNOWN queue: «under review» (TB3).
        await db().execute(sql`
          INSERT INTO payments (id, tenant_id, customer_id, order_id, state, method, amount, currency,
                                reference, external_reference, gateway_provider, created_at)
          VALUES (${ctx.container.ids.uuid()}, ${SEED_IDS.tenantA}, ${customer}, NULL, 'UNKNOWN',
                  'GATEWAY', 250000, 'IRT', ${key('pay-ref')}, 'ext-1', 'TONPAYS', now())`);
      };
      await tick();
      expect(await autoJobs(first.conversationId)).toMatchObject([
        {
          state: 'FAILED',
          outcome: 'guard_account_review',
          handoff_reason: 'ACCOUNT_UNDER_REVIEW',
        },
      ]);
      expect(await autoRows(first.conversationId)).toEqual([]);
      expect((await conversation(first.conversationId)).state).toBe('HANDOFF_REQUIRED');
    });

    it('nit: a trigger deleted before the job runs, or during its provider call, is never answered', async () => {
      const first = await record(message());
      await recordDeletion([messageSeq]);
      await tick();
      expect(calls).toBe(0);
      expect(await autoJobs(first.conversationId)).toMatchObject([
        { state: 'FAILED', outcome: 'guard_content', handoff_reason: 'UNSUPPORTED_CONTENT' },
      ]);
      await resume(first.conversationId);

      // Deleted after the preflight passed: the enqueue transaction reads it again (fail closed).
      const second = await record(message({ text: 'باز هم سلام' }));
      const id = messageSeq;
      duringCall = async () => {
        await recordDeletion([id]);
      };
      await tick();
      expect(calls).toBe(1);
      expect((await autoJobs(second.conversationId)).at(-1)).toMatchObject({
        state: 'FAILED',
        outcome: 'guard_content',
        handoff_reason: 'UNSUPPORTED_CONTENT',
      });
      expect(await autoRows(second.conversationId)).toEqual([]);
    });

    // --- finding 2: a stopped scope takes no writes; a resumed one gets no stale reply ------

    it('finding 2: a stop during the provider call writes nothing; after resume the stale job hands off', async () => {
      const first = await record(message());
      const convoBefore = await conversation(first.conversationId);
      let claimed: unknown[] = [];
      duringCall = async () => {
        claimed = await jobRow(first.conversationId);
        await stop();
      };
      try {
        await tick();
        expect(calls).toBe(1);
        // Untouched: the job exactly as the claim left it, no lane row, no handoff, no ticket.
        expect(await jobRow(first.conversationId)).toEqual(claimed);
        expect(await autoJobs(first.conversationId)).toMatchObject([
          { state: 'QUEUED', outcome: null },
        ]);
        expect(await autoRows(first.conversationId)).toEqual([]);
        expect(await escalationRows()).toEqual([]);
        expect(await conversation(first.conversationId)).toMatchObject({
          state: 'AI_ACTIVE',
          controlEpoch: convoBefore.controlEpoch,
        });
      } finally {
        await start();
      }
      // Resumed after more than SUPPORT_AI_AUTO_STALE_SECONDS: the job is claimed again, and a
      // person answers rather than a reply about a conversation that moved on.
      await db().execute(
        sql`UPDATE support_ai_jobs
               SET due_at = now() - make_interval(secs => ${SUPPORT_AI_AUTO_STALE_SECONDS + 60}),
                   claimed_until = now() - interval '1 second'
             WHERE conversation_id = ${first.conversationId}`,
      );
      await tick(0);
      expect(calls).toBe(1); // no provider was asked again
      expect(await autoJobs(first.conversationId)).toMatchObject([
        { state: 'FAILED', outcome: 'handoff_stale', handoff_reason: 'REPLY_STALE' },
      ]);
      expect(await autoRows(first.conversationId)).toEqual([]);
      expect(await conversation(first.conversationId)).toMatchObject({
        state: 'HANDOFF_REQUIRED',
        handoffReason: 'REPLY_STALE',
      });
      await deliver();
      expect(transport.sent).toEqual([]);
    });

    it('finding 2: a job within the bound is answered (the staleness rule is a bound, not a block)', async () => {
      const first = await record(message());
      await db().execute(
        sql`UPDATE support_ai_jobs
               SET due_at = now() - make_interval(secs => ${SUPPORT_AI_AUTO_STALE_SECONDS - 60})
             WHERE conversation_id = ${first.conversationId}`,
      );
      await tick(0);
      expect(await autoJobs(first.conversationId)).toMatchObject([{ outcome: 'sent' }]);
    });

    it('finding 2: an AUTO lane row left unsent past the bound is never sent; a person answers', async () => {
      const first = await record(message());
      await tick();
      await stop();
      try {
        await deliver(); // a stopped tenant's lane does nothing
      } finally {
        await start();
      }
      await db().execute(
        sql`UPDATE business_outbound_messages
               SET created_at = now() - make_interval(secs => ${SUPPORT_AI_AUTO_STALE_SECONDS + 60})
             WHERE conversation_id = ${first.conversationId} AND origin = 'AUTO'`,
      );
      await deliver();
      expect(transport.sent).toEqual([]);
      expect(await autoRows(first.conversationId)).toMatchObject([
        { state: 'SUPERSEDED', failure_code: 'support_ai.reply_stale' },
      ]);
      expect(await conversation(first.conversationId)).toMatchObject({
        state: 'HANDOFF_REQUIRED',
        handoffReason: 'REPLY_STALE',
      });
    });

    // --- finding 3: a handoff never throws for a business reason, and never stalls the lane --

    it('finding 3: a bad category override on an unseeded tenant: UNCONFIRMED, a handoff with no ticket, and the lane goes on', async () => {
      await db().execute(sql`
        INSERT INTO template_overrides (id, tenant_id, template_key, locale, body, revision, updated_by_admin_id)
        VALUES (${ctx.container.ids.uuid()}, ${SEED_IDS.tenantA}, 'bot.ticket.category_default_3', 'fa',
                ${'دو\nخط'}, 1, ${owner.id})`);
      const first = await record(message());
      await tick();
      transport.next.push({ outcome: 'UNKNOWN', errorCode: 'telegram.unreachable' });
      await deliver();
      expect(await autoRows(first.conversationId)).toMatchObject([{ state: 'UNCONFIRMED' }]);
      expect(await conversation(first.conversationId)).toMatchObject({
        state: 'HANDOFF_REQUIRED',
        handoffReason: 'SEND_OUTCOME_UNKNOWN',
        ticketId: null,
      });
      expect(await escalationRows()).toMatchObject([
        { reason: 'SEND_OUTCOME_UNKNOWN', ticket_outcome: 'NO_CATEGORY' },
      ]);
      const signal = await db().execute(
        sql`SELECT context->>'ticketOutcome' AS outcome FROM operational_events WHERE code = 'support.handoff_required'`,
      );
      expect(signal.rows).toEqual([{ outcome: 'NO_CATEGORY' }]);
      // The refused seed wrote nothing: no half-made categories, and no "seeded" mark that would
      // stop the tenant ever being seeded once the override is fixed.
      expect(await count('ticket_categories')).toBe(0);
      expect(await count('ticket_category_seeds')).toBe(0);

      // The next operator send still goes out.
      await ctx.container.businessConversations.send(scopeA, operator, {
        conversationId: first.conversationId,
        idempotencyKey: key('op'),
        text: 'سلام، من پشتیبان هستم',
      });
      await deliver();
      expect(transport.sent.map((m) => m.text)).toEqual([
        grounded.replyText,
        'سلام، من پشتیبان هستم',
      ]);
    });

    describe('finding 3: one conversation whose handoff fails does not stall the lane', () => {
      const chat = (n: string) => message({ chatId: n, fromUserId: n });

      /** A lane whose handoff throws for one conversation (an infrastructure failure). */
      function laneFailingFor(bad: () => string) {
        const c = ctx.container;
        return new BusinessOutboundService({
          outbound,
          conversations,
          messages: new DrizzleBusinessMessageRepository(c.database.db),
          control: {
            handOff: async (...args: Parameters<typeof c.businessConversations.handOff>) => {
              if (args[1] === bad()) throw new Error('handoff failed');
              return c.businessConversations.handOff(...args);
            },
          },
          transport,
          autoMode: new SupportAutoEnqueuer({
            configs: new DrizzleSupportAiConfigRepository(c.database.db),
            jobs,
            ids: c.ids,
          }),
          escalations: new DrizzleBusinessEscalationRepository(c.database.db),
          uow: c.uow,
          scopeActivity: c.tenants,
          clock: c.clock,
          ids: c.ids,
          logger: c.logger,
        });
      }

      it('at the send: the failing row is rolled back alone, and the next row is delivered', async () => {
        const a = await record(message());
        await tick();
        const b = await record(chat('7000002'));
        await ctx.container.businessConversations.send(scopeA, operator, {
          conversationId: b.conversationId,
          idempotencyKey: key('op'),
          text: 'پاسخ اپراتور',
        });
        transport.next.push({ outcome: 'UNKNOWN', errorCode: 'telegram.unreachable' });
        await laneFailingFor(() => a.conversationId).deliverDue(scopeA);
        expect(transport.sent.map((m) => m.text)).toEqual([grounded.replyText, 'پاسخ اپراتور']);
        // Its outcome transaction rolled back: still stamped, for the reaper to resolve.
        const [row] = await autoRows(a.conversationId);
        expect(row).toMatchObject({ state: 'PENDING' });
        expect((await conversation(a.conversationId)).state).toBe('AI_ACTIVE');
      });

      it('at the reaper: each stranded row in its own transaction, and the pass still delivers', async () => {
        const a = await record(message());
        const b = await record(chat('7000002'));
        await tick();
        expect(await autoRows(a.conversationId)).toHaveLength(1);
        expect(await autoRows(b.conversationId)).toHaveLength(1);
        // Both stamped long ago and never recorded: stranded.
        await db().execute(
          sql`UPDATE business_outbound_messages SET send_started_at = now() - interval '6 minutes'
               WHERE origin = 'AUTO'`,
        );
        const c = await record(chat('7000003'));
        await ctx.container.businessConversations.send(scopeA, operator, {
          conversationId: c.conversationId,
          idempotencyKey: key('op'),
          text: 'پاسخ اپراتور',
        });
        const report = await laneFailingFor(() => a.conversationId).deliverDue(scopeA);
        expect(report.stranded).toBe(1);
        expect(await autoRows(a.conversationId)).toMatchObject([{ state: 'PENDING' }]);
        expect(await autoRows(b.conversationId)).toMatchObject([{ state: 'UNCONFIRMED' }]);
        expect(await conversation(b.conversationId)).toMatchObject({
          state: 'HANDOFF_REQUIRED',
          handoffReason: 'SEND_OUTCOME_UNKNOWN',
        });
        expect(transport.sent.map((m) => m.text)).toEqual(['پاسخ اپراتور']);
      });
    });

    // --- finding 4: rules that had no killing test -----------------------------------------

    it('R7: a person taking over a handed-off conversation recovers support.handoff_required', async () => {
      decide({ topic: 'REFUND' });
      const first = await record(message());
      await tick();
      expect((await conversation(first.conversationId)).state).toBe('HANDOFF_REQUIRED');
      await takeOver(first.conversationId);
      const events = await db().execute(
        sql`SELECT code, resolved_at FROM operational_events
             WHERE code IN ('support.handoff_required', 'support.handoff_resolved') ORDER BY code`,
      );
      expect(events.rows).toHaveLength(2);
      expect((events.rows[0] as { resolved_at: Date | null }).resolved_at).not.toBeNull();
    });

    it("R6: two concurrent handoffs of one customer's two conversations open one ticket", async () => {
      await ctx.container.businessConnections.applyReport(scopeA, system(), {
        idempotencyKey: key('conn-2'),
        botInstanceId: BOT,
        report: {
          connectionId: 'conn-2',
          ownerTelegramUserId: '5000009',
          ownerUserChatId: '5000009',
          isEnabled: true,
          rights: ['can_reply'] as BusinessBotRight[],
          connectedAt: new Date('2026-10-01T00:00:00Z'),
        },
      });
      const one = await record(message());
      const two = await record(message({ connectionId: 'conn-2' }));
      expect(two.conversationId).not.toBe(one.conversationId);
      await ctx.container.ticketCategories.ensureSeeded(tenantA as never);
      // Both handoffs reach "is there an active ticket?" before either commits, unless the
      // customer's lock serialises them (the second then waits, and finds the first's ticket).
      type Repo = { latestActiveForCustomer: (...args: unknown[]) => Promise<unknown> };
      const repo = (ctx.container.tickets as unknown as { deps: { tickets: Repo } }).deps.tickets;
      const original = repo.latestActiveForCustomer;
      let arrived = 0;
      let release: () => void = () => {};
      const together = new Promise<void>((resolve) => (release = resolve));
      repo.latestActiveForCustomer = async (...args: unknown[]) => {
        arrived += 1;
        if (arrived >= 2) release();
        await Promise.race([together, new Promise((resolve) => setTimeout(resolve, 400))]);
        return original.apply(repo, args);
      };
      try {
        const handOff = (conversationId: string) =>
          ctx.container.uow.run(scopeA, (tx) =>
            ctx.container.businessConversations.handOff(
              scopeA,
              conversationId,
              'AI_REQUESTED',
              new Date(),
              tx,
            ),
          );
        await Promise.all([handOff(one.conversationId), handOff(two.conversationId)]);
      } finally {
        repo.latestActiveForCustomer = original;
      }
      expect(await count('tickets')).toBe(1);
      expect((await escalationRows()).map((e) => e.ticket_outcome).sort()).toEqual([
        'CREATED',
        'LINKED',
      ]);
    });

    it('R5: a connection that stopped being usable during the provider call: no AUTO row', async () => {
      const first = await record(message());
      duringCall = async () => {
        await ctx.container.businessConnections.applyReport(scopeA, system(), {
          idempotencyKey: key('conn-off'),
          botInstanceId: BOT,
          report: {
            connectionId: 'conn-1',
            ownerTelegramUserId: OWNER,
            ownerUserChatId: OWNER,
            isEnabled: false,
            rights: ['can_reply'] as BusinessBotRight[],
            connectedAt: new Date('2026-10-01T00:00:00Z'),
          },
        });
      };
      await tick();
      expect(await autoJobs(first.conversationId)).toMatchObject([
        { state: 'DISCARDED', outcome: 'dropped_connection' },
      ]);
      expect(await autoRows(first.conversationId)).toEqual([]);
    });

    it('R12: a takeover and resume during the provider call: the stale job never hands off the resumed conversation', async () => {
      decide({ topic: 'REFUND' });
      const first = await record(message());
      duringCall = async () => {
        await takeOver(first.conversationId);
        await resume(first.conversationId);
      };
      await tick();
      expect(await autoJobs(first.conversationId)).toMatchObject([
        { state: 'DISCARDED', outcome: 'dropped_epoch' },
      ]);
      expect((await conversation(first.conversationId)).state).toBe('AI_ACTIVE');
      expect(await escalationRows()).toEqual([]);
    });

    it('R4: an edit of an answered message starts nothing; an edit of the pending trigger re-enqueues', async () => {
      const m1 = message();
      const first = await record(m1);
      await tick();
      expect(await autoJobs(first.conversationId)).toMatchObject([{ outcome: 'sent' }]);
      await recordEdit(m1, 'ویرایش شد');
      expect(await autoJobs(first.conversationId)).toHaveLength(1);

      const m2 = message({ text: 'سؤال دوم' });
      await record(m2);
      await recordEdit(m2, 'سؤال دوم، ویرایش شده');
      expect(await autoJobs(first.conversationId)).toMatchObject([
        { state: 'SENT' },
        { state: 'DISCARDED', outcome: 'dropped_coalesced' },
        { state: 'QUEUED' },
      ]);
    });

    it('nit: an edit of an OLDER message while a job is pending leaves the job on its own trigger', async () => {
      const m1 = message();
      const first = await record(m1);
      await tick();
      const m2 = message({ text: 'سؤال دوم' });
      await record(m2);
      const [, pending] = await autoJobs(first.conversationId);
      await recordEdit(m1, 'پیام قدیمی، ویرایش شده');
      const after = await db().execute(
        sql`SELECT id, state, trigger_telegram_message_id AS trigger FROM support_ai_jobs
             WHERE kind = 'AUTO_DECISION' AND conversation_id = ${first.conversationId}
             ORDER BY created_at, id`,
      );
      expect(after.rows).toHaveLength(2);
      expect(after.rows[1]).toMatchObject({ id: pending!.id, state: 'QUEUED' });
      expect(Number((after.rows[1] as { trigger: string }).trigger)).toBe(m2.messageId);
    });

    it('R8: the escalation summary is purged with the transcript, after 30 days', async () => {
      decide({ topic: 'REFUND', summary: 'مشتری بازپرداخت می‌خواهد.' });
      await record(message());
      await tick();
      expect(await escalationRows()).toMatchObject([{ summary: 'مشتری بازپرداخت می‌خواهد.' }]);
      await db().execute(
        sql`UPDATE business_conversation_escalations SET created_at = now() - interval '31 days'`,
      );
      await deliver();
      const [row] = await escalationRows();
      expect(row).toMatchObject({ summary: null });
      expect(row!.text_purged_at).not.toBeNull();
    });

    it('R10: a SUPERSEDED automatic reply never counts toward the loop guard', async () => {
      await configure({ maxConsecutiveReplies: 1 });
      const first = await record(message());
      const convo = await conversation(first.conversationId);
      await db().execute(
        sql`INSERT INTO business_outbound_messages
              (id, tenant_id, conversation_id, origin, body, control_epoch, idempotency_key, request_hash, state, resolved_at)
            VALUES (${ctx.container.ids.uuid()}, ${SEED_IDS.tenantA}, ${convo.id}, 'AUTO', 'x',
                    ${convo.controlEpoch}, ${key('sup')}, 'h', 'SUPERSEDED', now())`,
      );
      await tick();
      expect(await autoJobs(first.conversationId)).toMatchObject([{ outcome: 'sent' }]);
    });

    it('Telegram REFUSED on an AUTO row hands off (TRANSPORT_REFUSED)', async () => {
      const first = await record(message());
      await tick();
      transport.next.push({
        outcome: 'REFUSED',
        reason: 'TELEGRAM_REJECTED',
        errorCode: 'telegram.400',
        connectionStatus: null,
      });
      await deliver();
      expect(await autoRows(first.conversationId)).toMatchObject([{ state: 'FAILED' }]);
      expect(await conversation(first.conversationId)).toMatchObject({
        state: 'HANDOFF_REQUIRED',
        handoffReason: 'TRANSPORT_REFUSED',
      });
      expect(await escalationRows()).toMatchObject([{ reason: 'TRANSPORT_REFUSED' }]);
    });

    // --- finding 5: the AI's note is the conversation's to show -----------------------------

    it("finding 5: tickets.view without business_chats.view never sees the AI's summary", async () => {
      decide({ topic: 'REFUND', summary: 'مشتری بازپرداخت می‌خواهد.' });
      const first = await record(message());
      await tick();
      const ticketId = (await conversation(first.conversationId)).ticketId!;
      const roleId = ctx.container.ids.uuid();
      await db().execute(
        sql`INSERT INTO roles (id, tenant_id, key, name) VALUES (${roleId}, ${SEED_IDS.tenantA}, 'ticket_reader', 'Ticket reader')`,
      );
      await db().execute(
        sql`INSERT INTO role_permissions (tenant_id, role_id, permission_key)
            VALUES (${SEED_IDS.tenantA}, ${roleId}, 'tickets.view')`,
      );
      const reader = adminActorFor(
        await createAdmin(ctx.container, tenantA, {
          username: 'reader1',
          roleKeys: ['ticket_reader'],
        }),
      );
      const seen = await ctx.container.tickets.detail(tenantA as never, reader, ticketId);
      expect(seen.escalations).toMatchObject([{ reason: 'HANDOFF_TOPIC', summary: null }]);
      const full = await ctx.container.tickets.detail(tenantA as never, owner, ticketId);
      expect(full.escalations).toMatchObject([
        { reason: 'HANDOFF_TOPIC', summary: 'مشتری بازپرداخت می‌خواهد.' },
      ]);
    });

    // --- nit: loosening an AUTO tenant's bounds is the CRITICAL permission ------------------

    it('nit: in AUTO, raising the reply limits or shortening the delays needs support_ai.auto_reply', async () => {
      await db().execute(
        sql`INSERT INTO role_permissions (tenant_id, role_id, permission_key)
            SELECT tenant_id, id, 'support_ai.configure' FROM roles
            WHERE tenant_id = ${SEED_IDS.tenantA} AND key = 'operator'`,
      );
      const admin = adminActorFor(
        await createAdmin(ctx.container, tenantA, { username: 'admin2', roleKeys: ['operator'] }),
      );
      const current = (await ctx.container.supportAiConfig.view(tenantA as never, owner)).config;
      for (const change of [
        { maxConsecutiveReplies: current.maxConsecutiveReplies + 1 },
        { maxOutputChars: current.maxOutputChars + 100 },
        { cooldownSeconds: current.cooldownSeconds - 1 },
        { settleDelaySeconds: current.settleDelaySeconds - 1 },
      ]) {
        await expect(configure(change, admin), JSON.stringify(change)).rejects.toSatisfy(
          isNexaError,
        );
      }
      // Tightening is ordinary configuration.
      await configure({ maxConsecutiveReplies: current.maxConsecutiveReplies - 1 }, admin);
      // Outside AUTO these shape only Assist drafts: ordinary configuration too.
      await configure({ mode: 'ASSIST_ONLY' });
      await configure({ maxOutputChars: current.maxOutputChars + 100 }, admin);
    });
  });

  // ===========================================================================================
  // Hotfix 2026-10-06 — a safe clarifying question is sent automatically, bounded by the
  // tenant's `maxConsecutiveClarifyingQuestions` (docs/support-agent/tb7-auto-reply.md).
  // ===========================================================================================
  describe('hotfix: automatic clarifying questions', () => {
    const QUESTION = 'حتماً. با چه برنامه‌ای وصل می‌شید و موقع اتصال چه خطایی می‌بینید؟';
    const scripted = (output: Record<string, unknown>): SupportAiOutcome => ({
      outcome: 'OK',
      output: { ...grounded, ...output },
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'gpt-5.5',
    });
    const askOut = (replyText = QUESTION, over: Record<string, unknown> = {}) =>
      scripted({ decision: 'ASK_CLARIFYING_QUESTION', replyText, factRefs: [], ...over });
    const replyOut = (over: Record<string, unknown> = {}) => scripted(over);
    /** One customer turn: the message, the assistant's pass, and the lane's pass. */
    const turn = async (
      text: string,
      output: SupportAiOutcome,
      over: Partial<ParsedBusinessMessage> = {},
    ) => {
      next = output;
      const recorded = await record(message({ text, ...over }));
      await tick();
      await deliver();
      return recorded.conversationId;
    };
    const outcomes = async (conversationId: string) =>
      (await autoJobs(conversationId)).map((j) => j.outcome);
    const streak = async (conversationId: string) =>
      jobs.clarifyingStreak(scopeA, {
        conversationId,
        epoch: (await conversation(conversationId)).controlEpoch,
      });

    it('1/17: a safe clarifying question is sent once, with no handoff and no ticket', async () => {
      const id = await turn('مشکل در اتصال دارم', askOut());
      expect(await autoJobs(id)).toMatchObject([
        { state: 'SENT', outcome: 'sent_clarifying', handoff_reason: null },
      ]);
      expect(transport.sent).toEqual([{ chatId: CUSTOMER, text: QUESTION }]);
      expect(await autoRows(id)).toMatchObject([{ state: 'DELIVERED', body: QUESTION }]);
      expect(await conversation(id)).toMatchObject({ state: 'AI_ACTIVE', handoffReason: null });
      expect(await count('tickets')).toBe(0);
      expect(await count('business_conversation_escalations')).toBe(0);
      // The decision is recorded on the job: it is what the streak reads.
      const decided = await db().execute(
        sql`SELECT decision FROM support_ai_jobs WHERE conversation_id = ${id}`,
      );
      expect(decided.rows).toEqual([{ decision: 'ASK_CLARIFYING_QUESTION' }]);
      expect(await streak(id)).toBe(1);
    });

    it('2: a clarifying question on a topic off the allowlist hands off, unsent', async () => {
      await configure({ autoTopics: ['GREETING'] });
      const id = await turn('مشکل در اتصال دارم', askOut());
      expect(await autoJobs(id)).toMatchObject([
        { state: 'FAILED', outcome: 'guard_topic_allowlist', handoff_reason: 'TOPIC_NOT_ALLOWED' },
      ]);
      expect(await autoRows(id)).toEqual([]);
      expect(transport.sent).toEqual([]);
    });

    it('3/10: a clarifying question below the confidence floor hands off, unsent', async () => {
      const id = await turn('مشکل در اتصال دارم', askOut(QUESTION, { confidence: 'MEDIUM' }));
      expect(await autoJobs(id)).toMatchObject([
        { state: 'FAILED', outcome: 'guard_confidence', handoff_reason: 'LOW_CONFIDENCE' },
      ]);
      expect(transport.sent).toEqual([]);
    });

    it('4/7: money in the customer’s words hands off before the provider, ASK or not', async () => {
      const id = await turn('وصل نمیشه، پولمو هم پس بدید', askOut());
      expect(calls).toBe(0);
      expect(await autoJobs(id)).toMatchObject([
        { state: 'FAILED', outcome: 'guard_handoff_topic', handoff_reason: 'HANDOFF_TOPIC' },
      ]);
      expect(transport.sent).toEqual([]);
      expect(await count('tickets')).toBe(1); // a real handoff: the ticket is the escalation
    });

    it('5/11: a clarifying question citing a fact or knowledge entry it was not given hands off', async () => {
      const id = await turn('مشکل در اتصال دارم', askOut(QUESTION, { factRefs: ['Z9'] }));
      expect((await autoJobs(id)).at(-1)).toMatchObject({
        state: 'FAILED',
        outcome: 'guard_grounding',
        handoff_reason: 'INSUFFICIENT_GROUNDING',
      });
      await resume(id);
      await turn('هنوز وصل نمیشه', askOut(QUESTION, { knowledgeRefs: ['K7'] }));
      expect((await autoJobs(id)).at(-1)).toMatchObject({
        state: 'FAILED',
        outcome: 'guard_grounding',
      });
      expect(transport.sent).toEqual([]);
    });

    it('6/8: a hard topic cannot pass as a clarifying question, even fully allowlisted', async () => {
      await configure({
        autoTopics: ['CONNECTION_TROUBLESHOOTING', 'GREETING', 'SERVICE_INFO', 'PLAN_INFO'],
        autoMinConfidence: 'MEDIUM',
      });
      let id: string | null = null;
      for (const topic of ['REFUND', 'WALLET', 'ACCOUNT_SECURITY', 'OTHER']) {
        if (id !== null) await resume(id);
        id = await turn('یک سؤال دارم', askOut(QUESTION, { topic }));
        expect((await autoJobs(id)).at(-1), topic).toMatchObject({
          state: 'FAILED',
          outcome: 'guard_handoff_topic',
          handoff_reason: 'HANDOFF_TOPIC',
        });
      }
      expect(transport.sent).toEqual([]);
    });

    it('7: the clarifying limit defaults to 2, also for a row written before the column', async () => {
      const bOwner = adminActorFor(
        await createAdmin(ctx.container, tenantB, { username: 'bowner2', roleKeys: ['owner'] }),
      );
      // A fresh tenant: the contract default.
      expect(
        (await ctx.container.supportAiConfig.view(tenantB as never, bOwner)).config
          .maxConsecutiveClarifyingQuestions,
      ).toBe(2);
      // A row written by a writer that does not know the column (an existing tenant's row as
      // migration 0218 found it): the column's default.
      await db().execute(
        sql`INSERT INTO support_ai_configs (tenant_id, mode, timeout_ms, max_output_chars,
              max_consecutive_replies, cooldown_seconds)
            VALUES (${SEED_IDS.tenantB}, 'OFF', 30000, 1200, 4, 20)`,
      );
      expect(
        (await ctx.container.supportAiConfig.view(tenantB as never, bOwner)).config
          .maxConsecutiveClarifyingQuestions,
      ).toBe(2);
    });

    it('8: the setting round-trips, and saving another field preserves it', async () => {
      await configure({ maxConsecutiveClarifyingQuestions: 5 });
      const after = await ctx.container.supportAiConfig.view(tenantA as never, owner);
      expect(after.config.maxConsecutiveClarifyingQuestions).toBe(5);
      await configure({ cooldownSeconds: 30 });
      const again = await ctx.container.supportAiConfig.view(tenantA as never, owner);
      expect(again.config).toMatchObject({
        maxConsecutiveClarifyingQuestions: 5,
        cooldownSeconds: 30,
      });
      expect(again.version).toBe(after.version + 1);
      // The bounds are the table's too: a writer that skips the schema is refused.
      await expect(
        db().execute(
          sql`UPDATE support_ai_configs SET max_consecutive_clarifying_questions = 11
              WHERE tenant_id = ${SEED_IDS.tenantA}`,
        ),
      ).rejects.toThrow();
    });

    it('8b: the same idempotency key replays the save; it is not applied twice', async () => {
      const current = await ctx.container.supportAiConfig.view(tenantA as never, owner);
      const body = {
        idempotencyKey: key('cfg-replay'),
        expectedVersion: current.version,
        config: { ...current.config, maxConsecutiveClarifyingQuestions: 3 },
      };
      const first = await ctx.container.supportAiConfig.update(tenantA as never, owner, body);
      const replay = await ctx.container.supportAiConfig.update(tenantA as never, owner, body);
      expect(replay).toEqual(first);
      expect((await ctx.container.supportAiConfig.view(tenantA as never, owner)).version).toBe(
        first.version,
      );
    });

    it('9: in AUTO, raising the clarifying limit needs support_ai.auto_reply; lowering does not', async () => {
      await db().execute(
        sql`INSERT INTO role_permissions (tenant_id, role_id, permission_key)
            SELECT tenant_id, id, 'support_ai.configure' FROM roles
            WHERE tenant_id = ${SEED_IDS.tenantA} AND key = 'operator'`,
      );
      const admin = adminActorFor(
        await createAdmin(ctx.container, tenantA, { username: 'admin3', roleKeys: ['operator'] }),
      );
      await expect(configure({ maxConsecutiveClarifyingQuestions: 3 }, admin)).rejects.toSatisfy(
        isNexaError,
      );
      await configure({ maxConsecutiveClarifyingQuestions: 1 }, admin);
      expect(
        (await ctx.container.supportAiConfig.view(tenantA as never, owner)).config
          .maxConsecutiveClarifyingQuestions,
      ).toBe(1);
      // The owner holds the CRITICAL permission.
      await configure({ maxConsecutiveClarifyingQuestions: 4 });
      // Outside AUTO the limit shapes nothing that is sent alone: ordinary configuration.
      await configure({ mode: 'ASSIST_ONLY' });
      await configure({ maxConsecutiveClarifyingQuestions: 6 }, admin);
    });

    it('10: at the limit (2) the third clarifying question hands off, unsent', async () => {
      const id = await turn('مشکل در اتصال دارم', askOut('با چه برنامه‌ای وصل می‌شید؟'));
      await turn('Sing-box', askOut('موقع اتصال چه خطایی می‌بینید؟'));
      await turn('نمی‌دونم', askOut('اینترنت گوشی بدون VPN کار می‌کنه؟'));
      expect(calls).toBe(3);
      expect(await outcomes(id)).toEqual([
        'sent_clarifying',
        'sent_clarifying',
        'guard_clarifying_limit',
      ]);
      expect((await autoJobs(id)).at(-1)).toMatchObject({
        state: 'FAILED',
        handoff_reason: 'CLARIFYING_LIMIT',
      });
      expect(await conversation(id)).toMatchObject({
        state: 'HANDOFF_REQUIRED',
        handoffReason: 'CLARIFYING_LIMIT',
      });
      expect(transport.sent.map((m) => m.text)).toEqual([
        'با چه برنامه‌ای وصل می‌شید؟',
        'موقع اتصال چه خطایی می‌بینید؟',
      ]);
      expect(await autoRows(id)).toHaveLength(2);
    });

    it('11: a higher limit (4) sends four clarifying questions and hands off the fifth', async () => {
      await configure({ maxConsecutiveClarifyingQuestions: 4, maxConsecutiveReplies: 10 });
      let id = '';
      for (let i = 1; i <= 5; i += 1) id = await turn(`پاسخ ${i}`, askOut(`سؤال ${i}؟`));
      expect(await outcomes(id)).toEqual([
        'sent_clarifying',
        'sent_clarifying',
        'sent_clarifying',
        'sent_clarifying',
        'guard_clarifying_limit',
      ]);
      expect(transport.sent).toHaveLength(4);
    });

    it('12/6: a REPLY resets the streak: ASK, ASK, REPLY, ASK, ASK are sent; the next ASK is not', async () => {
      await configure({ maxConsecutiveReplies: 10 });
      const id = await turn('مشکل در اتصال دارم', askOut('سؤال ۱؟'));
      await turn('Sing-box', askOut('سؤال ۲؟'));
      expect(await streak(id)).toBe(2);
      await turn('خطای اتصال میده', replyOut());
      expect(await streak(id)).toBe(0);
      await turn('درست شد، ولی کند است', askOut('سؤال ۳؟'));
      await turn('روی وای‌فای', askOut('سؤال ۴؟'));
      await turn('باز هم کند است', askOut('سؤال ۵؟'));
      expect(await outcomes(id)).toEqual([
        'sent_clarifying',
        'sent_clarifying',
        'sent',
        'sent_clarifying',
        'sent_clarifying',
        'guard_clarifying_limit',
      ]);
      expect(transport.sent).toHaveLength(5);
    });

    it('10b: the limit is decided again in the enqueue transaction, on the config of then', async () => {
      await configure({ maxConsecutiveClarifyingQuestions: 3 });
      const id = await turn('مشکل در اتصال دارم', askOut('سؤال ۱؟'));
      await turn('Sing-box', askOut('سؤال ۲؟'));
      // The owner lowers the limit while the third question is being produced.
      duringCall = async () => {
        duringCall = null;
        await configure({ maxConsecutiveClarifyingQuestions: 2 });
      };
      await turn('نمی‌دونم', askOut('سؤال ۳؟'));
      expect(await outcomes(id)).toEqual([
        'sent_clarifying',
        'sent_clarifying',
        'guard_clarifying_limit',
      ]);
      expect(transport.sent).toHaveLength(2);
    });

    it('N1: a question still PENDING on the lane counts (fail closed)', async () => {
      // Two questions produced, the lane has not sent the second yet.
      next = askOut('سؤال ۱؟');
      const id = (await record(message({ text: 'مشکل در اتصال دارم' }))).conversationId;
      await tick();
      await deliver();
      next = askOut('سؤال ۲؟');
      await record(message({ text: 'Sing-box' }));
      await tick(); // no deliver(): ASK #2 is PENDING
      expect((await autoRows(id)).map((r) => r.state)).toEqual(['DELIVERED', 'PENDING']);
      expect(await streak(id)).toBe(2);
      // The third question, at limit 2, hands off and is never sent.
      next = askOut('سؤال ۳؟');
      await record(message({ text: 'نمی‌دونم' }));
      await tick();
      expect(await outcomes(id)).toEqual([
        'sent_clarifying',
        'sent_clarifying',
        'guard_clarifying_limit',
      ]);
      await deliver();
      // The handoff superseded the pending second question; the third was never enqueued.
      expect(transport.sent.map((m) => m.text)).toEqual(['سؤال ۱؟']);
      expect((await autoRows(id)).map((r) => r.body)).toEqual(['سؤال ۱؟', 'سؤال ۲؟']);
    });

    it('N4: a save that omits the limit keeps the stored value; an explicit raise is still charged', async () => {
      await configure({ maxConsecutiveClarifyingQuestions: 1 });
      await db().execute(
        sql`INSERT INTO role_permissions (tenant_id, role_id, permission_key)
            SELECT tenant_id, id, 'support_ai.configure' FROM roles
            WHERE tenant_id = ${SEED_IDS.tenantA} AND key = 'operator'`,
      );
      const admin = adminActorFor(
        await createAdmin(ctx.container, tenantA, { username: 'admin4', roleKeys: ['operator'] }),
      );
      // An older client that does not know the field: everything else, the field absent.
      const olderClientSave = async (
        actor: ActorContext,
        change: Partial<SupportAiConfigInput>,
      ) => {
        const current = await ctx.container.supportAiConfig.view(tenantA as never, owner);
        const { maxConsecutiveClarifyingQuestions: _omitted, ...rest } = current.config;
        return ctx.container.supportAiConfig.update(tenantA as never, actor, {
          idempotencyKey: key('cfg-old'),
          expectedVersion: current.version,
          config: { ...rest, ...change },
        });
      };
      // Under AUTO_REPLY_SAFE, by an actor WITHOUT support_ai.auto_reply: no widening happened.
      const saved = await olderClientSave(admin, { cooldownSeconds: 25 });
      expect(saved.config.maxConsecutiveClarifyingQuestions).toBe(1);
      expect(
        (await ctx.container.supportAiConfig.view(tenantA as never, owner)).config,
      ).toMatchObject({ maxConsecutiveClarifyingQuestions: 1, cooldownSeconds: 25 });
      // The same request replayed under its key is the same result, not a second write.
      const current = await ctx.container.supportAiConfig.view(tenantA as never, owner);
      const { maxConsecutiveClarifyingQuestions: _x, ...rest } = current.config;
      const body = {
        idempotencyKey: key('cfg-old-replay'),
        expectedVersion: current.version,
        config: { ...rest, toneInstructions: 'کوتاه' },
      };
      const first = await ctx.container.supportAiConfig.update(tenantA as never, admin, body);
      const replay = await ctx.container.supportAiConfig.update(tenantA as never, admin, body);
      expect(replay).toEqual(first);
      expect(first.config.maxConsecutiveClarifyingQuestions).toBe(1);
      // An explicit raise from 1 to 3 in AUTO is still the CRITICAL permission.
      await expect(configure({ maxConsecutiveClarifyingQuestions: 3 }, admin)).rejects.toSatisfy(
        isNexaError,
      );
      await configure({ maxConsecutiveClarifyingQuestions: 3 });
      expect(
        (await ctx.container.supportAiConfig.view(tenantA as never, owner)).config
          .maxConsecutiveClarifyingQuestions,
      ).toBe(3);
    });

    it('13: a refused, superseded or failed reply, and a discarded job, never count', async () => {
      await configure({ maxConsecutiveClarifyingQuestions: 1, maxConsecutiveReplies: 10 });
      const id = await turn('مشکل در اتصال دارم', askOut('سؤال ۱؟'));
      expect(await streak(id)).toBe(1);
      const epoch = (await conversation(id)).controlEpoch;
      // The lane row did not reach the customer: FAILED (Telegram refused it) or SUPERSEDED.
      for (const state of ['FAILED', 'SUPERSEDED']) {
        await db().execute(
          sql`UPDATE business_outbound_messages SET state = ${state}
              WHERE origin = 'AUTO' AND conversation_id = ${id}`,
        );
        expect(await streak(id), state).toBe(0);
      }
      // Jobs that decided ASK but sent nothing: no lane row, nothing to count.
      for (const state of ['DISCARDED', 'FAILED']) {
        await db().execute(
          sql`INSERT INTO support_ai_jobs (id, tenant_id, kind, conversation_id, idempotency_key,
                state, decision, control_epoch, outcome, trigger_telegram_message_id,
                trigger_content_version, due_at)
              VALUES (${ctx.container.ids.uuid()}, ${SEED_IDS.tenantA}, 'AUTO_DECISION', ${id},
                      ${key('ghost')}, ${state}, 'ASK_CLARIFYING_QUESTION', ${epoch},
                      ${state === 'FAILED' ? 'guard_confidence' : 'dropped_connection'}, 1, 1, now())`,
        );
      }
      expect(await streak(id)).toBe(0);
      // So the next question is sent: limit 1, and nothing counted.
      await turn('Sing-box', askOut('سؤال ۲؟'));
      expect((await autoJobs(id)).at(-1)).toMatchObject({ outcome: 'sent_clarifying' });
    });

    it('13b: a real Telegram refusal hands off; after the resume the streak starts again', async () => {
      await configure({ maxConsecutiveClarifyingQuestions: 1 });
      transport.next.push({
        outcome: 'REFUSED',
        reason: 'TELEGRAM_REJECTED',
        errorCode: 'telegram.400',
        connectionStatus: null,
      });
      const id = await turn('مشکل در اتصال دارم', askOut('سؤال ۱؟'));
      expect(await autoRows(id)).toMatchObject([{ state: 'FAILED' }]);
      expect(await conversation(id)).toMatchObject({
        state: 'HANDOFF_REQUIRED',
        handoffReason: 'TRANSPORT_REFUSED',
      });
      await resume(id);
      await turn('Sing-box', askOut('سؤال ۲؟'));
      expect((await autoJobs(id)).at(-1)).toMatchObject({ outcome: 'sent_clarifying' });
    });

    it('14/15: a takeover and return to the AI start a new streak; the old ticket blocks nothing', async () => {
      const id = await turn('مشکل در اتصال دارم', askOut('سؤال ۱؟'));
      await turn('Sing-box', askOut('سؤال ۲؟'));
      await turn('نمی‌دونم', askOut('سؤال ۳؟'));
      // At the limit: a real handoff, with its ticket.
      expect(await conversation(id)).toMatchObject({ state: 'HANDOFF_REQUIRED' });
      expect(await count('tickets')).toBe(1);
      const ticketId = (await conversation(id)).ticketId;
      expect(ticketId).not.toBeNull();
      // A person takes it, then returns it to the AI: a new epoch.
      const before = (await conversation(id)).controlEpoch;
      await ctx.container.businessConversations.takeOver(scopeA, operator, {
        conversationId: id,
        idempotencyKey: key('take'),
      });
      await resume(id);
      const resumed = await conversation(id);
      expect(resumed).toMatchObject({ state: 'AI_ACTIVE', ticketId });
      expect(resumed.controlEpoch).toBeGreaterThan(before);
      expect(await streak(id)).toBe(0);
      // Like a fresh session: two more questions are sent, the old ticket notwithstanding.
      await turn('سلام دوباره، هنوز وصل نمیشه', askOut('سؤال ۴؟'));
      await turn('v2rayNG', askOut('سؤال ۵؟'));
      expect((await outcomes(id)).slice(-2)).toEqual(['sent_clarifying', 'sent_clarifying']);
      expect(await count('tickets')).toBe(1);
    });

    it('15: a redelivered message and a repeated lane pass count one question, once', async () => {
      next = askOut('سؤال ۱؟');
      const m = message({ text: 'مشکل در اتصال دارم' });
      const first = await record(m, key('update'));
      await record(m, key('update-again')); // Telegram redelivers the update
      await tick();
      await tick();
      await deliver();
      await deliver();
      const id = first.conversationId;
      expect(transport.sent).toHaveLength(1);
      expect(await autoRows(id)).toHaveLength(1);
      expect(await streak(id)).toBe(1);
      // Limit 2: one counted, so the second question is still sent; the third is not.
      await turn('Sing-box', askOut('سؤال ۲؟'));
      await turn('نمی‌دونم', askOut('سؤال ۳؟'));
      expect(await outcomes(id)).toEqual([
        'sent_clarifying',
        'sent_clarifying',
        'guard_clarifying_limit',
      ]);
    });

    it('16/4: a REPLY is unchanged — at the clarifying limit too — and a greeting never counts', async () => {
      await configure({ maxConsecutiveClarifyingQuestions: 1 });
      const id = await turn(
        'سلام',
        replyOut({ topic: 'GREETING', replyText: 'سلام! در خدمتم.', factRefs: [] }),
      );
      expect(await outcomes(id)).toEqual(['sent']);
      expect(await streak(id)).toBe(0);
      await turn('مشکل در اتصال دارم', askOut('سؤال ۱؟'));
      expect(await streak(id)).toBe(1);
      // At the limit, an answer is still an answer.
      await turn('Sing-box', replyOut());
      expect(await outcomes(id)).toEqual(['sent', 'sent_clarifying', 'sent']);
      expect(transport.sent).toHaveLength(3);
      expect(await count('tickets')).toBe(0);
    });

    it('item 3: short connection messages reach the model and are answered, never a deterministic handoff', async () => {
      let id: string | null = null;
      for (const [text, output] of [
        ['وصل نمیشه', askOut('سؤال ۱؟')],
        ['مشکل اتصال دارم', replyOut()],
        ['کانفیگ کار نمی‌کنه', askOut('سؤال ۲؟')],
        ['Sing-box وصل نمیشه', replyOut()],
      ] as const) {
        if (id !== null) {
          // A fresh epoch each time: this is about the deterministic guards, not the loop guard.
          await ctx.container.businessConversations.takeOver(scopeA, operator, {
            conversationId: id,
            idempotencyKey: key('take'),
          });
          await resume(id);
        }
        id = await turn(text, output);
        expect((await autoJobs(id)).at(-1), text).toMatchObject({ state: 'SENT' });
      }
      expect(calls).toBe(4);
      expect(await count('business_conversation_escalations')).toBe(0);
    });

    it('item 12/13: the next call reads the question the AI already asked', async () => {
      const id = await turn('مشکل در اتصال دارم', askOut(QUESTION));
      await turn('Sing-box', askOut('چه خطایی می‌بینید؟'));
      expect(requests[1]).toEqual([
        { role: 'user', text: 'مشکل در اتصال دارم' },
        { role: 'assistant', text: QUESTION },
        { role: 'user', text: 'Sing-box' },
      ]);
      expect(await outcomes(id)).toEqual(['sent_clarifying', 'sent_clarifying']);
    });

    it('item 16: an unlinked customer gets a general question; account topics stay behind identity', async () => {
      const STRANGER = '7000099';
      flags = { ...flags, identityLinked: false };
      const id = await turn('مشکل در اتصال دارم', askOut(), {
        chatId: STRANGER,
        fromUserId: STRANGER,
      });
      expect(await outcomes(id)).toEqual(['sent_clarifying']);
      await turn('سرویسم کی تموم میشه؟', askOut('کدام سرویس؟', { topic: 'SERVICE_INFO' }), {
        chatId: STRANGER,
        fromUserId: STRANGER,
      });
      expect((await autoJobs(id)).at(-1)).toMatchObject({
        outcome: 'guard_identity',
        handoff_reason: 'IDENTITY_UNVERIFIED',
      });
      expect(await count('tickets')).toBe(0); // no customer: recorded and signalled, no ticket
    });

    it('item 20: the acceptance flow — greeting, two questions, a grounded answer', async () => {
      await configure({ maxConsecutiveReplies: 10 });
      const id = await turn(
        'سلام',
        replyOut({ topic: 'GREETING', replyText: 'سلام! چطور کمکتون کنم؟', factRefs: [] }),
      );
      await turn('مشکل در اتصال دارم', askOut(QUESTION));
      expect(await count('tickets')).toBe(0);
      await turn('Sing-box', askOut('موقع اتصال چه پیامی می‌بینید؟'));
      expect(await streak(id)).toBe(2);
      const steps =
        'برای Sing-box: ۱) برنامه را ببندید ۲) لینک اشتراک را به‌روز کنید ۳) دوباره وصل شوید.';
      await turn(
        'خطای اتصال میده',
        replyOut({ replyText: steps, factRefs: [], knowledgeRefs: ['K1'] }),
      );
      expect(await outcomes(id)).toEqual(['sent', 'sent_clarifying', 'sent_clarifying', 'sent']);
      // Every outbound exactly once, in order; no duplicate.
      expect(transport.sent.map((m) => m.text)).toEqual([
        'سلام! چطور کمکتون کنم؟',
        QUESTION,
        'موقع اتصال چه پیامی می‌بینید؟',
        steps,
      ]);
      expect((await autoRows(id)).map((r) => r.state)).toEqual([
        'DELIVERED',
        'DELIVERED',
        'DELIVERED',
        'DELIVERED',
      ]);
      expect(await streak(id)).toBe(0);
      expect(await conversation(id)).toMatchObject({ state: 'AI_ACTIVE' });
      expect(await count('tickets')).toBe(0);
      expect(await count('business_conversation_escalations')).toBe(0);
    });
  });
});
