import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MINIAPP_API_PREFIX,
  MINIAPP_NOTIFICATION_PAGE_SIZE,
  MINIAPP_NOTIFICATION_TEXT_MAX,
  MINIAPP_NOTIFICATION_WINDOW_DAYS,
  MINIAPP_ROUTES,
  miniAppMeResponseSchema,
  miniAppNotificationReadResponseSchema,
  miniAppNotificationsResponseSchema,
  miniAppPath,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type UserId,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { miniAppActor } from '../../apps/api/src/modules/commerce/miniapp/application/miniapp-session.service';
import { DrizzleNotificationCentreRepository } from '../../apps/api/src/modules/commerce/miniapp/infrastructure/drizzle-notification-centre.repository';
import { DrizzleCustomerNotificationRepository } from '../../apps/api/src/modules/commerce/messaging/infrastructure/drizzle-customer-notification.repository';
import {
  CustomerNotificationService,
  type CustomerNotificationDeps,
} from '../../apps/api/src/modules/commerce/messaging/application/customer-notification.service';
import type { CustomerSendResult } from '../../apps/api/src/modules/commerce/messaging/application/ports';
import { DrizzleCustomerRepository } from '../../apps/api/src/modules/commerce/customers/infrastructure/drizzle-customer.repository';
import { DrizzleServiceReminderSnapshotReader } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service-reminder.repository';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  tenantB,
  testConfig,
  type TestContext,
} from './harness';

/**
 * Round 11, B1: the customer notification centre in the mini app — the bot messages the
 * customer notification lane has already DELIVERED to this customer, with read and unread.
 *
 * Two halves. The first drives the lane's own dispatcher and shows that the words are stored
 * by the `DELIVERED` outcome and by nothing else (so the centre is the lane's record, not a
 * second store). The second drives the mini app over real HTTP and shows what a customer can
 * and cannot see and change: only their own, from the bot they opened, in their own tenant;
 * nothing at all while the flag is off; marking is idempotent.
 */

const BOT_A1 = SEED_IDS.botA1 as BotInstanceId;
const BOT_A2 = SEED_IDS.botA2 as BotInstanceId;
const BOT_B1 = SEED_IDS.botB1 as BotInstanceId;
const TOKEN_A1 = '000000:seed-token-acme-1';

const systemActor = (key: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'notification-centre:test',
  surface: 'TELEGRAM',
  correlationId: `corr-${key}` as CorrelationId,
});

function initDataFor(user: { id: number; first_name: string }): string {
  const fields: Record<string, string> = {
    query_id: `q-${String(user.id)}-${String(Math.random()).slice(2, 10)}`,
    user: JSON.stringify(user),
    auth_date: String(Math.floor(Date.now() / 1000)),
  };
  const check = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN_A1).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

