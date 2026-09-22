import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  makePanelSellable,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * The category admin service, against a real database.
 *
 * Every case here is a rule the owner named for WP5 or a rule this package's own audit
 * promised, and each is written so the mutation that would break it has a test to die
 * in: delete refused while products remain (including under a concurrent insert),
 * reassignment that moves exactly the product and records where it came from, the four
 * transitions answering a repeat press without a second audit row, reorder refusing a
 * short match, tenant isolation on every path, and the order SNAPSHOT surviving every
 * later change to the category it was bought from.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('product categories — the admin service', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let ownerB: ActorContext;
  let products: DrizzleProductRepository;
  let panelA: string;
  let keyCounter = 0;
  const key = () => `cat-${(keyCounter += 1)}`;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    products = new DrizzleProductRepository(ctx.container.database.db);
    panelA = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA}, ${tenantA.tenantId}, 'A', 'sanaei', 'https://a.example.test', 'ACTIVE')`);
    await makePanelSellable(ctx.container, tenantA, panelA);
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'cat-owner', roleKeys: ['owner'] }),
    );
    ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'cat-owner-b', roleKeys: ['owner'] }),
    );
  });

  const service = () => ctx.container.productCategories;

  const create = (name: string, sortOrder = 10) =>
    service().create(tenantA, owner, {
      idempotencyKey: key(),
      draft: { name, description: null, emoji: null, sortOrder },
    });

  async function productIn(categoryId: string, status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE') {
    const created = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 1,
        panelId: panelA as PanelId,
        categoryId: categoryId as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 1n, deviceLimit: null },
        price: money(100_000n, 'IRT'),
      },
      now: ctx.container.clock.now(),
    });
    if (status === 'ACTIVE') {
      await products.setStatus(
        tenantA,
        created.id,
        'INACTIVE',
        'ACTIVE',
        ctx.container.clock.now(),
      );
    }
    return created;
  }

  const auditActions = async (entityId: string): Promise<string[]> => {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT action FROM audit_logs WHERE entity_id = ${entityId} AND result = 'SUCCESS'
           ORDER BY occurred_at ASC, id ASC` as never,
    )) as unknown as { rows: { action: string }[] };
    return rows.rows.map((r) => r.action);
  };

  const codeOf = async (promise: Promise<unknown>): Promise<string | null> => {
    try {
      await promise;
      return null;
    } catch (error) {
      return (error as { code?: string }).code ?? String(error);
    }
  };

  // -------------------------------------------------------------------------

  describe('creating and editing', () => {
    it('creates a category ACTIVE and VISIBLE, and audits it once', async () => {
      const made = await create('ویژه');
      expect([made.status, made.visibility]).toStrictEqual(['ACTIVE', 'VISIBLE']);
      expect(await auditActions(made.id)).toStrictEqual(['category.create']);
    });

    it('answers a repeated create with the SAME row, and writes one', async () => {
      const idempotencyKey = key();
      const draft = { name: 'تکرار', description: null, emoji: null, sortOrder: 1 };
      const first = await service().create(tenantA, owner, { idempotencyKey, draft });
      const again = await service().create(tenantA, owner, { idempotencyKey, draft });
      expect(again.id).toBe(first.id);
      const count = (await ctx.container.database.db.execute(
        sql`SELECT count(*)::int AS n FROM product_categories WHERE name = 'تکرار'` as never,
      )) as unknown as { rows: { n: number }[] };
      expect(count.rows[0]?.n).toBe(1);
    });

    it('refuses an emoji that is not one, and accepts none at all', async () => {
      expect(
        await codeOf(
          service().create(tenantA, owner, {
            idempotencyKey: key(),
            draft: { name: 'x', description: null, emoji: 'not an emoji', sortOrder: 1 },
          }),
        ),
      ).toBe('commerce.request_invalid');
      // Absence is ordinary — §6.1.
      expect((await create('بدون ایموجی')).emoji).toBeNull();
    });

    it('renames, and records the name it had before', async () => {
      const made = await create('قدیمی');
      await service().update(tenantA, owner, {
        idempotencyKey: key(),
        categoryId: made.id,
        edit: { name: 'تازه', description: null, emoji: null },
      });
      const rows = (await ctx.container.database.db.execute(
        sql`SELECT before, after FROM audit_logs
             WHERE entity_id = ${made.id} AND action = 'category.update'` as never,
      )) as unknown as { rows: { before: { name: string }; after: { name: string } }[] };
      expect([rows.rows[0]?.before.name, rows.rows[0]?.after.name]).toStrictEqual([
        'قدیمی',
        'تازه',
      ]);
    });
  });

  describe('the four transitions', () => {
    it('audits a transition once, and a repeat press is a success that changes nothing', async () => {
      const made = await create('دو بار');
      await service().deactivate(tenantA, owner, { idempotencyKey: key(), categoryId: made.id });
      const again = await service().deactivate(tenantA, owner, {
        idempotencyKey: key(),
        categoryId: made.id,
      });
      expect(again.status).toBe('INACTIVE');
      expect(await auditActions(made.id)).toStrictEqual(['category.create', 'category.deactivate']);
    });

    it('moves status and visibility independently', async () => {
      const made = await create('مستقل');
      await service().hide(tenantA, owner, { idempotencyKey: key(), categoryId: made.id });
      const hidden = await service().get(tenantA, owner, made.id);
      // Hiding withdrew nothing — §6.3.
      expect([hidden.status, hidden.visibility]).toStrictEqual(['ACTIVE', 'HIDDEN']);
      await service().deactivate(tenantA, owner, { idempotencyKey: key(), categoryId: made.id });
      const both = await service().get(tenantA, owner, made.id);
      expect([both.status, both.visibility]).toStrictEqual(['INACTIVE', 'HIDDEN']);
    });
  });

  describe('reordering', () => {
    it('writes the whole order in one statement', async () => {
      const a = await create('الف', 5);
      const b = await create('ب', 6);
      await service().reorder(tenantA, owner, {
        idempotencyKey: key(),
        positions: [
          { id: b.id, sortOrder: 1 },
          { id: a.id, sortOrder: 2 },
        ],
      });
      const list = await service().list(tenantA, owner);
      const mine = list.filter((c) => c.id === a.id || c.id === b.id).map((c) => c.id);
      expect(mine).toStrictEqual([b.id, a.id]);
    });

    it('refuses a SHORT match rather than reordering what it recognises', async () => {
      /*
       * A foreign id matches nothing under the tenant predicate, so the count comes back
       * one short — and the whole reorder is refused, including the half that WAS this
       * tenant's. A partial success under a success message is what this prevents.
       */
      const mine = await create('من', 5);
      const code = await codeOf(
        service().reorder(tenantA, owner, {
          idempotencyKey: key(),
          positions: [
            { id: mine.id, sortOrder: 99 },
            { id: SEED_IDS.categoryB, sortOrder: 1 },
          ],
        }),
      );
      expect(code).toBe('commerce.category_not_found');
      expect((await service().get(tenantA, owner, mine.id)).sortOrder).toBe(5);
    });

    it('refuses the same category given two positions', async () => {
      const one = await create('یک');
      expect(
        await codeOf(
          service().reorder(tenantA, owner, {
            idempotencyKey: key(),
            positions: [
              { id: one.id, sortOrder: 1 },
              { id: one.id, sortOrder: 2 },
            ],
          }),
        ),
      ).toBe('commerce.request_invalid');
    });
  });

  describe('deleting', () => {
    it('deletes an empty category, and audits it', async () => {
      const made = await create('خالی');
      await service().remove(tenantA, owner, { idempotencyKey: key(), categoryId: made.id });
      expect(await codeOf(service().get(tenantA, owner, made.id))).toBe(
        'commerce.category_not_found',
      );
      expect(await auditActions(made.id)).toContain('category.delete');
    });

    it('refuses while products remain — a WITHDRAWN one included — and says how many', async () => {
      /*
       * An inactive product blocks a delete exactly as an active one does: deleting the
       * category would strand it uncategorised, and re-activating it later would then
       * meet `PRODUCT_NOT_CATEGORISED` for a reason nobody remembers causing.
       */
      const made = await create('پر');
      await productIn(made.id, 'ACTIVE');
      await productIn(made.id, 'INACTIVE');

      let refusal: unknown;
      try {
        await service().remove(tenantA, owner, { idempotencyKey: key(), categoryId: made.id });
      } catch (error) {
        refusal = error;
      }
      expect((refusal as { code?: string }).code).toBe('commerce.category_not_empty');
      expect((refusal as { details?: { productCount?: number } }).details?.productCount).toBe(2);
      expect((await service().get(tenantA, owner, made.id)).id).toBe(made.id);
    });

    it('takes the row lock BEFORE counting, so a concurrent product is counted', async () => {
      /*
       * Controlled interleaving, not `Promise.all`.
       *
       * A raw transaction inserts a product into the category and holds it open. The
       * insert takes a KEY SHARE lock on the category row through the foreign key, so
       * the delete's `FOR UPDATE` must WAIT — asserted by watching `pg_locks`, not by
       * sleeping. Then the insert commits and the delete resumes.
       *
       * Locked first, the delete counts AFTER the wait and sees the committed product:
       * a sentence with a number in it. Counted first, it would read zero — the insert
       * was uncommitted — go on to delete, and meet the foreign key as a raw constraint
       * violation. The code asserted is what tells the two apart.
       */
      const made = await create('مسابقه');
      await ctx.container.database.withClient(async (client) => {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO products (id, tenant_id, title, status, panel_id, category_id,
                                 duration_days, traffic_bytes, price_amount, price_currency)
           VALUES ($1, $2, 'همزمان', 'ACTIVE', $3, $4, 30, 1, 100000, 'IRT')`,
          [ctx.container.ids.uuid(), tenantA.tenantId, panelA, made.id],
        );

        const racing = codeOf(
          service().remove(tenantA, owner, { idempotencyKey: key(), categoryId: made.id }),
        );
        await awaitBlocked(1);
        await client.query('COMMIT');

        expect(await racing, 'the delete counted before it locked').toBe(
          'commerce.category_not_empty',
        );
      });
    });
  });

  describe('reassigning a product', () => {
    it('moves exactly that product, and records the category it came FROM', async () => {
      const from = await create('مبدأ');
      const to = await create('مقصد');
      const moving = await productIn(from.id);
      const staying = await productIn(from.id);

      await service().reassignProduct(tenantA, owner, {
        idempotencyKey: key(),
        productId: moving.id,
        categoryId: to.id,
      });

      expect((await products.findById(tenantA, moving.id))?.categoryId).toBe(to.id);
      expect((await products.findById(tenantA, staying.id))?.categoryId).toBe(from.id);

      const rows = (await ctx.container.database.db.execute(
        sql`SELECT before, after FROM audit_logs
             WHERE entity_id = ${moving.id} AND action = 'category.reassign_product'` as never,
      )) as unknown as {
        rows: { before: { categoryId: string }; after: { categoryId: string } }[];
      };
      expect([rows.rows[0]?.before.categoryId, rows.rows[0]?.after.categoryId]).toStrictEqual([
        from.id,
        to.id,
      ]);
    });

    it('refuses a destination that is another tenant category, and moves nothing', async () => {
      const home = await create('خانه');
      const moving = await productIn(home.id);
      expect(
        await codeOf(
          service().reassignProduct(tenantA, owner, {
            idempotencyKey: key(),
            productId: moving.id,
            categoryId: SEED_IDS.categoryB,
          }),
        ),
      ).toBe('commerce.category_not_found');
      expect((await products.findById(tenantA, moving.id))?.categoryId).toBe(home.id);
    });
  });

  describe('tenant isolation', () => {
    it('answers another tenant category as unknown on every path', async () => {
      const theirs = SEED_IDS.categoryB;
      const paths: readonly [string, Promise<unknown>][] = [
        ['get', service().get(tenantA, owner, theirs)],
        [
          'update',
          service().update(tenantA, owner, {
            idempotencyKey: key(),
            categoryId: theirs,
            edit: { name: 'x', description: null, emoji: null },
          }),
        ],
        ['hide', service().hide(tenantA, owner, { idempotencyKey: key(), categoryId: theirs })],
        [
          'deactivate',
          service().deactivate(tenantA, owner, { idempotencyKey: key(), categoryId: theirs }),
        ],
        ['remove', service().remove(tenantA, owner, { idempotencyKey: key(), categoryId: theirs })],
      ];
      for (const [label, attempt] of paths) {
        expect(await codeOf(attempt), label).toBe('commerce.category_not_found');
      }
      // And theirs is untouched.
      const still = await service().get(tenantB, ownerB, theirs);
      expect([still.status, still.visibility]).toStrictEqual(['ACTIVE', 'VISIBLE']);
    });

    it('lists only this tenant categories', async () => {
      const ids = (await service().list(tenantA, owner)).map((c) => c.id);
      expect(ids).not.toContain(SEED_IDS.categoryB);
    });
  });

  describe('the order SNAPSHOT outlives every change to its category', () => {
    it('keeps the name, emoji and id it was bought under through rename, move, withdrawal and delete', async () => {
      /*
       * §6.2: new orders snapshot the category durably, and the snapshot must not change
       * if the product is reassigned, the category renamed, hidden or inactivated, or
       * deleted. All five happen here, in that order, to the same order's category.
       */
      const bought = await service().create(tenantA, owner, {
        idempotencyKey: key(),
        draft: { name: 'اصلی', description: null, emoji: '⭐', sortOrder: 1 },
      });
      const product = await productIn(bought.id);
      const { customer } = await ctx.container.customers.resolveFromUpdate(
        tenantA,
        systemActor('snap-resolve'),
        {
          idempotencyKey: 'snap-resolve',
          telegramUserId: '910001',
          from: { id: 910_001, first_name: 'زهرا' },
          botInstanceId: BOT_A,
        },
      );
      const order = await ctx.container.orders.createDraft(tenantA, systemActor('snap-draft'), {
        idempotencyKey: 'snap-draft',
        customerId: customer.id as UserId,
        productId: product.id,
      });

      const elsewhere = await create('دیگر');
      await service().update(tenantA, owner, {
        idempotencyKey: key(),
        categoryId: bought.id,
        edit: { name: 'تغییرنام', description: null, emoji: null },
      });
      await service().hide(tenantA, owner, { idempotencyKey: key(), categoryId: bought.id });
      await service().deactivate(tenantA, owner, { idempotencyKey: key(), categoryId: bought.id });
      await service().reassignProduct(tenantA, owner, {
        idempotencyKey: key(),
        productId: product.id,
        categoryId: elsewhere.id,
      });
      await service().remove(tenantA, owner, { idempotencyKey: key(), categoryId: bought.id });

      const row = (await ctx.container.database.db.execute(
        sql`SELECT line_category_id, line_category_name, line_category_emoji
              FROM orders WHERE id = ${order.id}` as never,
      )) as unknown as { rows: Record<string, unknown>[] };
      expect(row.rows[0]).toStrictEqual({
        line_category_id: bought.id,
        line_category_name: 'اصلی',
        line_category_emoji: '⭐',
      });
    });
  });

  /**
   * Waits until at least `expected` backends are waiting on a row lock.
   *
   * `locktype IN ('tuple', 'transactionid')` is how a row waiter appears: it queues on
   * the tuple, then on the holder's transaction id. Polled, not slept — a sleep proves
   * only that the machine was slow enough.
   */
  async function awaitBlocked(expected: number): Promise<void> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const rows = (await ctx.container.database.db.execute(
        sql`SELECT count(*)::int AS n FROM pg_locks
             WHERE NOT granted AND locktype IN ('tuple', 'transactionid')` as never,
      )) as unknown as { rows: { n: number }[] };
      if ((rows.rows[0]?.n ?? 0) >= expected) return;
      if (Date.now() > deadline) {
        throw new Error(
          'the delete never blocked on the category row. Either it no longer locks the ' +
            'category before counting, or it does so outside this transaction.',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
});
