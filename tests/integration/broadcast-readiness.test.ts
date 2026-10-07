import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BROADCAST_ERROR_CODES,
  BROADCAST_HISTORY_MAX,
  BROADCAST_LEASE_MS,
  BROADCAST_SENDS_PER_SECOND,
  type ActorContext,
  type Clock,
  type CorrelationId,
} from '@nexa/contracts';
import { BroadcastService } from '../../apps/api/src/modules/commerce/broadcasts/application/broadcast.service';
import { BroadcastDispatcher } from '../../apps/api/src/modules/commerce/broadcasts/application/broadcast-dispatcher';
import type {
  BroadcastDeliverRequest,
  BroadcastPinResult,
  BroadcastRenderRequest,
  BroadcastRenderResult,
  BroadcastSendResult,
  BroadcastTransport,
} from '../../apps/api/src/modules/commerce/broadcasts/application/ports';
import { DrizzleBroadcastRepository } from '../../apps/api/src/modules/commerce/broadcasts/infrastructure/drizzle-broadcast.repository';
import { DrizzleRecipientFactsReader } from '../../apps/api/src/modules/commerce/broadcasts/infrastructure/drizzle-recipient-facts.reader';
import { DrizzleAuditHistoryReader } from '../../apps/api/src/modules/platform/audit/infrastructure/drizzle-audit-history.reader';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';
import { AudienceFixtures } from './audience-fixtures';

/**
 * Roadmap C1 — automated readiness of the broadcast lane for what a fake can prove: each
 * recipient sent (and pinned) through its OWN frozen bot, one bot's refusal or 429 hold never
 * touching another's recipients, a re-queue that re-sends exactly the refusals and never a
 * delivered, unconfirmed, in-flight or opted-out recipient, pause/resume/cancel across bots,
 * and the promotional opt-out deciding at the send even after a re-queue. Plus the C2 reads
 * that make those facts visible (delivery per bot, the broadcast's own history).
 *
 * What only a real bot can prove is listed as NOT RUN in `docs/campaign-broadcast-readiness.md`.
 */

const BOT_1 = SEED_IDS.botA1;
const BOT_2 = SEED_IDS.botA2;
const SOURCE = { chatId: '-1001234567890', messageId: 42 };

class StoppedClock implements Clock {
  private at = Date.now() + 5_000;
  now(): Date {
    return new Date(this.at);
  }
  advance(ms: number): void {
    this.at += ms;
  }
}

/** Telegram, scripted per chat; every send and pin is recorded WITH the bot it went through. */
class ScriptedTransport implements BroadcastTransport {
  readonly sends: { chatId: string; bot: string }[] = [];
  readonly pins: { chatId: string; bot: string }[] = [];
  private readonly scripts = new Map<string, BroadcastSendResult[]>();
  /** Per bot: what every send through that bot answers, unless a chat is scripted. */
  readonly botAnswers = new Map<string, BroadcastSendResult>();
  crashOn: string | null = null;
  beforeDeliver: ((request: BroadcastDeliverRequest) => Promise<void>) | null = null;

  script(chatId: string, ...results: BroadcastSendResult[]): void {
    this.scripts.set(chatId, results);
  }

  async render(_scope: unknown, request: BroadcastRenderRequest): Promise<BroadcastRenderResult> {
    return {
      ok: true,
      rendered: {
        contentKind: request.contentKind,
        text: request.body,
        buttons: request.buttons,
        source: request.source,
      },
    };
  }

  async deliver(_scope: unknown, request: BroadcastDeliverRequest): Promise<BroadcastSendResult> {
    if (this.beforeDeliver !== null) await this.beforeDeliver(request);
    this.sends.push({ chatId: request.chatId, bot: request.botInstanceId });
    if (this.crashOn === request.chatId) throw new Error('worker died mid-send');
    const scripted = this.scripts.get(request.chatId)?.shift();
    if (scripted !== undefined) return scripted;
    return (
      this.botAnswers.get(request.botInstanceId) ?? {
        outcome: 'SENT',
        messageId: 500 + this.sends.length,
      }
    );
  }

