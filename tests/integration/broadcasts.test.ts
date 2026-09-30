import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AUDIENCE_ERROR_CODES,
  BROADCAST_ERROR_CODES,
  BROADCAST_LARGE_AUDIENCE,
  BROADCAST_LEASE_MS,
  BROADCAST_SENDS_PER_SECOND,
  type ActorContext,
  type AudienceDefinitionInput,
  type Clock,
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
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  type TestContext,
} from './harness';
import { AudienceFixtures } from './audience-fixtures';

/**
 * Broadcast (round N, B1): the regressions the brief names, each against the real tables and
 * the real dispatcher, with Telegram scripted per chat.
 */

/** Only moves when the test says so: pacing windows and leases are decided here. */
class StoppedClock implements Clock {
  private at = Date.now() + 5_000;
  now(): Date {
    return new Date(this.at);
  }
  advance(ms: number): void {
    this.at += ms;
  }
}

/** Telegram, scripted per chat id; every delivery is recorded. */
class ScriptedTransport implements BroadcastTransport {
  readonly delivered: string[] = [];
  private readonly scripts = new Map<string, BroadcastSendResult[]>();
  crashOn: string | null = null;

  script(chatId: string, ...results: BroadcastSendResult[]): void {
    this.scripts.set(chatId, results);
  }

  /** Every pin request, by chat id; and what each answers. */
  readonly pinned: string[] = [];
  private readonly pinScripts = new Map<string, BroadcastPinResult[]>();
  crashOnPin: string | null = null;

  scriptPin(chatId: string, ...results: BroadcastPinResult[]): void {
    this.pinScripts.set(chatId, results);
  }

  async render(_scope: unknown, request: BroadcastRenderRequest): Promise<BroadcastRenderResult> {
    const name = request.facts.firstName ?? '';
    return {
      ok: true,
      rendered: {
        contentKind: request.contentKind,
        text: request.body.replace('{firstName}', name),
        buttons: request.buttons,
        source: request.source,
      },
    };
  }

  async pin(
    _scope: unknown,
    request: { chatId: string; botInstanceId: string; messageId: number },
  ): Promise<BroadcastPinResult> {
    this.pinned.push(request.chatId);
    if (this.crashOnPin === request.chatId) throw new Error('worker died mid-pin');
    return this.pinScripts.get(request.chatId)?.shift() ?? { outcome: 'PINNED' };
  }

  /** A send that Telegram answers only after another chat's send has been asked for. */
  private readonly holds = new Map<string, string>();

  answerAfter(chatId: string, other: string): void {
    this.holds.set(chatId, other);
  }

  async deliver(_scope: unknown, request: BroadcastDeliverRequest): Promise<BroadcastSendResult> {
    this.delivered.push(request.chatId);
    const other = this.holds.get(request.chatId);
    while (other !== undefined && !this.delivered.includes(other)) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (this.crashOn === request.chatId) {
      // The process "dies" after Telegram took the request: nothing is recorded.
      throw new Error('worker died mid-send');
    }
    const queue = this.scripts.get(request.chatId);
    const next = queue?.shift();
    // A message id with every success, as Telegram answers, so a pin has something to pin.
    return next ?? { outcome: 'SENT', messageId: this.delivered.length };
  }
}

