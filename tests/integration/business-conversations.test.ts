import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  isNexaError,
  systemJobActor,
  type ActorContext,
  type BusinessBotRight,
  type CorrelationId,
} from '@nexa/contracts';
import { BusinessOutboundService } from '../../apps/api/src/modules/commerce/business-chats/application/business-outbound.service';
import type { BusinessSendOutcome } from '../../apps/api/src/modules/commerce/business-chats/application/business-transport';
import {
  DrizzleBusinessConversationRepository,
  DrizzleBusinessEscalationRepository,
  DrizzleBusinessMessageRepository,
  DrizzleBusinessOutboundRepository,
} from '../../apps/api/src/modules/commerce/business-chats/infrastructure/drizzle-business-conversation.repository';
import type { ParsedBusinessMessage } from '../../apps/api/src/modules/commerce/business-chats/domain/telegram-business';
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
 * TB2 — conversations, human takeover and the outbound lane against a real database
 * (ADR-0033 §4–§8, the continuation program §32).
 *
 * The six mandated races are named R1–R6 below. Telegram is a scripted transport; what runs
 * for real is the lock, the epoch, the conditional transitions and the lane's three
 * transactions.
 */

const BOT = SEED_IDS.botA1;
const OWNER = '5000001';
const CUSTOMER = '7000001';
const OUR_BOT = '9000001';
const scopeA = { ...tenantA, botInstanceId: BOT } as never;

class ScriptedTransport {
  sent: { chatId: string; text: string }[] = [];
  next: BusinessSendOutcome[] = [];
  nextMessageId = 500;
  /** Runs while the send is in flight: outside every lane transaction, as Telegram would. */
  during: (() => Promise<void>) | null = null;
  async sendText(_scope: unknown, _actor: unknown, input: { chatId: string; text: string }) {
    this.sent.push({ chatId: input.chatId, text: input.text });
    const during = this.during;
    this.during = null;
    if (during !== null) await during();
    const scripted = this.next.shift();
    if (scripted !== undefined) return scripted;
    this.nextMessageId += 1;
    return { outcome: 'DELIVERED' as const, messageId: this.nextMessageId, sentAt: null };
  }
}

