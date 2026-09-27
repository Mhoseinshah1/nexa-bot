import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ANTI_SPAM_BLOCK_REASON,
  ANTI_SPAM_MAX_INTERACTIONS,
  ANTI_SPAM_UNAVAILABLE_CODE,
  TELEGRAM_SECRET_TOKEN_HEADER,
  type AdminId,
  type UserId,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed, SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import {
  adminActorFor,
  createAdmin,
  migrateOnce,
  resetDatabase,
  tenantA,
  testConfig,
} from './harness';

/**
 * WP20 anti-spam (brief §3.4–§3.6), end to end through the webhook, against the real Redis
 * the counter uses and a real socket standing in for Telegram.
 *
 * The owner's rule: interactions 1–20 in a rolling ten seconds are allowed; the 21st blocks
 * the customer, once, as the system, with the owner's reason and sentence; later ones are
 * refused before any work and are not answered while the flood lasts.
 */

const WEBHOOK_SECRET = 'a-sufficiently-long-secret-for-anti-spam';
const BOT_A = SEED_IDS.botA1;
const BOT_A2 = SEED_IDS.botA2;
const BOT_B = SEED_IDS.botB1;
const SPAMMER = 7770001;

interface Sent {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

describe('anti-spam', () => {
  let api: ApiApp;
  let telegram: Server;
  let sent: Sent[];
  let updateId = 50_000;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  beforeAll(async () => {
    sent = [];
    telegram = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        } catch {
          body = {};
        }
        sent.push({ url: request.url ?? '', body });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      });
    });
    await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
    const address = telegram.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    const config = testConfig({
      TELEGRAM_WEBHOOK_ENABLED: 'true',
      TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
    });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  });

  afterAll(async () => {
    await api?.close();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
  });

  beforeEach(async () => {
    // Also clears anti-spam's Redis windows (`resetAntiSpamWindows`).
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    sent = [];
  });

  const message = (
    text: string,
    options: { from?: number; bot?: string; update?: number } = {},
  ) => {
    const id = options.update ?? (updateId += 1);
    const from = options.from ?? SPAMMER;
    return inject({
      method: 'POST',
      url: `/telegram/webhook/${options.bot ?? BOT_A}`,
      headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET },
      payload: {
        update_id: id,
        message: {
          message_id: id,
          date: 0,
          chat: { id: from, type: 'private' },
          from: { id: from, is_bot: false, first_name: 'Spam' },
          text,
        },
      },
    });
  };

  const tap = (data: string, options: { from?: number } = {}) => {
    const id = (updateId += 1);
    const from = options.from ?? SPAMMER;
    return inject({
      method: 'POST',
      url: `/telegram/webhook/${BOT_A}`,
      headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET },
      payload: {
        update_id: id,
        callback_query: {
          id: `cbq-${String(id)}`,
          from: { id: from, is_bot: false, first_name: 'Spam' },
          chat_instance: 'ci',
          message: {
            message_id: id,
            date: 0,
            chat: { id: from, type: 'private' },
            from: { id: 999999, is_bot: true, first_name: 'Nexa' },
            text: 'x',
          },
          data,
        },
      },
    });
  };

  const repeat = async (n: number, send: () => Promise<unknown>) => {
    for (let index = 0; index < n; index += 1) await send();
  };

  const customerRow = async (telegramUserId = SPAMMER, tenantId: string = SEED_IDS.tenantA) =>
    (
      await api.container.database.db.execute(sql`
        SELECT id, status, blocked_reason, blocked_reason_shown FROM customers
         WHERE telegram_user_id = ${String(telegramUserId)} AND tenant_id = ${tenantId}`)
    ).rows[0] as
      | {
          id: string;
          status: string;
          blocked_reason: string | null;
          blocked_reason_shown: boolean;
        }
      | undefined;

  const count = async (query: ReturnType<typeof sql>) =>
    Number(
      (
        (await api.container.database.db.execute(query as never)) as unknown as {
          rows: { n: number }[];
        }
      ).rows[0]?.n ?? 0,
    );

  const messagesSent = () => sent.filter((one) => one.url.includes('/sendMessage'));
  const spamReplies = () =>
    messagesSent().filter((one) => one.body['text'] === CATALOGUE_FA['bot.blocked_spam']);

  it('allows exactly twenty interactions in the window', async () => {
    await repeat(20, () => message('/start'));
    expect((await customerRow())?.status).toBe('ACTIVE');
    expect(spamReplies()).toHaveLength(0);
    expect(messagesSent()).toHaveLength(20);
  });

  it('blocks on the 21st, once, as the system, with the owner’s reason and sentence', async () => {
    await repeat(21, () => message('سلام'));
    const row = await customerRow();
    expect(row?.status).toBe('BLOCKED');
    expect(row?.blocked_reason).toBe(ANTI_SPAM_BLOCK_REASON);
    expect(row?.blocked_reason_shown).toBe(true);
    expect(spamReplies(), 'the customer is told why, once').toHaveLength(1);
    expect(messagesSent().at(-1)?.body['text']).toBe(CATALOGUE_FA['bot.blocked_spam']);

    // One block: one audit row that changed something, one event, by SYSTEM_JOB.
    expect(
      await count(sql`SELECT count(*)::int AS n FROM outbox_messages
                       WHERE event_type = 'CustomerBlocked'`),
    ).toBe(1);
    const audit = (
      await api.container.database.db.execute(sql`
        SELECT actor_type, after FROM audit_logs
         WHERE action = 'customer.block' AND entity_id = ${row?.id ?? ''}`)
    ).rows as { actor_type: string; after: Record<string, unknown> }[];
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor_type).toBe('SYSTEM_JOB');
    expect(audit[0]?.after['context']).toMatchObject({
      source: 'ANTI_SPAM',
      interactions: 21,
    });
  });

  it('answers nothing more while the flood lasts, and still answers every button', async () => {
    await repeat(21, () => message('x'));
    sent = [];
    await repeat(4, () => message('y'));
    await tap('menu');
    expect(messagesSent(), 'no reply per flooded message').toHaveLength(0);
    // The spinner is still stopped: the callback query is answered.
    expect(sent.filter((one) => one.url.includes('/answerCallbackQuery'))).toHaveLength(1);
    expect((await customerRow())?.status).toBe('BLOCKED');
  });

  it('counts /ping, and writes nothing for one past the limit', async () => {
    // The webhook answers `/ping` before the runtime runs; each one it records writes an
    // audit row, an outbox event and an idempotency row.
    await repeat(ANTI_SPAM_MAX_INTERACTIONS + 5, () => message('/ping'));
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM outbox_messages WHERE event_type = 'SystemPinged'`,
      ),
    ).toBe(ANTI_SPAM_MAX_INTERACTIONS);
  });

  it('tells the customer why on the turn that takes the block, when the 21st did not (review of #84)', async () => {
    // The 21st counted interaction is a `/ping`, which the webhook answers without
    // blocking. The next message is the 22nd — FLOODING — and it is the one that blocks.
    await message('/start');
    await repeat(ANTI_SPAM_MAX_INTERACTIONS, () => message('/ping'));
    expect((await customerRow())?.status, 'no block yet').toBe('ACTIVE');
    sent = [];
    await message('x');
    expect((await customerRow())?.status).toBe('BLOCKED');
    expect(spamReplies(), 'told why, by the turn that blocked').toHaveLength(1);
    // ...and still once: the flood after it is not answered.
    await repeat(3, () => message('y'));
    expect(spamReplies()).toHaveLength(1);
  });

  it('counts button presses', async () => {
    await message('/start');
    await repeat(20, () => tap('menu'));
    expect((await customerRow())?.status).toBe('BLOCKED');
  });

  it('counts /start', async () => {
    await repeat(21, () => message('/start'));
    expect((await customerRow())?.status).toBe('BLOCKED');
  });

  it('counts a callback that claims to be an administrator’s', async () => {
    await message('/start');
    await repeat(20, () => tap('C:019240ab-cdef-7012-8345-6789abcdef01'));
    expect((await customerRow())?.status).toBe('BLOCKED');
  });

  it('never blocks a bound administrator', async () => {
    const owner = await createAdmin(api.container, tenantA, {
      username: 'spam-owner',
      roleKeys: ['owner'],
    });
    await api.container.adminManagement.setTelegramBinding(
      tenantA,
      adminActorFor(owner),
      owner.id as AdminId,
      { telegramUserId: String(SPAMMER), reason: 'test binding' },
    );
    await repeat(25, () => message('/start'));
    expect((await customerRow())?.status).toBe('ACTIVE');
    expect(spamReplies()).toHaveLength(0);
  });

  it('does not count a redelivered update twice', async () => {
    await repeat(19, () => message('/start'));
    const again = (updateId += 1);
    await repeat(5, () => message('/start', { update: again }));
    expect((await customerRow())?.status, 'twenty distinct updates').toBe('ACTIVE');
    await message('/start');
    expect((await customerRow())?.status, 'the twenty-first distinct one').toBe('BLOCKED');
  });

  it('counts per tenant', async () => {
    await repeat(20, () => message('/start', { bot: BOT_A }));
    await repeat(20, () => message('/start', { bot: BOT_B }));
    expect((await customerRow(SPAMMER, SEED_IDS.tenantA))?.status).toBe('ACTIVE');
    expect((await customerRow(SPAMMER, SEED_IDS.tenantB))?.status).toBe('ACTIVE');
  });

  it('counts per bot', async () => {
    // The seed's second bot is STOPPED, and a stopped bot's updates are never handled —
    // so without this the test below passed without counting anything on it.
    await api.container.database.db.execute(
      sql`UPDATE bot_instances SET status = 'ACTIVE' WHERE id = ${BOT_A2}`,
    );
    await repeat(20, () => message('/start', { bot: BOT_A }));
    await repeat(20, () => message('/start', { bot: BOT_A2 }));
    expect((await customerRow())?.status, 'twenty on each bot').toBe('ACTIVE');
    // The second bot's window is real: its own twenty-first blocks.
    await message('/start', { bot: BOT_A2 });
    expect((await customerRow())?.status).toBe('BLOCKED');
  });

  it('blocks exactly once when the threshold is crossed concurrently', async () => {
    await message('/start');
    await Promise.all(Array.from({ length: 30 }, () => message('x')));
    expect((await customerRow())?.status).toBe('BLOCKED');
    expect(
      await count(sql`SELECT count(*)::int AS n FROM outbox_messages
                       WHERE event_type = 'CustomerBlocked'`),
    ).toBe(1);
    /*
     * Not "one reply": an interaction counted within the first twenty can still be
     * processed after the block commits, and is rightly answered with the blocked sentence.
     * What IS guaranteed is the amplification bound: nothing past the 21st interaction is
     * answered, so thirty-one interactions produce at most twenty-one messages.
     */
    expect(spamReplies().length).toBeGreaterThanOrEqual(1);
    expect(messagesSent().length, 'no reply past the 21st interaction').toBeLessThanOrEqual(21);
  });

  it('keeps an administrator’s block, and its reason, when anti-spam loses the race', async () => {
    await message('/start');
    const row = await customerRow();
    const owner = await createAdmin(api.container, tenantA, {
      username: 'block-owner',
      roleKeys: ['owner'],
    });
    await api.container.customers.block(tenantA, adminActorFor(owner), {
      idempotencyKey: 'manual-block',
      customerId: row?.id ?? '',
      reason: 'بدهی پرداخت‌نشده',
    });
    await repeat(21, () => message('x'));
    const after = await customerRow();
    expect(after?.blocked_reason).toBe('بدهی پرداخت‌نشده');
    expect(spamReplies()).toHaveLength(0);
  });

  it('answers nothing past the limit on a turn that did not take the block (review of #84)', async () => {
    // Blocked by an administrator first, so no turn of the flood takes the block. Counts
    // 2..20 are answered with the stored reason; the 21st — which under concurrency can
    // also be a turn that LOST the block to a later one — sends nothing, like the 22nd.
    await message('/start');
    const row = await customerRow();
    const owner = await createAdmin(api.container, tenantA, {
      username: 'silence-owner',
      roleKeys: ['owner'],
    });
    await api.container.customers.block(tenantA, adminActorFor(owner), {
      idempotencyKey: 'manual-block-silence',
      customerId: row?.id ?? '',
      reason: 'دلیل مدیر',
    });
    sent = [];
    await repeat(ANTI_SPAM_MAX_INTERACTIONS + 1, () => message('x'));
    expect(messagesSent()).toHaveLength(ANTI_SPAM_MAX_INTERACTIONS - 1);
  });

  it('refuses a blocked customer every commercial action', async () => {
    await repeat(21, () => message('/start'));
    sent = [];
    await message('/catalog');
    await tap('P:019240ab-cdef-7012-8345-6789abcdef01');
    expect(await count(sql`SELECT count(*)::int AS n FROM orders`)).toBe(0);
    for (const one of messagesSent()) {
      expect(one.body['text']).toBe(CATALOGUE_FA['bot.blocked_spam']);
    }
  });

  it('shows the administrator BLOCKED with the stored reason, and a manual unblock restores it', async () => {
    await repeat(21, () => message('/start'));
    const row = await customerRow();
    const owner = await createAdmin(api.container, tenantA, {
      username: 'unblock-owner',
      roleKeys: ['owner'],
    });
    const seen = await api.container.customers.get(tenantA, adminActorFor(owner), row?.id ?? '');
    expect(seen.status).toBe('BLOCKED');
    expect(seen.blockedReason).toBe(ANTI_SPAM_BLOCK_REASON);

    await api.container.customers.unblock(tenantA, adminActorFor(owner), {
      idempotencyKey: 'manual-unblock',
      customerId: row?.id as UserId,
      reason: null,
    });
    // Past the rolling window, so the flood that blocked them has aged out.
    await new Promise((resolve) => setTimeout(resolve, 10_500));
    sent = [];
    await message('/start');
    expect((await customerRow())?.status).toBe('ACTIVE');
    expect(spamReplies()).toHaveLength(0);
    expect(messagesSent()).toHaveLength(1);
  }, 30_000);
});

describe('anti-spam with Redis down', () => {
  let api: ApiApp;
  let telegram: Server;
  let updateId = 90_000;

  beforeAll(async () => {
    telegram = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    });
    await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
    const address = telegram.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    const config = testConfig({
      TELEGRAM_WEBHOOK_ENABLED: 'true',
      TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
      // Nothing listens here: every count fails.
      REDIS_URL: 'redis://127.0.0.1:6399',
    });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  });

  afterAll(async () => {
    await api?.close();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
  });

  it('blocks nobody, and records that the protection is off', async () => {
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    for (let index = 0; index < 25; index += 1) {
      const id = (updateId += 1);
      await api.app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: 'POST',
          url: `/telegram/webhook/${BOT_A}`,
          headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET },
          payload: {
            update_id: id,
            message: {
              message_id: id,
              date: 0,
              chat: { id: SPAMMER, type: 'private' },
              from: { id: SPAMMER, is_bot: false, first_name: 'Spam' },
              text: '/start',
            },
          },
        } as never);
    }
    const status = (
      await api.container.database.db.execute(sql`
        SELECT status FROM customers WHERE telegram_user_id = ${String(SPAMMER)}`)
    ).rows[0] as { status: string } | undefined;
    expect(status?.status).toBe('ACTIVE');
    const events = (
      await api.container.database.db.execute(sql`
        SELECT occurrence_count FROM operational_events WHERE code = ${ANTI_SPAM_UNAVAILABLE_CODE}`)
    ).rows as { occurrence_count: number }[];
    expect(events, 'one condition').toHaveLength(1);
    // Written once while it lasts, not once per message: a write per flood message would be
    // the database cost the brief forbids.
    expect(events[0]?.occurrence_count).toBe(1);
  }, 60_000);
});
