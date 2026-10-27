import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COMMERCE_ERROR_CODES,
  isNexaError,
  MINIAPP_ERROR_CODES,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type IdempotencyStore,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import {
  telegramCreateInvoiceLink,
  telegramSendInvoice,
} from '../../apps/api/src/infrastructure/telegram/send-message';
import {
  MiniAppStarsInvoiceService,
  type MiniAppStarsInvoiceServiceDeps,
} from '../../apps/api/src/modules/commerce/miniapp/application/miniapp-stars-invoice.service';
import type { MiniAppContext } from '../../apps/api/src/modules/commerce/miniapp/application/miniapp-session.service';
import type { StarsInvoiceLinkCreator } from '../../apps/api/src/modules/commerce/miniapp/application/ports';
import { TelegramStarsInvoiceLinkCreator } from '../../apps/api/src/modules/commerce/miniapp/infrastructure/telegram-stars-invoice-link';
import type { GatewayAttemptView } from '../../apps/api/src/modules/commerce/payments/application/gateway-payment.service';
import type { OrderRecord } from '../../apps/api/src/modules/commerce/orders/application/ports';

/**
 * R11 B5 — Telegram Stars paid inside the mini app (`openInvoice`): the link service's rules
 * over fakes, and the `createInvoiceLink` body. The end-to-end case — the link paid through
 * the bot's own webhook — is `tests/integration/miniapp-stars-invoice.test.ts`.
 */

const BOT = '01900000-0000-7000-8000-00000000a001' as BotInstanceId;
const OTHER_BOT = '01900000-0000-7000-8000-00000000a002' as BotInstanceId;
const CUSTOMER = '01900000-0000-7000-8000-0000000000c1' as UserId;
const PAYMENT = '01900000-0000-7000-8000-0000000000p1';
const ORDER = '01900000-0000-7000-8000-0000000000o1';
const PAYLOAD = 'ab'.repeat(16);
const NOW = new Date('2026-10-27T10:00:00Z');
const scope: TenantContext = { tenantId: 'tenant-a' as never, botInstanceId: BOT };
const actor: ActorContext = {
  type: 'SYSTEM_JOB',
  id: null,
  label: 'miniapp:test',
  surface: 'MINI_APP',
  correlationId: 'c-1' as CorrelationId,
};
const context = {
  scope,
  botInstanceId: BOT,
  sessionId: 's-1',
  customer: { id: CUSTOMER },
  telegramUserId: '910910',
} as unknown as MiniAppContext;

function attempt(
  overrides: {
    payment?: Record<string, unknown>;
    invoice?: Record<string, unknown>;
  } = {},
): GatewayAttemptView {
  return {
    payment: {
      id: PAYMENT,
      customerId: CUSTOMER,
      orderId: ORDER,
      method: 'GATEWAY',
      state: 'PENDING',
      expiresAt: new Date(NOW.getTime() + 60 * 60_000),
      ...overrides.payment,
    },
    invoice: {
      paymentId: PAYMENT,
      provider: 'TELEGRAM_STARS',
      providerOrderId: PAYLOAD,
      providerUnit: 'XTR',
      sentAmount: 200n,
      botInstanceId: BOT,
      ...overrides.invoice,
    },
  } as unknown as GatewayAttemptView;
}

/** The store's contract, in memory: `remember` reports a key already held. */
function memoryStore(): IdempotencyStore & { readonly rows: Map<string, unknown> } {
  const rows = new Map<string, { hash: string; result: unknown }>();
  return {
    rows: rows as Map<string, unknown>,
    async find<T>(_scope: unknown, ns: string, key: string, hash: string) {
      const row = rows.get(`${ns}|${key}`);
      if (row === undefined) return null;
      if (row.hash !== hash) throw new Error('payload mismatch');
      return { key, requestHash: hash, result: row.result as T, createdAt: NOW };
    },
    async remember(_scope: unknown, ns: string, key: string, hash: string, result: unknown) {
      if (rows.has(`${ns}|${key}`)) return false;
      rows.set(`${ns}|${key}`, { hash, result });
      return true;
    },
  } as never;
}

