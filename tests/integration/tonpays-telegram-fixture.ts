import { createServer, type Server } from 'node:http';
import type { TenantContext } from '@nexa/contracts';
import { DrizzleCustomerRepository } from '../../apps/api/src/modules/commerce/customers/infrastructure/drizzle-customer.repository';
import { DrizzlePaymentRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-payment.repository';
import { DrizzleGatewayInvoiceRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-gateway-invoice.repository';
import { DrizzleGatewayCardTransferRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-gateway-card-transfer.repository';
import {
  DrizzleGatewayCallBudget,
  DrizzleGatewayCredentialStore,
  DrizzlePublicOriginReader,
} from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-gateway-credentials';
import {
  TonPaysAdapter,
  type FetchLike,
} from '../../apps/api/src/modules/commerce/payments/infrastructure/tonpays-adapter';
import { TonPaysTelegramAdapter } from '../../apps/api/src/modules/commerce/payments/infrastructure/tonpays-telegram-adapter';
import {
  GatewayPaymentService,
  gatewayCallbackUrl,
  type GatewayPaymentServiceDeps,
} from '../../apps/api/src/modules/commerce/payments/application/gateway-payment.service';
import type { GatewayCallBudget } from '../../apps/api/src/modules/commerce/payments/application/gateway-invoice-ports';
import { DrizzleOperationalConditionReader } from '../../apps/api/src/modules/platform/opslog/infrastructure/drizzle-operational-event.reader';
import type { TestContext } from './harness';

/**
 * A fake TonPays CUSTOM TELEGRAM API, written from the owner's transcription of its
 * documentation (`docs/tonpays-telegram-gateway-audit.md` §2) and from nothing else. Every
 * shape it answers is the transcription's; nothing here is evidence of how the real
 * provider behaves (`OQ-WP10-01`, OQ-TPTG-16). Nothing leaves the process.
 */

export interface FakeTelegramInvoice {
  readonly invoiceId: string;
  readonly orderId: string;
  readonly amount: number;
  status: string;
  paid: unknown;
  finalAmount: number;
  cards: string[];
}

export type FakeWrite =
  'OK' | 'TIMEOUT' | 'SERVER_ERROR' | { readonly code: string; readonly status: number };

export interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export class FakeTonPaysTelegram {
  readonly invoices = new Map<string, FakeTelegramInvoice>();
  readonly creates: RecordedCall[] = [];
  readonly checks: string[] = [];
  readonly changes: RecordedCall[] = [];
  readonly receipts: RecordedCall[] = [];
  createMode: FakeWrite | 'NO_CARD' | 'TIMEOUT_AFTER_CREATING' = 'OK';
  changeMode: FakeWrite | 'NO_CARD' = 'OK';
  /** What the status check answers: the invoice (`OK`), a timeout, a 5xx or a refusal. */
  checkMode: FakeWrite = 'OK';
  /**
   * What the receipt upload answers: an acknowledgement (`receipt_received: true`), the
   * status `processing` alone, an answer with neither signal, `receipt_received` as the
   * STRING "true", or a failure.
   */
  receiptMode: FakeWrite | 'ACK' | 'PROCESSING_ONLY' | 'NO_SIGNAL' | 'STRING_TRUE' = 'ACK';
  /** Runs inside the upload, after the provider "received" it and before it answers. */
  duringReceipt: (() => Promise<void>) | null = null;
  private seq = 0;
  private cardSeq = 0;

  private nextCard(): string {
    this.cardSeq += 1;
    return `6037-9911-0000-${String(1000 + this.cardSeq)}`;
  }

  readonly fetch: FetchLike = async (url, init) => {
    const headers = init.headers as Record<string, string>;
    const method = init.method ?? 'GET';
    const body =
      init.body === undefined || init.body === null
        ? ''
        : typeof init.body === 'string'
          ? init.body
          : Buffer.from(init.body as Uint8Array).toString('latin1');
    const call: RecordedCall = { url, method, headers, body };
    const path = new URL(url).pathname;

    if (path === '/api/custom/v1/invoices/telegram/create') {
      this.creates.push(call);
      const mode = this.createMode;
      if (typeof mode === 'object') {
        return json(mode.status, { detail: { code: mode.code, message: 'refused' } });
      }
      if (mode === 'SERVER_ERROR') return json(502, { error: 'bad gateway' });
      if (mode === 'TIMEOUT') throw new Error('socket hang up');
      const request = JSON.parse(body) as Record<string, unknown>;
      this.seq += 1;
      const invoiceId = `TPT-${String(this.seq).padStart(6, '0')}`;
      const invoice: FakeTelegramInvoice = {
        invoiceId,
        orderId: String(request['order_id']),
        amount: Number(request['amount']),
        status: 'pending',
        paid: false,
        // The documented shape: TonPays' own figure may differ from the requested amount.
        finalAmount: Number(request['amount']) + 37,
        cards: mode === 'NO_CARD' ? [] : [this.nextCard()],
      };
      this.invoices.set(invoiceId, invoice);
      if (mode === 'TIMEOUT_AFTER_CREATING') throw new Error('socket hang up');
      return json(201, {
        invoice_id: invoiceId,
        order_id: invoice.orderId,
        request_amount: invoice.amount,
        final_amount: invoice.finalAmount,
        status: 'pending',
        callback_url: request['callback_url'] ?? null,
        card_number: invoice.cards.at(-1) ?? null,
        card_name: invoice.cards.length === 0 ? null : 'علی رضایی',
      });
    }

    const check = /^\/api\/custom\/v1\/invoices\/check\/([^/]+)$/u.exec(path);
    if (check !== null && method === 'GET') {
      const invoiceId = decodeURIComponent(check[1]!);
      this.checks.push(invoiceId);
      const checkMode = this.checkMode;
      if (typeof checkMode === 'object') {
        return json(checkMode.status, { detail: { code: checkMode.code, message: 'refused' } });
      }
      if (checkMode === 'SERVER_ERROR') return json(502, { error: 'bad gateway' });
      if (checkMode === 'TIMEOUT') throw new Error('socket hang up');
      const invoice = this.invoices.get(invoiceId);
      if (invoice === undefined) return json(404, { detail: { code: 'INVOICE_NOT_FOUND' } });
      return json(200, {
        invoice_id: invoice.invoiceId,
        order_id: invoice.orderId,
        request_amount: invoice.amount,
        final_amount: invoice.finalAmount,
        status: invoice.status,
        paid: invoice.paid,
      });
    }

    const change = /^\/api\/custom\/v1\/invoices\/([^/]+)\/change-card$/u.exec(path);
    if (change !== null && method === 'POST') {
      this.changes.push(call);
      const invoice = this.invoices.get(decodeURIComponent(change[1]!));
      const mode = this.changeMode;
      if (typeof mode === 'object') {
        return json(mode.status, { detail: { code: mode.code, message: 'refused' } });
      }
      if (mode === 'SERVER_ERROR') return json(503, { detail: { code: 'RATE_LIMIT_EXCEEDED' } });
      if (invoice === undefined) return json(404, { detail: { code: 'INVOICE_NOT_FOUND' } });
      const card = this.nextCard();
      invoice.cards.push(card);
      if (mode === 'TIMEOUT') throw new Error('socket hang up');
      if (mode === 'NO_CARD') return json(200, { show_change_card: true });
      return json(200, {
        card_number: card,
        card_name: 'مریم احمدی',
        show_change_card: true,
        change_card_cooldown_seconds: 60,
        change_card_exhausted: false,
      });
    }

    const receipt = /^\/api\/custom\/v1\/invoices\/([^/]+)\/receipt$/u.exec(path);
    if (receipt !== null && method === 'POST') {
      this.receipts.push(call);
      const invoice = this.invoices.get(decodeURIComponent(receipt[1]!));
      if (this.duringReceipt !== null) await this.duringReceipt();
      const mode = this.receiptMode;
      if (typeof mode === 'object') {
        return json(mode.status, { detail: { code: mode.code, message: 'refused' } });
      }
      if (mode === 'SERVER_ERROR') return json(500, { detail: { code: 'RATE_LIMIT_EXCEEDED' } });
      if (mode === 'TIMEOUT') throw new Error('socket hang up');
      if (invoice === undefined) return json(404, { detail: { code: 'INVOICE_NOT_FOUND' } });
      switch (mode) {
        case 'ACK':
          invoice.status = 'processing';
          // `paid: true` here is METADATA: the documentation says success may carry it, and
          // nothing in Nexa may settle on it.
          return json(200, { status: 'processing', paid: true, receipt_received: true });
        case 'PROCESSING_ONLY':
          invoice.status = 'processing';
          return json(200, { status: 'processing', paid: false });
        case 'NO_SIGNAL':
          return json(200, { status: 'pending', paid: false, receipt_received: false });
        case 'STRING_TRUE':
          return json(200, { status: 'pending', paid: false, receipt_received: 'true' });
        case 'OK':
          return json(200, { status: 'processing', paid: false, receipt_received: true });
      }
    }
    return json(404, { detail: { code: 'NOT_FOUND' } });
  };

  set(invoiceId: string, status: string, paid: unknown): void {
    const invoice = this.invoices.get(invoiceId);
    if (invoice === undefined) throw new Error(`no fake invoice ${invoiceId}`);
    invoice.status = status;
    invoice.paid = paid;
  }
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A JPEG's magic bytes and some content: what Telegram serves for a photo. */
export const JPEG_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(2_048, 7),
]);

/**
 * A local stand-in for Telegram: records every `sendMessage`/`editMessageText`, answers
 * `getFile` for the file ids a case registers, and serves their bytes.
 */
export async function startFakeTelegram(): Promise<{
  readonly base: string;
  readonly sent: Record<string, unknown>[];
  readonly files: Map<string, Buffer>;
  readonly downloads: string[];
  /** Every request, raw: a multipart `sendPhoto` (a delivery card) is not JSON. */
  readonly requests: { readonly url: string; readonly raw: string; readonly at: number }[];
  close(): Promise<void>;
}> {
  const sent: Record<string, unknown>[] = [];
  const requests: { url: string; raw: string; at: number }[] = [];
  const files = new Map<string, Buffer>();
  const downloads: string[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = request.url ?? '';
      const raw = Buffer.concat(chunks).toString('utf8');
      requests.push({ url, raw, at: Date.now() });
      let body: Record<string, unknown> | null;
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = null;
      }
      if (url.includes('/getFile') && body !== null) {
        const fileId = String(body['file_id']);
        if (!files.has(fileId)) {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ok: false, description: 'file not found' }));
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result: { file_path: `photos/${fileId}.jpg` } }));
        return;
      }
      const file = /\/file\/bot[^/]+\/photos\/([^/]+)\.jpg$/u.exec(url);
      if (file !== null) {
        const bytes = files.get(file[1]!);
        downloads.push(file[1]!);
        response.writeHead(bytes === undefined ? 404 : 200, { 'content-type': 'image/jpeg' });
        response.end(bytes ?? Buffer.alloc(0));
        return;
      }
      if (body !== null && (url.includes('/sendMessage') || url.includes('/editMessageText'))) {
        sent.push(body);
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, result: { message_id: 11 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  return {
    base: `http://127.0.0.1:${String(address.port)}`,
    sent,
    files,
    downloads,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/**
 * A gateway lane over the container's database: the REAL adapters with fake HTTP, the
 * container's receipt downloader (which reaches the fake Telegram above), and the container's
 * clock — which a case moves with `useClock`.
 */
export function telegramLaneWith(
  ctx: TestContext,
  fake: FakeTonPaysTelegram,
  overrides: {
    readonly budget?: GatewayCallBudget;
    readonly payments?: GatewayPaymentServiceDeps['payments'];
    readonly invoiceScreens?: GatewayPaymentServiceDeps['invoiceScreens'];
    readonly logger?: GatewayPaymentServiceDeps['logger'];
    readonly websiteFetch?: FetchLike;
    /** Wraps the lane's payment reads, so a case can act between a read and the next step. */
    readonly paymentRecords?: (
      real: DrizzlePaymentRepository,
    ) => GatewayPaymentServiceDeps['paymentRecords'];
    /** FIX10: the lane's invoice repository, so a case can make one of its calls throw. */
    readonly invoices?: (real: DrizzleGatewayInvoiceRepository) => DrizzleGatewayInvoiceRepository;
    /** FIX10: the receipt downloader, so a case can make one submission's download throw. */
    readonly receiptFiles?: GatewayPaymentServiceDeps['receiptFiles'];
  } = {},
): GatewayPaymentService {
  const db = ctx.container.database.db;
  const telegram = new TonPaysTelegramAdapter({ fetch: fake.fetch, timeoutMs: 2_000 });
  const website = new TonPaysAdapter({
    fetch:
      overrides.websiteFetch ??
      (() => Promise.reject(new Error('the website route is not dialled here'))),
  });
  const origins = new DrizzlePublicOriginReader(db);
  return new GatewayPaymentService({
    invoices:
      overrides.invoices === undefined
        ? new DrizzleGatewayInvoiceRepository(db)
        : overrides.invoices(new DrizzleGatewayInvoiceRepository(db)),
    payments: overrides.payments ?? ctx.container.payments,
    paymentRecords:
      overrides.paymentRecords === undefined
        ? new DrizzlePaymentRepository(db)
        : overrides.paymentRecords(new DrizzlePaymentRepository(db)),
    adapters: (provider) =>
      provider === 'TONPAYS_TELEGRAM' ? telegram : provider === 'TONPAYS' ? website : null,
    cardTransfer: new DrizzleGatewayCardTransferRepository(db),
    cardAdapters: (provider) => (provider === 'TONPAYS_TELEGRAM' ? telegram : null),
    receiptFiles: overrides.receiptFiles ?? {
      download: (scope, binding, options) =>
        ctx.container.receiptFiles.download(
          scope,
          { botInstanceId: binding.botInstanceId as never, fileId: binding.fileId },
          options,
        ),
    },
    credentials: new DrizzleGatewayCredentialStore(db, ctx.container.cipher, () =>
      ctx.container.ids.uuid(),
    ),
    botTokens: { tokenForBotInstance: () => Promise.resolve(null) },
    presentation: () => Promise.reject(new Error('TonPays renders no invoice text')),
    budget: overrides.budget ?? new DrizzleGatewayCallBudget(db),
    callbackUrlFor: async (scope: TenantContext, provider) =>
      gatewayCallbackUrl(await origins.originFor(scope), provider, String(scope.tenantId)),
    customers: new DrizzleCustomerRepository(db),
    conditions: new DrizzleOperationalConditionReader(db),
    scopeActivity: ctx.container.tenants,
    uow: ctx.container.uow,
    audit: ctx.container.audit,
    opsLog: ctx.container.opsLog,
    outbox: ctx.container.outbox,
    clock: ctx.container.clock,
    ids: ctx.container.ids,
    logger: overrides.logger ?? {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    ...(overrides.invoiceScreens === undefined ? {} : { invoiceScreens: overrides.invoiceScreens }),
  });
}

/**
 * Moves the CONTAINER's clock, which every service in it shares — the settlement path that
 * decides under the payment's lock included. `at(...)` pins it; `shift(ms)` moves it from the
 * real time; `restore()` puts the system clock back.
 */
export function useClock(ctx: TestContext): {
  at(date: Date): void;
  shift(ms: number): void;
  now(): Date;
  restore(): void;
} {
  const clock = ctx.container.clock as { now: () => Date };
  const original = Object.getPrototypeOf(clock).now as () => Date;
  let fixed: Date | null = null;
  let offset = 0;
  clock.now = () => (fixed === null ? new Date(Date.now() + offset) : new Date(fixed.getTime()));
  return {
    at(date) {
      fixed = date;
    },
    shift(ms) {
      fixed = null;
      offset = ms;
    },
    now: () => clock.now(),
    restore() {
      clock.now = original.bind(clock);
      delete (clock as { now?: () => Date }).now;
    },
  };
}
