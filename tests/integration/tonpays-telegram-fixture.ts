import { createServer, type Server } from 'node:http';
import type { TenantContext } from '@nexa/contracts';
import { DrizzleCustomerRepository } from '../../apps/api/src/modules/commerce/customers/infrastructure/drizzle-customer.repository';
import { DrizzlePaymentRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-payment.repository';
import { DrizzleGatewayInvoiceRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-gateway-invoice.repository';
import { DrizzleGatewayProviderRequestRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-gateway-provider-request.repository';
import { SecretCipherRefundCardSealer } from '../../apps/api/src/modules/commerce/payments/infrastructure/refund-card-sealer';
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
import type { TonPaysRateLimiter } from '../../apps/api/src/modules/commerce/payments/infrastructure/tonpays-rate-limiter';
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
  /** The buyer this invoice was created for (`buyer_chat_id`), for the one-open-invoice rule. */
  buyer: number;
  /** The document's `action_required_*` fields (page 17), as the inquiry answers them. */
  remainingAmount: number | null;
  remainingInvoiceId: string | null;
  remainingCardNumber: string | null;
  remainingCardHolder: string | null;
  remainingReceiptReceived: boolean;
  refundAmount: number | null;
  refundPending: boolean;
  rejectReasons: unknown[];
}

export type FakeWrite =
  | 'OK'
  | 'TIMEOUT'
  | 'SERVER_ERROR'
  | {
      readonly code: string;
      readonly status: number;
      /** R11 A8: a `Retry-After` header on the answer (only `/cancel` sends it). */
      readonly retryAfter?: string;
    };

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
  readonly cancels: RecordedCall[] = [];
  readonly refunds: RecordedCall[] = [];
  /**
   * The document's one-open-invoice rule (`BUYER_HAS_*`, page 20). Off by default: most cases
   * here create several attempts for one buyer and are not about that rule.
   */
  enforceOneOpenInvoice = false;
  /** What `/cancel` answers: success, or a failure / documented refusal. */
  cancelMode: FakeWrite = 'OK';
  /** What `/refund` answers: the document's success body, or a failure / documented refusal. */
  refundMode: FakeWrite = 'OK';
  createMode: FakeWrite | 'NO_CARD' | 'TIMEOUT_AFTER_CREATING' = 'OK';
  changeMode: FakeWrite | 'NO_CARD' = 'OK';
  /** R6 item 2: when set, a card change answers with this new exact amount (`final_amount`). */
  changeFinalAmount: number | null = null;
  /**
   * R8 A1: TonPays' own exact figure for a create, from the requested amount. Unset, the
   * requested amount plus 37 (a unique tail).
   */
  createFinalAmount: ((requested: number) => number) | null = null;
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
      /*
       * The document's one-open-invoice rule: a buyer with an invoice that is not final is
       * refused with the code naming that invoice's state (`BUYER_HAS_*`, page 20).
       */
      const open = (this.enforceOneOpenInvoice ? [...this.invoices.values()] : []).find(
        (one) =>
          one.buyer === Number(request['buyer_chat_id']) &&
          ['pending', 'processing', 'action_required_less', 'action_required_more'].includes(
            one.status,
          ),
      );
      if (open !== undefined) {
        const code = {
          pending: 'BUYER_HAS_PENDING_INVOICE',
          processing: 'BUYER_HAS_PROCESSING_INVOICE',
          action_required_less: 'BUYER_HAS_NEED_ACTION_LESS',
          action_required_more: 'BUYER_HAS_NEED_ACTION_MORE',
        }[open.status]!;
        return json(409, { detail: { code, message: 'buyer has an open invoice' } });
      }
      this.seq += 1;
      const invoiceId = `TPT-${String(this.seq).padStart(6, '0')}`;
      const invoice: FakeTelegramInvoice = {
        invoiceId,
        orderId: String(request['order_id']),
        amount: Number(request['amount']),
        status: 'pending',
        paid: false,
        // The documented shape: TonPays' own figure may differ from the requested amount.
        finalAmount:
          this.createFinalAmount?.(Number(request['amount'])) ?? Number(request['amount']) + 37,
        cards: mode === 'NO_CARD' ? [] : [this.nextCard()],
        buyer: Number(request['buyer_chat_id']),
        remainingAmount: null,
        remainingInvoiceId: null,
        remainingCardNumber: null,
        remainingCardHolder: null,
        remainingReceiptReceived: false,
        refundAmount: null,
        refundPending: false,
        rejectReasons: [],
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
      // The document's inquiry answer (page 14 / 17), every field it lists.
      return json(200, {
        invoice_id: invoice.invoiceId,
        order_id: invoice.orderId,
        request_amount: invoice.amount,
        final_amount: invoice.finalAmount,
        status: invoice.status,
        paid: invoice.paid,
        buyer_username: null,
        show_change_card: false,
        change_card_cooldown_seconds: 0,
        change_card_exhausted: false,
        status_label: invoice.status,
        need_action_kind:
          invoice.status === 'action_required_less'
            ? 'less'
            : invoice.status === 'action_required_more'
              ? 'more'
              : null,
        remaining_amount: invoice.remainingAmount,
        remaining_invoice_id: invoice.remainingInvoiceId,
        remaining_card_number: invoice.remainingCardNumber,
        remaining_card_holder: invoice.remainingCardHolder,
        remaining_receipt_received: invoice.remainingReceiptReceived,
        refund_amount: invoice.refundAmount,
        reject_reasons: invoice.rejectReasons,
        refund_pending: invoice.refundPending,
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
      if (this.changeFinalAmount !== null) invoice.finalAmount = this.changeFinalAmount;
      if (mode === 'TIMEOUT') throw new Error('socket hang up');
      if (mode === 'NO_CARD') return json(200, { show_change_card: true });
      return json(200, {
        card_number: card,
        card_name: 'مریم احمدی',
        ...(this.changeFinalAmount === null ? {} : { final_amount: this.changeFinalAmount }),
        show_change_card: true,
        change_card_cooldown_seconds: 60,
        change_card_exhausted: false,
      });
    }

    const receipt = /^\/api\/custom\/v1\/invoices\/([^/]+)\/receipt$/u.exec(path);
    if (receipt !== null && method === 'POST') {
      this.receipts.push(call);
      const target = decodeURIComponent(receipt[1]!);
      const invoice =
        this.invoices.get(target) ??
        [...this.invoices.values()].find((one) => one.remainingInvoiceId === target);
      if (this.duringReceipt !== null) await this.duringReceipt();
      // Page 18: a receipt for the remainder answers `processing` on the REMAINDER invoice, and
      // the original stays `action_required_less` with `remaining_receipt_received: true`.
      if (invoice !== undefined && invoice.remainingInvoiceId === target) {
        invoice.remainingReceiptReceived = true;
        return json(200, {
          invoice_id: target,
          order_id: '',
          request_amount: invoice.remainingAmount,
          final_amount: invoice.remainingAmount,
          status: 'processing',
          paid: false,
          receipt_received: true,
        });
      }
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
    const cancel = /^\/api\/custom\/v1\/invoices\/([^/]+)\/cancel$/u.exec(path);
    if (cancel !== null && method === 'POST') {
      this.cancels.push(call);
      const invoice = this.invoices.get(decodeURIComponent(cancel[1]!));
      const mode = this.cancelMode;
      if (typeof mode === 'object') {
        const answer = json(mode.status, { detail: { code: mode.code, message: 'refused' } });
        if (mode.retryAfter !== undefined) answer.headers.set('retry-after', mode.retryAfter);
        return answer;
      }
      if (mode === 'SERVER_ERROR') return json(502, { error: 'bad gateway' });
      if (mode === 'TIMEOUT') throw new Error('socket hang up');
      if (invoice === undefined) return json(404, { detail: { code: 'INVOICE_NOT_FOUND' } });
      // Only a `pending` invoice can be cancelled (page 15).
      const refusal = {
        processing: 'CANCEL_NOT_ALLOWED_PROCESSING',
        action_required_less: 'CANCEL_NOT_ALLOWED_NEED_ACTION_LESS',
        action_required_more: 'CANCEL_NOT_ALLOWED_NEED_ACTION_MORE',
      }[invoice.status];
      if (refusal !== undefined) return json(409, { detail: { code: refusal, message: 'no' } });
      if (invoice.status !== 'pending') {
        return json(409, { detail: { code: 'NOT_PENDING', message: 'no' } });
      }
      invoice.status = 'canceled';
      return json(200, { invoice_id: invoice.invoiceId, status: 'canceled', paid: false });
    }

    const refund = /^\/api\/custom\/v1\/invoices\/([^/]+)\/refund$/u.exec(path);
    if (refund !== null && method === 'POST') {
      this.refunds.push(call);
      const invoice = this.invoices.get(decodeURIComponent(refund[1]!));
      const mode = this.refundMode;
      if (typeof mode === 'object') {
        return json(mode.status, { detail: { code: mode.code, message: 'refused' } });
      }
      if (mode === 'SERVER_ERROR') return json(502, { error: 'bad gateway' });
      if (mode === 'TIMEOUT') throw new Error('socket hang up');
      if (invoice === undefined) return json(404, { detail: { code: 'INVOICE_NOT_FOUND' } });
      const request = JSON.parse(body) as Record<string, unknown>;
      if (request['invoice_id'] !== invoice.invoiceId) {
        return json(400, { detail: { code: 'INVOICE_ID_MISMATCH', message: 'no' } });
      }
      if (invoice.status !== 'action_required_more') {
        return json(409, { detail: { code: 'REFUND_NOT_ALLOWED', message: 'no' } });
      }
      if (invoice.refundPending) {
        return json(409, { detail: { code: 'REFUND_ALREADY_OPEN', message: 'no' } });
      }
      invoice.refundPending = true;
      // The document's refund answer (page 16): `completed` and `paid: true` — which is
      // metadata. The invoice's own status moves only when the provider's check says so.
      return json(200, {
        invoice_id: invoice.invoiceId,
        order_id: invoice.orderId,
        status: 'completed',
        paid: true,
        status_label: 'Approved',
        need_action_kind: null,
        refund_amount: invoice.refundAmount,
        refund_pending: true,
      });
    }
    return json(404, { detail: { code: 'NOT_FOUND' } });
  };

  /** The provider finds the transfer SHORT: the document's `action_required_less` (page 17). */
  underpay(invoiceId: string, remaining: number): void {
    const invoice = this.invoices.get(invoiceId);
    if (invoice === undefined) throw new Error(`no fake invoice ${invoiceId}`);
    invoice.status = 'action_required_less';
    invoice.paid = false;
    invoice.remainingAmount = remaining;
    invoice.remainingInvoiceId = 'TP-REM123XYZ0';
    invoice.remainingCardNumber = '6219861012345678';
    invoice.remainingCardHolder = 'Shop Card';
    invoice.remainingReceiptReceived = false;
  }

  /** The provider finds the transfer OVER: the document's `action_required_more` (page 17). */
  overpay(invoiceId: string, refund: number): void {
    const invoice = this.invoices.get(invoiceId);
    if (invoice === undefined) throw new Error(`no fake invoice ${invoiceId}`);
    invoice.status = 'action_required_more';
    invoice.paid = false;
    invoice.refundAmount = refund;
    invoice.refundPending = false;
  }

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
  let nextMessageId = 700_000;
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
      /*
       * R9 C1: a NEW message gets its own id (as Telegram's would), recorded on the body as
       * `sentMessageId`, so a test can tap the message the worker sent. An edit answers 11.
       */
      const fresh = url.includes('/sendMessage');
      const messageId = fresh ? (nextMessageId += 1) : 11;
      if (body !== null && (fresh || url.includes('/editMessageText'))) {
        sent.push(fresh ? { ...body, sentMessageId: messageId } : body);
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, result: { message_id: messageId } }));
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
    /**
     * Round 6: the lane's cancel/refund machinery. Absent, the lane has none — as every case
     * written before it assumes (a second attempt for a customer would otherwise cancel the
     * first). `true` is the production lane; a function wraps the repository so a case can
     * stage a race.
     */
    readonly providerRequests?:
      | true
      | ((
          real: DrizzleGatewayProviderRequestRepository,
        ) => DrizzleGatewayProviderRequestRepository);
    /** R5A item 4: the late-credit collaborator the production lane is given; absent, none. */
    readonly lateCredit?: GatewayPaymentServiceDeps['lateCredit'];
    /** R11 A8: the per-key TonPays limiter the production adapters share; absent, none. */
    readonly limiter?: TonPaysRateLimiter;
  } = {},
): GatewayPaymentService {
  const db = ctx.container.database.db;
  const telegram = new TonPaysTelegramAdapter({
    fetch: fake.fetch,
    timeoutMs: 2_000,
    ...(overrides.limiter === undefined ? {} : { limiter: overrides.limiter }),
  });
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
    ...(overrides.providerRequests === undefined
      ? {}
      : {
          providerRequests:
            overrides.providerRequests === true
              ? new DrizzleGatewayProviderRequestRepository(db)
              : overrides.providerRequests(new DrizzleGatewayProviderRequestRepository(db)),
          refundCards: new SecretCipherRefundCardSealer(ctx.container.cipher),
        }),
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
    ...(overrides.lateCredit === undefined ? {} : { lateCredit: overrides.lateCredit }),
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