function setup(
  options: {
    flag?: boolean;
    route?: 'TELEGRAM_STARS' | null;
    attempt?: GatewayAttemptView | null;
    orderState?: string;
    active?: boolean;
    links?: StarsInvoiceLinkCreator;
  } = {},
) {
  let seq = 0;
  const create = vi.fn<StarsInvoiceLinkCreator['create']>(async () => ({
    outcome: 'CREATED' as const,
    link: `https://t.me/$link-${String((seq += 1))}`,
  }));
  const idempotency = memoryStore();
  const audit = { record: vi.fn(async () => undefined) };
  const routeFor = vi.fn(async () =>
    options.route === undefined ? ('TELEGRAM_STARS' as const) : options.route,
  );
  const deps: MiniAppStarsInvoiceServiceDeps = {
    features: { isEnabled: vi.fn(async () => options.flag ?? true) },
    attempts: {
      attemptFor: vi.fn(async () => (options.attempt === undefined ? attempt() : options.attempt)),
    },
    orders: {
      orderForCustomer: vi.fn(
        async () =>
          ({
            id: ORDER,
            state: options.orderState ?? 'AWAITING_PAYMENT',
            totals: { total: money(260_000n, 'IRT') },
          }) as unknown as OrderRecord,
      ),
    },
    checkout: { gatewayRouteFor: routeFor },
    links: options.links ?? { create },
    idempotency,
    scopeActivity: { scopeIsActive: async () => options.active ?? true },
    guard: {
      check: vi.fn(async () => undefined),
      denialEvent: vi.fn(),
    } as never,
    uow: { run: async (_scope: unknown, fn: (tx: unknown) => unknown) => fn({}) } as never,
    audit: audit as never,
    opsLog: { record: vi.fn(async () => undefined) } as never,
    sessions: { isLive: async () => true } as never,
    clock: { now: () => NOW },
    logger: { warn: vi.fn() },
  };
  return {
    service: new MiniAppStarsInvoiceService(deps),
    create,
    idempotency,
    audit,
    routeFor,
  };
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!isNexaError(error)) throw new Error(`expected a refusal, got ${String(error)}`);
  return error.code;
}

