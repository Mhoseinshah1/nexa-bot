import { createServer, type Server } from 'node:http';
import { sql } from 'drizzle-orm';
import {
  money,
  type ActorContext,
  type AdminId,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type PaymentId,
  type ProductCategoryId,
  type ProductId,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import type { InboundReceiptFile } from '../../apps/api/src/modules/commerce/payments/application/receipt-ports';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  makePanelSellable,
  SEED_IDS,
  tenantA,
  type TestContext,
} from './harness';

/**
 * The shared fixture of the WP10 follow-up suites: the administrators' receipt push, Block
 * User from the receipt, and the block-versus-disposition races. The same real everything
 * `telegram-admin-receipts.test.ts` uses — PostgreSQL, the services, the guard, the bot
 * runtime — and a real socket standing in for Telegram whose answer can be chosen PER CHAT,
 * so one administrator's failure can be staged beside another's success.
 */

export const BOT_A = SEED_IDS.botA1 as BotInstanceId;

export const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

export interface Sent {
  readonly method: string;
  readonly body: Record<string, unknown>;
}

export interface Button {
  readonly text: string;
  readonly callback_data?: string;
}

/** How the stand-in answers a chat: success, 5xx (UNKNOWN), 429, or a 400 refusal. */
export type ChatBehaviour = 'OK' | 'SERVER_ERROR' | 'RATE_LIMITED' | 'REFUSED' | 'REFUSE_FILE';

export interface ReceiptFixture {
  readonly ctx: TestContext;
  sent: Sent[];
  readonly behaviour: Map<string, ChatBehaviour>;
  owner: ActorContext;
  ownerId: AdminId;
  panelA: string;
  customer: UserId;
  close(): Promise<void>;
  reset(options?: { readonly ownerTelegramId?: string }): Promise<void>;
}

