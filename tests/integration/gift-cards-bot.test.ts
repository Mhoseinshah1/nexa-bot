import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type ActorContext, type BotInstanceId, type CorrelationId } from '@nexa/contracts';
import type { CustomerRecord } from '../../apps/api/src/modules/commerce/customers/application/ports';
import { walletBalance } from '../../apps/api/src/surfaces/telegram/runtime/topup-flow';
import { GIFT_CARD_CALLBACK_DATA } from '../../apps/api/src/surfaces/telegram/bot-runtime';
import {
  SEED_IDS,
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  type TestContext,
} from './harness';

/**
 * R10 D4 — the gift card in the Telegram bot: the wallet screen's button exists only while the
 * feature is on; a tap opens ONE text window (GIFT_CARD_CODE) whose next message is redeemed by
 * the same service as the mini app; the answer is one of three sentences, and the window is
 * closed by the read, so a second message is not read as a code. Telegram is a local stand-in
 * that answers every call.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const CUSTOMER = '970001';
const HOUR = 60 * 60 * 1000;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('gift cards in the bot', () => {
  let ctx: TestContext;
  let telegram: Server;
  let owner: ActorContext;
  let customer: CustomerRecord;
  let updateSeq = 0;
  let n = 0;
  const key = () => `gift-bot-${(n += 1)}`;

  beforeAll(async () => {
    telegram = createServer((request: IncomingMessage, response: ServerResponse) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result: { message_id: 11 } }));
      });
    });
    await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
    const address = telegram.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    ctx = await createTestContext({
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
    });
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
  });

  beforeEach(async () => {
    await ctx.reset();
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-gc-bot', roleKeys: ['owner'] }),
    );
    ({ customer } = await ctx.container.customers.resolveFromUpdate(
      tenantA,
      systemActor('resolve'),
      {
        idempotencyKey: 'resolve-gift-bot',
        telegramUserId: CUSTOMER,
        from: { id: Number(CUSTOMER), first_name: 'مشتری' },
        botInstanceId: BOT_A,
      },
    ));
  });

  async function setFlag(enabled: boolean) {
    const before = (await ctx.container.featureFlags.list(tenantA, owner)).find(
      (flag) => flag.key === 'gift_cards',
    );
    if (before === undefined) throw new Error('no gift_cards flag');
    await ctx.container.featureFlags.set(tenantA, owner, {
      idempotencyKey: key(),
      key: 'gift_cards',
      enabled,
      expectedVersion: before.version,
      confirmKey: 'gift_cards',
      reason: 'gift card bot test',
    });
  }

  async function mintOne(): Promise<string> {
    const view = await ctx.container.giftCards.create(tenantA, owner, {
      idempotencyKey: key(),
      label: 'آزمون ربات',
      amountMinor: 30_000n,
      currency: 'IRT',
      count: 1,
      expiresAt: new Date(ctx.container.clock.now().getTime() + 7 * 24 * HOUR),
      perCustomerLimit: null,
      reason: 'آزمون',
      expectedTotalMinor: 30_000n,
      typedCount: 1,
    });
    const file = await ctx.container.giftCards.exportCodes(tenantA, owner, view.batch.id);
    return (file.content.trimEnd().split('\r\n')[1]?.split(',')[0] ?? '').replace(/"/g, '');
  }

  const handle = (update: Record<string, unknown>) => {
    updateSeq += 1;
    return ctx.container.botRuntime.handle(
      { tenantId: tenantA.tenantId, botInstanceId: BOT_A },
      systemActor('bot'),
      {
        idempotencyKey: `gift-update-${String(updateSeq)}`,
        botInstanceId: BOT_A,
        update: { update_id: updateSeq, ...update },
        telegramUserId: CUSTOMER,
        from: { id: Number(CUSTOMER), first_name: 'مشتری' },
      },
    );
  };
  const tap = (data: string) =>
    handle({
      callback_query: {
        id: `cbq-${String(updateSeq + 1)}`,
        from: { id: Number(CUSTOMER), first_name: 'مشتری', is_bot: false },
        data,
        message: {
          message_id: updateSeq + 1,
          date: 0,
          chat: { id: Number(CUSTOMER), type: 'private' },
          from: { id: 999999, is_bot: true, first_name: 'Nexa' },
        },
      },
    });
  const send = (text: string) =>
    handle({
      message: {
        message_id: updateSeq + 1,
        date: 0,
        chat: { id: Number(CUSTOMER), type: 'private' },
        from: { id: Number(CUSTOMER), first_name: 'مشتری', is_bot: false },
        text,
      },
    });

  const walletButtons = async () =>
    (
      await walletBalance(ctx.container.botRuntime, tenantA, systemActor('wallet'), customer)
    ).buttons.map((button) => ('data' in button ? button.data : null));

  it('draws the button only while the feature is on, and answers an old button with «unavailable»', async () => {
    expect(await walletButtons()).not.toContain(GIFT_CARD_CALLBACK_DATA);
    expect((await tap(GIFT_CARD_CALLBACK_DATA)).replyKey).toBe('bot.wallet.gift_card_unavailable');
    await setFlag(true);
    expect(await walletButtons()).toContain(GIFT_CARD_CALLBACK_DATA);
  });

  it('reads the next message as the code, credits it once, and reads the message after that as nothing', async () => {
    await setFlag(true);
    const code = await mintOne();
    expect((await tap(GIFT_CARD_CALLBACK_DATA)).replyKey).toBe('bot.wallet.gift_card_ask');
    const [window] = (
      await ctx.container.database.db.execute(
        sql`SELECT purpose, closed_at FROM customer_text_captures WHERE customer_id = ${customer.id}`,
      )
    ).rows as { purpose: string; closed_at: Date | null }[];
    expect(window).toMatchObject({ purpose: 'GIFT_CARD_CODE', closed_at: null });

    expect((await send(code.toLowerCase())).replyKey).toBe('bot.wallet.gift_card_redeemed');
    const credited = (
      await ctx.container.database.db.execute(
        sql`SELECT amount::text AS amount FROM wallet_entries
             WHERE customer_id = ${customer.id} AND reason = 'GIFT_CARD_REDEMPTION'`,
      )
    ).rows;
    expect(credited).toEqual([{ amount: '30000' }]);
    // The window closed with the read: the same text again is not a code any more.
    expect((await send(code)).replyKey).not.toBe('bot.wallet.gift_card_rejected');

    // Asked again, the used code gets the one refusal and nothing moves.
    await tap(GIFT_CARD_CALLBACK_DATA);
    expect((await send(code)).replyKey).toBe('bot.wallet.gift_card_rejected');
    expect(
      (
        await ctx.container.database.db.execute(
          sql`SELECT count(*)::int AS n FROM wallet_entries WHERE reason = 'GIFT_CARD_REDEMPTION'`,
        )
      ).rows,
    ).toEqual([{ n: 1 }]);
  });
});
