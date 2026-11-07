import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TELEGRAM_SECRET_TOKEN_HEADER, type CorrelationId } from '@nexa/contracts';
import { perBotWebhookSecret } from '../../../apps/api/src/modules/platform/tenancy/application/webhook-secret';
import { resetAntiSpamWindows } from '../harness';
import {
  buildWorld,
  leaks,
  PAIRS,
  TWIN_TELEGRAM_USER_ID,
  victimRows,
  WEBHOOK_SECRET,
  webhookHeaders,
  type TenantWorld,
  type World,
} from './fixtures';

/**
 * Phase 6A PR-5 (D3) — the bot runtime: a Telegram update for bot A never touches tenant B.
 *
 * The real webhook route, the real router, a fake Telegram that answers each bot by its own
 * token and records which bot every call came from. The sender is the TWIN (a customer of
 * every tenant); the updates carry the victim's real ids in their callback data — a product
 * to buy, an order to cancel, a ticket to open, a payment to cancel. After each one the
 * victim's rows are byte-for-byte what they were, every reply went out through the
 * attacker's own bot, and no reply names anything of the victim's.
 */

describe('isolation proof (PR-5) — the bot runtime', () => {
  let world: World;
  let updateId = 50_000;

  beforeAll(async () => {
    world = await buildWorld();
  }, 180_000);

  afterAll(async () => {
    await world?.close();
  });

  // Anti-spam windows are per Telegram user, and every case is the same twin.
  beforeEach(async () => {
    await resetAntiSpamWindows();
    world.telegram.calls.length = 0;
  });

  const post = (bot: TenantWorld, payload: unknown, headers = webhookHeaders) =>
    world.inject({
      method: 'POST',
      url: `/telegram/webhook/${bot.botId}`,
      headers: { ...headers, 'content-type': 'application/json' },
      payload: payload as never,
    });
  const from = { id: Number(TWIN_TELEGRAM_USER_ID), is_bot: false, first_name: 'Twin' };
  const message = (bot: TenantWorld, text: string) => {
    const id = (updateId += 1);
    return post(bot, {
      update_id: id,
      message: {
        message_id: id,
        date: 0,
        chat: { id: Number(TWIN_TELEGRAM_USER_ID), type: 'private' },
        from,
        text,
      },
    });
  };
  const tap = (bot: TenantWorld, data: string) => {
    const id = (updateId += 1);
    return post(bot, {
      update_id: id,
      callback_query: {
        id: `cbq-${String(id)}`,
        from,
        data,
        message: {
          message_id: id,
          date: 0,
          chat: { id: Number(TWIN_TELEGRAM_USER_ID), type: 'private' },
          from: { id: bot.telegramBotId, is_bot: true, first_name: 'Nexa' },
        },
      },
    });
  };
  const count = async (table: string, tenantId: string) =>
    (
      (
        await world.api.container.database.db.execute(
          sql`SELECT count(*)::int AS n FROM ${sql.raw(table)} WHERE tenant_id = ${tenantId}`,
        )
      ).rows[0] as { n: number }
    ).n;

  /** Every Telegram call came from `bot`, and none of them names the victim. */
  function expectRepliesOnlyFrom(bot: TenantWorld, victim: TenantWorld) {
    const calls = world.telegram.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(new Set(calls.map((call) => call.botId))).toEqual(new Set([bot.telegramBotId]));
    expect(leaks(JSON.stringify(calls.map((call) => call.body)), victim)).toEqual([]);
  }

  describe.each(PAIRS)('update to %s’s bot, victim %s', (attackerLabel, victimLabel) => {
    const attacker = () => world.tenants[attackerLabel];
    const victim = () => world.tenants[victimLabel];

    it('/start from the twin is the attacker’s customer and leaves the victim’s twin alone', async () => {
      const before = await victimRows(world, victim());
      const customers = await count('customers', victim().tenantId);
      const response = await message(attacker(), '/start');
      expect(response.statusCode, response.body).toBe(201);
      expect(await victimRows(world, victim())).toBe(before);
      expect(await count('customers', victim().tenantId)).toBe(customers);
      expectRepliesOnlyFrom(attacker(), victim());
    });

    it.each([
      ['buy the victim’s product', (v: TenantWorld) => `p:${v.productId}`],
      ['confirm the victim’s order', (v: TenantWorld) => `c:${v.orderId}`],
      ['ask to cancel the victim’s order', (v: TenantWorld) => `d:${v.orderId}`],
      ['pay the victim’s order from the wallet', (v: TenantWorld) => `w:${v.orderId}`],
      ['cancel the victim’s payment', (v: TenantWorld) => `z:${v.paymentId}`],
      ['open the victim’s ticket', (v: TenantWorld) => `tkv:${v.ticketId}`],
      ['close the victim’s ticket', (v: TenantWorld) => `tkx:${v.ticketId}`],
      ['open the victim’s category', (v: TenantWorld) => `ck:${v.categoryId}.0`],
      ['check the victim’s order payment', (v: TenantWorld) => `os:${v.orderId}`],
    ] as const)('a tap to %s does nothing to the victim', async (_what, data) => {
      // The twin is the attacker's customer first, as a real tap would follow a /start.
      await message(attacker(), '/start');
      world.telegram.calls.length = 0;
      const before = await victimRows(world, victim());
      const orders = await count('orders', attacker().tenantId);
      const response = await tap(attacker(), data(victim()));
      expect(response.statusCode, response.body).toBe(201);
      expect(await victimRows(world, victim())).toBe(before);
      // Nor did the attacker get an order out of somebody else's product or order.
      expect(await count('orders', attacker().tenantId)).toBe(orders);
      expectRepliesOnlyFrom(attacker(), victim());
    });

    it('a message carrying the victim’s payment code, ids and markers reveals nothing', async () => {
      await message(attacker(), '/start');
      const before = await victimRows(world, victim());
      for (const text of [victim().paymentCode, victim().orderId, `/start ${victim().marker}`]) {
        world.telegram.calls.length = 0;
        const response = await message(attacker(), text);
        expect(response.statusCode, response.body).toBe(201);
        expect(leaks(JSON.stringify(world.telegram.calls.map((c) => c.body)), victim())).toEqual(
          [],
        );
      }
      expect(await victimRows(world, victim())).toBe(before);
    });

    it('the attacker bot’s own webhook secret does not open the victim’s bot', async () => {
      const before = await victimRows(world, victim());
      const id = (updateId += 1);
      const own = perBotWebhookSecret(WEBHOOK_SECRET, attacker().botId);
      const response = await post(
        victim(),
        {
          update_id: id,
          message: {
            message_id: id,
            date: 0,
            chat: { id: 1, type: 'private' },
            from,
            text: '/start',
          },
        },
        { [TELEGRAM_SECRET_TOKEN_HEADER]: own },
      );
      expect(response.statusCode).toBe(401);
      expect(await victimRows(world, victim())).toBe(before);
      expect(world.telegram.calls).toEqual([]);
    });

    it('the victim’s Telegram-bound administrator is nobody in the attacker’s tenant', async () => {
      const telegramUserId = `92${String(attacker().telegramBotId).slice(-4)}${String(victim().telegramBotId).slice(-3)}`;
      await world.api.container.telegramAdmins.link(victim().scope, victim().ownerActor, {
        username: victim().owner.username,
        telegramUserId,
        reason: 'isolation proof',
      });
      const correlation = 'iso-proof' as CorrelationId;
      expect(
        await world.api.container.telegramAdmins.resolve(
          attacker().scope,
          telegramUserId,
          correlation,
        ),
      ).toBeNull();
      expect(
        (
          await world.api.container.telegramAdmins.resolve(
            victim().scope,
            telegramUserId,
            correlation,
          )
        )?.admin.id,
      ).toBe(victim().owner.id);
    });
  });

  it('a stopped hosted tenant’s bot answers 404 and writes nothing anywhere — the PRIMARY included', async () => {
    const hosted = world.tenants.HOSTED_2;
    const db = world.api.container.database.db;
    await db.execute(sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${hosted.tenantId}`);
    try {
      const counts = async () =>
        Promise.all(
          Object.values(world.tenants).map(async (t) => ({
            customers: await count('customers', t.tenantId),
            audits: await count('audit_logs', t.tenantId),
          })),
        );
      const before = await counts();
      const id = (updateId += 1);
      const response = await post(hosted, {
        update_id: id,
        message: {
          message_id: id,
          date: 0,
          chat: { id: 31337, type: 'private' },
          from: { id: 31337, is_bot: false, first_name: 'New' },
          text: '/start',
        },
      });
      expect(response.statusCode).toBe(404);
      expect(await counts()).toEqual(before);
      expect(world.telegram.calls).toEqual([]);
    } finally {
      await db.execute(sql`UPDATE tenants SET status = 'ACTIVE' WHERE id = ${hosted.tenantId}`);
    }
  });
});