describe('the mini app notification centre', () => {
  let ctx: TestContext;
  let api: ApiApp;
  let owner: ActorContext;
  let keySeq = 0;
  const key = () => `centre-key-${String((keySeq += 1)).padStart(6, '0')}-abcdef`;
  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  beforeAll(async () => {
    ctx = await createTestContext({});
    api = await createApiApp(testConfig({}));
  }, 120_000);

  afterAll(async () => {
    await api?.close();
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    api.container.setInstallationTenant(tenantA.tenantId);
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'centre-owner', roleKeys: ['owner'] }),
    );
    await setFlag('mini_app', true);
  });

  async function setFlag(flag: string, enabled: boolean) {
    const current = await ctx.container.featureFlagResolver.resolve(tenantA, flag as never);
    await ctx.container.featureFlags.set(tenantA, owner, {
      key: flag as never,
      enabled,
      expectedVersion: current.version,
      idempotencyKey: key(),
      reason: 'notification centre integration test',
    });
  }

  // --- HTTP helpers ----------------------------------------------------------------------

  async function sessionFor(telegramUserId: number): Promise<string> {
    const response = await inject({
      method: 'POST',
      url: `${MINIAPP_API_PREFIX}${miniAppPath(MINIAPP_ROUTES.session, { botInstanceId: BOT_A1 })}`,
      payload: { initData: initDataFor({ id: telegramUserId, first_name: 'مشتری' }) },
    });
    expect(response.statusCode, response.body).toBe(201);
    return (JSON.parse(response.body) as { token: string }).token;
  }

  const call = (
    token: string,
    method: 'GET' | 'POST',
    route: string,
    params: Record<string, string> = {},
    options: { readonly key?: string; readonly query?: string } = {},
  ) =>
    inject({
      method,
      url: `${MINIAPP_API_PREFIX}${miniAppPath(route, params)}${options.query ?? ''}`,
      headers: {
        authorization: `Bearer ${token}`,
        ...(method === 'GET' ? {} : { 'idempotency-key': options.key ?? key() }),
      },
      ...(method === 'GET' ? {} : { payload: {} }),
    });

  const customerIdOf = async (telegramUserId: number): Promise<UserId> => {
    const rows = await ctx.container.database.db.execute<{ id: string }>(
      sql`SELECT id FROM customers WHERE tenant_id = ${tenantA.tenantId}
            AND telegram_user_id = ${String(telegramUserId)}`,
    );
    const id = rows.rows[0]?.id;
    if (id === undefined) throw new Error('no customer');
    return id as UserId;
  };

  /** A customer of tenant B, for the cross-tenant cases. */
  async function tenantBCustomer(telegramUserId: string): Promise<UserId> {
    const { customer } = await ctx.container.customers.resolveFromUpdate(
      tenantB,
      systemActor(`b-${telegramUserId}`),
      {
        idempotencyKey: `b-${telegramUserId}`,
        telegramUserId,
        from: { id: Number(telegramUserId), first_name: 'ب' },
        botInstanceId: BOT_B1,
      },
    );
    return customer.id;
  }

  interface Fixture {
    readonly tenantId?: string;
    readonly botInstanceId?: BotInstanceId;
    readonly text: string | null;
    readonly state?: string;
    readonly minutesAgo?: number;
    readonly read?: boolean;
  }

  /** One `customer_notifications` row as the dispatcher leaves it after a send. */
  async function row(customerId: UserId, fixture: Fixture): Promise<string> {
    const id = ctx.container.ids.uuid();
    const state = fixture.state ?? 'DELIVERED';
    await ctx.container.database.db.execute(sql`
      INSERT INTO customer_notifications
        (id, tenant_id, customer_id, bot_instance_id, kind, subject_id, state, attempts,
         resolved_at, rendered_text, customer_read_at, created_at, updated_at)
      VALUES
        (${id}, ${fixture.tenantId ?? tenantA.tenantId}, ${customerId},
         ${fixture.botInstanceId ?? BOT_A1}, 'ORDER_CANCELLED', ${ctx.container.ids.uuid()},
         ${state}, 1,
         ${state === 'PENDING' ? null : sql`now() - make_interval(mins => ${fixture.minutesAgo ?? 1})`},
         ${fixture.text},
         ${fixture.read === true ? sql`now()` : null},
         now() - make_interval(mins => ${(fixture.minutesAgo ?? 1) + 1}), now())`);
    return id;
  }

  const readAt = async (id: string): Promise<Date | null> => {
    const result = await ctx.container.database.db.execute<{ customer_read_at: Date | null }>(
      sql`SELECT customer_read_at FROM customer_notifications WHERE id = ${id}`,
    );
    return result.rows[0]?.customer_read_at ?? null;
  };

  const listOf = async (token: string, query = '') => {
    const response = await call(token, 'GET', MINIAPP_ROUTES.notifications, {}, { query });
    expect(response.statusCode, response.body).toBe(200);
    return miniAppNotificationsResponseSchema.parse(JSON.parse(response.body));
  };

  const meOf = async (token: string) => {
    const response = await call(token, 'GET', MINIAPP_ROUTES.me);
    expect(response.statusCode, response.body).toBe(200);
    return miniAppMeResponseSchema.parse(JSON.parse(response.body));
  };

  // =====================================================================================
  // The lane stores the words of a DELIVERED message, and only that
  // =====================================================================================

  describe('what the dispatcher stores', () => {
    let outcomes: CustomerSendResult[];
    let renders: number;

    beforeEach(() => {
      outcomes = [];
      renders = 0;
    });

    function lane(centre: 'real' | 'absent' | 'throwing' = 'real') {
      const people = new DrizzleCustomerRepository(ctx.container.database.db);
      const deps: CustomerNotificationDeps = {
        notifications: new DrizzleCustomerNotificationRepository(ctx.container.database.db),
        refundFigures: { refundedForOrder: async () => null },
        paymentCredits: { creditedForPayment: async () => null },
        rejectionReasons: { rejectionReasonFor: async () => null },
        reminderSnapshots: new DrizzleServiceReminderSnapshotReader(ctx.container.database.db),
        contacts: {
          contactFor: async (scope, customerId, tx) => {
            const found = await people.findById(scope, customerId, tx);
            if (found === null) return { kind: 'NONE' };
            return { kind: 'CONTACT', contact: { chatId: found.telegramUserId } };
          },
        },
        subjects: { stillHolds: async () => true },
        messenger: {
          send: async () => outcomes.shift() ?? { outcome: 'DELIVERED' },
          acknowledge: async () => undefined,
          sendFile: async () => ({ outcome: 'REFUSED' }),
        },
        uow: ctx.container.uow,
        clock: ctx.container.clock,
        scopeIsActive: async () => true,
        logger: { info: () => {}, error: () => {} },
        ...(centre === 'absent'
          ? {}
          : {
              centreText: {
                render: async (scope, templateKey, values) => {
                  renders += 1;
                  if (centre === 'throwing') throw new Error('template store down');
                  return ctx.container.templateResolver.render(scope, templateKey, values);
                },
              },
            }),
      };
      return new CustomerNotificationService(deps);
    }

    async function queued(telegramUserId: string): Promise<string> {
      const { customer } = await ctx.container.customers.resolveFromUpdate(
        tenantA,
        systemActor(`q-${telegramUserId}`),
        {
          idempotencyKey: `q-${telegramUserId}`,
          telegramUserId,
          from: { id: Number(telegramUserId), first_name: 'زهرا' },
          botInstanceId: BOT_A1,
        },
      );
      const id = ctx.container.ids.uuid();
      await ctx.container.uow.run(tenantA, async (tx) =>
        new DrizzleCustomerNotificationRepository(ctx.container.database.db).enqueue(
          tenantA,
          {
            id,
            customerId: customer.id,
            botInstanceId: BOT_A1,
            kind: 'ORDER_CANCELLED',
            subjectId: ctx.container.ids.uuid(),
          },
          ctx.container.clock.now(),
          tx,
        ),
      );
      return id;
    }

    const stored = async (id: string) =>
      (
        await ctx.container.database.db.execute<{ state: string; rendered_text: string | null }>(
          sql`SELECT state, rendered_text FROM customer_notifications WHERE id = ${id}`,
        )
      ).rows[0];

    it('stamps the rendered words in the same statement that records DELIVERED', async () => {
      const id = await queued('8001');
      await lane().deliverDue(tenantA, 10);
      const after = await stored(id);
      expect(after?.state).toBe('DELIVERED');
      // The tenant's own rendering of the kind's template: «سفارش لغو شد.»
      expect(after?.rendered_text).toBe('سفارش لغو شد.');
      expect(renders).toBe(1);
    });

    it('stores nothing for a message that did not reach the customer', async () => {
      outcomes.push({ outcome: 'REFUSED' });
      const refused = await queued('8002');
      await lane().deliverDue(tenantA, 10);
      expect(await stored(refused)).toEqual({ state: 'PENDING', rendered_text: null });
      expect(renders, 'a refusal is not rendered a second time').toBe(0);

      outcomes.push({ outcome: 'UNKNOWN' });
      const unknown = await queued('8003');
      await lane().deliverDue(tenantA, 10);
      expect(await stored(unknown)).toEqual({ state: 'UNCONFIRMED', rendered_text: null });
    });

    it('keeps a delivery recorded when the second render fails: delivered, and not listed', async () => {
      const id = await queued('8004');
      await lane('throwing').deliverDue(tenantA, 10);
      expect(await stored(id)).toEqual({ state: 'DELIVERED', rendered_text: null });
    });

    it('leaves the words empty when no centre renderer is wired', async () => {
      const id = await queued('8005');
      await lane('absent').deliverDue(tenantA, 10);
      expect(await stored(id)).toEqual({ state: 'DELIVERED', rendered_text: null });
    });

    it('ignores words offered with any outcome but DELIVERED, rather than failing the record', async () => {
      const id = await queued('8007');
      const repo = new DrizzleCustomerNotificationRepository(ctx.container.database.db);
      const now = ctx.container.clock.now();
      const moved = await ctx.container.uow.run(tenantA, async (tx) =>
        repo.record(
          tenantA,
          id,
          'FAILED',
          { resolvedAt: now, nextAttemptAt: null, renderedText: 'متنی که نباید ذخیره شود' },
          now,
          tx,
        ),
      );
      expect(moved).toBe(true);
      expect(await stored(id)).toEqual({ state: 'FAILED', rendered_text: null });
    });

    it('refuses text on anything but a delivered row, and a read mark on a row with no text', async () => {
      const id = await queued('8006');
      await expect(
        ctx.container.database.db.execute(
          sql`UPDATE customer_notifications SET rendered_text = 'x' WHERE id = ${id}`,
        ),
      ).rejects.toThrow();
      await expect(
        ctx.container.database.db.execute(
          sql`UPDATE customer_notifications SET customer_read_at = now() WHERE id = ${id}`,
        ),
      ).rejects.toThrow();
    });
  });

  // =====================================================================================
  // The feature flag
  // =====================================================================================

  describe('the flag', () => {
    it('is OFF by default: no bell in /me and every endpoint answers as if it did not exist', async () => {
      const token = await sessionFor(8101);
      const id = await row(await customerIdOf(8101), { text: 'پیام' });
      expect((await meOf(token)).notifications).toBeNull();
      for (const response of [
        await call(token, 'GET', MINIAPP_ROUTES.notifications),
        await call(token, 'POST', MINIAPP_ROUTES.notificationRead, { notificationId: id }),
        await call(token, 'POST', MINIAPP_ROUTES.notificationsReadAll),
      ]) {
        expect(response.statusCode).toBe(404);
        expect(response.body).toContain('miniapp.unavailable');
      }
      expect(await readAt(id), 'a refused request marks nothing').toBeNull();
    });

    it('draws the bell once it is on, and takes it away again without losing a mark', async () => {
      const token = await sessionFor(8102);
      const customerId = await customerIdOf(8102);
      const read = await row(customerId, { text: 'خوانده', read: true });
      await row(customerId, { text: 'تازه' });
      await setFlag('notification_centre', true);
      expect((await meOf(token)).notifications).toEqual({ unreadCount: 1 });
      await setFlag('notification_centre', false);
      expect((await meOf(token)).notifications).toBeNull();
      expect(await readAt(read), 'switching it off kept the mark').not.toBeNull();
    });
  });

  // =====================================================================================
  // What the list shows
  // =====================================================================================

  describe('the list', () => {
    beforeEach(async () => {
      await setFlag('notification_centre', true);
    });

    it("shows only the session's own customer's delivered messages, newest first", async () => {
      const token = await sessionFor(8201);
      const other = await sessionFor(8202);
      const mine = await customerIdOf(8201);
      const theirs = await customerIdOf(8202);
      await row(mine, { text: 'قدیمی', minutesAgo: 30 });
      await row(mine, { text: 'تازه', minutesAgo: 5 });
      await row(theirs, { text: 'مال دیگری', minutesAgo: 1 });

      const page = await listOf(token);
      expect(page.items.map((item) => item.text)).toEqual(['تازه', 'قدیمی']);
      expect(page.items.every((item) => !item.read)).toBe(true);
      expect(page.unreadCount).toBe(2);
      expect((await listOf(other)).items.map((item) => item.text)).toEqual(['مال دیگری']);
    });

    it("never shows another bot's messages: to this bot they are nobody's", async () => {
      const token = await sessionFor(8203);
      const mine = await customerIdOf(8203);
      await row(mine, { text: 'از همین ربات' });
      // Another bot of the SAME tenant and the SAME customer.
      await row(mine, { text: 'ربات دیگر', botInstanceId: BOT_A2 });
      const page = await listOf(token);
      expect(page.items.map((item) => item.text)).toEqual(['از همین ربات']);
      expect(page.unreadCount).toBe(1);
    });

    it("never shows another tenant's messages", async () => {
      const token = await sessionFor(8209);
      const mine = await customerIdOf(8209);
      const foreign = await tenantBCustomer('8209');
      await row(mine, { text: 'مال من' });
      await row(foreign, {
        text: 'مستأجر دیگر',
        tenantId: tenantB.tenantId,
        botInstanceId: BOT_B1,
      });
      expect((await listOf(token)).items.map((item) => item.text)).toEqual(['مال من']);
    });

    it('lists only delivered messages: a row that never reached the customer has no words and is not one', async () => {
      const token = await sessionFor(8210);
      const mine = await customerIdOf(8210);
      await row(mine, { text: 'رسیده' });
      await row(mine, { text: null, state: 'PENDING' });
      await row(mine, { text: null, state: 'FAILED' });
      await row(mine, { text: null, state: 'DELIVERED' });
      const page = await listOf(token);
      expect(page.items.map((item) => item.text)).toEqual(['رسیده']);
      expect(page.unreadCount).toBe(1);
    });

    it('counts only the unread ones, and a read one stays listed as read', async () => {
      const token = await sessionFor(8211);
      const mine = await customerIdOf(8211);
      await row(mine, { text: 'خوانده', minutesAgo: 2, read: true });
      await row(mine, { text: 'خوانده‌نشده', minutesAgo: 1 });
      const page = await listOf(token);
      expect(page.unreadCount).toBe(1);
      expect(page.items.map((item) => [item.text, item.read])).toEqual([
        ['خوانده‌نشده', false],
        ['خوانده', true],
      ]);
      expect((await meOf(token)).notifications).toEqual({ unreadCount: 1 });
    });

    it('counts and lists only the window, so an old backlog is neither paged nor counted', async () => {
      const token = await sessionFor(8204);
      const mine = await customerIdOf(8204);
      await row(mine, {
        text: 'خیلی قدیمی',
        minutesAgo: (MINIAPP_NOTIFICATION_WINDOW_DAYS + 1) * 24 * 60,
      });
      await row(mine, {
        text: 'در بازه',
        minutesAgo: (MINIAPP_NOTIFICATION_WINDOW_DAYS - 1) * 24 * 60,
      });
      const page = await listOf(token);
      expect(page.items.map((item) => item.text)).toEqual(['در بازه']);
      expect(page.unreadCount).toBe(1);
    });

    it('pages by a keyset cursor, a page at a time, and refuses a cursor it did not mint', async () => {
      const token = await sessionFor(8205);
      const mine = await customerIdOf(8205);
      const total = MINIAPP_NOTIFICATION_PAGE_SIZE + 5;
      for (let at = 1; at <= total; at += 1) {
        await row(mine, { text: `پیام ${String(at)}`, minutesAgo: at });
      }
      const first = await listOf(token);
      expect(first.items).toHaveLength(MINIAPP_NOTIFICATION_PAGE_SIZE);
      expect(first.items[0]?.text).toBe('پیام 1');
      expect(first.nextCursor).not.toBeNull();
      expect(first.unreadCount, 'the count is the whole window, not the page').toBe(total);

      const second = await listOf(
        token,
        `?cursor=${encodeURIComponent(first.nextCursor as string)}`,
      );
      expect(second.items.map((item) => item.text)).toEqual(
        Array.from(
          { length: 5 },
          (_, at) => `پیام ${String(MINIAPP_NOTIFICATION_PAGE_SIZE + at + 1)}`,
        ),
      );
      expect(second.nextCursor).toBeNull();

      const forged = await call(
        token,
        'GET',
        MINIAPP_ROUTES.notifications,
        {},
        { query: '?cursor=abc' },
      );
      expect(forged.statusCode).toBe(400);
    });

    it("a cursor from another customer's list pages through THEIR rows only", async () => {
      const token = await sessionFor(8206);
      const other = await sessionFor(8207);
      const mine = await customerIdOf(8206);
      const theirs = await customerIdOf(8207);
      for (let at = 1; at <= MINIAPP_NOTIFICATION_PAGE_SIZE + 2; at += 1) {
        await row(theirs, { text: `دیگری ${String(at)}`, minutesAgo: at });
      }
      await row(mine, { text: 'من', minutesAgo: 100 });
      const theirFirst = await listOf(other);
      const replayed = await listOf(
        token,
        `?cursor=${encodeURIComponent(theirFirst.nextCursor as string)}`,
      );
      expect(replayed.items.map((item) => item.text)).toEqual(['من']);
    });

    it('cuts nothing and invents nothing: the text is the stored text, bounded on the wire', async () => {
      const token = await sessionFor(8208);
      const mine = await customerIdOf(8208);
      const text = 'خط اول\nخط دوم ' + 'ب'.repeat(MINIAPP_NOTIFICATION_TEXT_MAX);
      await row(mine, { text });
      const [item] = (await listOf(token)).items;
      expect(item?.text).toBe(text);
      expect(Object.keys(item ?? {}).sort()).toEqual(['createdAt', 'id', 'read', 'text']);
    });
  });

  describe('the repository', () => {
    it('names the tenant in every query: a tenant-A customer and bot read through tenant B find nothing', async () => {
      await sessionFor(8250);
      const mine = await customerIdOf(8250);
      const id = await row(mine, { text: 'مال مستأجر الف' });
      const repo = new DrizzleNotificationCentreRepository(ctx.container.database.db);
      const input = { customerId: mine, botInstanceId: BOT_A1 };
      const epoch = new Date(0);
      expect(
        (await repo.list(tenantA, { ...input, since: epoch, after: null, limit: 20 })).items,
      ).toHaveLength(1);
      expect(
        (await repo.list(tenantB, { ...input, since: epoch, after: null, limit: 20 })).items,
      ).toEqual([]);
      expect(await repo.unreadCount(tenantA, { ...input, since: epoch })).toBe(1);
      expect(await repo.unreadCount(tenantB, { ...input, since: epoch })).toBe(0);
      const at = ctx.container.clock.now();
      expect(
        await ctx.container.uow.run(tenantB, async (tx) =>
          repo.markRead(tenantB, { ...input, id, at }, tx),
        ),
      ).toBe('NOT_FOUND');
      expect(
        await ctx.container.uow.run(tenantB, async (tx) =>
          repo.markAllRead(tenantB, { ...input, at }, tx),
        ),
      ).toBe(0);
      expect(await readAt(id)).toBeNull();
    });
  });

  // =====================================================================================
  // Marking read
  // =====================================================================================

  describe('marking read', () => {
    beforeEach(async () => {
      await setFlag('notification_centre', true);
    });

    const markOne = async (token: string, id: string, withKey?: string) => {
      const response = await call(
        token,
        'POST',
        MINIAPP_ROUTES.notificationRead,
        { notificationId: id },
        withKey === undefined ? {} : { key: withKey },
      );
      return response;
    };

    it('marks one message read, lowers the counter, and a second tap changes nothing', async () => {
      const token = await sessionFor(8301);
      const mine = await customerIdOf(8301);
      const a = await row(mine, { text: 'الف', minutesAgo: 2 });
      const b = await row(mine, { text: 'ب', minutesAgo: 1 });

      const first = await markOne(token, a);
      expect(first.statusCode, first.body).toBe(201);
      expect(miniAppNotificationReadResponseSchema.parse(JSON.parse(first.body))).toEqual({
        marked: 1,
        unreadCount: 1,
      });
      const stamp = await readAt(a);
      expect(stamp).not.toBeNull();
      expect(await readAt(b)).toBeNull();

      // A NEW key (a second tap): nothing to change, said truthfully, first moment kept.
      const second = await markOne(token, a);
      expect(second.statusCode, second.body).toBe(201);
      expect(miniAppNotificationReadResponseSchema.parse(JSON.parse(second.body))).toEqual({
        marked: 0,
        unreadCount: 1,
      });
      expect(await readAt(a)).toEqual(stamp);

      const page = await listOf(token);
      expect(page.items.map((item) => [item.text, item.read])).toEqual([
        ['ب', false],
        ['الف', true],
      ]);
      expect((await meOf(token)).notifications).toEqual({ unreadCount: 1 });
    });

    it("replays a request's own key with its first answer, and refuses the key for another message", async () => {
      const token = await sessionFor(8302);
      const mine = await customerIdOf(8302);
      const a = await row(mine, { text: 'الف' });
      const b = await row(mine, { text: 'ب' });
      const sameKey = 'centre-replay-key-0001';
      const first = await markOne(token, a, sameKey);
      expect(JSON.parse(first.body)).toMatchObject({ marked: 1 });
      const replay = await markOne(token, a, sameKey);
      expect(replay.statusCode, replay.body).toBe(201);
      expect(JSON.parse(replay.body)).toMatchObject({ marked: 1, unreadCount: 1 });
      // The same key for a DIFFERENT message is a caller bug, never a replay.
      const reused = await markOne(token, b, sameKey);
      expect(reused.statusCode).toBe(409);
      expect(await readAt(b)).toBeNull();
    });

    it.each([
      [
        'another customer',
        async () => row(await customerIdOf(await seeded(8304)), { text: 'دیگری' }),
      ],
      [
        'another tenant',
        async () =>
          row(await tenantBCustomer('8303'), {
            text: 'مستأجر دیگر',
            tenantId: tenantB.tenantId,
            botInstanceId: BOT_B1,
          }),
      ],
      [
        'another bot',
        async () => row(await customerIdOf(8303), { text: 'ربات دیگر', botInstanceId: BOT_A2 }),
      ],
      [
        'a message that was never delivered',
        async () => row(await customerIdOf(8303), { text: null, state: 'PENDING' }),
      ],
      ['nothing at all', async () => ctx.container.ids.uuid()],
    ] as const)('answers not found, and changes nothing, for %s', async (_name, make) => {
      const token = await sessionFor(8303);
      const id = await make();
      const refused = await markOne(token, id);
      expect(refused.statusCode, refused.body).toBe(404);
      expect(refused.body).toContain('miniapp.not_found');
      expect(await readAt(id)).toBeNull();
    });

    it('answers not found for an id that is not an id at all', async () => {
      const token = await sessionFor(8312);
      expect((await markOne(token, 'not-a-uuid')).statusCode).toBe(404);
    });

    it("marks all of the customer's own unread, once, and touches nobody else's", async () => {
      const token = await sessionFor(8305);
      await sessionFor(8306);
      const mine = await customerIdOf(8305);
      const theirs = await customerIdOf(8306);
      const a = await row(mine, { text: 'الف', minutesAgo: 3 });
      const b = await row(mine, { text: 'ب', minutesAgo: 2 });
      const already = await row(mine, { text: 'قبلاً', minutesAgo: 1, read: true });
      const otherBot = await row(mine, { text: 'ربات دیگر', botInstanceId: BOT_A2 });
      const notMine = await row(theirs, { text: 'دیگری' });
      const before = await readAt(already);

      const first = await call(token, 'POST', MINIAPP_ROUTES.notificationsReadAll);
      expect(first.statusCode, first.body).toBe(201);
      expect(miniAppNotificationReadResponseSchema.parse(JSON.parse(first.body))).toEqual({
        marked: 2,
        unreadCount: 0,
      });
      expect(await readAt(a)).not.toBeNull();
      expect(await readAt(b)).not.toBeNull();
      expect(await readAt(already), 'an already-read message keeps its first moment').toEqual(
        before,
      );
      expect(await readAt(notMine), "another customer's message is untouched").toBeNull();
      expect(await readAt(otherBot), "another bot's message is untouched").toBeNull();

      const again = await call(token, 'POST', MINIAPP_ROUTES.notificationsReadAll);
      expect(JSON.parse(again.body)).toEqual({ marked: 0, unreadCount: 0 });
      expect((await listOf(token)).items.every((item) => item.read)).toBe(true);
    });

    it('is refused while the scope has stopped accepting work, read inside the transaction', async () => {
      const mine = await customerIdOf(await seeded(8307));
      const id = await row(mine, { text: 'پیام' });
      const actor = miniAppActor('miniapp:test', 'corr-stopped' as CorrelationId);
      await ctx.container.database.db.execute(
        sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}`,
      );
      await expect(
        ctx.container.miniApp.notificationCentre.markRead(tenantA, actor, {
          customerId: mine,
          botInstanceId: BOT_A1,
          notificationId: id,
          idempotencyKey: key(),
        }),
      ).rejects.toMatchObject({ kind: 'CONFLICT' });
      expect(await readAt(id)).toBeNull();
    });

    /** A customer with a session, by Telegram id: the mini app creates it at first launch. */
    async function seeded(telegramUserId: number): Promise<number> {
      await sessionFor(telegramUserId);
      return telegramUserId;
    }
  });
});
