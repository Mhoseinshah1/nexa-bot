import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ProductCategoryId } from '@nexa/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TELEGRAM_SECRET_TOKEN_HEADER, money, type ProductId } from '@nexa/contracts';
import { CATALOGUE_FA, formatMoney } from '@nexa/i18n';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed, SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import type { ProductDraft } from '../../apps/api/src/modules/commerce/catalog/application/ports';
import {
  makePanelSellable,
  migrateOnce,
  resetDatabase,
  seededCategoryFor,
  tenantA,
  tenantB,
  testConfig,
} from './harness';

/**
 * The customer's purchase flow, end to end, against a REAL socket standing in for
 * Telegram.
 *
 * Three commands — `/catalog`, a tapped product, a tapped confirm — and the whole of
 * Phase 4B's customer-facing surface. What each case is defending:
 *
 *   - the catalogue shows exactly what `listCatalog` admits, and says something
 *     DIFFERENT when it is empty. An empty list reads as a failure; `bot.catalog.empty`
 *     says why there is nothing.
 *   - a tap produces a DRAFT whose figures come from the ORDER, never from the tap.
 *     `templates.ts` states that rule for `bot.order.summary` in terms, and the way to
 *     break it is to render the product instead — which looks identical until somebody
 *     re-prices between the summary and the confirmation.
 *   - a redelivered callback produces ONE order and ONE event. Telegram redelivers any
 *     update it did not see a 200 for, and a second order here is a second thing the
 *     customer owes money for.
 *   - a refusal is a MESSAGE. The legacy bot's failure mode is silence, and a customer
 *     who tapped a button an operator had just withdrawn must be told, not ignored.
 *   - the flow STOPS at AWAITING_PAYMENT. Nothing here settles anything, and the
 *     database's own `orders_settled_at_check` is what says so.
 */

const WEBHOOK_SECRET = 'a-sufficiently-long-secret-for-the-order-flow';
const BOT_A = SEED_IDS.botA1;
const CUSTOMER_TELEGRAM_ID = 5551234567;
const CHAT_ID = 4242;

