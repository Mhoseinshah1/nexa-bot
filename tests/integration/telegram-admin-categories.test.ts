import { createServer, type Server } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  money,
  type ActorContext,
  type AdminId,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { encodeIdPair } from '../../apps/api/src/surfaces/telegram/bot-runtime';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * The Telegram management panel's categories section — WP5.
 *
 * Against real everything, the way the other sections are tested: a real PostgreSQL, the
 * real `ProductCategoryService` with its real guard, a real socket standing in for
 * Telegram, and the real bot runtime parsing real callback data.
 *
 * The questions this file is about:
 *
 *   1. **One set of rules.** Every write goes through the service the Web Admin uses, so
 *      each case asserts the ROW, not only the reply — a reply that said "hidden" while
 *      the row stayed visible is the failure a surface-only test cannot see.
 *   2. **Two permissions.** `catalog.view` opens the section; `catalog.edit` draws and
 *      performs the writes. Every case that asserts a control is absent is paired with
 *      one that sends the callback anyway.
 *   3. **Truthful refusals.** A category holding products is not deleted, and the reply
 *      says how many; an id that names nothing here, or another tenant's, is one answer.
 *   4. **Redelivery.** Telegram redelivers an update it did not see acknowledged; the same
 *      update must not create two categories or move one twice.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

