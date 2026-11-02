import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  SUPPORT_AI_SAFE_TOPICS,
  SUPPORT_AI_TOOL_CALL_LIMIT,
  supportAiCallbackData,
  systemJobActor,
  type ActorContext,
  type BusinessBotRight,
  type BusinessOutboundButtons,
  type CorrelationId,
  type SupportAiConfigInput,
  type SupportAiOutcome,
} from '@nexa/contracts';
import { AssistantLoop } from '../../apps/api/src/modules/control/support-ai/application/assistant-loop';
import {
  SupportAutoEnqueuer,
  SupportAutoReplyService,
} from '../../apps/api/src/modules/control/support-ai/application/support-auto-reply.service';
import { SupportAiCallbackService } from '../../apps/api/src/modules/control/support-ai/application/support-ai-callback.service';
import type { AutoContextFlags } from '../../apps/api/src/modules/control/support-ai/domain/auto-reply-guards';
import { DrizzleSupportAiJobRepository } from '../../apps/api/src/modules/control/support-ai/infrastructure/drizzle-support-ai-job.repository';
import { DrizzleSupportAiConfigRepository } from '../../apps/api/src/modules/control/support-ai/infrastructure/drizzle-support-ai.repository';
import {
  DrizzleSupportAiToolReader,
  SettingsSupportAiToolSettings,
} from '../../apps/api/src/modules/control/support-ai/infrastructure/drizzle-support-ai-tools.reader';
import { BusinessOutboundService } from '../../apps/api/src/modules/commerce/business-chats/application/business-outbound.service';
import type { BusinessSendOutcome } from '../../apps/api/src/modules/commerce/business-chats/application/business-transport';
import type { ParsedBusinessMessage } from '../../apps/api/src/modules/commerce/business-chats/domain/telegram-business';
import { DrizzleBusinessConnectionRepository } from '../../apps/api/src/modules/commerce/business-chats/infrastructure/drizzle-business-connection.repository';
import {
  DrizzleBusinessConversationRepository,
  DrizzleBusinessEscalationRepository,
  DrizzleBusinessMessageRepository,
  DrizzleBusinessOutboundRepository,
} from '../../apps/api/src/modules/commerce/business-chats/infrastructure/drizzle-business-conversation.repository';
import { DrizzleSupportContextReader } from '../../apps/api/src/modules/commerce/support-context/infrastructure/drizzle-support-context.reader';
import { AudienceFixtures } from './audience-fixtures';
import {
  SEED_IDS,
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  type TestContext,
} from './harness';

/**
 * Phase 4 PR-3 — the support AI's read-only tools, deep links, check-before-handoff and its own
 * buttons, against a real database: the job's conditional writes, the guards, the real tool
 * reader (the customer's own rows only), the handoff with its notice and escalation, TB2's lane,
 * and the callback binding. The provider is scripted; Telegram is a recording transport.
 */

const BOT = SEED_IDS.botA1;
const OWNER = '5000001';
const CUSTOMER = '7000001';
const STRANGER = '7000002';
const OUR_BOT = '9000001';
const scopeA = { ...tenantA, botInstanceId: BOT } as never;
const DUE = 120_000;

const reply = {
  decision: 'REPLY',
  replyText: 'لینک سرویس شما در ادامه آمده است.',
  topic: 'GET_SUBSCRIPTION_LINK',
  confidence: 'HIGH',
  factRefs: ['S1'],
  knowledgeRefs: [],
  ticketAction: 'NONE',
  summary: 'مشتری لینک اشتراکش را خواست.',
  intent: 'لینک اشتراک',
};

/** Telegram, recording every send with its keyboard; message ids are handed out in order. */
class RecordingTransport {
  sent: { chatId: string; text: string; buttons: BusinessOutboundButtons | null }[] = [];
  nextMessageId = 900;
  next: BusinessSendOutcome[] = [];
  async sendText(
    _scope: unknown,
    _actor: unknown,
    input: { chatId: string; text: string; buttons?: BusinessOutboundButtons | null },
  ) {
    this.sent.push({ chatId: input.chatId, text: input.text, buttons: input.buttons ?? null });
    const scripted = this.next.shift();
    if (scripted !== undefined) return scripted;
    this.nextMessageId += 1;
    return { outcome: 'DELIVERED' as const, messageId: this.nextMessageId, sentAt: null };
  }
}