describe('Telegram Business conversations (TB2)', () => {
  let ctx: TestContext;
  let operator: ActorContext;
  let transport: ScriptedTransport;
  let lane: BusinessOutboundService;
  let outbound: DrizzleBusinessOutboundRepository;
  let conversations: DrizzleBusinessConversationRepository;
  let messageSeq = 100;
  let keySeq = 0;
  const key = (label: string) => `${label}-${Date.now()}-${(keySeq += 1)}`;
  const system = () => systemJobActor('business-test', 'test-correlation' as CorrelationId);

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

  const record = (m: ParsedBusinessMessage, edited = false, k = key('update')) =>
    ctx.container.businessConversations.recordMessage(scopeA, system(), {
      idempotencyKey: k,
      botInstanceId: BOT,
      message: m,
      edited,
    });

  const fromOwner = (overrides: Partial<ParsedBusinessMessage> = {}) =>
    message({ fromUserId: OWNER, text: 'سلام، من پشتیبان هستم', ...overrides });

  async function conversation(id: string) {
    const found = await conversations.findById(scopeA, id);
    if (found === null) throw new Error('conversation missing');
    return found;
  }

  /** An AUTO row as TB7 will create it: under the epoch it saw, while AI_ACTIVE. */
  async function queueAuto(conversationId: string, epoch: number) {
    return ctx.container.uow.run(scopeA, async (tx) =>
      outbound.insert(
        scopeA,
        {
          id: ctx.container.ids.uuid(),
          conversationId,
          origin: 'AUTO',
          body: 'پاسخ پیشنهادی هوش مصنوعی',
          createdByAdminId: null,
          controlEpoch: epoch,
          idempotencyKey: key('auto'),
          requestHash: 'h',
          now: new Date(),
        },
        tx,
      ),
    );
  }

  async function laneState(id: string) {
    return (await outbound.findById(scopeA, id))?.state;
  }

  beforeEach(async () => {
    ctx ??= await createTestContext();
    await ctx.reset();
    const c = ctx.container;
    await c.database.db.execute(
      sql`UPDATE bot_instances SET telegram_bot_id = ${OUR_BOT} WHERE id = ${BOT}`,
    );
    await c.businessConnections.applyReport(scopeA, system(), {
      idempotencyKey: key('connect'),
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
    operator = adminActorFor(
      await createAdmin(c, tenantA, { username: 'support1', roleKeys: ['support'] }),
    );
    outbound = new DrizzleBusinessOutboundRepository(c.database.db);
    conversations = new DrizzleBusinessConversationRepository(c.database.db);
    transport = new ScriptedTransport();
    lane = new BusinessOutboundService({
      outbound,
      conversations,
      messages: new DrizzleBusinessMessageRepository(c.database.db),
      control: c.businessConversations,
      transport,
      // TB7: these races are about the epoch and the state, under a mode that allows AUTO.
      autoMode: { autoReplyEnabled: async () => true },
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

  it('records a customer message in a new AI_ACTIVE conversation, and links the customer only by exact id', async () => {
    const recorded = await record(message());
    expect(recorded).toMatchObject({ origin: 'INBOUND', inserted: true, tookOver: false });
    let found = await conversation(recorded!.conversationId);
    expect(found).toMatchObject({
      state: 'AI_ACTIVE',
      controlEpoch: 0,
      customerId: null,
      peerTelegramUserId: CUSTOMER,
    });

    // A customer with the same USERNAME but another id is never linked.
    await ctx.container.database.db.execute(
      sql`INSERT INTO customers (id, tenant_id, telegram_user_id, username, status)
          VALUES (${ctx.container.ids.uuid()}, ${SEED_IDS.tenantA}, '7999999', 'same_name', 'ACTIVE')`,
    );
    await record(message());
    expect((await conversation(recorded!.conversationId)).customerId).toBeNull();

    // The exact Telegram id in THIS tenant links; the same id in another tenant never would.
    const customerId = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(
      sql`INSERT INTO customers (id, tenant_id, telegram_user_id, status)
          VALUES (${ctx.container.ids.uuid()}, ${SEED_IDS.tenantB}, ${CUSTOMER}, 'ACTIVE'),
                 (${customerId}, ${SEED_IDS.tenantA}, ${CUSTOMER}, 'ACTIVE')`,
    );
    await record(message());
    found = await conversation(recorded!.conversationId);
    expect(found.customerId).toBe(customerId);
  });

  it('never creates a customer from a business message', async () => {
    await record(message());
    const rows = await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM customers`,
    );
    expect((rows.rows[0] as { n: number }).n).toBe(0);
  });

  it('a message the owner types by hand takes the conversation: HUMAN_ACTIVE, epoch+1, audited', async () => {
    const first = await record(message());
    const human = await record(fromOwner());
    expect(human).toMatchObject({ origin: 'HUMAN', tookOver: true });
    const found = await conversation(first!.conversationId);
    expect(found).toMatchObject({
      state: 'HUMAN_ACTIVE',
      controlEpoch: 1,
      takeoverReason: 'HUMAN_MESSAGE',
    });
    const audit = await ctx.container.database.db.execute(
      sql`SELECT action FROM audit_logs WHERE entity_id = ${found.id} AND action = 'business_chat.human_takeover'`,
    );
    expect(audit.rows).toHaveLength(1);
  });

  it('our own echo, an away message and a later customer message do not take the conversation', async () => {
    const first = await record(message());
    expect((await record(fromOwner({ senderBusinessBotId: OUR_BOT })))!.origin).toBe('OWN_ECHO');
    expect((await record(fromOwner({ isFromOffline: true })))!.origin).toBe('OFFLINE');
    await record(message());
    expect(await conversation(first!.conversationId)).toMatchObject({
      state: 'AI_ACTIVE',
      controlEpoch: 0,
    });
  });

  it('another business bot speaking for the owner takes the conversation like a human', async () => {
    const first = await record(message());
    expect((await record(fromOwner({ senderBusinessBotId: '9000002' })))!.tookOver).toBe(true);
    expect(await conversation(first!.conversationId)).toMatchObject({
      state: 'HUMAN_ACTIVE',
      takeoverReason: 'OTHER_BOT',
    });
  });

  // R1 — a human before the AI job.
  it('R1: a human message before the AI reply is queued leaves the AI nothing it can send', async () => {
    const first = await record(message());
    await record(fromOwner());
    const found = await conversation(first!.conversationId);
    // TB7 would queue under the epoch it reads now — and an AUTO row needs AI_ACTIVE anyway.
    const row = await queueAuto(found.id, found.controlEpoch);
    expect(await lane.deliverOne(scopeA, row)).toBe('superseded');
    expect(transport.sent).toEqual([]);
  });

  // R2 — a human while provider work is pending.
  it('R2: a human message while the AI reply is being produced supersedes it before any send', async () => {
    const first = await record(message());
    const before = await conversation(first!.conversationId);
    const row = await queueAuto(before.id, before.controlEpoch);
    await record(fromOwner());
    // Superseded at once by the human signal, and refused again by the final check.
    expect(await laneState(row.id)).toBe('SUPERSEDED');
    await lane.deliverDue(scopeA);
    expect(transport.sent).toEqual([]);
  });

  // R3 — a human after the draft, before the send.
  it('R3: a draft that already passed every earlier check still loses to a human at the final check', async () => {
    const first = await record(message());
    const before = await conversation(first!.conversationId);
    const row = await queueAuto(before.id, before.controlEpoch);
    // The human signal lands after the row was claimed (the lane holds a stale copy).
    const [claimed] = await outbound.claimDue(scopeA, new Date(), new Date(Date.now() + 60_000), 5);
    expect(claimed?.id).toBe(row.id);
    await ctx.container.uow.run(scopeA, async (tx) => {
      await conversations.transition(
        scopeA,
        before.id,
        {
          from: ['AI_ACTIVE'],
          to: 'HUMAN_ACTIVE',
          bumpEpoch: true,
          takeoverReason: 'HUMAN_MESSAGE',
          now: new Date(),
        },
        tx,
      );
    });
    expect(await lane.deliverOne(scopeA, claimed!)).toBe('superseded');
    expect(transport.sent).toEqual([]);
  });

  // R4 — a duplicate outgoing owner update.
  it('R4: a redelivered owner message moves the epoch once', async () => {
    const first = await record(message());
    const owner = fromOwner();
    const k = key('dup');
    await record(owner, false, k);
    await record(owner, false, k);
    await record(owner, false, key('other-delivery-of-same-message'));
    expect(await conversation(first!.conversationId)).toMatchObject({
      state: 'HUMAN_ACTIVE',
      controlEpoch: 1,
    });
  });

  // R5 — resume invalidates the older epoch.
  it('R5: resuming the AI advances the epoch, so nothing queued while a human held it sends', async () => {
    const first = await record(message());
    const queued = await ctx.container.businessConversations.send(scopeA, operator, {
      conversationId: first!.conversationId,
      idempotencyKey: key('send'),
      text: 'لطفاً برنامه را یک بار ببندید و باز کنید',
    });
    const resumed = await ctx.container.businessConversations.resume(scopeA, operator, {
      conversationId: first!.conversationId,
      idempotencyKey: key('resume'),
    });
    expect(resumed).toEqual({ state: 'AI_ACTIVE', controlEpoch: 2 });
    expect(await laneState(queued.id)).toBe('SUPERSEDED');
    await lane.deliverDue(scopeA);
    expect(transport.sent).toEqual([]);
  });

  // R6 — a stale outbound row cannot send.
  it('R6: a row whose epoch is not the conversation’s is superseded at the final check, whatever its origin', async () => {
    const first = await record(message());
    const found = await conversation(first!.conversationId);
    const stale = await ctx.container.uow.run(scopeA, (tx) =>
      outbound.insert(
        scopeA,
        {
          id: ctx.container.ids.uuid(),
          conversationId: found.id,
          origin: 'OPERATOR',
          body: 'x',
          createdByAdminId: operator.id,
          controlEpoch: found.controlEpoch + 5,
          idempotencyKey: key('stale'),
          requestHash: 'h',
          now: new Date(),
        },
        tx,
      ),
    );
    expect(await lane.deliverOne(scopeA, stale)).toBe('superseded');
    expect(transport.sent).toEqual([]);
  });

  it('an operator’s send takes the conversation over, is delivered, and its echo is recognised as ours', async () => {
    const first = await record(message());
    const row = await ctx.container.businessConversations.send(scopeA, operator, {
      conversationId: first!.conversationId,
      idempotencyKey: key('send'),
      text: 'سلام، بررسی می‌کنم',
    });
    expect(await conversation(first!.conversationId)).toMatchObject({
      state: 'HUMAN_ACTIVE',
      takeoverReason: 'OPERATOR_SEND',
    });
    const report = await lane.deliverDue(scopeA);
    expect(report.delivered).toBe(1);
    expect(transport.sent).toEqual([{ chatId: CUSTOMER, text: 'سلام، بررسی می‌کنم' }]);
    const delivered = await outbound.findById(scopeA, row.id);
    expect(delivered?.state).toBe('DELIVERED');
    // The echo carries no bot field here; the send record alone proves it is ours.
    const echo = await record(
      fromOwner({ messageId: delivered!.telegramMessageId!, text: 'سلام، بررسی می‌کنم' }),
    );
    expect(echo?.origin).toBe('OWN_ECHO');
  });

  it('a second operator message while the conversation is already human does not supersede the first', async () => {
    const first = await record(message());
    const one = await ctx.container.businessConversations.send(scopeA, operator, {
      conversationId: first!.conversationId,
      idempotencyKey: key('one'),
      text: 'پیام اول',
    });
    await ctx.container.businessConversations.send(scopeA, operator, {
      conversationId: first!.conversationId,
      idempotencyKey: key('two'),
      text: 'پیام دوم',
    });
    expect(await laneState(one.id)).toBe('PENDING');
    await lane.deliverDue(scopeA);
    expect(transport.sent.map((s) => s.text)).toEqual(['پیام اول', 'پیام دوم']);
  });

  it('an operator send replays on its key and refuses the key with other text', async () => {
    const first = await record(message());
    const k = key('send');
    const a = await ctx.container.businessConversations.send(scopeA, operator, {
      conversationId: first!.conversationId,
      idempotencyKey: k,
      text: 'متن',
    });
    const b = await ctx.container.businessConversations.send(scopeA, operator, {
      conversationId: first!.conversationId,
      idempotencyKey: k,
      text: 'متن',
    });
    expect(b.id).toBe(a.id);
    await expect(
      ctx.container.businessConversations.send(scopeA, operator, {
        conversationId: first!.conversationId,
        idempotencyKey: k,
        text: 'متن دیگر',
      }),
    ).rejects.toSatisfy(isNexaError);
  });

  it('an AUTO send whose outcome is unknown is never resent, and hands the conversation to a person', async () => {
    const first = await record(message());
    const found = await conversation(first!.conversationId);
    const row = await queueAuto(found.id, found.controlEpoch);
    transport.next.push({ outcome: 'UNKNOWN', errorCode: 'telegram.unreachable' });
    await lane.deliverDue(scopeA);
    expect(await laneState(row.id)).toBe('UNCONFIRMED');
    expect(await conversation(found.id)).toMatchObject({
      state: 'HANDOFF_REQUIRED',
      handoffReason: 'SEND_OUTCOME_UNKNOWN',
    });
    await lane.deliverDue(scopeA);
    expect(transport.sent).toHaveLength(1);
  });

  it('a 429 requeues the row without spending an attempt, and it sends later', async () => {
    const first = await record(message());
    const found = await conversation(first!.conversationId);
    const row = await queueAuto(found.id, found.controlEpoch);
    transport.next.push({ outcome: 'RATE_LIMITED', retryAfterMs: 1 });
    await lane.deliverDue(scopeA);
    const held = await outbound.findById(scopeA, row.id);
    expect(held).toMatchObject({ state: 'PENDING', sendStartedAt: null, attempts: 0 });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await ctx.container.database.db.execute(
      sql`UPDATE business_outbound_messages SET next_attempt_at = now() - interval '1 second' WHERE id = ${row.id}`,
    );
    await lane.deliverDue(scopeA);
    expect(await laneState(row.id)).toBe('DELIVERED');
  });

  it('a stranded stamped send is resolved UNCONFIRMED and never resent', async () => {
    const first = await record(message());
    const found = await conversation(first!.conversationId);
    const row = await queueAuto(found.id, found.controlEpoch);
    await ctx.container.database.db.execute(
      sql`UPDATE business_outbound_messages SET send_started_at = now() - interval '1 hour' WHERE id = ${row.id}`,
    );
    const report = await lane.deliverDue(scopeA);
    expect(report.stranded).toBe(1);
    expect(await laneState(row.id)).toBe('UNCONFIRMED');
    expect(transport.sent).toEqual([]);
    expect((await conversation(found.id)).state).toBe('HANDOFF_REQUIRED');
  });

  it('an edit is stored once and never duplicates the message; a deletion purges its text', async () => {
    const original = message({ text: 'متن اول' });
    const recorded = await record(original);
    await record(
      { ...original, text: 'متن ویرایش‌شده', editedAt: new Date(Date.now() + 1000) },
      true,
    );
    const messages = await new DrizzleBusinessMessageRepository(ctx.container.database.db).recent(
      scopeA,
      recorded!.conversationId,
      10,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ text: 'متن ویرایش‌شده', contentVersion: 2 });

    const deleted = await ctx.container.businessConversations.recordDeletion(scopeA, system(), {
      idempotencyKey: key('delete'),
      botInstanceId: BOT,
      deletion: { connectionId: 'conn-1', chatId: CUSTOMER, messageIds: [original.messageId] },
    });
    expect(deleted).toBe(1);
    const after = await new DrizzleBusinessMessageRepository(ctx.container.database.db).recent(
      scopeA,
      recorded!.conversationId,
      10,
    );
    expect(after[0]).toMatchObject({ text: null });
    expect(after[0]?.deletedAt).not.toBeNull();
    // A deletion changes nothing about control.
    expect((await conversation(recorded!.conversationId)).state).toBe('AI_ACTIVE');
  });

  it('a send through a connection that cannot send is refused up front', async () => {
    const first = await record(message());
    await ctx.container.businessConnections.applyReport(scopeA, system(), {
      idempotencyKey: key('revoke'),
      botInstanceId: BOT,
      report: {
        connectionId: 'conn-1',
        ownerTelegramUserId: OWNER,
        ownerUserChatId: OWNER,
        isEnabled: true,
        rights: [],
        connectedAt: new Date('2026-10-01T00:00:00Z'),
      },
    });
    await expect(
      ctx.container.businessConversations.send(scopeA, operator, {
        conversationId: first!.conversationId,
        idempotencyKey: key('send'),
        text: 'x',
      }),
    ).rejects.toSatisfy(isNexaError);
  });

  it('refuses an operator without business_chats.reply, and hides the inbox from one without view', async () => {
    const first = await record(message());
    const finance = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'fin', roleKeys: ['finance'] }),
    );
    await expect(
      ctx.container.businessConversations.takeOver(scopeA, finance, {
        conversationId: first!.conversationId,
        idempotencyKey: key('takeover'),
      }),
    ).rejects.toSatisfy(isNexaError);
    await expect(
      ctx.container.businessConversations.list(scopeA, finance, { limit: 10 }),
    ).rejects.toSatisfy(isNexaError);
    expect(
      await ctx.container.businessConversations.list(scopeA, operator, { limit: 10 }),
    ).toHaveLength(1);
  });

  it('another tenant sees none of these conversations', async () => {
    const first = await record(message());
    const otherOwner = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'bowner', roleKeys: ['owner'] }),
    );
    const scopeB = { ...tenantB, botInstanceId: null } as never;
    expect(
      await ctx.container.businessConversations.list(scopeB, otherOwner, { limit: 10 }),
    ).toHaveLength(0);
    await expect(
      ctx.container.businessConversations.detail(scopeB, otherOwner, first!.conversationId),
    ).rejects.toSatisfy(isNexaError);
  });

  it('takeover is idempotent and a second takeover of a human conversation changes nothing', async () => {
    const first = await record(message());
    const k = key('take');
    const a = await ctx.container.businessConversations.takeOver(scopeA, operator, {
      conversationId: first!.conversationId,
      idempotencyKey: k,
    });
    const b = await ctx.container.businessConversations.takeOver(scopeA, operator, {
      conversationId: first!.conversationId,
      idempotencyKey: k,
    });
    const c = await ctx.container.businessConversations.takeOver(scopeA, operator, {
      conversationId: first!.conversationId,
      idempotencyKey: key('take-again'),
    });
    expect(a).toEqual({ state: 'HUMAN_ACTIVE', controlEpoch: 1 });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  // ---- Substitute review of PR #197 (TB2): each finding's regression ----

  it('F1: a late update on a superseded connection never points the conversation back at it', async () => {
    const first = await record(message());
    await ctx.container.businessConnections.applyReport(scopeA, system(), {
      idempotencyKey: key('reconnect'),
      botInstanceId: BOT,
      report: {
        connectionId: 'conn-2',
        ownerTelegramUserId: OWNER,
        ownerUserChatId: OWNER,
        isEnabled: true,
        rights: ['can_reply'] as BusinessBotRight[],
        connectedAt: new Date('2026-10-02T00:00:00Z'),
      },
    });
    await record(message({ connectionId: 'conn-2' }));
    const live = (await conversation(first!.conversationId)).connectionRowId;
    // A message that was in flight on the old connection arrives late.
    await record(message({ connectionId: 'conn-1' }));
    expect((await conversation(first!.conversationId)).connectionRowId).toBe(live);
    const row = await ctx.container.businessConversations.send(scopeA, operator, {
      conversationId: first!.conversationId,
      idempotencyKey: key('send'),
      text: 'پاسخ پشتیبان',
    });
    expect(row.state).toBe('PENDING');
  });

  it('F2: an echo recorded before the lane writes the message id is relabelled ours, and its redelivery replays', async () => {
    const first = await record(message());
    await ctx.container.businessConversations.send(scopeA, operator, {
      conversationId: first!.conversationId,
      idempotencyKey: key('send'),
      text: 'سلام، بررسی می‌کنم',
    });
    transport.nextMessageId = 900;
    const echoKey = key('echo');
    const echo = fromOwner({ messageId: 901, text: 'سلام، بررسی می‌کنم' });
    transport.during = async () => {
      expect((await record(echo, false, echoKey))?.origin).toBe('HUMAN');
    };
    expect((await lane.deliverDue(scopeA)).delivered).toBe(1);
    const stored = await ctx.container.database.db.execute(
      sql`SELECT origin FROM business_messages WHERE telegram_message_id = 901`,
    );
    expect(stored.rows).toEqual([{ origin: 'OWN_ECHO' }]);
    // The same update redelivered under its key replays; its origin moved, its facts did not.
    await expect(record(echo, false, echoKey)).resolves.not.toBeNull();
  });

  it('F3: the owner editing a message NEXA sent is a human act, not our echo', async () => {
    const first = await record(message());
    const found = await conversation(first!.conversationId);
    await queueAuto(found.id, found.controlEpoch);
    transport.nextMessageId = 700;
    await lane.deliverDue(scopeA);
    const sentByUs = fromOwner({ messageId: 701, text: 'پاسخ پیشنهادی هوش مصنوعی' });
    expect((await record(sentByUs))?.origin).toBe('OWN_ECHO');
    expect((await conversation(found.id)).state).toBe('AI_ACTIVE');
    const edited = await record(
      { ...sentByUs, text: 'پاسخ اصلاح‌شده توسط صاحب حساب', editedAt: new Date(Date.now() + 1000) },
      true,
    );
    expect(edited).toMatchObject({ origin: 'HUMAN', tookOver: true });
    expect((await conversation(found.id)).state).toBe('HUMAN_ACTIVE');
  });

  it('M1: an owner message redelivered after a resume does not take the conversation again', async () => {
    const first = await record(message());
    const owner = fromOwner();
    await record(owner);
    await ctx.container.businessConversations.resume(scopeA, operator, {
      conversationId: first!.conversationId,
      idempotencyKey: key('resume'),
    });
    await record(owner, false, key('late-redelivery'));
    expect(await conversation(first!.conversationId)).toMatchObject({
      state: 'AI_ACTIVE',
      controlEpoch: 2,
    });
  });

  it('M3: two passes holding the same claim send once', async () => {
    const first = await record(message());
    const found = await conversation(first!.conversationId);
    const row = await queueAuto(found.id, found.controlEpoch);
    const now = new Date();
    const [claimed] = await outbound.claimDue(scopeA, now, new Date(now.getTime() + 60_000), 10);
    let second: string | null = null;
    transport.during = async () => {
      second = await lane.deliverOne(scopeA, claimed!);
    };
    expect(await lane.deliverOne(scopeA, claimed!)).toBe('delivered');
    expect(second).toBe('lost');
    expect(transport.sent).toHaveLength(1);
    expect(await laneState(row.id)).toBe('DELIVERED');
  });

  it('N6: a pass whose lease another pass took over neither stamps nor sends', async () => {
    const first = await record(message());
    const found = await conversation(first!.conversationId);
    const row = await queueAuto(found.id, found.controlEpoch);
    const now = new Date();
    const [stale] = await outbound.claimDue(scopeA, now, new Date(now.getTime() + 60_000), 10);
    // Another pass claimed it after this lease expired, was told to wait, and requeued it.
    await ctx.container.database.db.execute(
      sql`UPDATE business_outbound_messages SET next_attempt_at = now() + interval '30 seconds' WHERE id = ${row.id}`,
    );
    expect(await lane.deliverOne(scopeA, stale!)).toBe('lost');
    expect(transport.sent).toEqual([]);
    expect(await outbound.findById(scopeA, row.id)).toMatchObject({
      state: 'PENDING',
      sendStartedAt: null,
    });
  });

  it('N8: an outcome for a row the reaper already resolved is not counted as delivered', async () => {
    const first = await record(message());
    const found = await conversation(first!.conversationId);
    const row = await queueAuto(found.id, found.controlEpoch);
    transport.during = async () => {
      await ctx.container.database.db.execute(
        sql`UPDATE business_outbound_messages SET state = 'UNCONFIRMED', resolved_at = now() WHERE id = ${row.id}`,
      );
    };
    const report = await lane.deliverDue(scopeA);
    expect(report.delivered).toBe(0);
    expect(await laneState(row.id)).toBe('UNCONFIRMED');
  });

  it('M4: an edit delivered out of order never rewinds a newer one', async () => {
    const original = message({ text: 'متن اول' });
    const recorded = await record(original);
    const t = Date.now();
    await record({ ...original, text: 'ویرایش دوم', editedAt: new Date(t + 2000) }, true);
    await record({ ...original, text: 'ویرایش اول', editedAt: new Date(t + 1000) }, true);
    const [stored] = await new DrizzleBusinessMessageRepository(ctx.container.database.db).recent(
      scopeA,
      recorded!.conversationId,
      10,
    );
    expect(stored).toMatchObject({ text: 'ویرایش دوم', contentVersion: 2 });
  });

  it('N7: an edit does not restore text that retention already purged', async () => {
    const original = message({ text: 'متن قدیمی' });
    const recorded = await record(original);
    await ctx.container.database.db.execute(
      sql`UPDATE business_messages SET text = NULL, text_purged_at = now() WHERE telegram_message_id = ${original.messageId}`,
    );
    await record(
      { ...original, text: 'متن ویرایش‌شده', editedAt: new Date(Date.now() + 1000) },
      true,
    );
    const [stored] = await new DrizzleBusinessMessageRepository(ctx.container.database.db).recent(
      scopeA,
      recorded!.conversationId,
      10,
    );
    expect(stored?.text).toBeNull();
  });

  it('M5: a stopped tenant takes no send, no takeover, and its lane sends nothing', async () => {
    const first = await record(message());
    const found = await conversation(first!.conversationId);
    const row = await queueAuto(found.id, found.controlEpoch);
    // A pass that claimed the row before the stop committed.
    const now = new Date();
    const [claimed] = await outbound.claimDue(scopeA, now, new Date(now.getTime() + 60_000), 10);
    await ctx.container.database.db.execute(
      sql`UPDATE tenants SET status = 'DISABLED' WHERE id = ${SEED_IDS.tenantA}`,
    );
    await expect(
      ctx.container.businessConversations.send(scopeA, operator, {
        conversationId: found.id,
        idempotencyKey: key('send'),
        text: 'x',
      }),
    ).rejects.toSatisfy(isNexaError);
    await expect(
      ctx.container.businessConversations.takeOver(scopeA, operator, {
        conversationId: found.id,
        idempotencyKey: key('take'),
      }),
    ).rejects.toSatisfy(isNexaError);
    // A pass that starts after the stop does nothing; one already holding the row loses it
    // at the final check, inside the transaction that would have stamped the send.
    expect((await lane.deliverDue(scopeA)).claimed).toBe(0);
    expect(await lane.deliverOne(scopeA, claimed!)).toBe('superseded');
    expect(transport.sent).toEqual([]);
    expect(await outbound.findById(scopeA, row.id)).toMatchObject({
      state: 'SUPERSEDED',
      failureCode: 'scope.inactive',
    });
  });
});
