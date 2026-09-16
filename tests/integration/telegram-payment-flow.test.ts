import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TELEGRAM_SECRET_TOKEN_HEADER, money, type ProductId } from '@nexa/contracts';
import { CATALOGUE_FA, formatMoney } from '@nexa/i18n';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed, SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import type { ProductDraft } from '../../apps/api/src/modules/commerce/catalog/application/ports';
import {
  adminActorFor,
  createAdmin,
  migrateOnce,
  resetDatabase,
  tenantA,
  tenantB,
  testConfig,
} from './harness';

/**
 * The customer's PAYMENT flow over Telegram, against a real socket standing in for
 * Telegram.
 *
 * Phase 4B ends at `AWAITING_PAYMENT`; this is what a customer can do there. What each
 * case defends:
 *
 *   - a callback carries an ORDER ID AND NOTHING ELSE. Every figure that decides how
 *     much money moves is re-read from the database inside the transaction that moves
 *     it. Two cases below tamper with a tap directly and require the amount and the
 *     currency to be unaffected, because "the client is not the money authority" is a
 *     claim that has to be attacked to mean anything.
 *   - a REDELIVERED tap produces one debit, one payment and one settlement. Telegram
 *     redelivers any update it did not see a 200 for, and a second debit is a customer
 *     charged twice for one order.
 *   - the reply comes AFTER the commit, and a FAILED reply does not undo the money.
 *     That is the `resolve -> commit -> reply` rule with money attached, and the case
 *     below breaks the Telegram server on purpose to prove it.
 *   - the settled message says the payment was confirmed and NOTHING about a service.
 *     Nothing in this release provisions anything.
 *   - a gateway is REFUSED, never simulated.
 */

const WEBHOOK_SECRET = 'a-sufficiently-long-secret-for-the-payment-flow';
const BOT_A = SEED_IDS.botA1;
const CUSTOMER_TELEGRAM_ID = 5559998887;
const OTHER_TELEGRAM_ID = 5551112223;
const CHAT_ID = 8484;