interface Sent {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

describe('the categories section of the Telegram management panel', () => {
  let ctx: TestContext;
  let telegram: Server;
  let sent: Sent[];
  let owner: ActorContext;
  let panelA: string;
  let panelB: string;
  let updateSeq = 0;

  const TG = {
    owner: '730001',
    limited: '730002',
  } as const;

  beforeAll(async () => {
    sent = [];
    telegram = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          body = { unparseable: raw };
        }
        sent.push({ url: request.url ?? '', body });
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
    ctx.container.setInstallationTenant(tenantA.tenantId);
    sent = [];

    const seededOwner = await createAdmin(ctx.container, tenantA, {
      username: 'owner-tg-categories',
      roleKeys: ['owner'],
    });
    owner = adminActorFor(seededOwner);
    await bind(seededOwner.id as AdminId, TG.owner);

    panelA = ctx.container.ids.uuid();
    panelB = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA}, ${tenantA.tenantId}, 'A', 'sanaei', 'https://a.example.test', 'ACTIVE'),
             (${panelB}, ${tenantB.tenantId}, 'B', 'sanaei', 'https://b.example.test', 'ACTIVE')`);
  });

  // =========================================================================
  // Who sees the section
  // =========================================================================

  it('draws the Categories button for an administrator who holds catalog.view', async () => {
    await bindNewAdmin('categories-viewer', TG.limited, ['catalog.view']);

    const result = await say('/admin', TG.limited);

    expect(result.replyKey).toBe('bot.admin.panel');
    expect(callbacks(), 'the Categories button is not drawn').toContain('ka:0');
  });

  it('draws no Categories button for an administrator without catalog.view', async () => {
    // `users.view` opens a DIFFERENT section, so the panel exists and this is the one
    // thing it must not offer. Without this half a gate that always drew it would pass.
    await bindNewAdmin('customers-only', TG.limited, ['users.view']);

    const result = await say('/admin', TG.limited);

    expect(result.replyKey).toBe('bot.admin.panel');
    expect(callbacks()).not.toContain('ka:0');
  });

  it('refuses the section to a crafted tap from an administrator without catalog.view', async () => {
    await bindNewAdmin('customers-only-crafted', TG.limited, ['users.view']);

    const result = await tap('ka:0', TG.limited);

    expect(result.replyKey).toBe('bot.admin.refused');
  });

  // =========================================================================
  // The list and one category
  // =========================================================================

  it('lists EVERY category in the customer order, hidden, inactive and empty ones included', async () => {
    const second = await category('دوم', { sortOrder: 20, visibility: 'HIDDEN' });
    const first = await category('اول', { sortOrder: 10, status: 'INACTIVE' });
    await productIn(second);

    const result = await tap('ka:0', TG.owner);

    expect(result.replyKey).toBe('bot.admin.categories_section');
    const rows = buttons();
    const order = rows.map((button) => button.callback_data);
    expect(order.slice(0, 3), 'the list is not in sort order').toEqual([
      `kb:v:${SEED_IDS.categoryA}`,
      `kb:v:${first}`,
      `kb:v:${second}`,
    ]);
    // Both flags and the count ride on the label, so an operator can tell a hidden
    // category from a visible one without opening it.
    expect(rows[1]?.text).toBe('اول · INACTIVE · VISIBLE · 0');
    expect(rows[2]?.text).toBe('دوم · ACTIVE · HIDDEN · 1');
  });

  it('shows one category with its real product count and no write button to a viewer', async () => {
    const id = await category('نمایشی');
    await productIn(id);
    await productIn(id, { status: 'INACTIVE' });
    await bindNewAdmin('categories-viewer-detail', TG.limited, ['catalog.view']);

    const result = await tap(`kb:v:${id}`, TG.limited);

    expect(result.replyKey).toBe('bot.admin.category_detail');
    // An INACTIVE product still blocks a delete, so it is counted.
    expect(text()).toContain('2');
    expect(text()).toContain(id);
    expect(callbacks().filter((data) => data.startsWith('kb:'))).toEqual([]);
  });

  it('gives one answer for another tenant’s category and for an id that names nothing', async () => {
    for (const id of [SEED_IDS.categoryB, ctx.container.ids.uuid()]) {
      const result = await tap(`kb:v:${id}`, TG.owner);
      expect(result.replyKey, id).toBe('bot.admin.category_gone');
    }
  });

  // =========================================================================
  // Status and visibility
  // =========================================================================

  it('deactivates through the service, and a second tap writes nothing more', async () => {
    const id = await category('فعال');

    const result = await tap(`kb:d:${id}`, TG.owner);
    await tap(`kb:d:${id}`, TG.owner);

    expect(result.replyKey).toBe('bot.admin.category_detail');
    expect(await row(id)).toMatchObject({ status: 'INACTIVE', visibility: 'VISIBLE' });
    // The button left on the screen is the OPPOSITE of the state now held.
    expect(callbacks()).toContain(`kb:a:${id}`);
    expect(callbacks()).not.toContain(`kb:d:${id}`);
    expect(await audits(id, 'category.deactivate'), 'the repeat press was audited').toBe(1);
  });

  it('hides without touching status, and shows it again', async () => {
    const id = await category('پیدا');

    await tap(`kb:h:${id}`, TG.owner);
    expect(await row(id)).toMatchObject({ status: 'ACTIVE', visibility: 'HIDDEN' });

    await tap(`kb:s:${id}`, TG.owner);
    expect(await row(id)).toMatchObject({ status: 'ACTIVE', visibility: 'VISIBLE' });
  });

  it('refuses a crafted write from a viewer and leaves the row alone', async () => {
    const id = await category('محافظت');
    await bindNewAdmin('categories-viewer-write', TG.limited, ['catalog.view']);

    const result = await tap(`kb:h:${id}`, TG.limited);

    expect(result.replyKey).toBe('bot.admin.refused');
    expect(await row(id)).toMatchObject({ visibility: 'VISIBLE' });
  });

  it('refuses a write naming another tenant’s category and leaves THAT row alone', async () => {
    const result = await tap(`kb:h:${SEED_IDS.categoryB}`, TG.owner);

    expect(result.replyKey).toBe('bot.admin.category_gone');
    expect(await row(SEED_IDS.categoryB)).toMatchObject({ visibility: 'VISIBLE' });
  });

  // =========================================================================
  // Order
  // =========================================================================

  it('moves a category one place down, and a redelivered tap does not move it twice', async () => {
    const one = await category('یک', { sortOrder: 10 });
    const two = await category('دو', { sortOrder: 20 });
    const three = await category('سه', { sortOrder: 30 });

    const update = tapUpdate(`kb:w:${one}`, TG.owner);
    const first = await runtime().handle(tenantA, systemActor('bot'), update);
    expect(first.replyKey).toBe('bot.admin.categories_section');
    expect(await order()).toEqual([SEED_IDS.categoryA, two, one, three]);

    // The SAME update again, as Telegram sends it when it did not see our 200.
    const again = await runtime().handle(tenantA, systemActor('bot'), update);
    expect(again.replyKey, 'a redelivery was answered as a refusal').toBe(
      'bot.admin.categories_section',
    );
    expect(await order(), 'the redelivery moved it a second place').toEqual([
      SEED_IDS.categoryA,
      two,
      one,
      three,
    ]);
  });

  it('moves categories that share a sort order, which a two-value swap would not', async () => {
    // Every category created without a position has the same one; swapping two equal
    // numbers changes nothing, which is why the whole order is written back.
    const one = await category('یک', { sortOrder: 5 });
    const two = await category('دو', { sortOrder: 5 });
    const before = await order();
    const at = before.indexOf(two);

    await tap(`kb:u:${two}`, TG.owner);

    const after = await order();
    expect(after.indexOf(two), 'the category did not move').toBe(at - 1);
    expect(after).toContain(one);
  });

  it('draws no up button on the first category and no down button on the last', async () => {
    const last = await category('آخر', { sortOrder: 50 });

    await tap(`kb:v:${SEED_IDS.categoryA}`, TG.owner);
    expect(callbacks()).not.toContain(`kb:u:${SEED_IDS.categoryA}`);
    expect(callbacks()).toContain(`kb:w:${SEED_IDS.categoryA}`);

    await tap(`kb:v:${last}`, TG.owner);
    expect(callbacks()).toContain(`kb:u:${last}`);
    expect(callbacks()).not.toContain(`kb:w:${last}`);
  });

  // =========================================================================
  // Create and edit
  // =========================================================================

  it('creates a category at the end of the list, audited as this administrator', async () => {
    const result = await say('/category_new پلن های ویژه', TG.owner);

    expect(result.replyKey).toBe('bot.admin.category_detail');
    const rows = await ctx.container.database.db.execute(sql`
      SELECT id, status, visibility FROM product_categories
      WHERE tenant_id = ${tenantA.tenantId} AND name = 'پلن های ویژه'`);
    expect(rows.rows).toHaveLength(1);
    const created = rows.rows[0] as { id: string };
    expect(created).toMatchObject({ status: 'ACTIVE', visibility: 'VISIBLE' });
    expect((await order()).at(-1), 'it was not put last').toBe(created.id);

    const audit = await ctx.container.database.db.execute(sql`
      SELECT actor_type, source_surface FROM audit_logs
      WHERE entity_id = ${created.id} AND action = 'category.create'`);
    expect(audit.rows[0]).toMatchObject({
      actor_type: 'TELEGRAM_ADMIN',
      source_surface: 'TELEGRAM',
    });
  });

  it('creates ONE category when the same update is delivered twice', async () => {
    const update = textUpdate('/category_new تکراری', TG.owner);

    await runtime().handle(tenantA, systemActor('bot'), update);
    const again = await runtime().handle(tenantA, systemActor('bot'), update);

    expect(again.replyKey, 'a redelivery was answered as a refusal').not.toBe('bot.admin.refused');
    const rows = await ctx.container.database.db.execute(sql`
      SELECT id FROM product_categories WHERE tenant_id = ${tenantA.tenantId} AND name = 'تکراری'`);
    expect(rows.rows, 'a redelivered create made a second category').toHaveLength(1);
  });

  it('answers a command with nothing to act on with the syntax', async () => {
    for (const text of [
      '/category_new',
      '/category_rename',
      `/category_rename ${SEED_IDS.categoryA}`,
      '/category_rename not-an-id نام',
      '/category_emoji',
    ]) {
      const result = await say(text, TG.owner);
      expect(result.replyKey, text).toBe('bot.admin.category_usage');
    }
  });

  it('renames one field and leaves the emoji and description as they were', async () => {
    const id = await category('قدیمی', { emoji: '🔥', description: 'توضیح' });

    await say(`/category_rename ${id} تازه و بهتر`, TG.owner);

    expect(await row(id)).toMatchObject({
      name: 'تازه و بهتر',
      emoji: '🔥',
      description: 'توضیح',
    });
  });

  it('sets an emoji, refuses one the shared rule refuses, and clears it with a dash', async () => {
    const id = await category('نشان');

    await say(`/category_emoji ${id} ⭐`, TG.owner);
    expect(await row(id)).toMatchObject({ emoji: '⭐' });

    // The rule is `isValidCategoryEmoji`, and it deliberately does NOT check that the text
    // IS an emoji (the owner's "unicode text is sufficient"); what it bounds is length, at
    // eight code points. Ten letters is a sentence, not an icon.
    const refused = await say(`/category_emoji ${id} abcdefghij`, TG.owner);
    expect(refused.replyKey).toBe('bot.admin.category_usage');
    expect(await row(id), 'a refused emoji was stored').toMatchObject({ emoji: '⭐' });

    await say(`/category_emoji ${id} -`, TG.owner);
    expect(await row(id)).toMatchObject({ emoji: null });
  });

  it('does not rename another tenant’s category', async () => {
    const result = await say(`/category_rename ${SEED_IDS.categoryB} ربوده`, TG.owner);

    expect(result.replyKey).toBe('bot.admin.category_gone');
    expect(await row(SEED_IDS.categoryB)).toMatchObject({ name: 'عمومی' });
  });

  // =========================================================================
  // Delete
  // =========================================================================

  it('asks before deleting an empty category, and deletes it on the confirm', async () => {
    const id = await category('خالی');

    const ask = await tap(`kb:x:${id}`, TG.owner);
    expect(ask.replyKey).toBe('bot.admin.category_delete_ask');
    expect(callbacks()).toContain(`kb:X:${id}`);
    expect(await row(id), 'the ASK deleted it').toBeDefined();

    const done = await tap(`kb:X:${id}`, TG.owner);
    expect(done.replyKey).toBe('bot.admin.category_deleted');
    expect(await row(id)).toBeUndefined();
  });

  it('offers no confirm for a category holding products, and says how many', async () => {
    const id = await category('پر');
    await productIn(id);
    await productIn(id, { status: 'INACTIVE' });

    const ask = await tap(`kb:x:${id}`, TG.owner);

    expect(ask.replyKey).toBe('bot.admin.category_not_empty');
    expect(text()).toContain('2');
    expect(callbacks()).not.toContain(`kb:X:${id}`);
  });

  it('refuses a crafted confirm on a category holding products, and keeps it', async () => {
    /*
     * The confirm button is never drawn for this category, so this is a modified
     * client — or an ask drawn before a product was filed under it. The SERVICE refuses,
     * under the category's lock, and the count in the reply is the one it took.
     */
    const id = await category('پر');
    await productIn(id);

    const result = await tap(`kb:X:${id}`, TG.owner);

    expect(result.replyKey).toBe('bot.admin.category_not_empty');
    expect(text()).toContain('1');
    expect(await row(id), 'a category holding a product was deleted').toBeDefined();
  });

  // =========================================================================
  // Reassignment
  // =========================================================================

  it('lists every product with the category it is in now, uncategorised ones included', async () => {
    const id = await category('مقصد');
    await productIn(id, { title: 'دسته‌دار' });
    await productIn(null, { title: 'بی‌دسته' });

    const result = await tap('kc:', TG.owner);

    expect(result.replyKey).toBe('bot.admin.category_products');
    const labels = buttons().map((button) => button.text);
    expect(labels).toContain('دسته‌دار — مقصد');
    expect(labels, 'the product no customer can buy is missing').toContain('بی‌دسته — —');
  });

  it('offers every category except the current one, and moves the product on the tap', async () => {
    const from = await category('مبدا');
    const to = await category('مقصد', { status: 'INACTIVE' });
    const product = await productIn(from);

    const pick = await tap(`kd:${product}.0`, TG.owner);
    expect(pick.replyKey).toBe('bot.admin.category_pick');
    const offered = callbacks().filter((data) => data.startsWith('ke:'));
    expect(offered).toContain(`ke:${encodeIdPair(product, to)}`);
    expect(offered).not.toContain(`ke:${encodeIdPair(product, from)}`);

    const moved = await tap(`ke:${encodeIdPair(product, to)}`, TG.owner);

    expect(moved.replyKey).toBe('bot.admin.category_moved');
    const filed = await ctx.container.database.db.execute(
      sql`SELECT category_id FROM products WHERE id = ${product}`,
    );
    expect((filed.rows[0] as { category_id: string }).category_id).toBe(to);
    const audit = await ctx.container.database.db.execute(sql`
      SELECT before, after FROM audit_logs
      WHERE entity_id = ${product} AND action = 'category.reassign_product'`);
    expect(audit.rows[0]).toMatchObject({
      before: { categoryId: from },
      after: { categoryId: to },
    });
  });

  it('files an uncategorised product, which is what makes it sellable', async () => {
    const product = await productIn(null);

    await tap(`ke:${encodeIdPair(product, SEED_IDS.categoryA)}`, TG.owner);

    const filed = await ctx.container.database.db.execute(
      sql`SELECT category_id FROM products WHERE id = ${product}`,
    );
    expect((filed.rows[0] as { category_id: string }).category_id).toBe(SEED_IDS.categoryA);
  });

  it('will not move a product into another tenant’s category, nor move theirs', async () => {
    const mine = await productIn(SEED_IDS.categoryA);
    const theirs = await productIn(SEED_IDS.categoryB, { scope: tenantB, panel: 'B' });

    const intoTheirs = await tap(`ke:${encodeIdPair(mine, SEED_IDS.categoryB)}`, TG.owner);
    const moveTheirs = await tap(`ke:${encodeIdPair(theirs, SEED_IDS.categoryA)}`, TG.owner);

    expect(intoTheirs.replyKey).toBe('bot.admin.category_gone');
    expect(moveTheirs.replyKey).toBe('bot.admin.product_gone');
    const rows = await ctx.container.database.db.execute(sql`
      SELECT id, category_id FROM products WHERE id IN (${mine}, ${theirs}) ORDER BY id`);
    expect(
      Object.fromEntries(
        rows.rows.map((r) => [
          (r as { id: string }).id,
          (r as { category_id: string }).category_id,
        ]),
      ),
    ).toEqual({ [mine]: SEED_IDS.categoryA, [theirs]: SEED_IDS.categoryB });
  });

  it('says there is nowhere to move a product when its category is the only one', async () => {
    const product = await productIn(SEED_IDS.categoryA);

    const result = await tap(`kd:${product}.0`, TG.owner);

    expect(result.replyKey).toBe('bot.admin.category_pick_none');
  });

  // =========================================================================
  // Helpers
  // =========================================================================

  const runtime = () => ctx.container.botRuntime;
  const messages = () => sent.filter((one) => one.url.includes('/sendMessage'));
  const lastBody = () => messages()[messages().length - 1]?.body;
  const text = () => String(lastBody()?.['text'] ?? '');

  function buttons(): { text: string; callback_data?: string }[] {
    const markup = lastBody()?.['reply_markup'] as
      { inline_keyboard?: { text: string; callback_data?: string }[][] } | undefined;
    return (markup?.inline_keyboard ?? []).flat();
  }
  const callbacks = () => buttons().map((button) => button.callback_data ?? '');

  const tap = async (data: string, telegramUserId: string) => {
    sent = [];
    return runtime().handle(tenantA, systemActor('bot'), tapUpdate(data, telegramUserId));
  };
  const say = async (message: string, telegramUserId: string) => {
    sent = [];
    return runtime().handle(tenantA, systemActor('bot'), textUpdate(message, telegramUserId));
  };

  async function row(id: string): Promise<Record<string, unknown> | undefined> {
    const rows = await ctx.container.database.db.execute(sql`
      SELECT name, emoji, description, status, visibility FROM product_categories WHERE id = ${id}`);
    return rows.rows[0] as Record<string, unknown> | undefined;
  }

  async function order(): Promise<string[]> {
    const list = await ctx.container.productCategories.list(tenantA, owner);
    return list.map((category) => category.id);
  }

  async function audits(entityId: string, action: string): Promise<number> {
    const rows = await ctx.container.database.db.execute(sql`
      SELECT count(*)::int AS n FROM audit_logs
      WHERE entity_id = ${entityId} AND action = ${action} AND result = 'SUCCESS'`);
    return (rows.rows[0] as { n: number }).n;
  }

  async function category(
    name: string,
    fields: {
      sortOrder?: number;
      status?: 'ACTIVE' | 'INACTIVE';
      visibility?: 'VISIBLE' | 'HIDDEN';
      emoji?: string;
      description?: string;
    } = {},
  ): Promise<string> {
    const id = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO product_categories
        (id, tenant_id, name, emoji, description, status, visibility, sort_order)
      VALUES (${id}, ${tenantA.tenantId}, ${name}, ${fields.emoji ?? null},
              ${fields.description ?? null}, ${fields.status ?? 'ACTIVE'},
              ${fields.visibility ?? 'VISIBLE'}, ${fields.sortOrder ?? 10})`);
    return id;
  }

  async function productIn(
    categoryId: string | null,
    options: {
      status?: 'ACTIVE' | 'INACTIVE';
      title?: string;
      scope?: typeof tenantA;
      panel?: 'A' | 'B';
    } = {},
  ): Promise<string> {
    const scope = options.scope ?? tenantA;
    const repository = new DrizzleProductRepository(ctx.container.database.db);
    const created = await repository.create(scope, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: options.title ?? 'پلن',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 1,
        panelId: (options.panel === 'B' ? panelB : panelA) as PanelId,
        categoryId: categoryId as ProductCategoryId | null,
        specification: { durationDays: 30, trafficBytes: 1n, deviceLimit: null },
        price: money(100_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    if ((options.status ?? 'ACTIVE') === 'ACTIVE') {
      await repository.setStatus(
        scope,
        created.id,
        'INACTIVE',
        'ACTIVE',
        ctx.container.clock.now(),
      );
    }
    return created.id;
  }

  const bind = (adminId: AdminId, telegramUserId: string) =>
    ctx.container.adminManagement.setTelegramBinding(tenantA, owner, adminId, {
      telegramUserId,
      reason: 'test binding',
    });

  async function bindNewAdmin(
    username: string,
    telegramUserId: string,
    permissions: readonly string[],
  ): Promise<AdminId> {
    const admin = await createAdmin(ctx.container, tenantA, { username });
    const roleId = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO roles (id, tenant_id, key, name, is_system)
      VALUES (${roleId}, ${tenantA.tenantId}, ${`custom_${username.replaceAll('-', '_')}`}, ${username}, false)`);
    for (const permission of permissions) {
      await ctx.container.database.db.execute(sql`
        INSERT INTO role_permissions (tenant_id, role_id, permission_key)
        VALUES (${tenantA.tenantId}, ${roleId}, ${permission})`);
    }
    await ctx.container.database.db.execute(sql`
      INSERT INTO admin_roles (tenant_id, admin_id, role_id)
      VALUES (${tenantA.tenantId}, ${admin.id}, ${roleId})`);
    await bind(admin.id as AdminId, telegramUserId);
    return admin.id as AdminId;
  }

  const baseUpdate = (payload: Record<string, unknown>, telegramUserId: string) => {
    updateSeq += 1;
    return {
      idempotencyKey: `bot-update-cat-${String(updateSeq)}`,
      botInstanceId: BOT_A,
      update: { update_id: updateSeq, ...payload },
      telegramUserId,
      from: { id: Number(telegramUserId), first_name: 'کاربر' },
    };
  };

  const textUpdate = (message: string, telegramUserId: string) =>
    baseUpdate(
      {
        message: {
          message_id: updateSeq,
          date: 0,
          chat: { id: Number(telegramUserId), type: 'private' },
          from: { id: Number(telegramUserId), is_bot: false, first_name: 'کاربر' },
          text: message,
        },
      },
      telegramUserId,
    );

  const tapUpdate = (data: string, telegramUserId: string) =>
    baseUpdate(
      {
        callback_query: {
          id: `cbq-${String(updateSeq)}`,
          from: { id: Number(telegramUserId), is_bot: false, first_name: 'کاربر' },
          data,
          message: {
            message_id: updateSeq,
            date: 0,
            chat: { id: Number(telegramUserId), type: 'private' },
            from: { id: 999_999, is_bot: true, first_name: 'Nexa' },
          },
        },
      },
      telegramUserId,
    );
});