describe('broadcast', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let fixtures: AudienceFixtures;
  let clock: StoppedClock;
  let transport: ScriptedTransport;
  let dispatcher: BroadcastDispatcher;
  let key = 0;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-bc', roleKeys: ['owner'] }),
    );
    fixtures = new AudienceFixtures(ctx, tenantA.tenantId as string);
    clock = new StoppedClock();
    transport = new ScriptedTransport();
    dispatcher = new BroadcastDispatcher({
      repository: new DrizzleBroadcastRepository(ctx.container.database.db),
      transport,
      facts: new DrizzleRecipientFactsReader(ctx.container.database.db, async () => 'IRT'),
      outbox: ctx.container.outbox,
      uow: ctx.container.uow,
      clock,
      ids: ctx.container.ids,
      scopeIsActive: async () => true,
      logger: { info: () => undefined, error: () => undefined },
    });
  });

  const idem = () => `bc-${(key += 1)}-${Date.now()}`;

  async function customers(count: number, prefix = 88): Promise<string[]> {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      ids.push(
        await fixtures.customer({
          telegramUserId: `${String(prefix)}${String(1000 + index)}`,
          botInstanceId: SEED_IDS.botA1,
          firstName: `c${String(index)}`,
        }),
      );
    }
    return ids;
  }

  async function draft(audience: AudienceDefinitionInput = { version: 1 }) {
    return ctx.container.broadcasts.create(tenantA, owner, {
      idempotencyKey: idem(),
      title: 'Nowruz',
      contentKind: 'TEXT',
      body: 'سلام {firstName}',
      buttons: [{ label: 'Open', url: 'https://example.test/offer' }],
      audience,
    });
  }

  async function launchNow(id: string, overrides: { typedCount?: number | null } = {}) {
    const record = await ctx.container.broadcasts.get(tenantA, owner, id);
    const preview = await ctx.container.broadcasts.preview(tenantA, owner, id);
    return ctx.container.broadcasts.launch(tenantA, owner, id, {
      idempotencyKey: idem(),
      mode: 'NOW',
      scheduledAt: null,
      expectedVersion: record.version,
      expectedDefinitionHash: preview.definitionHash,
      expectedRecipients: preview.customers,
      expectedFingerprint: preview.fingerprint,
      typedCount: overrides.typedCount ?? null,
    });
  }

  async function states(broadcastId: string): Promise<Record<string, string>> {
    const result = await ctx.container.database.db.execute<{ chat_id: string; state: string }>(
      sql`SELECT chat_id, state FROM broadcast_recipients WHERE broadcast_id = ${broadcastId}::uuid`,
    );
    return Object.fromEntries(result.rows.map((row) => [row.chat_id, row.state]));
  }

  it('freezes exactly the previewed audience, and refuses a launch whose audience moved', async () => {
    const ids = await customers(3);
    const broadcast = await draft();
    const preview = await ctx.container.broadcasts.preview(tenantA, owner, broadcast.id);
    expect(preview.customers).toBe(3);

    // A fourth customer arrives between the preview and the confirmation.
    await customers(1, 99);
    await expect(
      ctx.container.broadcasts.launch(tenantA, owner, broadcast.id, {
        idempotencyKey: idem(),
        mode: 'NOW',
        scheduledAt: null,
        expectedVersion: broadcast.version,
        expectedDefinitionHash: preview.definitionHash,
        expectedRecipients: preview.customers,
        expectedFingerprint: preview.fingerprint,
        typedCount: null,
      }),
    ).rejects.toMatchObject({ code: AUDIENCE_ERROR_CODES.CHANGED });
    // Nothing was materialised and the draft is still a draft.
    expect(Object.keys(await states(broadcast.id))).toHaveLength(0);
    expect((await ctx.container.broadcasts.get(tenantA, owner, broadcast.id)).state).toBe('DRAFT');

    // Previewed again, the confirmation freezes exactly that set.
    const launched = await launchNow(broadcast.id);
    expect(launched.state).toBe('SENDING');
    expect(launched.recipientCount).toBe(4);
    const again = await ctx.container.audience.evaluate(tenantA, launched.audienceDefinition);
    expect(launched.audienceFingerprint).toBe(again.fingerprint);
    const frozen = await ctx.container.database.db.execute<{ customer_id: string }>(
      sql`SELECT customer_id FROM broadcast_recipients WHERE broadcast_id = ${broadcast.id}::uuid`,
    );
    expect(frozen.rows.map((row) => row.customer_id)).toEqual(expect.arrayContaining(ids));

    // A customer registering AFTER the launch is not a recipient: identity is frozen.
    await customers(1, 77);
    await dispatcher.pass(tenantA);
    expect(transport.delivered).toHaveLength(4);
  });

  it('sends each recipient once, and a stamped send whose worker died is never sent again', async () => {
    await customers(3);
    const broadcast = await draft();
    await launchNow(broadcast.id);
    transport.crashOn = '881001';

    await dispatcher.pass(tenantA);
    expect([...transport.delivered].sort()).toEqual(['881000', '881001', '881002']);
    expect((await states(broadcast.id))['881001']).toBe('SENDING');

    // A restarted worker, before and after the lease runs out: the stamped row is reaped
    // UNCONFIRMED and NOT delivered a second time.
    transport.crashOn = null;
    await dispatcher.pass(tenantA);
    clock.advance(BROADCAST_LEASE_MS + 1);
    await dispatcher.pass(tenantA);
    expect(transport.delivered.filter((chat) => chat === '881001')).toHaveLength(1);
    expect(transport.delivered).toHaveLength(3);
    expect(await states(broadcast.id)).toEqual({
      '881000': 'SENT',
      '881001': 'UNCONFIRMED',
      '881002': 'SENT',
    });
    const done = await ctx.container.broadcasts.get(tenantA, owner, broadcast.id);
    expect(done.state).toBe('COMPLETED');
  });

  it('keeps a rate-limited recipient, holds the bot until retry_after, then sends it', async () => {
    await customers(2);
    const broadcast = await draft();
    await launchNow(broadcast.id);
    transport.script('881000', { outcome: 'RATE_LIMITED', retryAfterMs: 30_000 });

    await dispatcher.pass(tenantA);
    const after = await states(broadcast.id);
    expect(after['881000']).toBe('PENDING');
    // The bot is held for every replica: nothing more is claimed until Telegram's own time.
    clock.advance(10_000);
    await dispatcher.pass(tenantA);
    expect(transport.delivered.filter((chat) => chat === '881000')).toHaveLength(1);
    clock.advance(21_000);
    await dispatcher.pass(tenantA);
    expect((await states(broadcast.id))['881000']).toBe('SENT');
    const attempts = await ctx.container.database.db.execute<{ attempts: number }>(
      sql`SELECT attempts FROM broadcast_recipients
           WHERE broadcast_id = ${broadcast.id}::uuid AND chat_id = '881000'`,
    );
    // The 429 spent no attempt; the success did.
    expect(attempts.rows[0]?.attempts).toBe(1);
  });

  it('records a customer who blocked the bot and carries on with the batch', async () => {
    await customers(3);
    const broadcast = await draft();
    await launchNow(broadcast.id);
    transport.script('881001', { outcome: 'UNREACHABLE', errorCode: 'telegram.rejected.403' });
    await dispatcher.pass(tenantA);
    expect(await states(broadcast.id)).toEqual({
      '881000': 'SENT',
      '881001': 'UNREACHABLE',
      '881002': 'SENT',
    });
    const report = await ctx.container.broadcasts.counts(tenantA, owner, [broadcast.id]);
    expect(report.get(broadcast.id)).toMatchObject({ total: 3, sent: 2, unreachable: 1 });
  });

  it('pauses, resumes and cancels safely, never recalling what was delivered', async () => {
    await customers(3);
    const broadcast = await draft();
    await launchNow(broadcast.id);
    await ctx.container.broadcasts.pause(tenantA, owner, broadcast.id);
    // A repeated pause is answered, not refused.
    expect((await ctx.container.broadcasts.pause(tenantA, owner, broadcast.id)).state).toBe(
      'PAUSED',
    );
    await dispatcher.pass(tenantA);
    expect(transport.delivered).toHaveLength(0);

    await ctx.container.broadcasts.resume(tenantA, owner, broadcast.id);
    // One recipient is claimed by a worker that has not stamped it yet; then the cancel.
    const repository = new DrizzleBroadcastRepository(ctx.container.database.db);
    const claimed = await ctx.container.uow.run(tenantA, (tx) =>
      repository.claimForBot(
        tenantA,
        SEED_IDS.botA1,
        {
          now: clock.now(),
          leaseUntil: new Date(clock.now().getTime() + BROADCAST_LEASE_MS),
          max: 1,
          perSecond: BROADCAST_SENDS_PER_SECOND,
        },
        tx,
      ),
    );
    expect(claimed).toHaveLength(1);
    const cancelled = await ctx.container.broadcasts.cancel(tenantA, owner, broadcast.id);
    expect(cancelled.state).toBe('CANCELLED');
    // The claimed-but-unstamped recipient is not sent after the cancel either.
    clock.advance(BROADCAST_LEASE_MS + 1);
    await dispatcher.pass(tenantA);
    expect(transport.delivered).toHaveLength(0);
    const counts = (await ctx.container.broadcasts.counts(tenantA, owner, [broadcast.id])).get(
      broadcast.id,
    );
    expect(counts).toMatchObject({ total: 3, cancelled: 3, sent: 0 });
    // Cancelling again is a no-op; resuming a cancelled broadcast is refused.
    await ctx.container.broadcasts.cancel(tenantA, owner, broadcast.id);
    await expect(
      ctx.container.broadcasts.resume(tenantA, owner, broadcast.id),
    ).rejects.toMatchObject({ code: BROADCAST_ERROR_CODES.STATE_CONFLICT });
  });

  it('cancelling mid-send keeps delivered messages delivered and stops the rest', async () => {
    await customers(2);
    const broadcast = await draft();
    await launchNow(broadcast.id);
    // One is delivered; the other is held back by a rate limit and still waiting.
    transport.script('881001', { outcome: 'RATE_LIMITED', retryAfterMs: 60_000 });
    await dispatcher.pass(tenantA);
    await ctx.container.broadcasts.cancel(tenantA, owner, broadcast.id);
    clock.advance(61_000);
    await dispatcher.pass(tenantA);
    expect(await states(broadcast.id)).toEqual({ '881000': 'SENT', '881001': 'CANCELLED' });
    expect(transport.delivered.filter((chat) => chat === '881001')).toHaveLength(1);
  });

  it('paces one bot to its per-second budget across passes', async () => {
    await customers(BROADCAST_SENDS_PER_SECOND + 5);
    const broadcast = await draft();
    await launchNow(broadcast.id);
    await dispatcher.pass(tenantA);
    expect(transport.delivered).toHaveLength(BROADCAST_SENDS_PER_SECOND);
    // Same second: the budget is spent.
    await dispatcher.pass(tenantA);
    expect(transport.delivered).toHaveLength(BROADCAST_SENDS_PER_SECOND);
    clock.advance(1_001);
    await dispatcher.pass(tenantA);
    expect(transport.delivered).toHaveLength(BROADCAST_SENDS_PER_SECOND + 5);
  });

  it('starts a scheduled broadcast only when its time comes', async () => {
    await customers(2);
    const broadcast = await draft();
    const preview = await ctx.container.broadcasts.preview(tenantA, owner, broadcast.id);
    const at = new Date(Date.now() + 10 * 60_000);
    const scheduled = await ctx.container.broadcasts.launch(tenantA, owner, broadcast.id, {
      idempotencyKey: idem(),
      mode: 'SCHEDULE',
      scheduledAt: at,
      expectedVersion: broadcast.version,
      expectedDefinitionHash: preview.definitionHash,
      expectedRecipients: preview.customers,
      expectedFingerprint: preview.fingerprint,
      typedCount: null,
    });
    expect(scheduled.state).toBe('SCHEDULED');
    await dispatcher.pass(tenantA);
    expect(transport.delivered).toHaveLength(0);
    clock.advance(11 * 60_000);
    await dispatcher.pass(tenantA);
    expect(transport.delivered).toHaveLength(2);
  });

  it('pauses the broadcast when its bot cannot send at all, and re-queues refusals on request', async () => {
    await customers(2);
    const broadcast = await draft();
    await launchNow(broadcast.id);
    transport.script('881000', { outcome: 'BOT_UNAVAILABLE', errorCode: 'broadcast.no_bot' });
    transport.script('881001', { outcome: 'REFUSED', errorCode: 'telegram.rejected.400' });
    // Two workers: the second recipient is stamped and asked for before the first one's
    // answer pauses the broadcast, so its refusal is recorded rather than its send stopped.
    transport.answerAfter('881000', '881001');
    await dispatcher.pass(tenantA);
    const paused = await ctx.container.broadcasts.get(tenantA, owner, broadcast.id);
    expect(paused).toMatchObject({ state: 'PAUSED', pauseReason: 'BOT_UNAVAILABLE' });
    expect(await states(broadcast.id)).toEqual({ '881000': 'PENDING', '881001': 'FAILED' });

    await ctx.container.broadcasts.resume(tenantA, owner, broadcast.id);
    clock.advance(10_000);
    await dispatcher.pass(tenantA);
    expect((await ctx.container.broadcasts.get(tenantA, owner, broadcast.id)).state).toBe(
      'COMPLETED',
    );
    // The refusal is re-queued on request and the completed broadcast re-opens to send it.
    const reopened = await ctx.container.broadcasts.retryFailed(tenantA, owner, broadcast.id);
    expect(reopened.state).toBe('SENDING');
    clock.advance(1_001);
    await dispatcher.pass(tenantA);
    expect(await states(broadcast.id)).toEqual({ '881000': 'SENT', '881001': 'SENT' });
  });

  it('asks a very large launch to type its count, and refuses a reader without the key', async () => {
    const broadcast = await draft();
    await expect(
      ctx.container.broadcasts.launch(tenantA, owner, broadcast.id, {
        idempotencyKey: idem(),
        mode: 'NOW',
        scheduledAt: null,
        expectedVersion: broadcast.version,
        expectedDefinitionHash: broadcast.audienceHash,
        expectedRecipients: BROADCAST_LARGE_AUDIENCE,
        expectedFingerprint: '0'.repeat(32),
        typedCount: null,
      }),
    ).rejects.toMatchObject({ code: BROADCAST_ERROR_CODES.CONFIRMATION_REQUIRED });

    const support = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'support-bc', roleKeys: ['support'] }),
    );
    await expect(
      ctx.container.broadcasts.create(tenantA, support, {
        idempotencyKey: idem(),
        title: 'x',
        contentKind: 'TEXT',
        body: 'x',
        buttons: [],
        audience: { version: 1 },
      }),
    ).rejects.toMatchObject({ kind: 'PERMISSION_DENIED' });
  });

  it('refuses a body with an undeclared placeholder, and a media broadcast with no file', async () => {
    await expect(
      ctx.container.broadcasts.create(tenantA, owner, {
        idempotencyKey: idem(),
        title: 'x',
        contentKind: 'TEXT',
        body: 'hello {subscriptionUrl}',
        buttons: [],
        audience: { version: 1 },
      }),
    ).rejects.toMatchObject({ code: BROADCAST_ERROR_CODES.BODY_INVALID });

    await customers(1);
    const photo = await ctx.container.broadcasts.create(tenantA, owner, {
      idempotencyKey: idem(),
      title: 'photo',
      contentKind: 'PHOTO',
      body: '',
      buttons: [],
      audience: { version: 1 },
    });
    const preview = await ctx.container.broadcasts.preview(tenantA, owner, photo.id);
    await expect(
      ctx.container.broadcasts.launch(tenantA, owner, photo.id, {
        idempotencyKey: idem(),
        mode: 'NOW',
        scheduledAt: null,
        expectedVersion: photo.version,
        expectedDefinitionHash: preview.definitionHash,
        expectedRecipients: preview.customers,
        expectedFingerprint: preview.fingerprint,
        typedCount: null,
      }),
    ).rejects.toMatchObject({ code: BROADCAST_ERROR_CODES.MEDIA_REQUIRED });

    // A PNG whose bytes are not a PNG is refused by its signature.
    await expect(
      ctx.container.broadcasts.setMedia(tenantA, owner, photo.id, {
        mimeType: 'image/png',
        fileName: 'a.png',
        contentBase64: Buffer.from('MZ-not-an-image').toString('base64'),
      }),
    ).rejects.toMatchObject({ code: BROADCAST_ERROR_CODES.MEDIA_REFUSED });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const withMedia = await ctx.container.broadcasts.setMedia(tenantA, owner, photo.id, {
      mimeType: 'image/png',
      fileName: 'a.png',
      contentBase64: png.toString('base64'),
    });
    expect(withMedia.media).toMatchObject({ mimeType: 'image/png', available: true });
    await launchNow(photo.id);
    await dispatcher.pass(tenantA);
    expect(transport.delivered).toEqual(['881000']);
  });

  /**
   * The container's broadcast service with Telegram scripted, the clock stopped and the
   * scope's activity a switch — what the two Codex R2/R3 regressions need to decide.
   */
  function serviceWith(options: { scopeActive: () => boolean }): BroadcastService {
    const c = ctx.container;
    return new BroadcastService({
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
      scopeActivity: { scopeIsActive: async () => options.scopeActive() },
      outbox: c.outbox,
      clock,
      ids: c.ids,
    });
  }

  // Codex R2 on PR #117: the test send is the one path that contacts Telegram from a
  // request, so its final authorization — scope activity included — comes BEFORE the call.
  it('sends a test only to a scope still accepting work, deciding that before Telegram', async () => {
    let active = false;
    const service = serviceWith({ scopeActive: () => active });
    await fixtures.customer({ telegramUserId: '881500', botInstanceId: SEED_IDS.botA1 });
    const tester = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'tester-bc',
        roleKeys: ['owner'],
        telegramUserId: '881500',
      }),
    );
    const broadcast = await draft();
    await expect(service.test(tenantA, tester, broadcast.id)).rejects.toMatchObject({
      kind: 'CONFLICT',
    });
    expect(transport.delivered).toEqual([]);

    active = true;
    expect(await service.test(tenantA, tester, broadcast.id)).toBe('SENT');
    expect(transport.delivered).toEqual(['881500']);
  });

  // Codex R3 on PR #117: a replay of a committed scheduled launch is answered with that
  // launch, however little lead time is left — time-relative checks follow the replay lookup.
  it('answers a replayed scheduled launch with the launch, after its lead time has shrunk', async () => {
    await customers(2);
    const service = serviceWith({ scopeActive: () => true });
    const broadcast = await draft();
    const preview = await service.preview(tenantA, owner, broadcast.id);
    const input = {
      idempotencyKey: idem(),
      mode: 'SCHEDULE' as const,
      scheduledAt: new Date(clock.now().getTime() + 2 * 60_000),
      expectedVersion: broadcast.version,
      expectedDefinitionHash: preview.definitionHash,
      expectedRecipients: preview.customers,
      expectedFingerprint: preview.fingerprint,
      typedCount: null,
    };
    const first = await service.launch(tenantA, owner, broadcast.id, input);
    expect(first.state).toBe('SCHEDULED');
    clock.advance(90_000); // thirty seconds of lead left: a NEW launch would be refused
    const replayed = await service.launch(tenantA, owner, broadcast.id, input);
    expect(replayed).toMatchObject({ id: first.id, state: 'SCHEDULED' });
    await expect(
      service.launch(tenantA, owner, broadcast.id, { ...input, idempotencyKey: idem() }),
    ).rejects.toMatchObject({ code: BROADCAST_ERROR_CODES.SCHEDULE_INVALID });
  });
});