describe('Phase 4 PR-3: tools, deep links, check-before-handoff, buttons', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let jobs: DrizzleSupportAiJobRepository;
  let conversations: DrizzleBusinessConversationRepository;
  let outbound: DrizzleBusinessOutboundRepository;
  let auto: SupportAutoReplyService;
  let loop: AssistantLoop;
  let lane: BusinessOutboundService;
  let callbacks: SupportAiCallbackService;
  let transport: RecordingTransport;
  let toasts: string[];
  let outputs: Record<string, unknown>[];
  let calls: number;
  let flags: AutoContextFlags;
  let tools: { actions: boolean; label: boolean; feedback: boolean };
  let trialEligible: boolean;
  let references: { services: Map<string, string>; catalogue: Map<string, string> };
  let contextJson: string;
  let fixtures: AudienceFixtures;
  let customerId: string;
  let panelId: string;
  let offset: number;
  let messageSeq = 100;
  let keySeq = 0;
  const key = (label: string) => `${label}-${Date.now()}-${(keySeq += 1)}`;
  const system = () => systemJobActor('sai3-test', 'c' as CorrelationId);
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
      text: 'لینکمو بفرست',
      photo: null,
      ...overrides,
    };
  }

  const record = async (m: ParsedBusinessMessage) =>
    (await ctx.container.businessConversations.recordMessage(scopeA, system(), {
      idempotencyKey: key('update'),
      botInstanceId: BOT,
      message: m,
      edited: false,
    }))!;

  async function configure(change: Partial<SupportAiConfigInput>) {
    const current = await ctx.container.supportAiConfig.view(tenantA as never, owner);
    return ctx.container.supportAiConfig.update(tenantA as never, owner, {
      idempotencyKey: key('cfg'),
      expectedVersion: current.version === 0 ? null : current.version,
      config: { ...current.config, ...change },
    });
  }

  const tick = async () => {
    offset = DUE;
    await loop.tick();
  };
  const deliver = () => lane.deliverDue(scopeA);
  /** One customer message, answered by the scripted outputs (the last one repeats). */
  const turn = async (text: string, ...answers: Record<string, unknown>[]) => {
    outputs = answers;
    const recorded = await record(message({ text, sentAt: new Date(Date.now() - 5_000) }));
    await tick();
    return recorded.conversationId;
  };

  async function conversation(id: string) {
    const found = await conversations.findById(scopeA, id);
    if (found === null) throw new Error('conversation missing');
    return found;
  }
  async function autoJobs(conversationId: string) {
    return (
      await db().execute(
        sql`SELECT state, outcome, handoff_reason, tool_action FROM support_ai_jobs
            WHERE kind = 'AUTO_DECISION' AND conversation_id = ${conversationId}
            ORDER BY created_at, id`,
      )
    ).rows as {
      state: string;
      outcome: string | null;
      handoff_reason: string | null;
      tool_action: string | null;
    }[];
  }
  const outcomes = async (id: string) => (await autoJobs(id)).map((job) => job.outcome);
  async function lastEscalation(conversationId: string) {
    const rows = (
      await db().execute(
        sql`SELECT reason, handoff_kind, summary, topic, intent FROM business_conversation_escalations
            WHERE conversation_id = ${conversationId} ORDER BY created_at DESC LIMIT 1`,
      )
    ).rows as {
      reason: string;
      handoff_kind: string | null;
      summary: string | null;
      topic: string | null;
      intent: string | null;
    }[];
    return rows[0];
  }
  async function opsEvents(code: string) {
    return (
      await db().execute(sql`SELECT context FROM operational_events WHERE code = ${code}`)
    ).rows.map((row) => (row as { context: Record<string, unknown> }).context);
  }

  /** A live service of `customer` with a subscription link, on `panel`. */
  async function liveService(owner = customerId, panel = panelId, link?: string) {
    const id = await fixtures.service({ customerId: owner, panelId: panel });
    const url = link ?? `https://sub.example.test/s/${id.replace(/-/g, '').slice(-12)}`;
    await db().execute(sql`UPDATE services SET subscription_url = ${url} WHERE id = ${id}`);
    const [row] = (
      await db().execute(sql`SELECT provider_username, order_id FROM services WHERE id = ${id}`)
    ).rows as { provider_username: string; order_id: string }[];
    return { id, url, username: row!.provider_username, orderId: row!.order_id };
  }

  /** One payment of `owner`, written as a state the product could have produced. */
  async function payment(input: {
    readonly owner?: string;
    readonly state: 'PENDING' | 'CONFIRMED' | 'FAILED';
    readonly orderId?: string | null;
    readonly code: string;
    readonly signalled?: boolean;
  }) {
    const id = ctx.container.ids.uuid();
    const confirmed = input.state === 'CONFIRMED';
    await db().execute(sql`INSERT INTO payments
        (id, tenant_id, customer_id, order_id, method, state, amount, currency, reference,
         confirmed_at, evidence_kind, resolved_at, expires_at, code, customer_signalled_at)
        VALUES (${id}, ${SEED_IDS.tenantA}, ${input.owner ?? customerId}, ${input.orderId ?? null},
                'MANUAL_TRANSFER', ${input.state}, 250000, 'IRT', ${key('ref')},
                ${confirmed ? new Date() : null}, ${confirmed ? 'OPERATOR_REVIEW' : null},
                ${input.state === 'FAILED' ? new Date() : null}, ${new Date(Date.now() + 3_600_000)},
                ${input.code}, ${input.signalled === true ? new Date() : null})`);
    return id;
  }

  /** The context the stub source returns: the payload JSON the model reads, and the alias map. */
  function showServices(...services: { alias: string; id: string; username: string }[]) {
    references = {
      services: new Map(services.map((s) => [s.alias, s.id])),
      catalogue: references.catalogue,
    };
    contextJson = JSON.stringify({
      services: services.map((s) => ({ alias: s.alias, label: s.username })),
    });
  }

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
    fixtures = new AudienceFixtures(ctx, SEED_IDS.tenantA);
    customerId = await fixtures.customer({ telegramUserId: CUSTOMER });
    panelId = await fixtures.panel();
    await configure({
      mode: 'AUTO_REPLY_SAFE',
      primary: { provider: 'OPENAI', model: 'gpt-5.5' },
      autoTopics: [...SUPPORT_AI_SAFE_TOPICS],
      autoMinConfidence: 'MEDIUM',
    });
    outputs = [reply];
    calls = 0;
    offset = 0;
    toasts = [];
    tools = { actions: true, label: false, feedback: true };
    trialEligible = true;
    references = { services: new Map(), catalogue: new Map() };
    contextJson = '{"services":[]}';
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
          const output = outputs[Math.min(calls - 1, outputs.length - 1)] ?? reply;
          const outcome: SupportAiOutcome = {
            outcome: 'OK',
            output,
            usage: { inputTokens: 1, outputTokens: 1 },
            model: 'gpt-5.5',
          };
          return {
            outcome,
            step: { provider: 'OPENAI', model: 'gpt-5.5' },
            attempts: 1,
            exhausted: null,
            imagesSent: 0,
            sight: { seen: [], unseen: new Map() },
          };
        },
        visionStepConfigured: () => false,
      },
      images: { load: async () => ({ outcome: 'SKIPPED', reason: 'NOT_ANSWERED' }) as never },
      ids: c.ids,
      context: {
        build: async () => ({
          json: contextJson,
          aliases: new Map([...references.services.keys()].map((alias) => [alias, alias])),
          knowledgeAliases: new Map(),
          linked: flags.identityLinked,
          flags,
          references,
        }),
      },
      conversations,
      messages: new DrizzleBusinessMessageRepository(c.database.db),
      outbound,
      facts: new DrizzleSupportContextReader(c.database.db),
      control: c.businessConversations,
      uow: c.uow,
      scopeActivity: c.tenants,
      clock: c.clock,
      templates: c.templateResolver,
      bots: { usernameOf: async () => 'nexa_test_bot' },
      opsLog: c.opsLog,
      tools: {
        reader: new DrizzleSupportAiToolReader({
          db: c.database.db,
          filesOnly: {
            isFilesOnly: async (_scope, id) =>
              (
                (await db().execute(sql`SELECT files_only_delivery FROM panels WHERE id = ${id}`))
                  .rows[0] as { files_only_delivery: boolean } | undefined
              )?.files_only_delivery !== false,
          },
          trials: { eligibleForSupportOffer: async () => trialEligible },
          products: { findById: async () => null },
        }),
        settings: { read: async () => tools },
        jobs,
      },
    });
    loop = new AssistantLoop(c.supportAssist, {
      auto,
      scope: () => scopeA,
      intervalMs: 1000,
      now: () => new Date(Date.now() + offset),
      logger: c.logger,
    });
    transport = new RecordingTransport();
    lane = new BusinessOutboundService({
      outbound,
      conversations,
      messages: new DrizzleBusinessMessageRepository(c.database.db),
      control: c.businessConversations,
      transport,
      autoMode: new SupportAutoEnqueuer({ configs, jobs, ids: c.ids }),
      templates: c.templateResolver,
      escalations: new DrizzleBusinessEscalationRepository(c.database.db),
      uow: c.uow,
      scopeActivity: c.tenants,
      clock: c.clock,
      ids: c.ids,
      logger: c.logger,
    });
    callbacks = new SupportAiCallbackService({
      outbound,
      conversations,
      connections: new DrizzleBusinessConnectionRepository(c.database.db),
      jobs,
      control: c.businessConversations,
      acknowledge: async (_scope, input) => {
        toasts.push(input.toastKey);
      },
      uow: c.uow,
      scopeActivity: c.tenants,
      clock: c.clock,
    });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const link = (target: string) => ({
    ...reply,
    action: { kind: 'SEND_SUBSCRIPTION_LINK', target },
  });

  // --- the owner's switches ---------------------------------------------------------------

  it('ships OFF: the real settings read actions off, label off, feedback on', async () => {
    const read = await new SettingsSupportAiToolSettings(ctx.container.settingsResolver).read(
      scopeA,
    );
    expect(read).toEqual({ actions: false, label: false, feedback: true });
  });

  it('tools off: an action in the decision is ignored — the reply goes as text, no buttons', async () => {
    tools = { actions: false, label: false, feedback: true };
    const service = await liveService();
    showServices({ alias: 'S1', id: service.id, username: service.username });
    const id = await turn('لینکمو بفرست', link('S1'));
    expect(await autoJobs(id)).toMatchObject([
      { state: 'SENT', outcome: 'sent', tool_action: null },
    ]);
    await deliver();
    expect(transport.sent).toEqual([{ chatId: CUSTOMER, text: reply.replyText, buttons: null }]);
  });

  // --- get_subscription_link ----------------------------------------------------------------

  it('sends a linked customer their own link, logged by service username, with the human and 👍/👎 buttons bound to the row', async () => {
    const service = await liveService();
    showServices({ alias: 'S1', id: service.id, username: service.username });
    const id = await turn('لینکمو بفرست', link('S1'));
    expect(await autoJobs(id)).toMatchObject([
      { state: 'SENT', outcome: 'sent', tool_action: 'SEND_SUBSCRIPTION_LINK' },
    ]);
    await deliver();
    const [sent] = transport.sent;
    expect(sent?.text).toContain(reply.replyText);
    expect(sent?.text).toContain(service.url);
    expect(sent?.text).toContain(service.username);
    expect(sent?.text).toContain('مشکل حل شد؟');
    const [row] = (
      await db().execute(
        sql`SELECT id FROM business_outbound_messages WHERE conversation_id = ${id} AND origin = 'AUTO'`,
      )
    ).rows as { id: string }[];
    expect(sent?.buttons).toEqual([
      [
        { label: '👍', url: null, callbackData: supportAiCallbackData('yes', row!.id) },
        { label: '👎', url: null, callbackData: supportAiCallbackData('no', row!.id) },
      ],
      [
        {
          label: '👤 پشتیبان انسانی',
          url: null,
          callbackData: supportAiCallbackData('human', row!.id),
        },
      ],
    ]);
    const [event] = await opsEvents('support.ai.subscription_link_sent');
    expect(event).toMatchObject({
      customerId,
      conversationId: id,
      serviceUsername: service.username,
    });
    expect(JSON.stringify(event)).not.toContain(service.url);
  });

  it('a «فقط فایل» panel: never the link — a button into the service card in the bot', async () => {
    await db().execute(sql`UPDATE panels SET files_only_delivery = true WHERE id = ${panelId}`);
    const service = await liveService();
    showServices({ alias: 'S1', id: service.id, username: service.username });
    const id = await turn('لینکمو بفرست', link('S1'));
    expect(await outcomes(id)).toEqual(['sent']);
    await deliver();
    const [sent] = transport.sent;
    expect(sent?.text).not.toContain(service.url);
    expect(sent?.text).toContain('فایل');
    expect(sent?.buttons?.[0]).toEqual([
      {
        label: '📄 باز کردن سرویس در ربات',
        url: `https://t.me/nexa_test_bot?start=sai-sv-${service.id}`,
        callbackData: null,
      },
    ]);
  });

  // --- tool scoping (cross-cutting item 1) ------------------------------------------------

  it('a target the payload did not show is refused: regenerated once, then a soft handoff, nothing sent', async () => {
    const service = await liveService();
    showServices({ alias: 'S1', id: service.id, username: service.username });
    const id = await turn('لینک سرویس دوم رو بده', link('S2'), link('S2'));
    expect(calls).toBe(2);
    expect(await autoJobs(id)).toMatchObject([
      {
        state: 'FAILED',
        outcome: 'guard_tool_scope',
        handoff_reason: 'INSUFFICIENT_GROUNDING',
        tool_action: 'SEND_SUBSCRIPTION_LINK',
      },
    ]);
    await deliver();
    expect(transport.sent.map((m) => m.text).join('\n')).not.toContain(service.url);
  });

  it('a model-supplied id (another customer’s service UUID) is refused; a regenerated alias is served', async () => {
    const stranger = await fixtures.customer({ telegramUserId: STRANGER });
    const theirs = await liveService(stranger);
    const mine = await liveService();
    showServices({ alias: 'S1', id: mine.id, username: mine.username });
    const id = await turn('لینک سرویس برادرم رو بده', link(theirs.id.slice(0, 4)), link('S1'));
    expect(calls).toBe(2);
    expect(await outcomes(id)).toEqual(['sent']);
    await deliver();
    expect(transport.sent[0]?.text).toContain(mine.url);
    expect(transport.sent.map((m) => m.text).join('\n')).not.toContain(theirs.url);
  });

  it('the reader is scoped too: an alias the map wrongly pointed at another customer’s service yields nothing', async () => {
    const stranger = await fixtures.customer({ telegramUserId: STRANGER });
    const theirs = await liveService(stranger);
    showServices({ alias: 'S1', id: theirs.id, username: theirs.username });
    const id = await turn('لینکمو بفرست', link('S1'), link('S1'));
    expect(await autoJobs(id)).toMatchObject([{ state: 'FAILED', outcome: 'guard_tool_scope' }]);
    await deliver();
    expect(transport.sent.map((m) => m.text).join('\n')).not.toContain(theirs.url);
  });

  it('the validator allows the customer’s own link only when the tool sends it', async () => {
    const service = await liveService();
    showServices({ alias: 'S1', id: service.id, username: service.username });
    // The same link typed into the model's own reply, with no tool: refused, then a handoff.
    const leaked = {
      ...reply,
      replyText: `لینک شما: ${service.url}`,
      action: { kind: 'NONE', target: '' },
    };
    const id = await turn('لینکمو بفرست', leaked, leaked);
    expect(await autoJobs(id)).toMatchObject([
      { state: 'FAILED', outcome: 'guard_output_policy', handoff_reason: 'OUTPUT_POLICY' },
    ]);
    await deliver();
    expect(transport.sent.map((m) => m.text).join('\n')).not.toContain(service.url);
  });

  // --- the tool-call limit (cross-cutting item 7) -----------------------------------------

  it(`more than ${String(SUPPORT_AI_TOOL_CALL_LIMIT)} tool calls in an epoch: tools stop, a soft handoff, the probing signal with the customer’s code only`, async () => {
    const service = await liveService();
    showServices({ alias: 'S1', id: service.id, username: service.username });
    const id = await turn('لینکمو بفرست', link('S1'));
    await deliver();
    const epoch = (await conversation(id)).controlEpoch;
    // Earlier tool calls of this epoch (already answered jobs).
    for (let i = 1; i < SUPPORT_AI_TOOL_CALL_LIMIT; i += 1) {
      await db().execute(sql`INSERT INTO support_ai_jobs
          (id, tenant_id, kind, conversation_id, idempotency_key, state, outcome, control_epoch,
           tool_action, trigger_telegram_message_id, trigger_content_version, due_at,
           created_at, updated_at)
          VALUES (${ctx.container.ids.uuid()}, ${SEED_IDS.tenantA}, 'AUTO_DECISION', ${id},
                  ${key('seed-job')}, 'DISCARDED', 'dropped_coalesced', ${epoch}, 'RENEW',
                  ${10_000 + i}, 1, now() - interval '1 hour',
                  now() - interval '1 hour', now() - interval '1 hour')`);
    }
    await turn('دوباره لینک رو بفرست', link('S1'));
    expect((await autoJobs(id)).at(-1)).toMatchObject({
      state: 'FAILED',
      outcome: 'guard_tool_rate_limit',
      handoff_reason: 'SUSPICIOUS_PROBING',
    });
    expect((await conversation(id)).handoffKind).toBe('SOFT');
    const [event] = await opsEvents('support.ai.suspicious_probing');
    expect(Object.keys(event ?? {}).sort()).toEqual(['conversationId', 'customerId']);
    expect(JSON.stringify(event)).not.toContain('لینک');
  });

  // --- deep links ------------------------------------------------------------------------

  it('renew: a URL button into the bot’s renewal of that service; nothing is renewed', async () => {
    const service = await liveService();
    showServices({ alias: 'S1', id: service.id, username: service.username });
    const id = await turn('تمدید کنم', {
      ...reply,
      topic: 'RENEWAL_INFO',
      replyText: 'با دکمهٔ زیر سرویس را در ربات تمدید کنید.',
      action: { kind: 'RENEW', target: 'S1' },
    });
    expect(await autoJobs(id)).toMatchObject([{ outcome: 'sent', tool_action: 'RENEW' }]);
    await deliver();
    expect(transport.sent[0]?.buttons?.[0]).toEqual([
      {
        label: '💊 تمدید سرویس در ربات',
        url: `https://t.me/nexa_test_bot?start=sai-rn-${service.id}`,
        callbackData: null,
      },
    ]);
    const [orders] = (
      await db().execute(sql`SELECT count(*)::int AS n FROM orders WHERE purpose = 'RENEW'`)
    ).rows as { n: number }[];
    expect(orders?.n).toBe(0);
  });

  const trial = {
    ...reply,
    topic: 'TRIAL_INFO',
    factRefs: [],
    replyText: 'با دکمهٔ زیر سرویس تست بگیرید.',
    action: { kind: 'TRIAL', target: '' },
  };

  it('trial: an ineligible customer gets no trial button (eligibility first)', async () => {
    trialEligible = false;
    const id = await turn('تست رایگان دارید؟', trial, trial);
    expect(await autoJobs(id)).toMatchObject([{ state: 'FAILED', outcome: 'guard_tool_scope' }]);
    await deliver();
    expect(transport.sent.map((m) => JSON.stringify(m.buttons)).join('')).not.toContain('sai-t');
  });

  it('trial: an eligible customer gets the button into the bot’s trial', async () => {
    const id = await turn('تست میخوام', trial);
    expect(await autoJobs(id)).toMatchObject([{ outcome: 'sent', tool_action: 'TRIAL' }]);
    await deliver();
    expect(transport.sent[0]?.buttons?.[0]?.[0]?.url).toBe(
      'https://t.me/nexa_test_bot?start=sai-t',
    );
  });

  it('an unlinked customer’s service action becomes the bot’s open button', async () => {
    flags = { ...flags, identityLinked: false };
    const id = await turn('چطوری تمدید کنم؟', {
      ...reply,
      topic: 'RENEWAL_INFO',
      factRefs: [],
      replyText: 'تمدید در ربات انجام می‌شود.',
      action: { kind: 'RENEW', target: 'S1' },
    });
    expect(await outcomes(id)).toEqual(['sent']);
    await deliver();
    expect(transport.sent[0]?.buttons?.[0]).toEqual([
      { label: '🤖 ورود به ربات', url: 'https://t.me/nexa_test_bot', callbackData: null },
    ]);
  });

  // --- check-before-handoff («paid but not received») -------------------------------------

  it('under review: the facts in ONE message (the handoff’s notice), then a HARD handoff with the Persian summary', async () => {
    await payment({ state: 'PENDING', code: 'RVW23456', signalled: true });
    const id = await turn('پرداخت کردم ولی هنوز سرویس نیومد');
    expect(calls).toBe(0); // nothing for a model to say: the facts decide
    expect(await autoJobs(id)).toMatchObject([
      {
        state: 'FAILED',
        outcome: 'handoff_payment_checked',
        handoff_reason: 'HANDOFF_TOPIC',
        tool_action: 'PAYMENT_STATUS',
      },
    ]);
    expect(await conversation(id)).toMatchObject({
      state: 'HANDOFF_REQUIRED',
      handoffKind: 'HARD',
    });
    const escalation = await lastEscalation(id);
    expect(escalation?.summary).toContain('RVW23456');
    expect(escalation?.summary).toContain('در حال بررسی');
    expect(escalation?.summary).toContain('به مشتری گفته شد');
    await deliver();
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.text).toContain('RVW23456');
    expect(transport.sent[0]?.text).toContain('در حال بررسی است');
    expect(transport.sent[0]?.text).not.toMatch(/برمی‌گرد|بازگشت وجه|عودت|رایگان/u);
  });

  it('confirmed without a delivered service: told once, then a HARD handoff', async () => {
    const orderId = await fixtures.order({ customerId, panelId });
    await payment({ state: 'CONFIRMED', orderId, code: 'PND23456' });
    const id = await turn('پول کم شد ولی سرویس نیومد');
    expect(await outcomes(id)).toEqual(['handoff_payment_checked']);
    expect((await conversation(id)).handoffKind).toBe('HARD');
    await deliver();
    expect(transport.sent[0]?.text).toContain('PND23456');
    expect(transport.sent[0]?.text).toContain('تأیید شده');
  });

  it('confirmed and delivered: the service’s link with «مشکل حل شد؟»; a thanks closes it, no handoff', async () => {
    const service = await liveService();
    await payment({ state: 'CONFIRMED', orderId: service.orderId, code: 'DKV23456' });
    const id = await turn('خرید کردم ولی هنوز لینک نیومد');
    expect(await autoJobs(id)).toMatchObject([
      { state: 'SENT', outcome: 'sent_payment_delivered', tool_action: 'PAYMENT_STATUS' },
    ]);
    expect(await conversation(id)).toMatchObject({ state: 'AI_ACTIVE' });
    await deliver();
    expect(transport.sent[0]?.text).toContain('DKV23456');
    expect(transport.sent[0]?.text).toContain(service.url);
    expect(transport.sent[0]?.text).toContain('مشکل حل شد؟');
    expect((await opsEvents('support.ai.subscription_link_sent'))[0]).toMatchObject({
      serviceUsername: service.username,
    });
    await turn('مرسی درست شد');
    expect(await outcomes(id)).toEqual(['sent_payment_delivered', 'no_action']);
    expect(await conversation(id)).toMatchObject({ state: 'AI_ACTIVE' });
  });

  it('confirmed and delivered, not confirmed solved: the next message hands off HARD with the summary', async () => {
    const service = await liveService();
    await payment({ state: 'CONFIRMED', orderId: service.orderId, code: 'DKV34567' });
    const id = await turn('پرداخت کردم ولی نیومد');
    await deliver();
    await turn('نه هنوز وصل نمیشه');
    expect(await outcomes(id)).toEqual(['sent_payment_delivered', 'handoff_payment_checked']);
    expect((await conversation(id)).handoffKind).toBe('HARD');
    expect((await lastEscalation(id))?.summary).toContain('DKV34567');
    expect((await lastEscalation(id))?.summary).toContain('تأیید نکرد');
  });

  it('nothing found: ONE question; the answer goes to a person, HARD, and no second question', async () => {
    const id = await turn('پرداخت کردم ولی نیومد');
    expect(await outcomes(id)).toEqual(['sent_payment_ask']);
    await deliver();
    expect(transport.sent[0]?.text).toContain('کد پیگیری');
    await turn('ساعت ۱۰ صبح کارت به کارت کردم ۲۵۰ هزار');
    expect(await outcomes(id)).toEqual(['sent_payment_ask', 'handoff_payment_checked']);
    expect(await conversation(id)).toMatchObject({
      state: 'HANDOFF_REQUIRED',
      handoffKind: 'HARD',
    });
    const summary = (await lastEscalation(id))?.summary ?? '';
    expect(summary).toContain('هیچ پرداختی پیدا نشد');
    // The customer's own words stay in the transcript, never in the note.
    expect(summary).not.toContain('ساعت ۱۰');
    expect(calls).toBe(0);
  });

  it('someone else’s payment: its code in the message reads nothing — the check sees only this customer', async () => {
    const stranger = await fixtures.customer({ telegramUserId: STRANGER });
    await payment({ owner: stranger, state: 'PENDING', code: 'XTH23456', signalled: true });
    const id = await turn('پرداخت کردم با کد XTH23456 ولی نیومد، مال برادرمه');
    expect(await outcomes(id)).toEqual(['sent_payment_ask']);
    await deliver();
    const told = transport.sent.map((m) => m.text).join('\n');
    expect(told).not.toContain('در حال بررسی است');
    expect(told).not.toMatch(/XTH23456.*(در حال|تأیید)/u);
    await turn('کدش XTH23456 بود');
    expect((await lastEscalation(id))?.summary).not.toContain('XTH23456');
  });

  it('an unlinked customer: the bot link and a HARD handoff', async () => {
    flags = { ...flags, identityLinked: false };
    await db().execute(sql`DELETE FROM customers WHERE id = ${customerId}`);
    const id = await turn('پرداخت کردم ولی هیچی نیومد');
    expect(await outcomes(id)).toEqual(['handoff_payment_checked']);
    expect((await conversation(id)).handoffKind).toBe('HARD');
    expect((await lastEscalation(id))?.summary).toContain('وصل نیست');
    await deliver();
    expect(transport.sent[0]?.text).toContain('https://t.me/nexa_test_bot?start=support');
    expect(transport.sent[0]?.buttons).toEqual([
      [
        {
          label: '🤖 ورود به ربات',
          url: 'https://t.me/nexa_test_bot?start=support',
          callbackData: null,
        },
      ],
    ]);
  });

  it('a refund demand is still a straight hard handoff: nothing is checked', async () => {
    await payment({ state: 'PENDING', code: 'RFD23456', signalled: true });
    const id = await turn('پولمو پس بدید');
    expect(await autoJobs(id)).toMatchObject([
      { outcome: 'guard_handoff_topic', handoff_reason: 'HANDOFF_TOPIC', tool_action: null },
    ]);
    await deliver();
    expect(transport.sent.map((m) => m.text).join('\n')).not.toContain('RFD23456');
  });

  it('tools off: «paid but not received» hands off exactly as before, with no check', async () => {
    tools = { actions: false, label: false, feedback: true };
    await payment({ state: 'PENDING', code: 'XFF23456', signalled: true });
    const id = await turn('پرداخت کردم ولی نیومد');
    expect(await outcomes(id)).toEqual(['guard_handoff_topic']);
  });

  // --- buttons and their binding ----------------------------------------------------------

  /** A delivered AI message of this chat, and the tap on it, as Telegram would send it. */
  async function deliveredReply() {
    const service = await liveService();
    showServices({ alias: 'S1', id: service.id, username: service.username });
    const id = await turn('لینکمو بفرست', link('S1'));
    await deliver();
    const [row] = (
      await db().execute(
        sql`SELECT id, telegram_message_id FROM business_outbound_messages
            WHERE conversation_id = ${id} AND origin = 'AUTO'`,
      )
    ).rows as { id: string; telegram_message_id: number }[];
    const tap = (action: 'yes' | 'no' | 'human', overrides: Record<string, unknown> = {}) =>
      callbacks.handle(scopeA, {
        botInstanceId: BOT,
        callback: {
          callbackQueryId: key('cq'),
          data: supportAiCallbackData(action, row!.id),
          fromUserId: CUSTOMER,
          chatId: CUSTOMER,
          messageId: Number(row!.telegram_message_id),
          connectionId: 'conn-1',
          ...overrides,
        },
      });
    return { id, rowId: row!.id, tap };
  }

  it('«👤 پشتیبان انسانی»: a HARD handoff on tap', async () => {
    const { id, tap } = await deliveredReply();
    expect(await tap('human')).toBe('HUMAN');
    expect(await conversation(id)).toMatchObject({
      state: 'HANDOFF_REQUIRED',
      handoffReason: 'HUMAN_REQUESTED',
      handoffKind: 'HARD',
    });
    expect(toasts).toEqual(['bot.support.ai_human_requested']);
  });

  it('a forged tap — another chat, another user, another message, another connection — changes nothing', async () => {
    const { id, rowId, tap } = await deliveredReply();
    expect(await tap('human', { chatId: STRANGER, fromUserId: STRANGER })).toBe('REFUSED');
    expect(await tap('human', { fromUserId: STRANGER })).toBe('REFUSED');
    expect(await tap('human', { chatId: STRANGER })).toBe('REFUSED');
    expect(await tap('no', { messageId: 1 })).toBe('REFUSED');
    expect(await tap('human', { connectionId: 'conn-other' })).toBe('REFUSED');
    expect(
      await callbacks.handle(scopeA, {
        botInstanceId: BOT,
        callback: {
          callbackQueryId: key('cq'),
          data: `sai:h:${ctx.container.ids.uuid()}`,
          fromUserId: CUSTOMER,
          chatId: CUSTOMER,
          messageId: 901,
          connectionId: 'conn-1',
        },
      }),
    ).toBe('REFUSED');
    expect(await conversation(id)).toMatchObject({ state: 'AI_ACTIVE' });
    const [row] = (
      await db().execute(sql`SELECT feedback FROM business_outbound_messages WHERE id = ${rowId}`)
    ).rows as { feedback: string | null }[];
    expect(row?.feedback).toBeNull();
    expect(new Set(toasts)).toEqual(new Set(['bot.support.ai_callback_stale']));
  });

  it('👎: a SOFT handoff with the answer’s topic and intent (the knowledge-gap entry); 👍 recorded once', async () => {
    const { id, rowId, tap } = await deliveredReply();
    expect(await tap('no')).toBe('FEEDBACK_DOWN');
    expect(await conversation(id)).toMatchObject({
      state: 'HANDOFF_REQUIRED',
      handoffReason: 'CUSTOMER_UNSATISFIED',
      handoffKind: 'SOFT',
    });
    expect(await lastEscalation(id)).toMatchObject({
      reason: 'CUSTOMER_UNSATISFIED',
      topic: 'GET_SUBSCRIPTION_LINK',
      intent: 'لینک اشتراک',
    });
    // The first tap wins; a 👍 after it records nothing.
    await tap('yes');
    const [row] = (
      await db().execute(sql`SELECT feedback FROM business_outbound_messages WHERE id = ${rowId}`)
    ).rows as { feedback: string | null }[];
    expect(row?.feedback).toBe('DOWN');
  });

  it('👎 under check-before-handoff’s delivered link hands off HARD', async () => {
    const service = await liveService();
    await payment({ state: 'CONFIRMED', orderId: service.orderId, code: 'DKV45678' });
    const id = await turn('پرداخت کردم ولی نیومد');
    await deliver();
    const [row] = (
      await db().execute(
        sql`SELECT id, telegram_message_id FROM business_outbound_messages
            WHERE conversation_id = ${id} AND origin = 'AUTO'`,
      )
    ).rows as { id: string; telegram_message_id: number }[];
    await callbacks.handle(scopeA, {
      botInstanceId: BOT,
      callback: {
        callbackQueryId: key('cq'),
        data: supportAiCallbackData('no', row!.id),
        fromUserId: CUSTOMER,
        chatId: CUSTOMER,
        messageId: Number(row!.telegram_message_id),
        connectionId: 'conn-1',
      },
    });
    expect((await conversation(id)).handoffKind).toBe('HARD');
  });

  it('the label line opens every reply when the owner turns it on', async () => {
    tools = { actions: false, label: true, feedback: true };
    const id = await turn('سلام', {
      ...reply,
      topic: 'GREETING',
      factRefs: [],
      replyText: 'سلام، در خدمتم.',
    });
    expect(await outcomes(id)).toEqual(['sent']);
    await deliver();
    expect(transport.sent[0]?.text).toBe('🤖 پاسخ هوش مصنوعی\n\nسلام، در خدمتم.');
    expect(transport.sent[0]?.buttons).toBeNull();
  });

  // --- voice, stickers, files --------------------------------------------------------------

  it('a voice message or sticker: one templated request to type, and the AI keeps the chat', async () => {
    const recorded = await record(message({ kind: 'OTHER', text: null }));
    await tick();
    const id = recorded.conversationId;
    expect(await outcomes(id)).toEqual(['sent_unsupported_content']);
    expect(await conversation(id)).toMatchObject({ state: 'AI_ACTIVE' });
    expect(calls).toBe(0);
    await deliver();
    expect(transport.sent[0]?.text).toContain('به‌صورت متن بنویسید');
  });

  it('tools off: a voice message still hands off as unreadable content', async () => {
    tools = { actions: false, label: false, feedback: true };
    const recorded = await record(message({ kind: 'OTHER', text: null }));
    await tick();
    expect(await autoJobs(recorded.conversationId)).toMatchObject([
      { outcome: 'guard_content', handoff_reason: 'UNSUPPORTED_CONTENT' },
    ]);
  });

  // --- review of PR #369 --------------------------------------------------------------------

  it('a payment-status question is answered by the payment_status tool from facts, no promise', async () => {
    await payment({ state: 'PENDING', code: 'STA23456', signalled: true });
    const status = {
      ...reply,
      topic: 'PAYMENT_STATUS',
      factRefs: [],
      replyText: 'وضعیت پرداخت‌های اخیر شما:',
      action: { kind: 'PAYMENT_STATUS', target: '' },
    };
    const id = await turn('وضعیت پرداخت من چیه؟', status);
    expect(await autoJobs(id)).toMatchObject([
      { state: 'SENT', outcome: 'sent', tool_action: 'PAYMENT_STATUS' },
    ]);
    expect(await conversation(id)).toMatchObject({ state: 'AI_ACTIVE' });
    await deliver();
    expect(transport.sent[0]?.text).toContain('STA23456');
    expect(transport.sent[0]?.text).toContain('در حال بررسی');
    expect(transport.sent[0]?.text).not.toMatch(/برمی‌گرد|بازگشت وجه|عودت/u);
  });

  it('tools off: the same payment-status question hands off as before', async () => {
    tools = { actions: false, label: false, feedback: true };
    const id = await turn('وضعیت پرداخت من چیه؟', {
      ...reply,
      topic: 'PAYMENT_STATUS',
      factRefs: [],
      action: { kind: 'PAYMENT_STATUS', target: '' },
    });
    expect(await outcomes(id)).toEqual(['guard_handoff_topic']);
  });

  it('a wallet top-up how-to gets the top-up button; a wallet balance question still hands off', async () => {
    const topup = {
      ...reply,
      topic: 'WALLET',
      factRefs: [],
      replyText: 'با دکمهٔ زیر کیف پول را در ربات شارژ کنید.',
      action: { kind: 'WALLET_TOPUP', target: '' },
    };
    const id = await turn('چطوری کیف پولمو شارژ کنم؟', topup);
    expect(await autoJobs(id)).toMatchObject([{ outcome: 'sent', tool_action: 'WALLET_TOPUP' }]);
    await deliver();
    expect(transport.sent[0]?.buttons?.[0]?.[0]?.url).toBe(
      'https://t.me/nexa_test_bot?start=sai-w',
    );
    const balance = await turn('موجودی کیف پولم چقدره؟', {
      ...topup,
      action: { kind: 'NONE', target: '' },
    });
    expect((await autoJobs(balance)).at(-1)).toMatchObject({ outcome: 'guard_handoff_topic' });
  });

  it('a PDF or voice answer to the receipt question goes to a person with the summary, never «please type»', async () => {
    const id = await turn('پرداخت کردم ولی نیومد');
    expect(await outcomes(id)).toEqual(['sent_payment_ask']);
    await deliver();
    await record(message({ kind: 'OTHER', text: null }));
    await tick();
    expect(await outcomes(id)).toEqual(['sent_payment_ask', 'handoff_payment_checked']);
    expect(await conversation(id)).toMatchObject({
      state: 'HANDOFF_REQUIRED',
      handoffKind: 'HARD',
    });
    expect((await lastEscalation(id))?.summary).toContain('هیچ پرداختی پیدا نشد');
    await deliver();
    expect(transport.sent.map((m) => m.text).join('\n')).not.toContain('به‌صورت متن بنویسید');
  });

  it('the unlinked account-link reply carries the label and the human button like every reply', async () => {
    tools = { actions: true, label: true, feedback: true };
    flags = { ...flags, identityLinked: false };
    const id = await turn('حجمم چقدر مونده؟', {
      ...reply,
      topic: 'TRAFFIC_AND_EXPIRY',
      factRefs: [],
      replyText: 'x',
    });
    expect(await outcomes(id)).toEqual(['sent_link']);
    await deliver();
    const [sent] = transport.sent;
    expect(sent?.text.startsWith('🤖 پاسخ هوش مصنوعی')).toBe(true);
    expect(sent?.text).toContain('https://t.me/nexa_test_bot?start=support');
    expect(sent?.buttons?.flat().map((b) => b.label)).toEqual([
      '🤖 ورود به ربات',
      '👤 پشتیبان انسانی',
    ]);
  });
});