describe('the mini app’s Stars invoice link (R11 B5)', () => {
  it('makes ONE link per attempt: a replay is the same link and Telegram is asked once', async () => {
    const { service, create, audit } = setup();
    const first = await service.linkFor(context, actor, PAYMENT);
    const again = await service.linkFor(context, actor, PAYMENT);
    expect(first).toEqual({ paymentId: PAYMENT, invoiceLink: 'https://t.me/$link-1' });
    expect(again).toEqual(first);
    expect(create).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('asks for the attempt’s OWN payload and snapshotted Stars, with its bot, as bigint', async () => {
    const { service, create } = setup();
    await service.linkFor(context, actor, PAYMENT);
    expect(create).toHaveBeenCalledWith(scope, {
      botInstanceId: BOT,
      payload: PAYLOAD,
      stars: 200n,
    });
  });

  it('hands a concurrent loser the winner’s link, never a second one', async () => {
    const holder: { service?: MiniAppStarsInvoiceService } = {};
    // While the first ask waits on Telegram, a second ask for the same attempt wins the row.
    let inner = 0;
    const links: StarsInvoiceLinkCreator = {
      create: async () => {
        inner += 1;
        if (inner === 1) {
          await holder.service!.linkFor(context, actor, PAYMENT);
          return { outcome: 'CREATED', link: 'https://t.me/$loser' };
        }
        return { outcome: 'CREATED', link: 'https://t.me/$winner' };
      },
    };
    const { service } = setup({ links });
    holder.service = service;
    const answer = await service.linkFor(context, actor, PAYMENT);
    expect(answer.invoiceLink).toBe('https://t.me/$winner');
  });

  it('refuses with the existing route_unavailable when the bot would not offer Stars for this order now', async () => {
    const { service, create, routeFor } = setup({ route: null });
    expect(await refusal(service.linkFor(context, actor, PAYMENT))).toBe(
      MINIAPP_ERROR_CODES.MINIAPP_ROUTE_UNAVAILABLE,
    );
    // Asked with the order's frozen total and for Stars by name: the bot's own question.
    expect(routeFor).toHaveBeenCalledWith(
      scope,
      CUSTOMER,
      money(260_000n, 'IRT'),
      'TELEGRAM_STARS',
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses while the flag is off', async () => {
    const { service, create } = setup({ flag: false });
    expect(await refusal(service.linkFor(context, actor, PAYMENT))).toBe(
      MINIAPP_ERROR_CODES.MINIAPP_ROUTE_UNAVAILABLE,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses an attempt bound to another bot, a top-up, and another provider', async () => {
    for (const other of [
      attempt({ invoice: { botInstanceId: OTHER_BOT } }),
      attempt({ payment: { orderId: null } }),
      attempt({ invoice: { provider: 'TONPAYS', providerUnit: 'TON' } }),
    ]) {
      const { service, create } = setup({ attempt: other });
      expect(await refusal(service.linkFor(context, actor, PAYMENT))).toBe(
        MINIAPP_ERROR_CODES.MINIAPP_ROUTE_UNAVAILABLE,
      );
      expect(create).not.toHaveBeenCalled();
    }
  });

  it('answers another customer’s payment, or none, as not found', async () => {
    const { service } = setup({ attempt: null });
    expect(await refusal(service.linkFor(context, actor, PAYMENT))).toBe(
      MINIAPP_ERROR_CODES.MINIAPP_NOT_FOUND,
    );
  });

  it('refuses a closed or expired attempt, and an order no longer awaiting payment', async () => {
    for (const closed of [
      attempt({ payment: { state: 'CONFIRMED' } }),
      attempt({ payment: { state: 'EXPIRED' } }),
      attempt({ payment: { expiresAt: NOW } }),
    ]) {
      const { service, create } = setup({ attempt: closed });
      expect(await refusal(service.linkFor(context, actor, PAYMENT))).toBe(
        COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID,
      );
      expect(create).not.toHaveBeenCalled();
    }
    const { service, create } = setup({ orderState: 'PAID' });
    expect(await refusal(service.linkFor(context, actor, PAYMENT))).toBe(
      COMMERCE_ERROR_CODES.ORDER_STATE_INVALID,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('remembers nothing when Telegram made no link, so the next ask tries again', async () => {
    const failing = vi.fn<StarsInvoiceLinkCreator['create']>(async () => ({
      outcome: 'FAILED' as const,
      code: 'telegram.unreachable',
    }));
    const { service, idempotency } = setup({ links: { create: failing } });
    expect(await refusal(service.linkFor(context, actor, PAYMENT))).toBe(
      COMMERCE_ERROR_CODES.PAYMENT_GATEWAY_UNAVAILABLE,
    );
    expect(idempotency.rows.size).toBe(0);
  });

  it('records nothing for a scope that stopped accepting work while Telegram was asked', async () => {
    const { service, idempotency, audit } = setup({ active: false });
    expect(await refusal(service.linkFor(context, actor, PAYMENT))).toBe(
      MINIAPP_ERROR_CODES.MINIAPP_UNAVAILABLE,
    );
    expect(idempotency.rows.size).toBe(0);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('draws the in-app button only for a Stars order attempt of this bot, with the flag on', async () => {
    expect(await setup().service.offersInApp(context, attempt())).toBe(true);
    expect(await setup({ flag: false }).service.offersInApp(context, attempt())).toBe(false);
    expect(
      await setup().service.offersInApp(
        context,
        attempt({ invoice: { botInstanceId: OTHER_BOT } }),
      ),
    ).toBe(false);
    expect(
      await setup().service.offersInApp(context, attempt({ payment: { orderId: null } })),
    ).toBe(false);
    expect(await setup().service.paysInApp(scope, 'TELEGRAM_STARS')).toBe(true);
    expect(await setup().service.paysInApp(scope, 'TONPAYS')).toBe(false);
    expect(await setup({ flag: false }).service.paysInApp(scope, 'TELEGRAM_STARS')).toBe(false);
  });
});

describe('createInvoiceLink (R11 B5)', () => {
  const seen: { url: string; body: Record<string, unknown> }[] = [];
  const respond = (status: number, body: unknown) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body: string }) => {
        seen.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
        return { ok: status < 400, status, json: async () => body };
      }),
    );
  };
  afterEach(() => {
    vi.unstubAllGlobals();
    seen.length = 0;
  });
  const fields = {
    token: 'T0KEN',
    apiBaseUrl: 'https://t.invalid',
    timeoutMs: 1000,
    title: 'title',
    description: 'description',
    payload: PAYLOAD,
    priceLabel: 'label',
    stars: 81n,
  };

  it('sends the chat invoice’s body exactly, minus the chat: XTR, one price, no provider token', async () => {
    respond(200, { ok: true, result: 'https://t.me/$abc' });
    expect(await telegramCreateInvoiceLink(fields)).toEqual({
      outcome: 'SUCCEEDED',
      link: 'https://t.me/$abc',
    });
    respond(200, { ok: true, result: { message_id: 1 } });
    await telegramSendInvoice({ ...fields, chatId: '910910' });
    const [link, chat] = seen;
    expect(link!.url).toBe('https://t.invalid/botT0KEN/createInvoiceLink');
    expect(link!.body).toEqual({
      title: 'title',
      description: 'description',
      payload: PAYLOAD,
      provider_token: '',
      currency: 'XTR',
      prices: [{ label: 'label', amount: 81 }],
    });
    const { chat_id: chatId, ...rest } = chat!.body;
    expect(chatId).toBe('910910');
    expect(rest).toEqual(link!.body);
  });

  it('is not a link unless Telegram returned one', async () => {
    respond(200, { ok: true, result: true });
    expect((await telegramCreateInvoiceLink(fields)).outcome).toBe('FAILED_RETRYABLE');
    respond(400, { ok: false, error_code: 400, description: 'Bad Request' });
    expect(await telegramCreateInvoiceLink(fields)).toMatchObject({
      outcome: 'FAILED_PERMANENT',
      errorCode: 'telegram.rejected.400',
    });
  });

  it('refuses a Star amount it cannot carry, before any call', async () => {
    respond(200, { ok: true, result: 'https://t.me/$abc' });
    expect((await telegramCreateInvoiceLink({ ...fields, stars: 0n })).outcome).toBe(
      'FAILED_PERMANENT',
    );
    expect((await telegramCreateInvoiceLink({ ...fields, stars: 2n ** 60n })).outcome).toBe(
      'FAILED_PERMANENT',
    );
    expect(seen).toHaveLength(0);
  });

  it('is made with the attempt bot’s token and the tenant’s invoice texts', async () => {
    const make = vi.fn<typeof telegramCreateInvoiceLink>(async () => ({
      outcome: 'SUCCEEDED' as const,
      link: 'https://t.me/$x',
    }));
    const tokenFor = vi.fn(async () => 'BOT-TOKEN');
    const creator = new TelegramStarsInvoiceLinkCreator({
      bots: { tokenForBotInstance: tokenFor },
      presentation: async () => ({ title: 'T', description: 'D', priceLabel: 'L' }),
      apiBaseUrl: 'https://t.invalid',
      timeoutMs: 10,
      create: make,
    });
    expect(
      await creator.create(scope, { botInstanceId: BOT, payload: PAYLOAD, stars: 7n }),
    ).toEqual({ outcome: 'CREATED', link: 'https://t.me/$x' });
    expect(tokenFor).toHaveBeenCalledWith(scope, BOT);
    expect(make).toHaveBeenCalledWith({
      token: 'BOT-TOKEN',
      apiBaseUrl: 'https://t.invalid',
      timeoutMs: 10,
      title: 'T',
      description: 'D',
      priceLabel: 'L',
      payload: PAYLOAD,
      stars: 7n,
    });
    const noToken = new TelegramStarsInvoiceLinkCreator({
      bots: { tokenForBotInstance: async () => null },
      presentation: async () => ({ title: 'T', description: 'D', priceLabel: 'L' }),
      apiBaseUrl: 'https://t.invalid',
      timeoutMs: 10,
      create: make,
    });
    expect(
      await noToken.create(scope, { botInstanceId: BOT, payload: PAYLOAD, stars: 7n }),
    ).toEqual({ outcome: 'FAILED', code: 'nexa.credential_missing' });
  });
});
