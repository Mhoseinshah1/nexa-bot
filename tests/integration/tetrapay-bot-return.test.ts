import { createServer, type Server } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  TELEGRAM_SECRET_TOKEN_HEADER,
  money,
  type ActorContext,
  type CorrelationId,
  type PaymentGatewayConfig,
  type UserId,
} from '@nexa/contracts';
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
 * TetraPay's return to the bot, through the bot (Round 9 C4): the customer pays on TetraPay's
 * page and comes back through `https://t.me/<bot>?start=tp-<payment id>`. That `/start` is
 * the same question as a tap on «بررسی وضعیت»: the payment's own state, read now — never
 * anything the link says — and a payment that is not this customer's is answered as closed.
 *
 * A real API app over a real database, with a local socket standing in for Telegram. The
 * gateway lane is never run here: nothing is sent to TetraPay, and the invoice's created state
 * is written on its row as the lane would have left it.
 */

const WEBHOOK_SECRET = 'a-sufficiently-long-secret-for-the-tetrapay-return';
const BOT_A = SEED_IDS.botA1;
const CUSTOMER = 5559998801;
const STRANGER = 5559998802;
const CHAT_ID = 9191;
const TOKEN = 'q9Xk2VbR7tLmN4pA8sWcYg';

const OPEN_ROUTE: PaymentGatewayConfig = {
  displayName: null,
  instructions: null,
  minAmountMinor: 0n,
  maxAmountMinor: 0n,
  eligibility: {
    activateAfterPayments: 0,
    deactivateAfterPayments: 0,
    activateAfterAccountDays: 0,
  },
  sortOrder: 0,
  topupCashbackPercent: 0,
  allowServicePurchase: true,
  allowWalletTopup: true,
};

interface Sent {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

describe('TetraPay: /start tp-<payment> answers with the payment’s own state', () => {
  let api: ApiApp;
  let telegram: Server;
  let sent: Sent[];
  let owner: ActorContext;
  let customer: UserId;
  let updateId = 91_000;
  let seq = 0;
  const key = () => `tpr-${String((seq += 1))}`;

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

  const systemActor = (id: string): ActorContext => ({
    type: 'SYSTEM_JOB',
    id: null,
    label: 'telegram-update:test',
    surface: 'TELEGRAM',
    correlationId: id as CorrelationId,
  });

  beforeEach(async () => {
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    owner = adminActorFor(
      await createAdmin(api.container, tenantA, { username: 'owner-tpr', roleKeys: ['owner'] }),
    );
    customer = (
      await api.container.customers.resolveFromUpdate(tenantA, systemActor('resolve-tpr'), {
        idempotencyKey: 'resolve-tpr',
        telegramUserId: String(CUSTOMER),
        from: { id: CUSTOMER, first_name: 'Ali' },
        botInstanceId: BOT_A,
      })
    ).customer.id;
    await api.container.paymentGateways.configure(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'TETRAPAY',
      config: OPEN_ROUTE,
    });
    await api.container.paymentGateways.setCredential(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'TETRAPAY',
      apiKey: 'tp_live_SYNTHETIC_return_test_key',
    });
    await api.container.paymentGateways.setStatus(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'TETRAPAY',
      status: 'ACTIVE',
    });
    sent = [];
  });

  const start = (payload: string, from = CUSTOMER) => {
    const id = (updateId += 1);
    return api.app
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
            chat: { id: CHAT_ID, type: 'private' },
            from: { id: from, is_bot: false, first_name: 'Ali' },
            text: `/start ${payload}`,
          },
        },
      } as never);
  };

  const replies = () =>
    sent.filter((one) => one.url.includes('/sendMessage') || one.url.includes('/editMessageText'));
  const lastText = () => String(replies().at(-1)?.body['text'] ?? '');
  const lastButtons = () => JSON.stringify(replies().at(-1)?.body['reply_markup'] ?? {});

  async function topup(): Promise<string> {
    const k = key();
    const attempt = await api.container.payments.requestGatewayTopup(
      tenantA,
      systemActor(k),
      customer,
      {
        idempotencyKey: k,
        amount: money(10_000n, 'IRT'),
        provider: 'TETRAPAY',
      },
    );
    return attempt.payment.id;
  }

  it('a created invoice: the invoice again, with its pay link and the check button for THIS payment', async () => {
    const paymentId = await topup();
    await api.container.database.db.execute(sql`UPDATE gateway_invoices SET
        creation_state = 'CREATED', provider_invoice_id = ${TOKEN}, created_invoice_at = now(),
        invoice_url = ${`https://tetrapay.online/pay/${TOKEN}`}
      WHERE payment_id = ${paymentId}`);
    const response = await start(`tp-${paymentId}`);
    expect(response.statusCode).toBeLessThan(300);
    expect(lastText()).toContain('فاکتور پرداخت آنلاین');
    expect(lastButtons()).toContain(`https://tetrapay.online/pay/${TOKEN}`);
    expect(lastButtons()).toContain(`gc:${paymentId}`);
    // The return asked for nothing to be settled: the payment is exactly as it was.
    const [row] = (
      await api.container.database.db.execute(
        sql`SELECT state FROM payments WHERE id = ${paymentId}`,
      )
    ).rows as { state: string }[];
    expect(row?.state).toBe('PENDING');
  });

  it('an invoice still being made: the preparing screen, never a link that does not exist', async () => {
    const paymentId = await topup();
    await start(`tp-${paymentId}`);
    expect(lastText()).toContain('در حال ساخت است');
    expect(lastButtons()).not.toContain('tetrapay.online');
  });

  it('another customer’s payment is answered as closed, telling them nothing about it', async () => {
    const paymentId = await topup();
    await api.container.database.db.execute(sql`UPDATE gateway_invoices SET
        creation_state = 'CREATED', provider_invoice_id = ${TOKEN}, created_invoice_at = now(),
        invoice_url = ${`https://tetrapay.online/pay/${TOKEN}`}
      WHERE payment_id = ${paymentId}`);
    await start(`tp-${paymentId}`, STRANGER);
    expect(lastText()).toContain('دیگر قابل پرداخت نیست');
    expect(lastButtons()).not.toContain('tetrapay.online');
    expect(lastText()).not.toContain(paymentId);
  });

  it('a payload that is not tp-<uuid> is the plain /start, not a payment', async () => {
    await start('tp-not-a-uuid');
    expect(lastText()).not.toContain('دیگر قابل پرداخت نیست');
    expect(lastText()).not.toContain('فاکتور پرداخت آنلاین');
  });
});