  async pin(
    _scope: unknown,
    request: { chatId: string; botInstanceId: string; messageId: number },
  ): Promise<BroadcastPinResult> {
    this.pins.push({ chatId: request.chatId, bot: request.botInstanceId });
    return { outcome: 'PINNED' };
  }

  sentTo(chatId: string): number {
    return this.sends.filter((send) => send.chatId === chatId).length;
  }
}

const telegramActor = (key: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: `corr-${key}` as CorrelationId,
});

describe('broadcast readiness (roadmap C1)', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let operator: ActorContext;
  let fixtures: AudienceFixtures;
  let clock: StoppedClock;
  let transport: ScriptedTransport;
  let dispatcher: BroadcastDispatcher;
  let broadcasts: BroadcastService;
  let n = 0;
  const key = (): string => `bcr-${(n += 1)}-${Date.now()}`;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    const c = ctx.container;
    owner = adminActorFor(
      await createAdmin(c, tenantA, { username: 'owner-bcr', roleKeys: ['owner'] }),
    );
    fixtures = new AudienceFixtures(ctx, tenantA.tenantId as string);
    clock = new StoppedClock();
    transport = new ScriptedTransport();
    const optOutPolicy = {
      honoured: (scope: typeof tenantA, tx?: unknown) =>
        c.featureFlagResolver.isEnabled(scope, 'customer_marketing_opt_out', tx),
    };
    dispatcher = new BroadcastDispatcher({
      repository: new DrizzleBroadcastRepository(c.database.db),
      transport,
      facts: new DrizzleRecipientFactsReader(c.database.db, async () => 'IRT'),
      outbox: c.outbox,
      uow: c.uow,
      clock,
      ids: c.ids,
      scopeIsActive: async () => true,
      logger: { info: () => undefined, error: () => undefined },
      marketingOptOut: optOutPolicy,
    });
    broadcasts = new BroadcastService({
      repository: new DrizzleBroadcastRepository(c.database.db),
      audience: c.audience,
      transport,
      facts: new DrizzleRecipientFactsReader(c.database.db, async () => 'IRT'),
      guard: c.guard,
      uow: c.uow,
      audit: c.audit,
      opsLog: c.opsLog,
      sessions: c.sessions,
      idempotency: c.idempotency,
      scopeActivity: c.tenants,
      outbox: c.outbox,
      clock,
      ids: c.ids,
      marketingOptOut: optOutPolicy,
      auditHistory: new DrizzleAuditHistoryReader(c.database.db),
    });
    // The operator's own Telegram, known to the tenant through bot 1: where a test goes.
    await fixtures.customer({ telegramUserId: '660900', botInstanceId: BOT_1 });
    operator = adminActorFor(
      await createAdmin(c, tenantA, {
        username: 'tester-bcr',
        roleKeys: ['owner'],
        telegramUserId: '660900',
      }),
    );
  });

  /** Two customers on bot 1, two on bot 2, one who never wrote to a bot. */
  async function twoBotAudience() {
    const ids = {
      a: await fixtures.customer({ telegramUserId: '661001', botInstanceId: BOT_1 }),
      b: await fixtures.customer({ telegramUserId: '661002', botInstanceId: BOT_1 }),
      c: await fixtures.customer({ telegramUserId: '662001', botInstanceId: BOT_2 }),
      d: await fixtures.customer({ telegramUserId: '662002', botInstanceId: BOT_2 }),
      e: await fixtures.customer({ telegramUserId: '669001', botInstanceId: null }),
    };
    return ids;
  }

  async function composed(
    overrides: { pin?: boolean; purpose?: 'MARKETING' | 'SERVICE_ANNOUNCEMENT' } = {},
  ) {
    return broadcasts.create(tenantA, owner, {
      idempotencyKey: key(),
      title: 'readiness',
      contentKind: 'TEXT',
      body: 'سلام',
      buttons: [],
      audience: { version: 1 },
      purpose: overrides.purpose ?? 'MARKETING',
      pin: overrides.pin ?? false,
    });
  }

  async function copy(pin = false) {
    return broadcasts.create(tenantA, owner, {
      idempotencyKey: key(),
      title: 'copy',
      contentKind: 'COPY',
      body: '',
      buttons: [],
      audience: { version: 1 },
      source: SOURCE,
      pin,
    });
  }

  async function launch(id: string) {
    const record = await broadcasts.get(tenantA, owner, id);
    const preview = await broadcasts.preview(tenantA, owner, id);
    return broadcasts.launch(tenantA, owner, id, {
      idempotencyKey: key(),
      mode: 'NOW',
      scheduledAt: null,
      expectedVersion: record.version,
      expectedDefinitionHash: preview.definitionHash,
      expectedRecipients: preview.customers,
      expectedFingerprint: preview.fingerprint,
      typedCount: null,
    });
  }

  async function states(broadcastId: string): Promise<Record<string, string>> {
    const result = await ctx.container.database.db.execute<{
      chat_id: string;
      state: string;
      error_code: string | null;
    }>(
      sql`SELECT chat_id, state, error_code FROM broadcast_recipients
           WHERE broadcast_id = ${broadcastId}::uuid`,
    );
    return Object.fromEntries(
      result.rows.map((row) => [
        row.chat_id,
        row.error_code === null ? row.state : `${row.state}:${row.error_code}`,
      ]),
    );
  }

  /** Passes until nothing more moves, advancing past any hold or retry floor. */
  async function drain(passes = 6): Promise<void> {
    for (let i = 0; i < passes; i += 1) {
      await dispatcher.pass(tenantA);
      clock.advance(6_000);
    }
  }

  const optOut = (customerId: string, optedOut: boolean) => {
    const k = key();
    return ctx.container.customers.setMarketingOptOut(tenantA, telegramActor(k), {
      idempotencyKey: k,
      customerId,
      optedOut,
    });
  };

  describe('multi-bot routing', () => {
    it('sends and pins each recipient through its own FROZEN bot, and counts the delivery per bot', async () => {
      const ids = await twoBotAudience();
      const record = await copy(true);
      // Verified through the operator's bot: the only proof the Bot API offers.
      expect(await broadcasts.test(tenantA, operator, record.id)).toBe('SENT');
      expect(transport.sends.at(-1)).toEqual({ chatId: '660900', bot: BOT_1 });
      transport.sends.length = 0;
      await launch(record.id);

      // A customer whose recorded bot changes after the launch is still sent through the
      // bot frozen on their recipient row: identity is the launch's.
      await ctx.container.database.db.execute(
        sql`UPDATE customers SET first_bot_instance_id = ${BOT_1}::uuid WHERE id = ${ids.c}::uuid`,
      );
      await drain(2);

      const expected: Record<string, string> = {
        '660900': BOT_1,
        '661001': BOT_1,
        '661002': BOT_1,
        '662001': BOT_2,
        '662002': BOT_2,
      };
      expect(Object.fromEntries(transport.sends.map((s) => [s.chatId, s.bot]))).toEqual(expected);
      expect(Object.fromEntries(transport.pins.map((s) => [s.chatId, s.bot]))).toEqual(expected);
      expect(transport.sends).toHaveLength(5);
      // The member with no bot was never attempted: counted and recorded UNREACHABLE.
      expect((await states(record.id))['669001']).toBe('UNREACHABLE:broadcast.no_bot_recorded');

      const perBot = await broadcasts.botDelivery(tenantA, owner, record.id);
      const byBot = Object.fromEntries(perBot.map((row) => [row.botInstanceId ?? 'none', row]));
      expect(byBot[BOT_1]?.counts).toMatchObject({ total: 3, sent: 3, pinned: 3 });
      expect(byBot[BOT_2]?.counts).toMatchObject({ total: 2, sent: 2, pinned: 2 });
      expect(byBot['none']?.counts).toMatchObject({ total: 1, unreachable: 1 });
      expect(byBot[BOT_1]?.botStatus).toBe('ACTIVE');
      // The rows sum to the broadcast's own counts.
      const total = (await broadcasts.counts(tenantA, owner, [record.id])).get(record.id);
      expect(perBot.reduce((sum, row) => sum + row.counts.total, 0)).toBe(total?.total);
      expect(perBot.reduce((sum, row) => sum + row.counts.sent, 0)).toBe(total?.sent);
    });

    it('a source one bot cannot reach fails that bot’s recipients only; the re-queue re-sends exactly them, once', async () => {
      await twoBotAudience();
      const record = await copy();
      expect(await broadcasts.test(tenantA, operator, record.id)).toBe('SENT');
      transport.sends.length = 0;
      await launch(record.id);
      transport.botAnswers.set(BOT_2, { outcome: 'REFUSED', errorCode: 'telegram.rejected.400' });
      await drain(2);
      expect(await states(record.id)).toMatchObject({
        '661001': 'SENT',
        '661002': 'SENT',
        '660900': 'SENT',
        '662001': 'FAILED:telegram.rejected.400',
        '662002': 'FAILED:telegram.rejected.400',
      });
      const perBot = await broadcasts.botDelivery(tenantA, owner, record.id);
      expect(perBot.find((row) => row.botInstanceId === BOT_2)?.counts.failed).toBe(2);
      expect(perBot.find((row) => row.botInstanceId === BOT_1)?.counts.failed).toBe(0);

      // The operator gives bot 2 access to the source and re-queues.
      transport.botAnswers.delete(BOT_2);
      const before = transport.sends.length;
      await broadcasts.retryFailed(tenantA, owner, record.id);
      await drain(3);
      const resent = transport.sends.slice(before);
      expect(resent.map((s) => s.chatId).sort()).toEqual(['662001', '662002']);
      expect(resent.every((s) => s.bot === BOT_2)).toBe(true);
      for (const chat of ['660900', '661001', '661002']) expect(transport.sentTo(chat)).toBe(1);

      // The history shows the test, the launch and the re-queue with its count.
      const history = (await broadcasts.history(tenantA, owner, record.id)).entries;
      const retry = history.find((row) => row.action === 'broadcast.retry_failed');
      expect(retry).toMatchObject({ result: 'SUCCESS', requeued: 2, fromState: 'COMPLETED' });
      expect(history.find((row) => row.action === 'broadcast.test')?.testOutcome).toBe('SENT');
      expect(history.find((row) => row.action === 'broadcast.launch')).toMatchObject({
        fromState: 'DRAFT',
        toState: 'SENDING',
      });
    });

    it('a 429 holds the bot that got it and no other; the waiting recipient shows when it is due', async () => {
      const ids = await twoBotAudience();
      // More bot-2 customers than one pass claims for a bot (its per-second budget), so some
      // are still PENDING with no answer on record when the 429 lands.
      for (let i = 0; i < BROADCAST_SENDS_PER_SECOND; i += 1) {
        await fixtures.customer({
          telegramUserId: String(663000 + i),
          botInstanceId: BOT_2,
        });
      }
      const record = await composed();
      await launch(record.id);
      transport.script('662001', { outcome: 'RATE_LIMITED', retryAfterMs: 30_000 });
      await dispatcher.pass(tenantA);

      const perBot = await broadcasts.botDelivery(tenantA, owner, record.id);
      const two = perBot.find((row) => row.botInstanceId === BOT_2);
      const one = perBot.find((row) => row.botInstanceId === BOT_1);
      expect(two?.heldUntil).not.toBeNull();
      // Exactly the deferred one (PR #237 review N2): bot 2's recipients that no pass has
      // claimed yet are PENDING with no answer on record, and are not "waiting for a retry".
      expect(two?.waitingRetry).toBe(1);
      expect(two?.counts.pending).toBeGreaterThan(1);
      expect(one?.heldUntil).toBeNull();
      expect(one?.counts.sent).toBe(3);
      const waiting = await broadcasts.recipients(tenantA, owner, record.id, {
        state: 'PENDING',
        limit: 10,
        after: null,
      });
      const deferred = waiting.find((row) => row.customerId === ids.c);
      expect(deferred?.errorCode).toBe('telegram.rate_limited');
      expect(deferred?.nextAttemptAt?.getTime()).toBeGreaterThanOrEqual(
        clock.now().getTime() + 29_000,
      );
      // Not before Telegram's own time, and then exactly once.
      clock.advance(10_000);
      await dispatcher.pass(tenantA);
      expect(transport.sentTo('662001')).toBe(1);
      clock.advance(25_000);
      await drain(2);
      expect(transport.sentTo('662001')).toBe(2);
      expect((await states(record.id))['662001']).toBe('SENT');
      expect(
        (await broadcasts.botDelivery(tenantA, owner, record.id)).find(
          (row) => row.botInstanceId === BOT_2,
        )?.heldUntil,
      ).toBeNull();
    });

    it('one bot that cannot send pauses the broadcast; resumed, nobody on the other bot is sent twice', async () => {
      await twoBotAudience();
      const record = await composed();
      await launch(record.id);
      transport.botAnswers.set(BOT_2, {
        outcome: 'BOT_UNAVAILABLE',
        errorCode: 'broadcast.no_bot',
      });
      await dispatcher.pass(tenantA);
      const paused = await broadcasts.get(tenantA, owner, record.id);
      expect(paused).toMatchObject({ state: 'PAUSED', pauseReason: 'BOT_UNAVAILABLE' });
      const perBot = await broadcasts.botDelivery(tenantA, owner, record.id);
      expect(perBot.find((row) => row.botInstanceId === BOT_2)?.waitingRetry).toBe(2);

      transport.botAnswers.delete(BOT_2);
      await broadcasts.resume(tenantA, owner, record.id);
      clock.advance(BROADCAST_LEASE_MS + 1);
      await drain(3);
      for (const chat of ['660900', '661001', '661002']) expect(transport.sentTo(chat)).toBe(1);
      expect(await states(record.id)).toMatchObject({ '662001': 'SENT', '662002': 'SENT' });
    });
  });

  describe('pause, resume and cancel across bots', () => {
    it('a pause stops both bots at the stamp; cancel ends what is left on both and recalls nothing', async () => {
      await twoBotAudience();
      const record = await composed();
      await launch(record.id);
      // The operator pauses while the first send of the pass is in flight.
      let paused = false;
      transport.beforeDeliver = async () => {
        if (paused) return;
        paused = true;
        await broadcasts.pause(tenantA, owner, record.id);
      };
      await dispatcher.pass(tenantA);
      transport.beforeDeliver = null;
      // Only sends stamped before the pause committed went (the pass runs a few in parallel);
      // every other claimed recipient, on either bot, stopped at its stamp and stays PENDING.
      const beforePause = transport.sends.length;
      expect(beforePause).toBeLessThan(5);
      await drain(2);
      expect(transport.sends).toHaveLength(beforePause);
      expect(Object.values(await states(record.id)).filter((s) => s === 'PENDING').length).toBe(
        5 - beforePause,
      );

      // Resumed: bot 1 delivers; Telegram holds bot 2 (429), so its recipients wait.
      const sentBeforePause = new Set(transport.sends.map((send) => send.chatId));
      await broadcasts.resume(tenantA, owner, record.id);
      transport.botAnswers.set(BOT_2, { outcome: 'RATE_LIMITED', retryAfterMs: 60_000 });
      clock.advance(BROADCAST_LEASE_MS + 1);
      await dispatcher.pass(tenantA);
      transport.botAnswers.delete(BOT_2);
      const resumed = await states(record.id);
      for (const chat of ['660900', '661001', '661002']) expect(resumed[chat]).toBe('SENT');

      // Cancel: whatever is still waiting, on either bot, is CANCELLED and never sent; what
      // was delivered stays delivered.
      await broadcasts.cancel(tenantA, owner, record.id);
      const attempts = transport.sends.length;
      clock.advance(120_000);
      await drain(2);
      expect(transport.sends).toHaveLength(attempts);
      const final = await states(record.id);
      for (const chat of ['662001', '662002']) {
        // A cancelled row keeps the last answer it had (here the 429) beside its state.
        expect(final[chat]).toMatch(sentBeforePause.has(chat) ? /^SENT$/ : /^CANCELLED/);
      }
      for (const chat of ['660900', '661001', '661002']) expect(final[chat]).toBe('SENT');
      const perBot = await broadcasts.botDelivery(tenantA, owner, record.id);
      expect(perBot.find((row) => row.botInstanceId === BOT_2)?.counts.cancelled).toBe(
        ['662001', '662002'].filter((chat) => !sentBeforePause.has(chat)).length,
      );
      // A cancelled broadcast re-queues nothing.
      await expect(broadcasts.retryFailed(tenantA, owner, record.id)).rejects.toMatchObject({
        code: BROADCAST_ERROR_CODES.STATE_CONFLICT,
      });
      const history = (await broadcasts.history(tenantA, owner, record.id)).entries.map(
        (r) => r.action,
      );
      expect(history).toEqual(
        expect.arrayContaining(['broadcast.pause', 'broadcast.resume', 'broadcast.cancel']),
      );
    });
  });

  describe('the re-queue never sends twice', () => {
    it('re-sends only the refusals: never a delivered, unconfirmed, unreachable, skipped or in-flight recipient', async () => {
      const ids = await twoBotAudience();
      const record = await composed();
      await launch(record.id);
      transport.script('661002', { outcome: 'REFUSED', errorCode: 'telegram.rejected.400' });
      transport.script('662001', { outcome: 'UNREACHABLE', errorCode: 'telegram.rejected.403' });
      transport.script('662002', { outcome: 'UNKNOWN', errorCode: 'telegram.unreachable' });
      await optOut(ids.a, true);
      await drain(2);
      expect(await states(record.id)).toMatchObject({
        '660900': 'SENT',
        '661001': 'SKIPPED:broadcast.marketing_opted_out',
        '661002': 'FAILED:telegram.rejected.400',
        '662001': 'UNREACHABLE:telegram.rejected.403',
        '662002': 'UNCONFIRMED:telegram.unreachable',
      });

      // A re-queue issued again WHILE the re-sent refusal is in flight finds nothing to move:
      // the in-flight row is SENDING, not FAILED.
      let again = false;
      transport.beforeDeliver = async (request) => {
        if (request.chatId !== '661002' || again) return;
        again = true;
        await broadcasts.retryFailed(tenantA, owner, record.id);
      };
      await broadcasts.retryFailed(tenantA, owner, record.id);
      await drain(3);
      transport.beforeDeliver = null;
      expect(again).toBe(true);
      // And twice more after it settled: nothing is FAILED, so nothing moves.
      await broadcasts.retryFailed(tenantA, owner, record.id);
      await broadcasts.retryFailed(tenantA, owner, record.id);
      await drain(2);

      expect(transport.sentTo('661002')).toBe(2);
      expect(transport.sentTo('660900')).toBe(1);
      expect(transport.sentTo('662001')).toBe(1);
      expect(transport.sentTo('662002')).toBe(1);
      expect(transport.sentTo('661001')).toBe(0);
      expect((await states(record.id))['661002']).toBe('SENT');
      // Exactly one re-queue moved anything, and the history says it moved one.
      const retries = (await broadcasts.history(tenantA, owner, record.id)).entries.filter(
        (row) => row.action === 'broadcast.retry_failed',
      );
      expect(retries).toHaveLength(1);
      expect(retries[0]?.requeued).toBe(1);
    });

    it('a stamped send whose worker died is reaped UNCONFIRMED and no re-queue ever sends it', async () => {
      await twoBotAudience();
      const record = await composed();
      await launch(record.id);
      transport.crashOn = '662001';
      await dispatcher.pass(tenantA);
      transport.crashOn = null;
      clock.advance(BROADCAST_LEASE_MS + 1);
      await drain(2);
      expect((await states(record.id))['662001']).toBe('UNCONFIRMED:broadcast.send_interrupted');
      await expect(broadcasts.retryFailed(tenantA, owner, record.id)).resolves.toBeDefined();
      await drain(2);
      expect(transport.sentTo('662001')).toBe(1);
    });
  });

  describe('the promotional opt-out stays authoritative', () => {
    it('a refused recipient who opts out before the re-queue is SKIPPED by the stamp, never sent', async () => {
      const ids = await twoBotAudience();
      const record = await composed();
      await launch(record.id);
      transport.script('662002', { outcome: 'REFUSED', errorCode: 'telegram.rejected.400' });
      await drain(2);
      expect((await states(record.id))['662002']).toBe('FAILED:telegram.rejected.400');

      await optOut(ids.d, true);
      await broadcasts.retryFailed(tenantA, owner, record.id);
      await drain(2);
      expect(transport.sentTo('662002')).toBe(1);
      expect((await states(record.id))['662002']).toBe('SKIPPED:broadcast.marketing_opted_out');
      // The preference itself is untouched by any of it.
      const pref = await ctx.container.database.db.execute<{ at: unknown }>(
        sql`SELECT marketing_opt_out_at AS at FROM customers WHERE id = ${ids.d}::uuid`,
      );
      expect(pref.rows[0]?.at).not.toBeNull();
    });

    it('a service announcement still reaches an opted-out customer, through their own bot', async () => {
      const ids = await twoBotAudience();
      await optOut(ids.c, true);
      const record = await composed({ purpose: 'SERVICE_ANNOUNCEMENT' });
      await launch(record.id);
      await drain(2);
      expect(transport.sends.find((s) => s.chatId === '662001')?.bot).toBe(BOT_2);
      expect((await states(record.id))['662001']).toBe('SENT');
    });
  });

  describe('access to the new reads', () => {
    it('charges broadcasts.view for delivery per bot and history, and keeps both inside the tenant', async () => {
      await twoBotAudience();
      const record = await composed();
      await launch(record.id);
      const technical = adminActorFor(
        await createAdmin(ctx.container, tenantA, {
          username: 'tech-bcr',
          roleKeys: ['technical'],
        }),
      );
      await expect(broadcasts.botDelivery(tenantA, technical, record.id)).rejects.toMatchObject({
        code: 'platform.permission_denied',
      });
      await expect(broadcasts.history(tenantA, technical, record.id)).rejects.toMatchObject({
        code: 'platform.permission_denied',
      });
      const ownerB = adminActorFor(
        await createAdmin(ctx.container, tenantB, { username: 'owner-bcr-b', roleKeys: ['owner'] }),
      );
      await expect(broadcasts.botDelivery(tenantB, ownerB, record.id)).rejects.toMatchObject({
        code: BROADCAST_ERROR_CODES.NOT_FOUND,
      });
      await expect(broadcasts.history(tenantB, ownerB, record.id)).rejects.toMatchObject({
        code: BROADCAST_ERROR_CODES.NOT_FOUND,
      });
    });

    it('without audit.view, shows the successful facts only and nobody’s name (review N1)', async () => {
      await twoBotAudience();
      const record = await composed();
      await launch(record.id);
      const support = adminActorFor(
        await createAdmin(ctx.container, tenantA, {
          username: 'support-n1',
          roleKeys: ['support'],
        }),
      );
      await expect(broadcasts.pause(tenantA, support, record.id)).rejects.toBeDefined();
      // A custom role that reads broadcasts and does not hold audit.view.
      const roleId = ctx.container.ids.uuid();
      const db = ctx.container.database.db;
      await db.execute(sql`INSERT INTO roles (id, tenant_id, key, name, is_system)
        VALUES (${roleId}::uuid, ${tenantA.tenantId}::uuid, 'marketing_n1', 'Marketing', false)`);
      await db.execute(sql`INSERT INTO role_permissions (tenant_id, role_id, permission_key)
        VALUES (${tenantA.tenantId}::uuid, ${roleId}::uuid, 'broadcasts.view')`);
      const marketer = await createAdmin(ctx.container, tenantA, { username: 'marketer-n1' });
      await db.execute(sql`INSERT INTO admin_roles (tenant_id, admin_id, role_id)
        VALUES (${tenantA.tenantId}::uuid, ${marketer.id}::uuid, ${roleId}::uuid)`);
      const reader = adminActorFor(marketer);

      const seen = (await broadcasts.history(tenantA, reader, record.id)).entries;
      expect(seen.map((row) => row.action)).toEqual(
        expect.arrayContaining(['broadcast.create', 'broadcast.launch']),
      );
      expect(seen.every((row) => row.result === 'SUCCESS')).toBe(true);
      expect(seen.every((row) => row.actorLabel === null)).toBe(true);
      // The owner, who holds audit.view, sees the refusal and who did what.
      const full = (await broadcasts.history(tenantA, owner, record.id)).entries;
      expect(full.find((row) => row.action === 'broadcast.pause')?.result).toBe('DENIED');
      expect(full.find((row) => row.action === 'broadcast.launch')?.actorLabel).not.toBeNull();
    });

    it('says when older history rows exist beyond the cap (review N4)', async () => {
      await twoBotAudience();
      const record = await composed();
      expect((await broadcasts.history(tenantA, owner, record.id)).truncated).toBe(false);
      let version = record.version;
      for (let i = 0; i < BROADCAST_HISTORY_MAX; i += 1) {
        const saved = await broadcasts.update(tenantA, owner, record.id, {
          expectedVersion: version,
          title: `readiness ${String(i)}`,
          contentKind: 'TEXT',
          body: 'سلام',
          buttons: [],
          audience: { version: 1 },
        });
        version = saved.version;
      }
      const history = await broadcasts.history(tenantA, owner, record.id);
      expect(history.entries).toHaveLength(BROADCAST_HISTORY_MAX);
      expect(history.truncated).toBe(true);
      // The newest are the ones shown; the create row is the one beyond the cap.
      expect(history.entries.some((row) => row.action === 'broadcast.create')).toBe(false);
    });

    it('lists a refused steer as refused, and carries no raw audit payload', async () => {
      await twoBotAudience();
      const record = await composed();
      await launch(record.id);
      const support = adminActorFor(
        await createAdmin(ctx.container, tenantA, {
          username: 'support-bcr',
          roleKeys: ['support'],
        }),
      );
      await expect(broadcasts.pause(tenantA, support, record.id)).rejects.toBeDefined();
      const history = (await broadcasts.history(tenantA, owner, record.id)).entries;
      const denied = history.find((row) => row.action === 'broadcast.pause');
      expect(denied?.result).toBe('DENIED');
      for (const row of history) {
        expect(Object.keys(row).sort()).toEqual(
          [
            'action',
            'actorLabel',
            'fromState',
            'id',
            'occurredAt',
            'requeued',
            'result',
            'testOutcome',
            'toState',
          ].sort(),
        );
      }
    });
  });
});