interface Sent {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

describe('the customer payment flow over Telegram', () => {
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
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  let updateId = 7000;

  const command = (text: string, options: { from?: number; update?: number } = {}) => {
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
          chat: { id: CHAT_ID, type: 'private' },
          from: { id: options.from ?? CUSTOMER_TELEGRAM_ID, is_bot: false, first_name: 'Ali' },
          text,
        },
      },
    });
  };

  const tap = (data: string, options: { from?: number; update?: number } = {}) => {
    const id = options.update ?? (updateId += 1);
    return inject({
      method: 'POST',
      url: `/telegram/webhook/${BOT_A}`,
      headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET },
      payload: {
        update_id: id,
        callback_query: {
          id: `cbq-${id}`,
          from: { id: options.from ?? CUSTOMER_TELEGRAM_ID, is_bot: false, first_name: 'Ali' },
          data,
          message: {
            message_id: id,
            date: 0,
            chat: { id: CHAT_ID, type: 'private' },
            from: { id: 999999, is_bot: true, first_name: 'Nexa' },
          },
        },
      },
    });
  };

  const draft = (overrides: Partial<ProductDraft> = {}): ProductDraft => ({
    title: 'پلن پایه',
    description: null,
    audience: 'EVERYONE',
    sortOrder: 10,
    panelId: panelA as never,
    specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
    price: money(250_000n, 'IRT'),
    ...overrides,
  });

  async function sellableProduct(overrides: Partial<ProductDraft> = {}) {
    const created = await products.create(tenantA, {
      id: api.container.ids.uuid() as ProductId,
      draft: draft(overrides),
      now: api.container.clock.now(),
    });
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', api.container.clock.now());
    const after = await products.findById(tenantA, created.id);
    if (after === null) throw new Error('product vanished');
    return after;
  }

  /** An order in `AWAITING_PAYMENT`, reached the way a customer reaches one. */
  async function awaitingPayment(options: { from?: number } = {}): Promise<string> {
    const product = await sellableProduct();
    await tap(`p:${product.id}`, options);
    const rows = await orders();
    const order = rows[rows.length - 1];
    const id = String(order?.['id']);
    await tap(`c:${id}`, options);
    return id;
  }

  /** An operator crediting a wallet. The ONLY way a wallet is funded in this release. */
  async function creditWallet(customerTelegramId: number, amountMinor: bigint): Promise<void> {
    const owner = adminActorFor(
      await createAdmin(api.container, tenantA, {
        username: `owner-${String(customerTelegramId)}-${String(amountMinor)}`,
        roleKeys: ['owner'],
      }),
    );
    const rows = (await api.container.database.db.execute(
      sql`SELECT id FROM customers WHERE telegram_user_id = ${String(customerTelegramId)}` as never,
    )) as unknown as { rows: { id: string }[] };
    const customerId = rows.rows[0]?.id;
    if (customerId === undefined) throw new Error('no customer to credit');
    await api.container.wallet.adjust(tenantA, owner, customerId, {
      idempotencyKey: `credit-${String(customerTelegramId)}-${String(amountMinor)}`,
      direction: 'CREDIT',
      amountMinor,
      currency: 'IRT',
      note: 'fixture',
    });
  }

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
        sql`SELECT id, state, settled_at, total_amount, currency FROM orders
            ORDER BY created_at ASC` as never,
      )
    ).rows as Record<string, unknown>[];

  const payments = async () =>
    (
      await api.container.database.db.execute(
        sql`SELECT id, state, method, amount, currency, evidence_kind, order_id
            FROM payments ORDER BY created_at ASC` as never,
      )
    ).rows as Record<string, unknown>[];

  const entries = async () =>
    (
      await api.container.database.db.execute(
        sql`SELECT direction, reason, amount, currency FROM wallet_entries
            ORDER BY created_at ASC` as never,
      )
    ).rows as Record<string, unknown>[];

  const notifications = async () =>
    (
      await api.container.database.db.execute(
        sql`SELECT kind, subject_id, state, customer_id FROM customer_notifications
            ORDER BY created_at ASC` as never,
      )
    ).rows as Record<string, unknown>[];

  /** Telegram declining to look at the message yet — a real 429, not a stubbed outcome. */
  const telegramIsRateLimiting = () => {
    reply = (_request, response) => {
      response.writeHead(429, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          ok: false,
          error_code: 429,
          description: 'Too Many Requests: retry after 3',
          parameters: { retry_after: 3 },
        }),
      );
    };
  };

  const eventTypes = async () =>
    (
      (
        await api.container.database.db.execute(
          sql`SELECT event_type FROM outbox_messages ORDER BY sequence ASC` as never,
        )
      ).rows as Record<string, unknown>[]
    ).map((row) => String(row['event_type']));

  // -------------------------------------------------------------------------
  // /wallet
  // -------------------------------------------------------------------------

  it('answers /wallet with the balance derived from the ledger', async () => {
    await command('/start');
    await creditWallet(CUSTOMER_TELEGRAM_ID, 750_000n);
    sent = [];

    await command('/wallet');

    expect(lastMessage()?.body['text']).toBe(
      CATALOGUE_FA['bot.wallet.balance'].replace('{balance}', formatMoney(money(750_000n, 'IRT'))),
    );
  });

  // -------------------------------------------------------------------------
  // The wallet settlement
  // -------------------------------------------------------------------------

  it('settles from the wallet, debits exactly the order total, and then says what follows', async () => {
    const orderId = await awaitingPayment();
    await creditWallet(CUSTOMER_TELEGRAM_ID, 1_000_000n);
    sent = [];

    expect((await tap(`w:${orderId}`)).statusCode).toBe(201);

    const order = (await orders())[0];
    expect(order?.['state']).toBe('PAID');
    expect(order?.['settled_at']).not.toBeNull();

    const payment = (await payments())[0];
    expect(payment?.['state']).toBe('CONFIRMED');
    expect(payment?.['method']).toBe('WALLET');
    expect(payment?.['evidence_kind']).toBe('WALLET_DEBIT');
    expect(String(payment?.['amount'])).toBe('250000');

    // One CREDIT from the operator, one PURCHASE debit for exactly the total.
    const ledger = await entries();
    expect(ledger).toHaveLength(2);
    expect(ledger[1]).toMatchObject({ direction: 'DEBIT', reason: 'PURCHASE' });
    expect(String(ledger[1]?.['amount'])).toBe('250000');

    /*
     * TWO messages since 4H, and keeping them apart is the point.
     *
     * The first says the money arrived and NOTHING about a service. The shipped copy
     * used to say «سرویس شما در حال آماده‌سازی است» — "your service is being prepared" —
     * when 4C provisioned nothing, and the prohibition below is kept verbatim so a
     * future re-word that folds the two facts back together fails here rather than in
     * production. It is still the right prohibition: `bot.order.settled` is also sent
     * for a RENEW, where nothing is being made.
     *
     * The second is `bot.service.provisioning`, and `docs/phase4h-audit.md` §5 is the
     * gap it closes — a customer who had paid saw the settled message and then nothing
     * at all until the subscription link arrived, however long that took.
     */
    const texts = messages().map((one) => String(one.body['text']));
    expect(texts).toEqual([
      CATALOGUE_FA['bot.order.settled'],
      CATALOGUE_FA['bot.service.provisioning'],
    ]);
    const settled = texts[0] ?? '';
    for (const claim of ['آماده‌سازی', 'سرویس شما', 'در حال ساخت']) {
      expect(
        settled,
        `the settled message claims "${claim}", which is false for a renewal`,
      ).not.toContain(claim);
    }
  });

  it('refuses a settlement the balance cannot cover, and names the SHORTFALL', async () => {
    const orderId = await awaitingPayment();
    await creditWallet(CUSTOMER_TELEGRAM_ID, 100_000n);
    sent = [];

    await tap(`w:${orderId}`);

    expect(lastMessage()?.body['text']).toBe(
      CATALOGUE_FA['bot.wallet.insufficient'].replace(
        '{shortfall}',
        formatMoney(money(150_000n, 'IRT')),
      ),
    );
    // No debit, no payment, no settlement — and NO invented top-up offered.
    expect(await entries()).toHaveLength(1);
    expect(await payments()).toHaveLength(0);
    expect((await orders())[0]?.['state']).toBe('AWAITING_PAYMENT');
    expect(buttonsOf(lastMessage())).toEqual([]);
  });

  it('treats a REDELIVERED settlement tap as a replay: one debit, one payment', async () => {
    const orderId = await awaitingPayment();
    await creditWallet(CUSTOMER_TELEGRAM_ID, 1_000_000n);
    sent = [];

    const update = (updateId += 1);
    await tap(`w:${orderId}`, { update });
    // The SAME update_id: Telegram redelivering what it did not see a 200 for.
    await tap(`w:${orderId}`, { update });

    expect(await payments()).toHaveLength(1);
    expect((await entries()).filter((e) => e['reason'] === 'PURCHASE')).toHaveLength(1);
    expect(await eventTypes()).toEqual([
      'CustomerRegistered',
      'OrderConfirmed',
      'WalletEntryRecorded',
      'PaymentConfirmed',
      'OrderSettled',
      'WalletEntryRecorded',
    ]);
    /*
     * The customer is answered BOTH times, and since 4H each answer is two messages —
     * the settlement and what follows it — so four in total.
     *
     * A replay that stayed silent would leave a customer who never saw the first reply
     * staring at nothing, for ever. The pairing is asserted rather than the count
     * alone, so a follow-up that started arriving without its subject, or a subject
     * that lost its follow-up on the replay path, fails here.
     */
    expect(messages().map((one) => String(one.body['text']))).toEqual([
      CATALOGUE_FA['bot.order.settled'],
      CATALOGUE_FA['bot.service.provisioning'],
      CATALOGUE_FA['bot.order.settled'],
      CATALOGUE_FA['bot.service.provisioning'],
    ]);
  });

  it('converges two concurrent settlement taps on ONE financial effect', async () => {
    const orderId = await awaitingPayment();
    await creditWallet(CUSTOMER_TELEGRAM_ID, 1_000_000n);
    sent = [];

    // Two SEPARATE updates: the customer pressed twice, fast.
    await Promise.allSettled([tap(`w:${orderId}`), tap(`w:${orderId}`)]);

    expect((await entries()).filter((e) => e['reason'] === 'PURCHASE')).toHaveLength(1);
    expect((await payments()).filter((p) => p['state'] === 'CONFIRMED')).toHaveLength(1);
    expect((await eventTypes()).filter((t) => t === 'OrderSettled')).toHaveLength(1);
    expect((await orders())[0]?.['state']).toBe('PAID');
  });

  it('refuses a second settlement of an order already PAID', async () => {
    const orderId = await awaitingPayment();
    await creditWallet(CUSTOMER_TELEGRAM_ID, 1_000_000n);
    await tap(`w:${orderId}`);
    sent = [];

    await tap(`w:${orderId}`);

    /*
     * About the ORDER, and not about the product.
     *
     * This asserted `bot.order.unavailable` — «این سرویس در حال حاضر قابل خرید نیست» —
     * which told a customer who had just been debited that their service could not be
     * bought. The awaiting-payment message keeps its buttons after settlement, so the
     * second tap is the ORDINARY case rather than an edge, and the sentence it gets is
     * the one thing this test is for.
     */
    expect(lastMessage()?.body['text']).toBe(CATALOGUE_FA['bot.order.not_awaiting_payment']);
    expect((await entries()).filter((e) => e['reason'] === 'PURCHASE')).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // The trust boundary
  // -------------------------------------------------------------------------

  /*
   * The two cases that attack the invariant rather than restating it.
   *
   * A callback has no field for an amount or a currency, so the attack is to put one
   * there anyway and require that it changes nothing. If a future encoding ever carried
   * a figure, these are the tests that would notice.
   */
  it('ignores an AMOUNT a tampered callback tries to carry', async () => {
    const orderId = await awaitingPayment();
    await creditWallet(CUSTOMER_TELEGRAM_ID, 1_000_000n);
    sent = [];

    await tap(`w:${orderId}:1`);

    // Not parsed as "pay 1". The id fails UUID validation at the boundary, so it is an
    // unsupported tap — and NOTHING moved.
    expect(lastMessage()?.body['text']).toBe(CATALOGUE_FA['bot.unknown_command']);
    expect(await payments()).toHaveLength(0);
    expect((await entries()).filter((e) => e['reason'] === 'PURCHASE')).toHaveLength(0);
  });

  it('charges the ORDER’s amount and currency, not any the client could name', async () => {
    const orderId = await awaitingPayment();
    await creditWallet(CUSTOMER_TELEGRAM_ID, 1_000_000n);
    sent = [];

    // A well-formed tap. The service reads the order row for every figure.
    await tap(`w:${orderId}`);

    const payment = (await payments())[0];
    const order = (await orders())[0];
    expect(String(payment?.['amount'])).toBe(String(order?.['total_amount']));
    expect(payment?.['currency']).toBe(order?.['currency']);
    // And the debit equals it too — no conversion anywhere, in either direction.
    const debit = (await entries()).find((e) => e['reason'] === 'PURCHASE');
    expect(String(debit?.['amount'])).toBe(String(order?.['total_amount']));
    expect(debit?.['currency']).toBe(order?.['currency']);
  });

  it('refuses a tap naming another customer’s order', async () => {
    const orderId = await awaitingPayment();
    // A second customer, with money of their own.
    await command('/start', { from: OTHER_TELEGRAM_ID });
    await creditWallet(OTHER_TELEGRAM_ID, 1_000_000n);
    sent = [];

    await tap(`w:${orderId}`, { from: OTHER_TELEGRAM_ID });

    // UNKNOWN, not FORBIDDEN: a distinct refusal would answer "does order X exist" for
    // anybody willing to guess ids.
    expect(lastMessage()?.body['text']).toBe(CATALOGUE_FA['bot.order.unavailable']);
    expect(await payments()).toHaveLength(0);
    expect((await entries()).filter((e) => e['reason'] === 'PURCHASE')).toHaveLength(0);
  });

  it('refuses a tap naming another TENANT’s order', async () => {
    await command('/start');
    const panelB = api.container.ids.uuid();
    await api.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelB}, ${tenantB.tenantId}, 'Panel B', 'sanaei', 'https://b.example.test', 'ACTIVE')`);
    const theirs = await products.create(tenantB, {
      id: api.container.ids.uuid() as ProductId,
      draft: { ...draft(), panelId: panelB as never },
      now: api.container.clock.now(),
    });
    const theirOrder = api.container.ids.uuid();
    await api.container.database.db.execute(sql`
      INSERT INTO orders (id, tenant_id, customer_id, state, product_id, panel_id, line_title,
                          line_duration_days, line_traffic_bytes, line_device_limit,
                          line_unit_price_amount, line_quantity, subtotal_amount, discount_amount,
                          total_amount, currency, quote, confirmed_at)
      SELECT ${theirOrder}, ${tenantB.tenantId}, c.id, 'AWAITING_PAYMENT', ${theirs.id}, ${panelB},
             'پلن', 30, 53687091200, 2, 250000, 1, 250000, 0, 250000, 'IRT',
             '{"trace":[]}'::jsonb, now()
        FROM customers c WHERE c.tenant_id = ${tenantB.tenantId} LIMIT 1`);
    await creditWallet(CUSTOMER_TELEGRAM_ID, 1_000_000n);
    sent = [];

    await tap(`w:${theirOrder}`);

    expect(lastMessage()?.body['text']).toBe(CATALOGUE_FA['bot.order.unavailable']);
    expect(await payments()).toHaveLength(0);
  });

  it('answers a STALE tap naming an order that no longer exists', async () => {
    await command('/start');
    await creditWallet(CUSTOMER_TELEGRAM_ID, 1_000_000n);
    sent = [];

    await tap(`w:${api.container.ids.uuid()}`);

    expect(lastMessage()?.body['text']).toBe(CATALOGUE_FA['bot.order.unavailable']);
    expect(await payments()).toHaveLength(0);
  });

  it('answers a MALFORMED callback id without reaching the database', async () => {
    await command('/start');
    sent = [];

    await tap('w:not-a-uuid');

    expect(lastMessage()?.body['text']).toBe(CATALOGUE_FA['bot.unknown_command']);
    expect(await payments()).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // The manual transfer
  // -------------------------------------------------------------------------

  it('creates a PENDING transfer for the order total, and quotes its reference', async () => {
    const orderId = await awaitingPayment();
    sent = [];

    await tap(`m:${orderId}`);

    const payment = (await payments())[0];
    expect(payment?.['state']).toBe('PENDING');
    expect(payment?.['method']).toBe('MANUAL_TRANSFER');
    expect(String(payment?.['amount'])).toBe('250000');
    expect(payment?.['evidence_kind']).toBeNull();

    const text = String(lastMessage()?.body['text']);
    expect(text).toContain(formatMoney(money(250_000n, 'IRT')));
    expect(text).toContain(String(payment?.['reference'] ?? ''));

    // The wallet is untouched and the order is unsettled. Money arrived nowhere yet.
    expect(await entries()).toHaveLength(0);
    expect((await orders())[0]?.['state']).toBe('AWAITING_PAYMENT');
  });

  it('treats a REDELIVERED transfer tap as a replay: one pending payment', async () => {
    const orderId = await awaitingPayment();
    sent = [];

    const update = (updateId += 1);
    await tap(`m:${orderId}`, { update });
    await tap(`m:${orderId}`, { update });

    expect(await payments()).toHaveLength(1);
    expect(messages()).toHaveLength(2);
  });

  it('offers a way out with the instructions, and withdrawing closes the payment', async () => {
    const orderId = await awaitingPayment();
    sent = [];

    await tap(`m:${orderId}`);
    const payment = (await payments())[0];

    /*
     * The button is ON the instructions message, not somewhere else. That placement is
     * the rule: the message that creates the obligation carries the way out of it, and
     * the customer who is looking at a reference they are not going to use does not
     * have to go and find a menu.
     */
    const keyboard = lastMessage()?.body['reply_markup'] as
      { inline_keyboard: { text: string; callback_data: string }[][] } | undefined;
    const buttons = (keyboard?.inline_keyboard ?? []).flat();
    /*
     * TWO buttons since 4H, and their ORDER is the assertion.
     *
     * `docs/phase4h-audit.md` §4: the instructions used to end «سپس رسید را ارسال
     * نمایید» — send the receipt — and no surface in this product accepts one (owner
     * revision 17), so a customer who had transferred the money had nothing to do and
     * `bot.payment.received_for_review` was a frozen sentence with no producer.
     *
     * The claim comes FIRST and the withdrawal second. It is what most customers
     * returning to this message want, and the destructive one should not be the nearest
     * thumb.
     */
    expect(buttons).toHaveLength(2);
    expect(buttons.map((b) => b.callback_data)).toEqual([
      `i:${String(payment?.['id'])}`,
      `x:${String(payment?.['id'])}`,
    ]);
    // Both name the PAYMENT, not the order — the only id that identifies what either
    // one is about, since an order can have had several payments over its life.
    const cancelButton = buttons[1];

    /*
     * The first tap ASKS. It must not close anything: this message stays in the chat
     * for ever, and a customer who has already transferred the money is one mis-touch
     * away from closing the payment it was against — permanently, since there is no
     * edge out of CANCELLED. The service TERMINATE flow is two taps for the same
     * reason and this follows it.
     */
    sent = [];
    await tap(String(cancelButton?.callback_data));

    expect((await payments())[0]?.['state']).toBe('PENDING');
    const question = lastMessage()?.body['reply_markup'] as
      { inline_keyboard: { text: string; callback_data: string }[][] } | undefined;
    const confirm = (question?.inline_keyboard ?? []).flat();
    expect(String(lastMessage()?.body['text'])).toContain('برگشت‌پذیر نیست');
    expect(confirm[0]?.callback_data).toBe(`z:${String(payment?.['id'])}`);

    sent = [];
    await tap(String(confirm[0]?.callback_data));

    expect((await payments())[0]?.['state']).toBe('CANCELLED');
    // The ORDER is still open, which is what the reply says too.
    expect((await orders())[0]?.['state']).toBe('AWAITING_PAYMENT');
    expect(String(lastMessage()?.body['text'])).toContain('پرداخت شما لغو شد');
  });

  it('answers a second tap on a withdrawn payment without withdrawing anything else', async () => {
    const orderId = await awaitingPayment();
    await tap(`m:${orderId}`);
    const payment = (await payments())[0];
    await tap(`x:${String(payment?.['id'])}`);
    await tap(`z:${String(payment?.['id'])}`);
    sent = [];

    // The message lives in the chat for ever. A tap on it a week later must not read as
    // a fault in the product, and must not produce a second anything. The ASK answers
    // `bot.payment.not_pending` rather than offering a question about a closed payment.
    await tap(`x:${String(payment?.['id'])}`);
    expect(String(lastMessage()?.body['text'])).toContain('در انتظار نیست');

    sent = [];
    await tap(`z:${String(payment?.['id'])}`);

    expect(await payments()).toHaveLength(1);
    expect((await payments())[0]?.['state']).toBe('CANCELLED');
  });

  it('refuses a withdrawal naming another customer\u2019s payment', async () => {
    const orderId = await awaitingPayment();
    await tap(`m:${orderId}`);
    const payment = (await payments())[0];
    sent = [];

    // A different Telegram user, which resolves to a different customer. Both taps are
    // driven: the ASK must not even show them the question, and the destructive prefix
    // must refuse if they reach it by typing it.
    await tap(`x:${String(payment?.['id'])}`, { from: 900_999 });
    expect(String(lastMessage()?.body['text'])).toContain('در انتظار نیست');

    await tap(`z:${String(payment?.['id'])}`, { from: 900_999 });
    expect((await payments())[0]?.['state']).toBe('PENDING');
  });

  it('settles only when an operator confirms, and the wallet stays untouched', async () => {
    const orderId = await awaitingPayment();
    await tap(`m:${orderId}`);
    const pending = (await payments())[0];
    const reviewer = adminActorFor(
      await createAdmin(api.container, tenantA, {
        username: 'finance-telegram',
        roleKeys: ['finance'],
      }),
    );

    const { order } = await api.container.payments.confirmManualTransfer(
      tenantA,
      reviewer,
      String(pending?.['id']),
      { idempotencyKey: 'confirm-telegram-0001', note: 'کارت به کارت' },
    );

    expect(order?.state).toBe('PAID');
    expect(await entries()).toHaveLength(0);
    expect((await payments())[0]?.['evidence_kind']).toBe('OPERATOR_REVIEW');
  });

  // -------------------------------------------------------------------------
  // The gateway, and the blocked customer
  // -------------------------------------------------------------------------

  it('never offers a gateway, and refuses one tapped from an older message', async () => {
    const orderId = await awaitingPayment();

    /*
     * Not drawn: the choice offers only what this installation can perform.
     *
     * The third entry is 4H's cancel-order ASK, not a payment rail — asserted here
     * rather than filtered out, so that a gateway button appearing would not be hidden
     * by a test that had learnt to expect "some extra buttons".
     */
    const buttons = buttonsOf(lastMessage());
    expect(buttons.map((b) => b.callback_data)).toEqual([
      `w:${orderId}`,
      `m:${orderId}`,
      `d:${orderId}`,
    ]);
    sent = [];

    await tap(`g:${orderId}`);

    // Named, not simulated and not answered as an unknown command.
    expect(lastMessage()?.body['text']).toBe(CATALOGUE_FA['bot.payment.unconfigured']);
    expect(await payments()).toHaveLength(0);
    expect(await entries()).toHaveLength(0);
  });

  it('lets a BLOCKED customer move no money at all', async () => {
    const orderId = await awaitingPayment();
    await creditWallet(CUSTOMER_TELEGRAM_ID, 1_000_000n);
    await api.container.database.db.execute(
      sql`UPDATE customers SET status = 'BLOCKED', blocked_at = now()
          WHERE telegram_user_id = ${String(CUSTOMER_TELEGRAM_ID)}` as never,
    );
    sent = [];

    await tap(`w:${orderId}`);
    await tap(`m:${orderId}`);

    expect(lastMessage()?.body['text']).toBe(CATALOGUE_FA['bot.blocked']);
    expect(await payments()).toHaveLength(0);
    expect((await entries()).filter((e) => e['reason'] === 'PURCHASE')).toHaveLength(0);
    expect((await orders())[0]?.['state']).toBe('AWAITING_PAYMENT');
  });

  // -------------------------------------------------------------------------
  // Commit, then reply
  // -------------------------------------------------------------------------

  /*
   * The money commits BEFORE the reply, and a failed reply does not undo it.
   *
   * Telegram is broken on purpose for the whole turn. If the send were inside the
   * financial transaction — or if a send failure threw — the debit would roll back and
   * the customer would have an unpaid order and no message. Instead the money is
   * committed, the reply is lost, and the webhook still answers 2xx so Telegram's
   * redelivery is a replay rather than an unbounded retry loop.
   */
  it('commits the money before replying, and a FAILED reply does not undo it', async () => {
    const orderId = await awaitingPayment();
    await creditWallet(CUSTOMER_TELEGRAM_ID, 1_000_000n);
    sent = [];
    reply = (_request, response) => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, description: 'Internal Server Error' }));
    };

    const response = await tap(`w:${orderId}`);

    // The turn did not fail.
    expect(response.statusCode).toBe(201);
    // The send was attempted and refused.
    expect(messages()).toHaveLength(1);
    // And the money is committed anyway.
    expect((await orders())[0]?.['state']).toBe('PAID');
    expect((await entries()).filter((e) => e['reason'] === 'PURCHASE')).toHaveLength(1);
    expect((await payments())[0]?.['state']).toBe('CONFIRMED');
  });

  // -------------------------------------------------------------------------
  // The persistent main menu
  // -------------------------------------------------------------------------

  it('answers a main-menu tap exactly as it answers the slash command', async () => {
    /*
     * The equivalence real v0.2.0 staging acceptance asked for, proved end to end
     * through the real webhook, the real runtime and the real socket rather than
     * against `intentOf` alone: a tap is ORDINARY TEXT, and what must match is the
     * message the customer ends up reading.
     *
     * `/wallet` is the pair driven here because its answer contains a figure derived
     * from the ledger — so an assertion that the two texts are equal is an assertion
     * that the same application path produced both, not merely that both replied.
     */
    // The customer row first: every other case here reaches one through a tap, and a
    // wallet cannot be credited for somebody the bot has never met.
    await command('/start');
    await creditWallet(CUSTOMER_TELEGRAM_ID, 500_000n);

    sent = [];
    await command('/wallet');
    const viaCommand = String(lastMessage()?.body['text']);

    sent = [];
    await command(CATALOGUE_FA['bot.menu.wallet']);
    const viaMenu = String(lastMessage()?.body['text']);

    expect(viaMenu, 'the menu button reached a different path').toBe(viaCommand);
    expect(viaMenu).toContain(formatMoney(money(500_000n, 'IRT')));
  });

  it('answers the catalogue button with the catalogue, and its buttons still work', async () => {
    // The other half of the requirement: the menu is navigation and the CONTEXTUAL
    // actions stay on `callback_data`. So the tap must produce the same inline keyboard
    // the command produces, and a tap on one of those must still buy.
    const product = await sellableProduct();
    sent = [];

    await command(CATALOGUE_FA['bot.menu.catalog']);

    const buttons = buttonsOf(lastMessage());
    expect(buttons.map((b) => b.callback_data)).toContain(`p:${product.id}`);

    sent = [];
    await tap(`p:${product.id}`);
    const rows = await orders();
    expect(rows, 'the inline flow stopped working under the reply keyboard').toHaveLength(1);
  });

  it('answers an unknown message as an unknown command, menu or no menu', async () => {
    sent = [];
    await command('چطور می‌توانم اشتراک بخرم؟');
    expect(String(lastMessage()?.body['text'])).toBe(CATALOGUE_FA['bot.unknown_command']);
  });

  // -------------------------------------------------------------------------
  // A reply lost to a rate limit
  // -------------------------------------------------------------------------

  /*
   * `OQ-4H-01`, closed here.
   *
   * The turn commits its durable write and then answers Telegram. A 429 between the two
   * loses the answer for good: Telegram does not redeliver an update it accepted, and
   * nothing rescheduled the reply. The customer is left believing nothing happened —
   * which, for a transfer they have just claimed to have sent, means sending it again.
   *
   * The fix is one line at the send site, and the tests below are what stop it becoming
   * a general "send this customer some text": a fact about an entity falls back to the
   * lane, a RENDER does not, and an UNKNOWN outcome never does.
   */

  it('puts a rate-limited transfer CLAIM on the notification lane', async () => {
    const orderId = await awaitingPayment();
    await tap(`m:${orderId}`);
    const payment = (await payments())[0];
    const paymentId = String(payment?.['id']);
    sent = [];
    telegramIsRateLimiting();

    const response = await tap(`i:${paymentId}`);

    // The turn did not fail, and the claim is on record — the durable write committed
    // before the send, which is the ordering that creates this window in the first place.
    expect(response.statusCode).toBe(201);
    expect(messages(), 'the reply was attempted').toHaveLength(1);
    const claimed = (
      await api.container.database.db.execute(
        sql`SELECT customer_signalled_at FROM payments WHERE id = ${paymentId}` as never,
      )
    ).rows as Record<string, unknown>[];
    expect(claimed[0]?.['customer_signalled_at']).not.toBeNull();

    const queued = await notifications();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.['kind']).toBe('PAYMENT_TRANSFER_RECORDED');
    // The PAYMENT, not the order. The kind decides which table `subject_id` names.
    expect(String(queued[0]?.['subject_id'])).toBe(paymentId);
    expect(queued[0]?.['state']).toBe('PENDING');
  });

  it('puts a rate-limited order CANCELLATION on the notification lane', async () => {
    const orderId = await awaitingPayment();
    sent = [];
    telegramIsRateLimiting();

    await tap(`f:${orderId}`);

    expect((await orders())[0]?.['state']).toBe('CANCELLED');
    const queued = await notifications();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.['kind']).toBe('ORDER_CANCELLED');
    expect(String(queued[0]?.['subject_id'])).toBe(orderId);
  });

  it('queues NOTHING for a rate-limited reply that only renders state', async () => {
    /*
     * The line that keeps the lane from becoming a message queue.
     *
     * `m:` writes a PENDING payment and its reply is the bank details and the reference
     * — state, not a fact about an entity, and reproduced in full by the customer's next
     * tap on the same button. Putting it on the lane would need a parameterised payload
     * (which bank, which reference), and `ADR 0030` §1 refuses one; the kinds would stop
     * being a closed set of facts and become "send this customer some text".
     *
     * `/wallet` is the same case with no write at all. Both are driven, because a
     * fallback added to `PendingReply` without this rule would quietly grow to cover
     * every reply that felt important.
     */
    const orderId = await awaitingPayment();
    sent = [];
    telegramIsRateLimiting();

    await tap(`m:${orderId}`);
    await command('/wallet');

    expect(messages(), 'both replies were attempted').toHaveLength(2);
    expect((await payments())[0]?.['state'], 'the write still committed').toBe('PENDING');
    expect(await notifications()).toHaveLength(0);
  });

  it('queues nothing when the outcome is UNKNOWN, because the reply may have arrived', async () => {
    /*
     * The narrowness is the design. A 5xx is `UNKNOWN`: Telegram may have processed the
     * send. Queueing a second copy of a message that probably arrived is the mistake the
     * lane's own `UNCONFIRMED` state exists to avoid — a customer reading two answers and
     * wondering which is true — committed one layer up.
     */
    const orderId = await awaitingPayment();
    await tap(`m:${orderId}`);
    const payment = (await payments())[0];
    sent = [];
    reply = (_request, response) => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, description: 'Internal Server Error' }));
    };

    await tap(`i:${String(payment?.['id'])}`);

    const claimed = (
      await api.container.database.db.execute(
        sql`SELECT customer_signalled_at FROM payments WHERE id = ${String(payment?.['id'])}` as never,
      )
    ).rows as Record<string, unknown>[];
    expect(claimed[0]?.['customer_signalled_at'], 'the claim committed').not.toBeNull();
    expect(await notifications()).toHaveLength(0);
  });

  it('tells a customer once however many rate-limited taps they make', async () => {
    /*
     * `customer_notifications_subject_key` is `(tenant, kind, subject)`, so the second
     * enqueue loses on the constraint rather than on a check in the surface. A customer
     * tapping a button that appears to have done nothing taps it again, which is exactly
     * the behaviour a rate limit produces.
     */
    const orderId = await awaitingPayment();
    await tap(`m:${orderId}`);
    const payment = (await payments())[0];
    sent = [];
    telegramIsRateLimiting();

    await tap(`i:${String(payment?.['id'])}`);
    await tap(`i:${String(payment?.['id'])}`);

    expect(messages(), 'both taps were answered').toHaveLength(2);
    expect(await notifications()).toHaveLength(1);
  });

  it('never queues a fallback for a customer whose reply went out', async () => {
    // The whole mechanism is conditional on the 429. A DELIVERED reply needs nothing,
    // and a lane row for one is a second copy of a message the customer already read.
    const orderId = await awaitingPayment();
    await tap(`m:${orderId}`);
    const payment = (await payments())[0];
    sent = [];

    await tap(`i:${String(payment?.['id'])}`);

    expect(messages()).toHaveLength(1);
    expect(await notifications()).toHaveLength(0);
  });
});
