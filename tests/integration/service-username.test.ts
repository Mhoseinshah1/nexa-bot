import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  COMMERCE_ERROR_CODES,
  PANEL_ERROR_CODES,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import type { ProductDraft } from '../../apps/api/src/modules/commerce/catalog/application/ports';
import type { OrderRecord } from '../../apps/api/src/modules/commerce/orders/application/ports';
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
 * What a customer's service is called, and who gets to decide.
 *
 * The cases here are grouped by the way each one can go wrong in production rather
 * than by the module they touch, because every failure in this area has the same
 * shape: a name that two parties disagree about. This installation and the panel, the
 * summary and the account, one customer and another.
 *
 * Four properties carry everything:
 *
 *   - a name is CANONICAL before anything durable sees it, so `Ali_2026` and
 *     `ali_2026` are one identity that collides on one index;
 *   - a name is held by a ROW in a namespace derived from the provider and the host,
 *     so two panels pointing at one machine cannot both sell it;
 *   - a name is FUNDED in the transaction that takes the money and released only by
 *     the transaction that gives it back;
 *   - and every one of those is decided by an index or a conditional write, never by
 *     a question asked before the write.
 */
const BOT_A = SEED_IDS.botA1 as BotInstanceId;

/** The same shape `automatic-refund.test.ts` uses: a customer's own turn, not an operator's. */
const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('the name a service is sold under', () => {
  let ctx: TestContext;
  let products: DrizzleProductRepository;
  /** Legacy policy: both modes, derived generator — what migration 0088 gave everyone. */
  let panelLegacy: string;
  /** A panel with a template, so RANDOM renders rather than deriving. */
  let panelTemplated: string;
  /** Another tenant's panel on the SAME host as `panelLegacy`. See the namespace case. */
  let panelShared: string;
  let customerA: UserId;
  let customerB: UserId;
  let owner: ActorContext;
  let n = 0;
  const key = (): string => `username-key-${(n += 1)}`;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    products = new DrizzleProductRepository(ctx.container.database.db);
    panelLegacy = ctx.container.ids.uuid();
    panelTemplated = ctx.container.ids.uuid();
    panelShared = ctx.container.ids.uuid();
    /*
     * `panelShared` is ANOTHER TENANT'S panel with the same provider and host as
     * `panelLegacy`, and that is the whole point of it: one provider account
     * namespace, two tenants, neither aware of the other.
     */
    await ctx.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status,
                          allow_custom_username, allow_random_username, username_template)
      VALUES (${panelLegacy}, ${tenantA.tenantId}, 'Legacy', 'sanaei',
              'https://shared.example.test', 'ACTIVE', true, true, NULL),
             (${panelTemplated}, ${tenantA.tenantId}, 'Templated', 'sanaei',
              'https://t.example.test', 'ACTIVE', true, true, 'nx{random10}'),
             (${panelShared}, ${tenantB.tenantId}, 'Shared host', 'sanaei',
              'https://shared.example.test', 'ACTIVE', true, true, NULL)`);
    customerA = await customer(tenantA, '900901');
    customerB = await customer(tenantA, '900902');
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'owner-username',
        roleKeys: ['owner'],
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  async function customer(scope: typeof tenantA, telegramUserId: string): Promise<UserId> {
    const { customer: record } = await ctx.container.customers.resolveFromUpdate(
      scope,
      systemActor(`resolve-${telegramUserId}`),
      {
        idempotencyKey: `resolve-${telegramUserId}`,
        telegramUserId,
        from: { id: Number(telegramUserId), first_name: 'زهرا' },
        botInstanceId: BOT_A,
      },
    );
    return record.id;
  }

  const draft = (panelId: string): ProductDraft => ({
    title: 'پلن پایه',
    description: 'یک ماهه',
    audience: 'EVERYONE',
    sortOrder: 10,
    panelId: panelId as PanelId,
    specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
    price: money(250_000n, 'IRT'),
  });

  /** A DRAFT order, which is the only state in which a name may be chosen. */
  async function drafted(panelId: string, who: UserId = customerA): Promise<OrderRecord> {
    const created = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: draft(panelId),
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    const k = key();
    return ctx.container.orders.createDraft(tenantA, systemActor(k), {
      idempotencyKey: `${k}-draft`,
      customerId: who,
      productId: created.id,
    });
  }

  const choose = (order: OrderRecord, raw: string | null, who: UserId = customerA) =>
    ctx.container.orders.chooseUsername(tenantA, systemActor(key()), {
      idempotencyKey: key(),
      customerId: who,
      orderId: order.id,
      choice: raw === null ? { mode: 'RANDOM' } : { mode: 'CUSTOM', raw },
    });

  const confirm = (order: OrderRecord, who: UserId = customerA) =>
    ctx.container.orders.confirm(tenantA, systemActor(key()), {
      idempotencyKey: key(),
      customerId: who,
      orderId: order.id,
    });

  const setPolicy = (panelId: string, custom: boolean, random: boolean, template: string | null) =>
    ctx.container.database.db.execute(sql`
      UPDATE panels SET allow_custom_username = ${custom},
                        allow_random_username = ${random},
                        username_template = ${template}
       WHERE id = ${panelId}`);

  const reservations = async (orderId: string) =>
    (
      await ctx.container.database.db.execute(
        sql`SELECT username, namespace_key, mode, funded_at
              FROM service_username_reservations WHERE order_id = ${orderId}`,
      )
    ).rows as { username: string; namespace_key: string; mode: string; funded_at: Date | null }[];

  // -------------------------------------------------------------------------
  // What a customer may type
  // -------------------------------------------------------------------------

  it('stores the canonical lowercase form of what the customer typed', async () => {
    /*
     * The owner's rule: case is INPUT, not identity. Asserted on the stored row rather
     * than on the return value, because the row is what the uniqueness index, the
     * provider call and the audit all read.
     */
    const order = await drafted(panelLegacy);
    const reserved = await choose(order, 'Ali_2026');
    expect(reserved.username).toBe('ali_2026');
    expect((await reservations(order.id))[0]?.username).toBe('ali_2026');
  });

  it('treats two spellings of one name as one identity', async () => {
    /*
     * The case that would hand two customers accounts an operator reading a client
     * list cannot tell apart. The second is refused by the unique index, not by a
     * check — a check issued before the insert sees the state the loser started from.
     */
    const first = await drafted(panelLegacy);
    await choose(first, 'ali_2026');

    const second = await drafted(panelLegacy, customerB);
    await expect(choose(second, 'ALI_2026', customerB)).rejects.toMatchObject({
      code: COMMERCE_ERROR_CODES.SERVICE_USERNAME_TAKEN,
    });
  });

  it('refuses a name that breaks the rule, and reserves nothing', async () => {
    const order = await drafted(panelLegacy);
    // No digit, Persian digits, whitespace, and too short: four refusals, one code.
    for (const raw of ['alialiali', 'ali_۱۴۰۳', ' ali_2026 ', 'ali_20']) {
      await expect(choose(order, raw)).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.SERVICE_USERNAME_INVALID,
      });
    }
    expect(await reservations(order.id)).toHaveLength(0);
  });

  it('refuses a mode the panel does not offer, whatever the surface drew', async () => {
    /*
     * A callback is a string somebody can send twice, or send after an operator
     * changed the policy. The button that produced it is not authorisation.
     */
    await setPolicy(panelLegacy, false, true, null);
    const order = await drafted(panelLegacy);
    await expect(choose(order, 'ali_2026')).rejects.toMatchObject({
      code: COMMERCE_ERROR_CODES.SERVICE_USERNAME_MODE_UNAVAILABLE,
    });
  });

  // -------------------------------------------------------------------------
  // What the installation generates
  // -------------------------------------------------------------------------

  it('renders the panel template for a RANDOM name', async () => {
    const order = await drafted(panelTemplated);
    const reserved = await choose(order, null);
    expect(reserved.username).toMatch(/^nx[a-z0-9]{10}$/);
    expect((await reservations(order.id))[0]?.mode).toBe('RANDOM');
  });

  it('mints the legacy shape when the panel has no template', async () => {
    /*
     * `nx` plus 32 hex — the same shape, length and pattern every panel produced
     * before this policy existed, so nothing an operator reads changes. What changed
     * is that the name now exists BEFORE the money does.
     */
    const order = await drafted(panelLegacy);
    const reserved = await choose(order, null);
    expect(reserved.username).toMatch(/^nx[0-9a-f]{32}$/);
  });

  // -------------------------------------------------------------------------
  // Whose namespace it is
  // -------------------------------------------------------------------------

  it('holds a name across tenants that share one provider host', async () => {
    /*
     * DELIBERATELY not tenant-scoped. Two tenants pointing at one machine share its
     * account namespace whether or not either knows about the other, and a name one
     * created is a name the other cannot have. Keying the index on `panel_id` would
     * let the second discover that from the provider — after the money moved.
     *
     * The refusal leaks nothing across the boundary: the loser learns the name is
     * unavailable, which is the answer the provider would have given eventually.
     */
    const mine = await drafted(panelLegacy);
    await choose(mine, 'ali_2026');
    expect((await reservations(mine.id))[0]?.namespace_key).toBe('sanaei:shared.example.test');

    const foreignCustomer = await customer(tenantB, '900903');
    const foreignProduct = await products.create(tenantB, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: draft(panelShared),
      now: ctx.container.clock.now(),
    });
    await products.setStatus(
      tenantB,
      foreignProduct.id,
      'INACTIVE',
      'ACTIVE',
      ctx.container.clock.now(),
    );
    const k = key();
    const theirs = await ctx.container.orders.createDraft(tenantB, systemActor(k), {
      idempotencyKey: `${k}-draft`,
      customerId: foreignCustomer,
      productId: foreignProduct.id,
    });
    await expect(
      ctx.container.orders.chooseUsername(tenantB, systemActor(key()), {
        idempotencyKey: key(),
        customerId: foreignCustomer,
        orderId: theirs.id,
        choice: { mode: 'CUSTOM', raw: 'ali_2026' },
      }),
    ).rejects.toMatchObject({ code: COMMERCE_ERROR_CODES.SERVICE_USERNAME_TAKEN });
  });

  it('separates namespaces by host, so a different machine is a different name space', async () => {
    const mine = await drafted(panelLegacy);
    await choose(mine, 'ali_2026');

    const elsewhere = await drafted(panelTemplated, customerB);
    const reserved = await choose(elsewhere, 'ali_2026', customerB);
    expect(reserved.username).toBe('ali_2026');
    expect((await reservations(elsewhere.id))[0]?.namespace_key).toBe('sanaei:t.example.test');
  });

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  it('gives one order one name however many times the button is tapped', async () => {
    /*
     * A Telegram callback Telegram redelivers, a double tap, a second replica. The
     * `(tenant_id, order_id)` index decides, and the second call reads the winner's
     * row rather than taking a second name.
     */
    const order = await drafted(panelTemplated);
    const first = await choose(order, null);
    const second = await choose(order, null);
    expect(second.username).toBe(first.username);
    expect(await reservations(order.id)).toHaveLength(1);
  });

  it('keeps the first name when the customer sends a second one', async () => {
    // Deliberate: the FIRST accepted name stands. A second `choose` is answered with
    // the held row, so a customer cannot rename their service out from under a
    // summary they have already been shown.
    const order = await drafted(panelLegacy);
    await choose(order, 'ali_2026');
    const again = await choose(order, 'reza_1404');
    expect(again.username).toBe('ali_2026');
  });

  // -------------------------------------------------------------------------
  // The money boundary
  // -------------------------------------------------------------------------

  it('allocates a RANDOM name for an order confirmed without one', async () => {
    /*
     * The upgrade case: a draft created before this feature, confirmed after. Sending
     * a customer at the confirm button back for something the installation can decide
     * itself is a worse answer than deciding it.
     */
    const order = await drafted(panelLegacy);
    const confirmed = await confirm(order);
    expect(confirmed.state).toBe('AWAITING_PAYMENT');
    expect(await reservations(order.id)).toHaveLength(1);
  });

  it('refuses to confirm a CUSTOM-only order with no name', async () => {
    /*
     * There the operator has said the customer chooses, and choosing for them is this
     * product's own version of the legacy defect that baked an administrator's name
     * into thirteen thousand customers' records.
     */
    await setPolicy(panelLegacy, true, false, null);
    const order = await drafted(panelLegacy);
    await expect(confirm(order)).rejects.toMatchObject({
      code: COMMERCE_ERROR_CODES.SERVICE_USERNAME_REQUIRED,
    });
    expect(await reservations(order.id)).toHaveLength(0);
  });

  it('refuses to change a name once the order is past DRAFT', async () => {
    // After AWAITING_PAYMENT the customer has agreed to a summary naming this
    // username, and a payment may already be in flight.
    const order = await drafted(panelLegacy);
    await choose(order, 'ali_2026');
    await confirm(order);
    await expect(choose(order, 'reza_1404')).rejects.toMatchObject({
      code: COMMERCE_ERROR_CODES.ORDER_STATE_INVALID,
    });
  });

  it('leaves the name unfunded until the money commits', async () => {
    /*
     * `funded_at` is the single field that stops the reaper taking the name back, and
     * an unfunded hold is exactly what an abandoned checkout should leave behind.
     */
    const order = await drafted(panelLegacy);
    await choose(order, 'ali_2026');
    await confirm(order);
    expect((await reservations(order.id))[0]?.funded_at).toBeNull();
  });

  // -------------------------------------------------------------------------
  // The policy itself
  // -------------------------------------------------------------------------

  it('refuses a panel policy with neither mode', async () => {
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Policy panel',
      providerType: 'sanaei',
      baseUrl: 'https://policy.example.test',
      idempotencyKey: key(),
    });
    await expect(
      ctx.container.panels.update(tenantA, owner, created.view.panel.id, {
        usernamePolicy: { allowCustom: false, allowRandom: false, template: null },
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ code: PANEL_ERROR_CODES.PANEL_USERNAME_POLICY_EMPTY });
  });

  it('refuses a template that cannot produce a unique name', async () => {
    /*
     * Refused while the operator is looking at the field. The alternative shape of
     * this rule — accept it and find out at the first purchase — costs a customer a
     * failed order instead of costing an operator a shorter template.
     */
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Template panel',
      providerType: 'sanaei',
      baseUrl: 'https://template.example.test',
      idempotencyKey: key(),
    });
    await expect(
      ctx.container.panels.update(tenantA, owner, created.view.panel.id, {
        usernamePolicy: { allowCustom: true, allowRandom: true, template: 'everyone' },
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ code: PANEL_ERROR_CODES.PANEL_USERNAME_TEMPLATE_INVALID });
  });

  it('reads the policy back exactly as it was written', async () => {
    // The write-only settings defect, refused: an operator who cannot read a policy
    // can only discover it by overwriting it.
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Readback panel',
      providerType: 'sanaei',
      baseUrl: 'https://readback.example.test',
      usernamePolicy: { allowCustom: false, allowRandom: true, template: 'a{random6}' },
      idempotencyKey: key(),
    });
    expect(created.view.panel.usernamePolicy).toEqual({
      allowCustom: false,
      allowRandom: true,
      template: 'a{random6}',
    });
  });

  it('gives a panel created without a policy the legacy behaviour', async () => {
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Default panel',
      providerType: 'sanaei',
      baseUrl: 'https://default.example.test',
      idempotencyKey: key(),
    });
    expect(created.view.panel.usernamePolicy).toEqual({
      allowCustom: true,
      allowRandom: true,
      template: null,
    });
  });
});
