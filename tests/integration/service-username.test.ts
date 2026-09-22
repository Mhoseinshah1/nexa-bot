import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  DEFAULT_USERNAME_PATTERN,
  RANDOM_STRATEGY_LENGTH,
  isNewProviderUsername,
  usernameDigest4,
  COMMERCE_ERROR_CODES,
  PANEL_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type ProductId,
  type UserId,
  type ProductCategoryId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import type { ProductDraft } from '../../apps/api/src/modules/commerce/catalog/application/ports';
import type { OrderRecord } from '../../apps/api/src/modules/commerce/orders/application/ports';
import {
  SEED_IDS,
  adminActorFor,
  createAdmin,
  createTestContext,
  makePanelSellable,
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

/** The SAME hasher the container binds, so `{order4}` renders identically here. */
const sha256 = (input: string): string => createHash('sha256').update(input).digest('hex');

describe('the name a service is sold under', () => {
  let ctx: TestContext;
  let products: DrizzleProductRepository;
  /** The default policy: both choices, `nx` plus ten — what 0094 gave every panel. */
  let panelLegacy: string;
  /** A panel on CUSTOM_TEMPLATE, so a template renders rather than the default preset. */
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
                          allow_custom_username, allow_automatic_username,
                          username_strategy, username_prefix, username_template)
      VALUES (${panelLegacy}, ${tenantA.tenantId}, 'Legacy', 'sanaei',
              'https://shared.example.test', 'ACTIVE', true, true,
              'PREFIX_RANDOM', 'nx', NULL),
             (${panelTemplated}, ${tenantA.tenantId}, 'Templated', 'sanaei',
              'https://t.example.test', 'ACTIVE', true, true,
              'CUSTOM_TEMPLATE', NULL, 'nx{random10}'),
             (${panelShared}, ${tenantB.tenantId}, 'Shared host', 'sanaei',
              'https://shared.example.test', 'ACTIVE', true, true,
              'PREFIX_RANDOM', 'nx', NULL)`);
    /*
     * Sellable in full, not just rows. Since this hotfix a confirmation also
     * needs credentials, an activation and a recorded connection test, and
     * these cases are about the NAME a sale is made under — so the sale has to
     * be able to happen.
     */
    await makePanelSellable(ctx.container, tenantA, panelLegacy);
    await makePanelSellable(ctx.container, tenantA, panelTemplated);
    await makePanelSellable(ctx.container, tenantB, panelShared);
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
    categoryId: SEED_IDS.categoryA as ProductCategoryId,
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
      choice: raw === null ? { mode: 'AUTOMATIC' } : { mode: 'CUSTOM', raw },
    });

  const confirm = (order: OrderRecord, who: UserId = customerA) =>
    ctx.container.orders.confirm(tenantA, systemActor(key()), {
      idempotencyKey: key(),
      customerId: who,
      orderId: order.id,
    });

  /**
   * Writes the policy columns directly, which is deliberate for a FIXTURE.
   *
   * The service is what a test of the service uses; this is for arranging a panel a
   * case needs, and going through the service would make every arrangement also a
   * test of the validator. The two biconditional CHECK constraints still apply, so
   * the strategy and its configuration are written together.
   */
  const setPolicy = (
    panelId: string,
    custom: boolean,
    automatic: boolean,
    template: string | null,
  ) =>
    ctx.container.database.db.execute(sql`
      UPDATE panels SET allow_custom_username = ${custom},
                        allow_automatic_username = ${automatic},
                        username_strategy = ${template === null ? 'PREFIX_RANDOM' : 'CUSTOM_TEMPLATE'},
                        username_prefix = ${template === null ? 'nx' : null},
                        username_template = ${template}
       WHERE id = ${panelId}`);

  /** Puts a panel on one preset with its configuration, both written together. */
  const setStrategy = (panelId: string, strategy: string, prefix: string | null) =>
    ctx.container.database.db.execute(sql`
      UPDATE panels SET username_strategy = ${strategy},
                        username_prefix = ${prefix},
                        username_template = NULL
       WHERE id = ${panelId}`);

  /** Every payment row this order produced. Used to prove a refusal charged nothing. */
  const payments = async (orderId: string) =>
    (
      await ctx.container.database.db.execute(
        sql`SELECT id FROM payments WHERE order_id = ${orderId}`,
      )
    ).rows;

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
    /*
     * No digit, Persian digits, whitespace, too short and too long: five refusals,
     * one code. `a1` is three characters under the floor and the 21-character one is
     * a character over the ceiling — the two boundaries the universal contract moved.
     */
    for (const raw of ['alialiali', 'ali_۱۴۰۳', ' ali_2026 ', 'a1', `${'a'.repeat(20)}1`]) {
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

  it('renders the panel template for an AUTOMATIC name', async () => {
    const order = await drafted(panelTemplated);
    const reserved = await choose(order, null);
    expect(reserved.username).toMatch(/^nx[a-z0-9]{10}$/);
    expect((await reservations(order.id))[0]?.mode).toBe('AUTOMATIC');
  });

  it('mints the DEFAULT preset on a panel nobody has configured', async () => {
    /*
     * `nx` plus ten, twelve characters — and emphatically NOT the 34-character
     * derived shape this release removed. The name exists before the money does,
     * and it fits inside the universal contract like every other new name.
     */
    const order = await drafted(panelLegacy);
    const reserved = await choose(order, null);
    expect(reserved.username).toMatch(DEFAULT_USERNAME_PATTERN);
    expect(isNewProviderUsername(reserved.username)).toBe(true);
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

  // -------------------------------------------------------------------------
  // The four presets, against real rows
  // -------------------------------------------------------------------------

  it('mints twelve characters on RANDOM, and the whole Telegram id on TELEGRAM_ID_RANDOM', async () => {
    await setStrategy(panelTemplated, 'RANDOM', null);
    const first = await choose(await drafted(panelTemplated), null);
    expect(first.username).toHaveLength(RANDOM_STRATEGY_LENGTH);
    expect(isNewProviderUsername(first.username)).toBe(true);

    await setStrategy(panelTemplated, 'TELEGRAM_ID_RANDOM', null);
    const second = await choose(await drafted(panelTemplated), null);
    // `customerA` is Telegram 900901, rendered in FULL and never truncated.
    expect(second.username.startsWith('900901_')).toBe(true);
    expect(second.username).toHaveLength('900901_'.length + 6);
    expect(isNewProviderUsername(second.username)).toBe(true);
  });

  it('refuses a purchase TELEGRAM_ID_RANDOM cannot name, before any debit', async () => {
    /*
     * A thirteen-digit id renders 13 + 1 + 6 = 20 and fits; a fourteen-digit one
     * renders 21 and does not. The refusal names no panel and no preset to the
     * customer, and it is a DIFFERENT code from a collision because no redraw could
     * have helped — the operator is the one who fixes it.
     */
    await setStrategy(panelTemplated, 'TELEGRAM_ID_RANDOM', null);
    const long = await customer(tenantA, '99999999999999');
    const order = await drafted(panelTemplated, long);
    await expect(choose(order, null, long)).rejects.toMatchObject({
      code: COMMERCE_ERROR_CODES.SERVICE_USERNAME_UNGENERATABLE,
    });
    expect(await reservations(order.id)).toHaveLength(0);
    expect(await payments(order.id)).toHaveLength(0);
  });

  it('refuses rather than redrawing when the template has no random component', async () => {
    /*
     * `{order4}` is a deterministic function of the order, so the second attempt
     * renders exactly what the first did. Regenerating it would mean changing the
     * order's identity to hide a name clash, so there is ONE attempt and then a
     * refusal — and the refusal is EXHAUSTED rather than TAKEN, because the customer
     * chose nothing and has nothing to choose differently.
     *
     * The collision is arranged by taking the name first with a CUSTOM reservation on
     * the same panel, which is the same namespace row the redraw would contend with.
     */
    await ctx.container.database.db.execute(sql`
      UPDATE panels SET username_strategy = 'CUSTOM_TEMPLATE', username_prefix = NULL,
                        username_template = 'u{order4}'
       WHERE id = ${panelTemplated}`);
    const victim = await drafted(panelTemplated);
    const rendered = `u${usernameDigest4(victim.id, sha256)}`;
    await ctx.container.database.db.execute(sql`
      INSERT INTO service_username_reservations
        (id, tenant_id, namespace_key, username, panel_id, order_id, customer_id, mode, expires_at)
      SELECT ${ctx.container.ids.uuid()}, ${tenantA.tenantId}, 'sanaei:t.example.test',
             ${rendered}, ${panelTemplated}, id, ${customerA}, 'CUSTOM', now() + interval '1 hour'
        FROM orders WHERE id = ${(await drafted(panelTemplated)).id}`);

    await expect(choose(victim, null)).rejects.toMatchObject({
      code: COMMERCE_ERROR_CODES.SERVICE_USERNAME_EXHAUSTED,
    });
    expect(await reservations(victim.id)).toHaveLength(0);
    expect(await payments(victim.id), 'nothing was charged').toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // A frozen name, and what may re-judge it
  // -------------------------------------------------------------------------

  it('refuses to confirm an UNFUNDED draft whose frozen name the contract no longer takes', async () => {
    /*
     * A draft frozen under the old 34-character shape, confirmed after this release.
     * No money has moved and nothing exists on a panel, so the safe answer is to
     * refuse and make the customer choose again — fenced by `funded_at`, as the case
     * below proves from the other side.
     *
     * The hold is still THERE afterwards, and that is the point rather than an
     * oversight. The refusal aborts the confirming transaction, so anything that
     * transaction wrote — a release included — goes with it. An earlier version
     * released here and asserted the row was gone; it was gone only until the
     * rollback put it back, and the customer got the same refused name for ever.
     */
    const order = await drafted(panelLegacy);
    await choose(order, null);
    const stale = `nx${'a'.repeat(32)}`;
    await ctx.container.database.db.execute(sql`
      UPDATE service_username_reservations
         SET username = ${stale}
       WHERE order_id = ${order.id}`);

    await expect(confirm(order)).rejects.toMatchObject({
      code: COMMERCE_ERROR_CODES.SERVICE_USERNAME_STALE,
    });
    const [survived] = await reservations(order.id);
    expect(survived?.username, 'nothing was rewritten by a transaction that refused').toBe(stale);
  });

  it('lets the customer choose again, and the stale hold gives way to the new name', async () => {
    /*
     * The other half, and the one that makes the refusal above an answer rather than
     * a dead end. `reserve` is `ON CONFLICT DO NOTHING` on `(tenant_id, order_id)`, so
     * without the clearing in `choose` a re-selection hands back the SAME refused name
     * and the customer can never get past the summary.
     *
     * This transaction commits, which is why the clearing lives here.
     */
    const order = await drafted(panelLegacy);
    await choose(order, null);
    await ctx.container.database.db.execute(sql`
      UPDATE service_username_reservations
         SET username = ${`nx${'b'.repeat(32)}`}
       WHERE order_id = ${order.id}`);

    await choose(order, null);

    const [replaced] = await reservations(order.id);
    expect(replaced?.username, 'one hold, and it is a name this contract mints').toMatch(
      DEFAULT_USERNAME_PATTERN,
    );
    expect(await reservations(order.id)).toHaveLength(1);
    // And confirmation now goes through, which is what the customer was told to do.
    expect((await confirm(order)).state).toBe('AWAITING_PAYMENT');
  });

  it('never re-judges a FUNDED name, whatever it looks like', async () => {
    /*
     * The asymmetry that matters. Money has moved and an account may already exist
     * under that name; renaming it would leave this installation addressing an
     * account by a name the panel does not know it by. An ambiguous outcome is
     * reconciliation's problem and a definitive non-delivery is the refund's.
     */
    const order = await drafted(panelLegacy);
    await choose(order, null);
    const legacyName = `nx${'b'.repeat(32)}`;
    await ctx.container.database.db.execute(sql`
      UPDATE service_username_reservations
         SET username = ${legacyName}, funded_at = now()
       WHERE order_id = ${order.id}`);

    /*
     * Confirmation succeeds and the name is untouched — no refusal, no rewrite. The
     * unfunded case above is the only path that may release one.
     */
    const confirmed = await confirm(order);
    expect(confirmed.state).toBe('AWAITING_PAYMENT');
    const [row] = await reservations(order.id);
    expect(row?.username).toBe(legacyName);
  });

  // -------------------------------------------------------------------------
  // The hold's lifecycle: what gives a name back, and what must never
  // -------------------------------------------------------------------------

  it('gives the name back when the customer cancels, so somebody else may have it', async () => {
    /*
     * `service_username_reservations_name_key` is unique on
     * `(namespace_key, username)` and does NOT read `expires_at`. So a hold nothing
     * deletes keeps its name out of circulation for ever — and on a panel where
     * customers type their own names, for ever is the name they wanted.
     *
     * Cancellation gave back the panel SLOT and not the name. This is the half that
     * was missing, and the proof is not that a row vanished but that the name can be
     * taken again afterwards.
     */
    const first = await drafted(panelLegacy);
    await choose(first, 'zahra_9');
    await confirm(first);
    await ctx.container.orders.cancelByCustomer(tenantA, systemActor(key()), {
      idempotencyKey: key(),
      customerId: customerA,
      orderId: first.id,
    });
    expect(await reservations(first.id), 'the cancelled order holds nothing').toHaveLength(0);

    const second = await drafted(panelLegacy, customerB);
    const retaken = await choose(second, 'zahra_9', customerB);
    expect(retaken.username, 'the next customer may have it').toBe('zahra_9');
  });

  it('keeps a FUNDED name through a cancellation that arrives too late', async () => {
    /*
     * The asymmetry, from the cancellation side. Money has moved and an account may
     * exist under that name, so a second tap or a redelivered callback arriving after
     * settlement must find nothing to free. The `funded_at IS NULL` lives in the
     * DELETE's predicate rather than in a read before it, because a settlement
     * committing between the read and the delete is exactly the race.
     */
    const order = await drafted(panelLegacy);
    const held = await choose(order, 'late_cancel1');
    await confirm(order);
    await ctx.container.database.db.execute(sql`
      UPDATE service_username_reservations SET funded_at = now() WHERE order_id = ${order.id}`);

    await ctx.container.orders
      .cancelByCustomer(tenantA, systemActor(key()), {
        idempotencyKey: key(),
        customerId: customerA,
        orderId: order.id,
      })
      .catch(() => undefined);

    const [survived] = await reservations(order.id);
    expect(survived?.username, 'a funded name is never freed by a cancellation').toBe(
      held.username,
    );
  });

  it('sweeps an abandoned DRAFT’s hold once its deadline passes, and never a funded one', async () => {
    /*
     * The population no order-ending path can see. A customer who tapped a product,
     * chose a name and then simply stopped leaves a DRAFT — `expireDue` only looks at
     * `AWAITING_PAYMENT` — holding a name with nothing to remove it.
     *
     * Both halves in one case on purpose: a sweep that frees the abandoned name is
     * only safe if the same pass leaves the funded one alone, and separating them
     * lets a bound that catches the first row hide the second.
     */
    const abandoned = await drafted(panelLegacy);
    await choose(abandoned, 'gone_forever1');
    const funded = await drafted(panelLegacy, customerB);
    const kept = await choose(funded, 'paid_for_it1', customerB);
    await ctx.container.database.db.execute(sql`
      UPDATE service_username_reservations
         SET expires_at = now() - interval '1 hour',
             funded_at = CASE WHEN order_id = ${funded.id} THEN now() ELSE NULL END`);

    const report = await ctx.container.paymentExpirySweep.runOnce(tenantA);
    expect(report.usernameHolds, 'exactly the abandoned one').toBe(1);
    expect(await reservations(abandoned.id)).toHaveLength(0);
    expect((await reservations(funded.id))[0]?.username).toBe(kept.username);

    // And the freed name is genuinely free, which is the only thing the row's
    // absence was ever standing in for.
    const next = await drafted(panelLegacy);
    expect((await choose(next, 'gone_forever1')).username).toBe('gone_forever1');
  });

  it('refuses a panel policy with neither mode', async () => {
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Policy panel',
      providerType: 'sanaei',
      baseUrl: 'https://policy.example.test',
      idempotencyKey: key(),
    });
    await expect(
      ctx.container.panels.update(tenantA, owner, created.view.panel.id, {
        usernamePolicy: {
          allowCustom: false,
          allowAutomatic: false,
          strategy: 'RANDOM',
          prefix: null,
          template: null,
        },
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
        usernamePolicy: {
          allowCustom: true,
          allowAutomatic: true,
          strategy: 'CUSTOM_TEMPLATE',
          prefix: null,
          template: 'everyone',
        },
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
      usernamePolicy: {
        allowCustom: false,
        allowAutomatic: true,
        strategy: 'CUSTOM_TEMPLATE',
        prefix: null,
        template: 'a{random6}',
      },
      idempotencyKey: key(),
    });
    expect(created.view.panel.usernamePolicy).toEqual({
      allowCustom: false,
      allowAutomatic: true,
      strategy: 'CUSTOM_TEMPLATE',
      prefix: null,
      template: 'a{random6}',
    });
  });

  it('gives a panel created without a policy the DEFAULT preset', async () => {
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Default panel',
      providerType: 'sanaei',
      baseUrl: 'https://default.example.test',
      idempotencyKey: key(),
    });
    expect(created.view.panel.usernamePolicy).toEqual({
      allowCustom: true,
      allowAutomatic: true,
      strategy: 'PREFIX_RANDOM',
      prefix: 'nx',
      template: null,
    });
  });
  // -------------------------------------------------------------------------
  // What a RETRY gets, and what a stale button may open
  // -------------------------------------------------------------------------

  it('hands a retried choice the name it already took, rather than a conflict', async () => {
    /*
     * Codex, P2. The command had no replay lookup at all.
     *
     * `rememberOnce` is a conditional INSERT, so the second arrival under a key finds
     * the row already there and throws `IDEMPOTENCY_IN_FLIGHT`. That is the right
     * answer for two requests racing — the loser must roll back — and the wrong one
     * for the case it also caught: a customer whose reply timed out, retrying with the
     * key the client already generated, was told their request conflicted with itself.
     *
     * The same key AND the same ask, which is what makes it a retry. `confirm` and
     * `createDraft` have had this lookup since Phase 4B; the username command was
     * written without it.
     */
    const order = await drafted(panelLegacy);
    const once = await ctx.container.orders.chooseUsername(tenantA, systemActor('retry-1'), {
      idempotencyKey: 'choose-retry',
      customerId: customerA,
      orderId: order.id,
      choice: { mode: 'CUSTOM', raw: 'ali2026' },
    });
    const again = await ctx.container.orders.chooseUsername(tenantA, systemActor('retry-2'), {
      idempotencyKey: 'choose-retry',
      customerId: customerA,
      orderId: order.id,
      choice: { mode: 'CUSTOM', raw: 'ali2026' },
    });

    expect(again.username, 'the name they already have, not a 409').toBe('ali2026');
    expect(again.id, 'and the same row — nothing was allocated twice').toBe(once.id);
    expect(await reservations(order.id)).toHaveLength(1);
  });

  it('still refuses a DIFFERENT ask under one key, because that is a bug and not a retry', async () => {
    /*
     * The negative half, and the reason the replay compares a request hash rather
     * than just finding the key. Without it the fix above would turn "I asked for
     * something else under the same key" into "here is the first answer", which is
     * how a customer ends up holding a name they did not choose.
     */
    const order = await drafted(panelLegacy);
    await ctx.container.orders.chooseUsername(tenantA, systemActor('mismatch-1'), {
      idempotencyKey: 'choose-mismatch',
      customerId: customerA,
      orderId: order.id,
      choice: { mode: 'CUSTOM', raw: 'ali2026' },
    });
    await expect(
      ctx.container.orders.chooseUsername(tenantA, systemActor('mismatch-2'), {
        idempotencyKey: 'choose-mismatch',
        customerId: customerA,
        orderId: order.id,
        choice: { mode: 'CUSTOM', raw: 'ali2027' },
      }),
    ).rejects.toMatchObject({ code: PLATFORM_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH });
    expect((await reservations(order.id))[0]?.username, 'and the first name stands').toBe(
      'ali2026',
    );
  });

  it('refuses to open a typing window on a panel that no longer takes typed names', async () => {
    /*
     * Codex, P2. `beginUsernameEntry` checked the ORDER and not the panel.
     *
     * `allocate` does refuse a CUSTOM the panel does not offer — one typed message
     * later, and the refusal aborts the transaction that would have closed the
     * window. So a button drawn before an operator made the panel automatic-only told
     * the customer to type a name, refused every name they typed, and left the window
     * intercepting their ordinary messages for the rest of its ten minutes. That is
     * the legacy prompt-capture failure (INCIDENT-FIN-001) with the customer on the
     * other end of it.
     *
     * Asserted as BOTH: the refusal, and no row. A refusal that still opened the
     * window would leave the interception in place, which is the actual harm.
     */
    const order = await drafted(panelLegacy);
    await setPolicy(panelLegacy, false, true, null);

    await expect(
      ctx.container.orders.beginUsernameEntry(tenantA, systemActor(key()), {
        idempotencyKey: key(),
        botInstanceId: BOT_A,
        customerId: customerA,
        orderId: order.id,
      }),
    ).rejects.toMatchObject({ code: COMMERCE_ERROR_CODES.SERVICE_USERNAME_MODE_UNAVAILABLE });

    const windows = await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM username_captures WHERE order_id = ${order.id}`,
    );
    expect(
      (windows.rows[0] as { n: number } | undefined)?.n,
      'nothing is listening for a name it would refuse',
    ).toBe(0);
  });

  it('opens the window on a panel that does take typed names', async () => {
    // The positive half, so the guard above cannot be satisfied by refusing always.
    const order = await drafted(panelLegacy);
    const opened = await ctx.container.orders.beginUsernameEntry(tenantA, systemActor(key()), {
      idempotencyKey: key(),
      botInstanceId: BOT_A,
      customerId: customerA,
      orderId: order.id,
    });
    expect(opened.expiresAt.getTime()).toBeGreaterThan(ctx.container.clock.now().getTime());
  });

  // -------------------------------------------------------------------------
  // What moving a panel does to the names it is holding
  // -------------------------------------------------------------------------

  it('carries the names a panel holds to the namespace of its new address', async () => {
    /*
     * Codex, P2. `namespace_key` is frozen on the row, and nothing moved it.
     *
     * The key is provider plus host and deliberately NOT the panel, because two
     * panels pointing at one machine share its account namespace. Freezing it means
     * an address change left every name this panel holds counting against a machine
     * the panel no longer talks to — so the guarantee the unique index exists for
     * stopped describing the machine the accounts would actually be created on.
     */
    const order = await drafted(panelTemplated);
    await choose(order, 'ali2026');
    const before = (await reservations(order.id))[0];
    expect(before?.namespace_key).toContain('t.example.test');

    await ctx.container.panels.update(tenantA, owner, panelTemplated, {
      baseUrl: 'https://moved.example.test',
      idempotencyKey: key(),
    });

    const after = (await reservations(order.id))[0];
    expect(after?.namespace_key, 'the hold followed the panel').toContain('moved.example.test');
    expect(after?.username, 'and the name itself is untouched, as it must be').toBe('ali2026');
  });

  it('refuses the move when a name this panel holds is already held at the destination', async () => {
    /*
     * The other outcome, and the one that costs money if it is allowed.
     *
     * `panelShared` belongs to the OTHER tenant and sits on `shared.example.test`;
     * namespaces are not tenant-scoped, which is the point of the case above this
     * file's "holds a name across tenants that share one provider host". Moving
     * `panelTemplated` onto that host would put two holds on one name for one
     * machine — and nothing would notice until the second provider create answered
     * 409, with both customers already paid.
     *
     * The edit is refused WHOLE: the rebind and the panel row are one transaction, so
     * the address is still the old one afterwards. A rebind that skipped the row it
     * could not move would be the same collision with a success message on it.
     */
    // The other tenant's panel, on the host this one is about to move to.
    const elsewhere = await products.create(tenantB, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: draft(panelShared),
      now: ctx.container.clock.now(),
    });
    await products.setStatus(
      tenantB,
      elsewhere.id,
      'INACTIVE',
      'ACTIVE',
      ctx.container.clock.now(),
    );
    const theirCustomer = await customer(tenantB, '900903');
    const theirOrder = await ctx.container.orders.createDraft(tenantB, systemActor(key()), {
      idempotencyKey: key(),
      customerId: theirCustomer,
      productId: elsewhere.id,
    });
    await ctx.container.orders.chooseUsername(tenantB, systemActor(key()), {
      idempotencyKey: key(),
      customerId: theirCustomer,
      orderId: theirOrder.id,
      choice: { mode: 'CUSTOM', raw: 'taken2026' },
    });
    // And this tenant's own order holds the same name, legitimately, on another host.
    const ours = await drafted(panelTemplated, customerB);
    await choose(ours, 'taken2026', customerB);

    await expect(
      ctx.container.panels.update(tenantA, owner, panelTemplated, {
        baseUrl: 'https://shared.example.test',
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ code: PANEL_ERROR_CODES.PANEL_NAMESPACE_CONFLICT });

    const row = await ctx.container.database.db.execute(
      sql`SELECT base_url FROM panels WHERE id = ${panelTemplated}`,
    );
    expect(
      (row.rows[0] as { base_url: string } | undefined)?.base_url,
      'the whole edit unwound, address included',
    ).toBe('https://t.example.test');
    expect((await reservations(ours.id))[0]?.namespace_key).toContain('t.example.test');
  });
});
