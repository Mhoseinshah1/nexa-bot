import { createServer, type Server } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  TELEGRAM_SECRET_TOKEN_HEADER,
  type AdminId,
  type BotInstanceId,
  type CorrelationId,
} from '@nexa/contracts';
import type { ApiApp } from '../../apps/api/src/bootstrap';
import { seed, SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import {
  adminActorFor,
  createAdmin,
  // The harness's: the application as nexa_app, `container.database` the owner's (ADR-0037).
  createApiApp,
  migrateOnce,
  resetDatabase,
  tenantA,
  testConfig,
} from './harness';

/**
 * Updates from a group, supergroup or channel never create or touch a customer.
 *
 * Seen on a real server: somebody joined the operations log group by its invite link, the
 * bot posted «کاربر جدید» there and a customer row appeared, which then blocked the legacy
 * import's "no customers yet" check. Only a PRIVATE chat is a customer contact. The one
 * thing a group may still send is an administrator's tap on a button the bot posted there,
 * which goes to the management panel without resolving a customer.
 */

const WEBHOOK_SECRET = 'a-sufficiently-long-secret-for-the-group';
const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const GROUP = { id: -1001234567890, type: 'supergroup', title: 'ops' };
const MEMBER = { id: 777000111, is_bot: false, first_name: 'Joiner' };
const ADMIN_TG = '720099';
const SUBJECT_TG = '555100200';

describe('group and channel updates', () => {
  let api: ApiApp;
  let telegram: Server;
  let sent: { url: string; body: Record<string, unknown> }[];
  let updateId = 5000;

  beforeAll(async () => {
    sent = [];
    telegram = createServer((request, response) => {
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
        response.end(JSON.stringify({ ok: true, result: { message_id: 11 } }));
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
  }, 120_000);

  afterAll(async () => {
    await api?.close();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
  });

  beforeEach(async () => {
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    sent = [];
  });

  const post = (payload: Record<string, unknown>) => {
    updateId += 1;
    return api.app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: `/telegram/webhook/${BOT_A}`,
        headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET },
        payload: { update_id: updateId, ...payload },
      } as never);
  };

  const count = async (table: 'customers' | 'registered') =>
    Number(
      (
        await api.container.database.db.execute<{ n: string }>(
          table === 'customers'
            ? sql`SELECT count(*)::text AS n FROM customers`
            : sql`SELECT count(*)::text AS n FROM outbox_messages WHERE event_type = 'CustomerRegistered'`,
        )
      ).rows[0]?.n ?? '0',
    );

  const groupMessage = (extra: Record<string, unknown>) =>
    post({
      message: { message_id: updateId, date: 0, chat: GROUP, from: MEMBER, ...extra },
    });

  const expectNothing = async () => {
    expect(await count('customers')).toBe(0);
    expect(await count('registered')).toBe(0);
    expect(sent.filter((s) => s.url.includes('/sendMessage'))).toEqual([]);
  };

  it('a join through an invite link creates no customer and posts no «کاربر جدید»', async () => {
    const response = await groupMessage({ new_chat_members: [MEMBER] });
    expect(response.statusCode).toBeLessThan(300);
    await expectNothing();
  });

  it('a leave creates no customer', async () => {
    await groupMessage({ left_chat_member: MEMBER });
    await expectNothing();
  });

  it('a pin creates no customer', async () => {
    await groupMessage({ pinned_message: { message_id: 1, date: 0, chat: GROUP } });
    await expectNothing();
  });

  it('a plain group message creates no customer', async () => {
    await groupMessage({ text: 'hello everyone' });
    await expectNothing();
  });

  it('a plain message in an ordinary group creates no customer either', async () => {
    await post({
      message: {
        message_id: 1,
        date: 0,
        chat: { id: -4242, type: 'group' },
        from: MEMBER,
        text: '/start',
      },
    });
    await expectNothing();
  });

  it('a channel post creates no customer, even one that carries a sender', async () => {
    await post({
      channel_post: {
        message_id: 1,
        date: 0,
        chat: { id: -100999, type: 'channel' },
        from: MEMBER,
        text: 'news',
      },
    });
    await expectNothing();
  });

  it('a private /start still creates the customer and the arrival event', async () => {
    const response = await post({
      message: {
        message_id: 1,
        date: 0,
        chat: { id: 4242, type: 'private' },
        from: { id: 5551234567, is_bot: false, first_name: 'Ali' },
        text: '/start',
      },
    });
    expect(response.statusCode).toBe(201);
    expect(await count('customers')).toBe(1);
    expect(await count('registered')).toBe(1);
  });

  describe('a tapped button in the group', () => {
    const tap = (data: string, fromId: string, chatType = 'supergroup') =>
      post({
        callback_query: {
          id: `cbq-${String(updateId)}`,
          from: { id: Number(fromId), is_bot: false, first_name: 'X' },
          data,
          message: {
            message_id: 9,
            date: 0,
            chat: { ...GROUP, type: chatType },
            from: { id: 1, is_bot: true, first_name: 'Nexa' },
          },
        },
      });

    const blockedCustomer = async (): Promise<string> => {
      const { customer } = await api.container.customers.resolveFromUpdate(
        tenantA,
        {
          type: 'SYSTEM_JOB',
          id: null,
          label: 'telegram-update:test',
          surface: 'TELEGRAM',
          correlationId: 'seed' as CorrelationId,
        },
        {
          intake: 'INTERNAL',
          idempotencyKey: 'seed-subject',
          telegramUserId: SUBJECT_TG,
          from: { id: Number(SUBJECT_TG), first_name: 'کاربر' },
          botInstanceId: BOT_A,
        },
      );
      await api.container.database.db.execute(
        sql`UPDATE customers SET status = 'BLOCKED', blocked_reason = 'spam', blocked_at = now() WHERE id = ${customer.id}`,
      );
      return customer.id;
    };

    const statusOf = async (id: string): Promise<string> =>
      String(
        (
          await api.container.database.db.execute<{ status: string }>(
            sql`SELECT status FROM customers WHERE id = ${id}`,
          )
        ).rows[0]?.status,
      );

    const bindOwner = async () => {
      const admin = await createAdmin(api.container, tenantA, {
        username: 'group-owner',
        roleKeys: ['owner'],
      });
      await api.container.adminManagement.setTelegramBinding(
        tenantA,
        adminActorFor(admin),
        admin.id as AdminId,
        { telegramUserId: ADMIN_TG, reason: 'test binding' },
      );
    };

    it('still works for a bound administrator, and creates no customer for them', async () => {
      const subject = await blockedCustomer();
      await bindOwner();
      const before = await count('customers');

      const response = await tap(`9:n:${subject}`, ADMIN_TG);

      expect(response.statusCode).toBeLessThan(300);
      expect(await statusOf(subject)).toBe('ACTIVE');
      // The administrator tapped from the group: no row for their Telegram account.
      expect(await count('customers')).toBe(before);
      // The spinner was stopped, and nothing was sent into the group.
      expect(sent.some((s) => s.url.includes('/answerCallbackQuery'))).toBe(true);
      expect(sent.some((s) => s.url.includes('/sendMessage'))).toBe(false);
    });

    it('is still refused for somebody who is not an administrator, and creates no customer', async () => {
      const subject = await blockedCustomer();
      await bindOwner();
      const before = await count('customers');

      await tap(`9:n:${subject}`, '999000999');

      expect(await statusOf(subject)).toBe('BLOCKED');
      expect(await count('customers')).toBe(before);
    });

    it('a non-admin callback in a group is only acknowledged', async () => {
      await tap('unknown-callback', '999000999');
      expect(await count('customers')).toBe(0);
      expect(sent.filter((s) => s.url.includes('/sendMessage'))).toEqual([]);
    });
  });

  it('a private callback still works and still resolves its customer', async () => {
    const response = await post({
      callback_query: {
        id: 'cbq-private',
        from: { id: 5551234567, is_bot: false, first_name: 'Ali' },
        data: 'unknown-callback',
        message: {
          message_id: 9,
          date: 0,
          chat: { id: 5551234567, type: 'private' },
          from: { id: 1, is_bot: true, first_name: 'Nexa' },
        },
      },
    });
    expect(response.statusCode).toBeLessThan(500);
    expect(await count('customers')).toBe(1);
    expect(sent.some((s) => s.url.includes('/answerCallbackQuery'))).toBe(true);
  });
});