interface Sent {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

describe('the customer purchase flow over Telegram', () => {
  let api: ApiApp;
  let telegram: Server;
  let sent: Sent[];
  let reply: (request: IncomingMessage, response: ServerResponse) => void;
  let products: DrizzleProductRepository;
  let panelA: string;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

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
        reply(request, response);
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
    reply = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, result: { message_id: 11 } }));
    };
    products = new DrizzleProductRepository(api.container.database.db);
    panelA = api.container.ids.uuid();
    await api.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://a.example.test', 'ACTIVE')`);
    /*
     * Made GENUINELY sellable, not left as a bare row.
     *
     * A panel with no credentials, no activation and no probe cannot create an
     * account, and since this hotfix `decideEligibility` refuses to take money
     * for one. A fixture that expects a sale therefore has to describe a panel
     * that could deliver it; `makePanelSellable` writes the three things a sale
     * now requires, using the production identity function so it cannot drift.
     */
    await makePanelSellable(api.container, tenantA, panelA);
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  let updateId = 2000;

  /** An ordinary text command from the customer. */
  const command = (text: string, options: { chatType?: string; update?: number } = {}) => {
    const id = options.update ?? (updateId += 1);
    return inject({
      method: 'POST',
      url: `/telegram/webhook/${BOT_A}`,
      headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET },
      payload: {
        update_id: id,
        message: {
          message_id: id,
          date: 0,
          chat: { id: CHAT_ID, type: options.chatType ?? 'private' },
          from: { id: CUSTOMER_TELEGRAM_ID, is_bot: false, first_name: 'Ali' },
          text,
        },
      },
    });
  };

  /**
   * A tapped button.
   *
   * `from` sits on the CALLBACK QUERY, and the message it hangs off is the BOT's — which
   * is why the message here carries a bot sender. A runtime that read `message.from`
   * would resolve a customer row for the bot on every tap, and this fixture is shaped so
   * that mistake fails rather than passes.
   */
  const tap = (data: string, options: { chatType?: string; update?: number } = {}) => {
    const id = options.update ?? (updateId += 1);
    return inject({
      method: 'POST',
      url: `/telegram/webhook/${BOT_A}`,
      headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET },
      payload: {
        update_id: id,
        callback_query: {
          id: `cbq-${id}`,
          from: { id: CUSTOMER_TELEGRAM_ID, is_bot: false, first_name: 'Ali' },
          data,
          message: {
            message_id: id,
            date: 0,
            chat: { id: CHAT_ID, type: options.chatType ?? 'private' },
            from: { id: 999999, is_bot: true, first_name: 'Nexa' },
          },
        },
      },
    });
  };

  const draft = (scope: typeof tenantA, overrides: Partial<ProductDraft> = {}): ProductDraft => ({
    title: 'پلن پایه',
    description: null,
    audience: 'EVERYONE',
    sortOrder: 10,
    panelId: panelA as never,
    /*
     * The category of the tenant this draft is written for, never a fixed one.
     * `products_tenant_category_fk` is composite, so a tenant B product filed under
     * tenant A's category is refused by the database — turning a cross-tenant
     * isolation test into a foreign-key error instead of the assertion it was
     * written to make.
     */
    categoryId: seededCategoryFor(scope) as ProductCategoryId,
    specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
    price: money(250_000n, 'IRT'),
    ...overrides,
  });

  async function product(
    scope: typeof tenantA,
    status: 'ACTIVE' | 'INACTIVE',
    overrides: Partial<ProductDraft> = {},
  ) {
    const created = await products.create(scope, {
      id: api.container.ids.uuid() as ProductId,
      draft: draft(scope, overrides),
      now: api.container.clock.now(),
    });
    if (status === 'ACTIVE') {
      await products.setStatus(scope, created.id, 'INACTIVE', 'ACTIVE', api.container.clock.now());
    }
    const after = await products.findById(scope, created.id);
    if (after === null) throw new Error('product vanished');
    return after;
  }

  /** Only the messages, so an `answerCallbackQuery` does not shift every index. */
  const messages = () => sent.filter((one) => one.url.includes('/sendMessage'));
  const lastMessage = () => messages()[messages().length - 1];
  const buttonsOf = (message: Sent | undefined) =>
    (
      (
        message?.body['reply_markup'] as
          { inline_keyboard?: { text: string; callback_data: string }[][] } | undefined
      )?.inline_keyboard ?? []
    ).flat();

  const orders = async () =>
    (
      await api.container.database.db.execute(
        sql`SELECT id, state, customer_id, product_id, line_title, line_unit_price_amount,
                   total_amount, currency, confirmed_at, settled_at, expires_at
              FROM orders ORDER BY created_at ASC`,
      )
    ).rows as Record<string, unknown>[];

  const orderEvents = async () =>
    (
      await api.container.database.db.execute(
        sql`SELECT event_type FROM outbox_messages WHERE aggregate_type = 'Order'
            ORDER BY sequence ASC`,
      )
    ).rows as Record<string, unknown>[];

  // -------------------------------------------------------------------------
  // The catalogue
  // -------------------------------------------------------------------------

  it('answers /catalog with the EMPTY message when nothing is sellable', async () => {
    // Not an empty list. An empty list reads as a failure; this says why there is
    // nothing, which is the distinction `bot.catalog.empty` exists to draw.
    expect((await command('/catalog')).statusCode).toBe(201);
    expect(messages()).toHaveLength(1);
    expect(lastMessage()?.body['text']).toBe(CATALOGUE_FA['bot.catalog.empty']);
    expect(lastMessage()?.body['reply_markup']).toBeUndefined();
  });

  it('lists every sellable product as a button carrying its id, and nothing else', async () => {
    const sellable = await product(tenantA, 'ACTIVE');
    // One of each way a product fails the catalogue's four predicates.
    await product(tenantA, 'INACTIVE');
    await product(tenantA, 'ACTIVE', { audience: 'HIDDEN' });
    await product(tenantA, 'ACTIVE', { price: null });
    await product(tenantA, 'ACTIVE', { panelId: null });

    await command('/catalog');
    expect(lastMessage()?.body['text']).toBe(CATALOGUE_FA['bot.catalog.heading']);

    const buttons = buttonsOf(lastMessage());
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.callback_data).toBe(`p:${sellable.id}`);
    // The label is the tenant's own title and the shared money rendering — the SAME
    // function the message body uses, so a button and a summary cannot disagree.
    expect(buttons[0]?.text).toBe(`پلن پایه — ${formatMoney(money(250_000n, 'IRT'))}`);
    // 38 bytes: Telegram caps `callback_data` at 64, which is why the prefix is one
    // letter and not a word.
    expect(Buffer.byteLength(buttons[0]?.callback_data ?? '', 'utf8')).toBeLessThanOrEqual(64);
  });

  it('shows nothing from another tenant', async () => {
    const panelB = api.container.ids.uuid();
    await api.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelB}, ${tenantB.tenantId}, 'Panel B', 'sanaei', 'https://b.example.test', 'ACTIVE')`);
    /*
     * Made GENUINELY sellable, not left as a bare row.
     *
     * A panel with no credentials, no activation and no probe cannot create an
     * account, and since this hotfix `decideEligibility` refuses to take money
     * for one. A fixture that expects a sale therefore has to describe a panel
     * that could deliver it; `makePanelSellable` writes the three things a sale
     * now requires, using the production identity function so it cannot drift.
     */
    await makePanelSellable(api.container, tenantB, panelB);
    await product(tenantB, 'ACTIVE', { panelId: panelB as never });

    await command('/catalog');
    expect(lastMessage()?.body['text']).toBe(CATALOGUE_FA['bot.catalog.empty']);
  });

  // -------------------------------------------------------------------------
  // Ordering
  // -------------------------------------------------------------------------

  it('turns a tap into a DRAFT and answers with the order summary', async () => {
    const sellable = await product(tenantA, 'ACTIVE');
    expect((await tap(`p:${sellable.id}`)).statusCode).toBe(201);

    const rows = await orders();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['state']).toBe('DRAFT');
    expect(rows[0]?.['line_title']).toBe('پلن پایه');
    expect(rows[0]?.['confirmed_at']).toBeNull();
    // The hold is on the DRAFT, which is what stops a quoted price being confirmed
    // a week later.
    expect(rows[0]?.['expires_at']).not.toBeNull();

    /*
     * The draft's first screen is the USERNAME question, not the summary.
     *
     * A panel that offers both ways of choosing has a question to ask, and it is asked
     * before the summary because the summary shows the name that was chosen. Asserting
     * the summary on the reply to the product tap stopped being right when the username
     * step landed; this test had not followed.
     */
    expect(String(lastMessage()?.body['text'])).toBe(CATALOGUE_FA['bot.username.choose']);
    expect(buttonsOf(lastMessage()).map((b) => b.callback_data)).toEqual([
      `j:${String(rows[0]?.['id'])}`,
      `Z:${String(rows[0]?.['id'])}`,
    ]);

    // Answer it the cheap way, and NOW the summary.
    expect((await tap(`Z:${String(rows[0]?.['id'])}`)).statusCode).toBe(201);

    // The summary, rendered from the catalogue with the ORDER's figures in it.
    const text = String(lastMessage()?.body['text']);
    expect(text).toContain('پلن پایه');
    expect(text).toContain(formatMoney(money(250_000n, 'IRT')));

    // And exactly one button, naming the ORDER rather than the product.
    const buttons = buttonsOf(lastMessage());
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.text).toBe(CATALOGUE_FA['bot.order.confirm_button']);
    expect(buttons[0]?.callback_data).toBe(`c:${String(rows[0]?.['id'])}`);

    // Nothing about payment, because nothing can take one.
    expect(text).not.toContain(CATALOGUE_FA['bot.order.awaiting_payment']);
  });

  it('stops the button spinning, AFTER the real answer', async () => {
    const sellable = await product(tenantA, 'ACTIVE');
    await tap(`p:${sellable.id}`);

    const answers = sent.filter((one) => one.url.includes('/answerCallbackQuery'));
    expect(answers).toHaveLength(1);
    expect(answers[0]?.body['callback_query_id']).toBeTypeOf('string');
    // No `text`: a toast written here would be the one customer-facing string with no
    // template key and no tenant override.
    expect(answers[0]?.body['text']).toBeUndefined();
    // The message the customer is waiting for went first.
    expect(sent.findIndex((one) => one.url.includes('/sendMessage'))).toBeLessThan(
      sent.findIndex((one) => one.url.includes('/answerCallbackQuery')),
    );
  });

  it('creates the customer from the CALLBACK sender, never from the bot beside it', async () => {
    const sellable = await product(tenantA, 'ACTIVE');
    await tap(`p:${sellable.id}`);

    const rows = (
      await api.container.database.db.execute(
        sql`SELECT telegram_user_id FROM customers ORDER BY created_at ASC`,
      )
    ).rows as Record<string, unknown>[];
    // ONE customer, and it is the human. `callback_query.message.from` is the BOT;
    // reading it would make a customer row for the bot on every single tap.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['telegram_user_id']).toBe(String(CUSTOMER_TELEGRAM_ID));
  });

  it('treats a REDELIVERED tap as a replay: one order, and the summary again', async () => {
    const sellable = await product(tenantA, 'ACTIVE');
    const id = 7001;
    await tap(`p:${sellable.id}`, { update: id });
    await tap(`p:${sellable.id}`, { update: id });

    // One order. Telegram redelivers whatever it did not see a 200 for, and a second
    // order here is a second thing the customer owes money for.
    expect(await orders()).toHaveLength(1);
    // And the customer is answered BOTH times, on purpose: `sendMessage` has no
    // idempotency key, so the choice is a duplicate summary or a missing one, and the
    // duplicate names the same order.
    expect(messages()).toHaveLength(2);
    expect(messages()[0]?.body['text']).toBe(messages()[1]?.body['text']);
  });

  // -------------------------------------------------------------------------
  // Confirmation — and the boundary
  // -------------------------------------------------------------------------

  it('confirms to AWAITING_PAYMENT, and stops there', async () => {
    const sellable = await product(tenantA, 'ACTIVE');
    await tap(`p:${sellable.id}`);
    const orderId = String((await orders())[0]?.['id']);

    expect((await tap(`c:${orderId}`)).statusCode).toBe(201);

    const rows = await orders();
    expect(rows[0]?.['state']).toBe('AWAITING_PAYMENT');
    expect(rows[0]?.['confirmed_at']).not.toBeNull();
    // The database's own constraint binds `settled_at` to PAID, so this is the schema
    // agreeing that nothing settled — not merely this test declining to look.
    expect(rows[0]?.['settled_at']).toBeNull();

    expect((await orderEvents()).map((row) => row['event_type'])).toEqual(['OrderConfirmed']);

    const text = String(lastMessage()?.body['text']);
    expect(text).toContain(formatMoney(money(250_000n, 'IRT')));

    /*
     * The two rails this installation can actually perform, the way out, and ONLY those.
     *
     * Phase 4B asserted no buttons here and said "there is nothing further a customer
     * can do in this release", which was true of 4B and is not true of 4C. The claim is
     * replaced rather than deleted: what matters now is that a gateway button is NOT
     * drawn, because there is no adapter behind it, and that each button carries the
     * order id and nothing else.
     *
     * 4H adds the third. `docs/phase4h-audit.md` §3 measured the gap it closes:
     * `ORDER_MACHINE`'s CANCEL edge was writable and had no caller, so a customer who
     * changed their mind had exactly one option — never pay — and the order sat
     * `AWAITING_PAYMENT` until a sweep expired it.
     *
     * It carries the ASK prefix (`d:`), not the destructive one (`f:`), and that is the
     * assertion rather than a detail: this message stays in the chat for ever and
     * `ORDER_MACHINE` has no edge out of CANCELLED, so a one-tap cancel reached by
     * scrolling would take the customer's quoted price with it.
     */
    const buttons = buttonsOf(lastMessage());
    expect(buttons.map((b) => b.callback_data)).toEqual([
      `w:${orderId}`,
      `m:${orderId}`,
      `d:${orderId}`,
    ]);
    expect(buttons.map((b) => b.text)).toEqual([
      CATALOGUE_FA['bot.payment.wallet_button'],
      CATALOGUE_FA['bot.payment.manual_button'],
      CATALOGUE_FA['bot.order.cancel_button'],
    ]);
  });

  it('cancels an order over the wire, and asks before it does', async () => {
    /*
     * The cancellation END TO END, through the webhook, as a customer performs it.
     *
     * This case exists because of what its absence allowed. The assertion above says
     * the cancel button is DRAWN; the first version of the handler behind it called
     * `OrderService.get`, which is the operator's read and checks `orders.view` — a
     * permission a customer-initiated turn does not hold, since
     * `SYSTEM_JOB_PERMISSIONS` is `['maintenance.run']` and nothing else. So every
     * customer who tapped it got a refusal, and nothing in the suite noticed, because
     * nothing tapped it.
     *
     * Two taps, and the FIRST must change nothing: this message stays in the chat for
     * ever and `ORDER_MACHINE` has no edge out of CANCELLED, so a one-tap cancel
     * reached by scrolling would take the customer's quoted price with it.
     */
    const sellable = await product(tenantA, 'ACTIVE');
    await tap(`p:${sellable.id}`);
    const orderId = String((await orders())[0]?.['id']);
    await tap(`c:${orderId}`);
    sent = [];

    await tap(`d:${orderId}`);

    expect((await orders())[0]?.['state'], 'the ask writes nothing').toBe('AWAITING_PAYMENT');
    expect(String(lastMessage()?.body['text'])).toBe(CATALOGUE_FA['bot.order.cancel_confirm']);
    const confirm = buttonsOf(lastMessage());
    expect(confirm.map((b) => b.callback_data)).toEqual([`f:${orderId}`]);
    sent = [];

    await tap(`f:${orderId}`);

    expect(String(lastMessage()?.body['text'])).toBe(CATALOGUE_FA['bot.order.cancelled']);
    const rows = await orders();
    expect(rows[0]?.['state']).toBe('CANCELLED');
    /*
     * And nothing was settled. `orders_settled_at_check` binds that column to PAID, so
     * this is the schema agreeing rather than the test declining to look.
     */
    expect(rows[0]?.['settled_at']).toBeNull();
  });

  it('answers a cancel tap on an order that is no longer awaiting payment', async () => {
    /*
     * The message carrying the button outlives the state it was drawn in. A customer
     * scrolling back after paying must be told what is true of the ORDER rather than
     * shown a question whose answer would be refused.
     */
    const sellable = await product(tenantA, 'ACTIVE');
    await tap(`p:${sellable.id}`);
    const orderId = String((await orders())[0]?.['id']);
    await tap(`c:${orderId}`);
    await tap(`d:${orderId}`);
    await tap(`f:${orderId}`);
    sent = [];

    await tap(`d:${orderId}`);

    expect(String(lastMessage()?.body['text'])).toBe(
      CATALOGUE_FA['bot.order.not_awaiting_payment'],
    );
    expect(buttonsOf(lastMessage())).toHaveLength(0);
  });

  it('lets a double tap of Confirm produce ONE transition and ONE event', async () => {
    const sellable = await product(tenantA, 'ACTIVE');
    await tap(`p:${sellable.id}`);
    const orderId = String((await orders())[0]?.['id']);

    // Two SEPARATE updates, not a redelivery: the customer pressed twice.
    await tap(`c:${orderId}`);
    await tap(`c:${orderId}`);

    expect((await orders())[0]?.['state']).toBe('AWAITING_PAYMENT');
    // A consumer that charged per event would otherwise charge twice.
    expect((await orderEvents()).map((row) => row['event_type'])).toEqual(['OrderConfirmed']);
  });

  // -------------------------------------------------------------------------
  // Refusals are messages, never silence
  // -------------------------------------------------------------------------

  it('tells the customer when the product was withdrawn between the list and the tap', async () => {
    const sellable = await product(tenantA, 'ACTIVE');
    await command('/catalog');
    await products.setStatus(tenantA, sellable.id, 'ACTIVE', 'INACTIVE', api.container.clock.now());

    await tap(`p:${sellable.id}`);
    expect(lastMessage()?.body['text']).toBe(CATALOGUE_FA['bot.order.unavailable']);
    expect(await orders()).toHaveLength(0);
  });

  it('refuses a reseller-only product handed to an ordinary customer by reference', async () => {
    /*
     * The catalogue never offered this button. A callback id survives a screenshot, a
     * forward and a second customer, so an exclusion that only removed the row from the
     * listing would sell reseller pricing to whoever had one.
     */
    const reseller = await product(tenantA, 'ACTIVE', { audience: 'RESELLERS_ONLY' });
    await command('/catalog');
    expect(lastMessage()?.body['text']).toBe(CATALOGUE_FA['bot.catalog.empty']);

    await tap(`p:${reseller.id}`);
    // Deliberately the SAME sentence as every other refusal: a distinct one would teach
    // a customer that a cheaper tier exists and that they are not in it.
    expect(lastMessage()?.body['text']).toBe(CATALOGUE_FA['bot.order.unavailable']);
    expect(await orders()).toHaveLength(0);
  });

  it('tells the customer when the draft outlived its own hold', async () => {
    const sellable = await product(tenantA, 'ACTIVE');
    await tap(`p:${sellable.id}`);
    const orderId = String((await orders())[0]?.['id']);
    await api.container.database.db.execute(sql`
      UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = ${orderId}`);

    await tap(`c:${orderId}`);
    // A different message from "unavailable": nobody withdrew this, the window closed,
    // and a customer told "cancelled" looks for what they did.
    expect(lastMessage()?.body['text']).toBe(CATALOGUE_FA['bot.order.expired']);
    expect((await orders())[0]?.['state']).toBe('DRAFT');
    expect(await orderEvents()).toHaveLength(0);
  });

  it('answers a BLOCKED customer with the block message and takes no order', async () => {
    const sellable = await product(tenantA, 'ACTIVE');
    await command('/start');
    await api.container.database.db.execute(sql`
      UPDATE customers SET status = 'BLOCKED', blocked_at = now()`);

    await tap(`p:${sellable.id}`);
    expect(lastMessage()?.body['text']).toBe(CATALOGUE_FA['bot.blocked']);
    expect(await orders()).toHaveLength(0);
  });

  it('refuses a callback naming ANOTHER tenant’s product, without saying it exists', async () => {
    const panelB = api.container.ids.uuid();
    await api.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelB}, ${tenantB.tenantId}, 'Panel B', 'sanaei', 'https://b.example.test', 'ACTIVE')`);
    /*
     * Made GENUINELY sellable, not left as a bare row.
     *
     * A panel with no credentials, no activation and no probe cannot create an
     * account, and since this hotfix `decideEligibility` refuses to take money
     * for one. A fixture that expects a sale therefore has to describe a panel
     * that could deliver it; `makePanelSellable` writes the three things a sale
     * now requires, using the production identity function so it cannot drift.
     */
    await makePanelSellable(api.container, tenantB, panelB);
    const theirs = await product(tenantB, 'ACTIVE', { panelId: panelB as never });

    await tap(`p:${theirs.id}`);
    // The same message a withdrawn product gets, on purpose: a distinct one would
    // answer "does this id exist in some tenant" for anybody willing to guess.
    expect(lastMessage()?.body['text']).toBe(CATALOGUE_FA['bot.order.unavailable']);
    expect(await orders()).toHaveLength(0);
  });

  it('refuses somebody else’s ORDER id the same way', async () => {
    const sellable = await product(tenantA, 'ACTIVE');
    await tap(`p:${sellable.id}`);
    const orderId = String((await orders())[0]?.['id']);

    // A second customer of the SAME tenant, tapping the first one's confirm button.
    await inject({
      method: 'POST',
      url: `/telegram/webhook/${BOT_A}`,
      headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET },
      payload: {
        update_id: (updateId += 1),
        callback_query: {
          id: 'cbq-other',
          from: { id: 5559999999, is_bot: false, first_name: 'Sara' },
          data: `c:${orderId}`,
          message: {
            message_id: 1,
            date: 0,
            chat: { id: 9999, type: 'private' },
            from: { id: 999999, is_bot: true },
          },
        },
      },
    });

    expect(lastMessage()?.body['text']).toBe(CATALOGUE_FA['bot.order.unavailable']);
    expect((await orders())[0]?.['state']).toBe('DRAFT');
  });

  it('answers malformed callback data without pretending to understand it', async () => {
    await tap('p:not-a-uuid');
    expect(lastMessage()?.body['text']).toBe(CATALOGUE_FA['bot.unknown_command']);
    expect(await orders()).toHaveLength(0);
    // Still acknowledged: the button is still spinning whatever it said.
    expect(sent.filter((one) => one.url.includes('/answerCallbackQuery'))).toHaveLength(1);
  });

  it('does not answer a catalogue request made outside a private chat', async () => {
    await product(tenantA, 'ACTIVE');
    await command('/catalog', { chatType: 'group' });
    // A catalogue posted into a group is a catalogue an operator cannot switch off, and
    // the next message in that flow would be an order summary naming one person.
    expect(messages()).toHaveLength(0);
  });
});