export async function receiptFixture(): Promise<ReceiptFixture> {
  const behaviour = new Map<string, ChatBehaviour>();
  const fixture = {
    sent: [] as Sent[],
    behaviour,
  } as unknown as ReceiptFixture & { ctx: TestContext };

  const telegram: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      const method = (request.url ?? '').split('/').pop() ?? '';
      fixture.sent.push({ method, body });
      const chat = String(body['chat_id'] ?? '');
      const mode = behaviour.get(chat) ?? 'OK';
      const isFile = method === 'sendPhoto' || method === 'sendDocument';
      const reply = (status: number, payload: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };
      if (method !== 'answerCallbackQuery') {
        if (mode === 'SERVER_ERROR') {
          return reply(502, { ok: false, error_code: 502, description: 'Bad Gateway' });
        }
        if (mode === 'RATE_LIMITED') {
          return reply(429, {
            ok: false,
            error_code: 429,
            description: 'Too Many Requests',
            parameters: { retry_after: 30 },
          });
        }
        if (mode === 'REFUSED' || (mode === 'REFUSE_FILE' && isFile)) {
          return reply(403, { ok: false, error_code: 403, description: 'Forbidden' });
        }
      }
      return reply(200, { ok: true, result: { message_id: 11 } });
    });
  });
  await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
  const address = telegram.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  const ctx = await createTestContext({
    TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
  });
  fixture.ctx = ctx;

  fixture.close = async () => {
    await ctx.close();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
  };

  fixture.reset = async (options = {}) => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    fixture.sent = [];
    behaviour.clear();
    const seededOwner = await createAdmin(ctx.container, tenantA, {
      username: 'owner-receipts',
      roleKeys: ['owner'],
    });
    fixture.owner = adminActorFor(seededOwner);
    fixture.ownerId = seededOwner.id as AdminId;
    await bind(fixture, fixture.ownerId, options.ownerTelegramId ?? TG.owner);
    fixture.panelA = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${fixture.panelA}, ${tenantA.tenantId}, 'A', 'sanaei', 'https://a.example.test', 'ACTIVE')`);
    await makePanelSellable(ctx.container, tenantA, fixture.panelA);
    fixture.customer = await customerNamed(fixture, TG.customer, 'zahra_pay');
  };

  return fixture;
}

export const TG = {
  owner: '750001',
  reviewer: '750002',
  observer: '750003',
  disabled: '750004',
  blocker: '750005',
  third: '750006',
  tenantB: '750099',
  customer: '750900',
} as const;

export function bind(f: ReceiptFixture, adminId: AdminId, telegramUserId: string) {
  return f.ctx.container.adminManagement.setTelegramBinding(tenantA, f.owner, adminId, {
    telegramUserId,
    reason: 'test binding',
  });
}

/** An administrator of tenant A with exactly these permissions, bound to this chat. */
export async function bindNewAdmin(
  f: ReceiptFixture,
  username: string,
  telegramUserId: string | null,
  permissions: readonly string[],
): Promise<AdminId> {
  const db = f.ctx.container.database.db;
  const admin = await createAdmin(f.ctx.container, tenantA, { username });
  const roleId = f.ctx.container.ids.uuid();
  await db.execute(sql`
    INSERT INTO roles (id, tenant_id, key, name, is_system)
    VALUES (${roleId}, ${tenantA.tenantId}, ${`custom_${username.replaceAll('-', '_')}`}, ${username}, false)`);
  for (const permission of permissions) {
    await db.execute(sql`
      INSERT INTO role_permissions (tenant_id, role_id, permission_key)
      VALUES (${tenantA.tenantId}, ${roleId}, ${permission})`);
  }
  await db.execute(sql`
    INSERT INTO admin_roles (tenant_id, admin_id, role_id)
    VALUES (${tenantA.tenantId}, ${admin.id}, ${roleId})`);
  if (telegramUserId !== null) await bind(f, admin.id as AdminId, telegramUserId);
  return admin.id as AdminId;
}

export async function customerNamed(
  f: ReceiptFixture,
  telegramUserId: string,
  username: string,
): Promise<UserId> {
  const { customer } = await f.ctx.container.customers.resolveFromUpdate(
    tenantA,
    systemActor(`resolve-${telegramUserId}`),
    {
      idempotencyKey: `resolve-${telegramUserId}`,
      telegramUserId,
      from: { id: Number(telegramUserId), first_name: 'زهرا', username },
      botInstanceId: BOT_A,
    },
  );
  return customer.id;
}

/** A pending manual transfer for the fixture's customer, signalled, and nothing filed yet. */
export async function signalledTransfer(f: ReceiptFixture, key: string): Promise<PaymentId> {
  const c = f.ctx.container;
  const products = new DrizzleProductRepository(c.database.db);
  const created = await products.create(tenantA, {
    id: c.ids.uuid() as ProductId,
    draft: {
      title: 'پلن پایه',
      description: null,
      audience: 'EVERYONE',
      sortOrder: 10,
      panelId: f.panelA as PanelId,
      categoryId: SEED_IDS.categoryA as ProductCategoryId,
      specification: { durationDays: 30, trafficBytes: 1n, deviceLimit: null },
      price: money(250_000n, 'IRT'),
    },
    now: c.clock.now(),
  });
  await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', c.clock.now());
  const order = await c.orders.createDraft(tenantA, systemActor(`${key}-d`), {
    idempotencyKey: `${key}-draft`,
    customerId: f.customer,
    productId: created.id,
  });
  const confirmed = await c.orders.confirm(tenantA, systemActor(`${key}-c`), {
    idempotencyKey: `${key}-confirm`,
    customerId: f.customer,
    orderId: order.id,
  });
  const issued = await c.payments.requestManualTransfer(
    tenantA,
    systemActor(`${key}-p`),
    f.customer,
    {
      idempotencyKey: `${key}-pay`,
      orderId: confirmed.id,
    },
  );
  const paymentId = issued.payment.id as PaymentId;
  await c.payments.signalTransferSent(tenantA, systemActor(`${key}-s`), f.customer, {
    idempotencyKey: `${key}-signal`,
    paymentId,
    botInstanceId: BOT_A,
  });
  return paymentId;
}

export function receiptFile(fileId: string, caption: string | null = null): InboundReceiptFile {
  return {
    kind: 'PHOTO',
    fileId,
    fileUniqueId: `unique-${fileId}`,
    mimeType: 'image/jpeg',
    fileSize: 102_400n,
    fileName: null,
    telegramMessageId: 41n,
    caption,
  };
}

/** Files one receipt through the real service, under this idempotency key. */
export function fileReceipt(
  f: ReceiptFixture,
  key: string,
  fileId: string,
  caption: string | null = null,
) {
  return f.ctx.container.receipts.submit(tenantA, systemActor(`${key}-f`), f.customer, {
    idempotencyKey: `${key}-file`,
    botInstanceId: BOT_A,
    file: receiptFile(fileId, caption),
  });
}

/** A signalled transfer with one receipt filed on it. */
export async function pendingWithReceipt(
  f: ReceiptFixture,
  key: string,
  caption: string | null = null,
): Promise<PaymentId> {
  const payment = await signalledTransfer(f, key);
  await fileReceipt(f, key, `file-${key}`, caption);
  return payment;
}

export async function rows<T>(f: ReceiptFixture, query: ReturnType<typeof sql>): Promise<T[]> {
  const result = await f.ctx.container.database.db.execute(query);
  return result.rows as T[];
}

export async function paymentState(f: ReceiptFixture, paymentId: string): Promise<string> {
  const found = await rows<{ state: string }>(
    f,
    sql`SELECT state FROM payments WHERE id = ${paymentId}`,
  );
  return found[0]?.state ?? 'MISSING';
}

export async function customerStatus(
  f: ReceiptFixture,
  customerId: string,
): Promise<{ status: string; blocked_reason: string | null }> {
  const found = await rows<{ status: string; blocked_reason: string | null }>(
    f,
    sql`SELECT status, blocked_reason FROM customers WHERE id = ${customerId}`,
  );
  return found[0] ?? { status: 'MISSING', blocked_reason: null };
}

/** Every ledger row of the payment's customer — the "no extra financial rows" measure. */
export async function ledgerCount(f: ReceiptFixture): Promise<number> {
  const found = await rows<{ n: number }>(
    f,
    sql`SELECT count(*)::int AS n FROM wallet_entries WHERE customer_id = ${f.customer}`,
  );
  return Number(found[0]?.n ?? 0);
}

export function keyboardOf(body: Record<string, unknown>): Button[] {
  const markup = body['reply_markup'] as { inline_keyboard?: Button[][] } | undefined;
  return (markup?.inline_keyboard ?? []).flat();
}

let updateSeq = 0;

const baseUpdate = (payload: Record<string, unknown>, telegramUserId: string) => {
  updateSeq += 1;
  return {
    idempotencyKey: `bot-update-wp10f-${String(updateSeq)}-${String(Date.now())}`,
    botInstanceId: BOT_A,
    update: { update_id: updateSeq, ...payload },
    telegramUserId,
    from: { id: Number(telegramUserId), first_name: 'کاربر' },
  };
};

export function tap(f: ReceiptFixture, data: string, telegramUserId: string) {
  f.sent = [];
  return f.ctx.container.botRuntime.handle(
    tenantA,
    systemActor('bot'),
    baseUpdate(
      {
        callback_query: {
          id: `cbq-${String(updateSeq)}`,
          from: { id: Number(telegramUserId), is_bot: false, first_name: 'کاربر' },
          data,
          message: {
            message_id: 1,
            date: 0,
            chat: { id: Number(telegramUserId), type: 'private' },
          },
        },
      },
      telegramUserId,
    ),
  );
}

export function say(f: ReceiptFixture, message: string, telegramUserId: string) {
  f.sent = [];
  return f.ctx.container.botRuntime.handle(
    tenantA,
    systemActor('bot'),
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
    ),
  );
}

/** A photo message from a customer, as Telegram sends one — the receipt path end to end. */
export function photoUpdate(fileId: string, telegramUserId: string, idempotencyKey?: string) {
  const update = baseUpdate(
    {
      message: {
        message_id: updateSeq,
        date: 0,
        chat: { id: Number(telegramUserId), type: 'private' },
        from: { id: Number(telegramUserId), is_bot: false, first_name: 'زهرا' },
        photo: [
          {
            file_id: fileId,
            file_unique_id: `unique-${fileId}`,
            file_size: 2048,
            width: 90,
            height: 90,
          },
        ],
      },
    },
    telegramUserId,
  );
  return idempotencyKey === undefined ? update : { ...update, idempotencyKey };
}

export const lastReply = (f: ReceiptFixture): Record<string, unknown> => {
  const replies = f.sent.filter((one) =>
    ['sendMessage', 'sendPhoto', 'sendDocument'].includes(one.method),
  );
  return replies[replies.length - 1]?.body ?? {};
};

export const lastText = (f: ReceiptFixture) =>
  String(lastReply(f)['text'] ?? lastReply(f)['caption'] ?? '');

export const lastKeyboard = (f: ReceiptFixture) => keyboardOf(lastReply(f));

/** The tenant a test addresses, named for the reader. */
export const TENANT_A: TenantContext = tenantA;
