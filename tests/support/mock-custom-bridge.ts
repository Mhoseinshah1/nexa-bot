import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import { once } from 'node:events';
import type { ProviderHttpRequest, ProviderHttpResult } from '@nexa/contracts';

/**
 * A REFERENCE bridge for Nexa's custom-gateway protocol (`docs/protocols/custom-gateway.md`),
 * written from the protocol document alone — never from Nexa's adapter — so a test that passes
 * against it is a test of the document. Tests only: it is never shipped, and nothing in
 * `apps/` imports it.
 *
 * It does what §3–§6 say a bridge MUST: verifies Nexa's request signature, timestamp window and
 * nonce (§4) and answers 401 with the protocol's codes otherwise; keeps create idempotent on
 * `invoice_id` (same body: the same answer with 200; a different body: 409 INVOICE_CONFLICT);
 * signs every 2xx answer over `NEXA-CGW-V1-RESPONSE\n<t>\n<request nonce>\n` + the raw body
 * (§5); answers inquiries by reference or, with `reference: null`, by `invoice_id`; and builds
 * signed callbacks. Every misbehaviour a test needs is a switch on the instance.
 *
 * One core (`handle`), two transports: `http` is an in-process stand-in for `SafeHttpClient`
 * (it serialises the body exactly as that client does), and `listen` serves the same core over
 * real TLS.
 */

export interface BridgePayment {
  readonly invoiceId: string;
  readonly reference: string;
  readonly amount: bigint;
  readonly requestBody: string;
  readonly callbackUrl: string | null;
  readonly expiresAt: string;
  readonly customerRef: string;
  status: 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED' | 'UNDERPAID' | 'OVERPAID';
  amountPaid: bigint | null;
}

export interface BridgeRequest {
  readonly method: string;
  /** The FULL path received, base prefix included, no query. */
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface BridgeAnswer {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

type Override =
  | {
      readonly kind: 'answer';
      readonly status: number;
      readonly body: unknown;
      readonly headers?: Record<string, string>;
      readonly sign?: boolean;
    }
  | { readonly kind: 'drop' };

const SIGNATURE_HEADER = 'x-nexa-bridge-signature';

function hex(secret: string, text: Buffer): string {
  return createHmac('sha256', secret).update(text).digest('hex');
}

export class MockCustomBridge {
  readonly payments = new Map<string, BridgePayment>();
  readonly received: { method: string; path: string; verdict: string }[] = [];
  private readonly nonces = new Set<string>();
  private sequence = 0;
  /** The next create (or inquiry, or ping) answers this instead of the protocol's answer. */
  nextCreate: Override | null = null;
  nextInquiry: Override | null = null;
  nextPing: Override | null = null;
  /** Whether 2xx answers are signed at all, and with which secret (default: the shared one). */
  signResponses = true;
  responseSecret: string | null = null;
  /** Rotation: sign with these extra secrets too (several `v1=`). */
  alsoSignWith: string[] = [];
  /** Whether a create makes the payment before an overridden answer (a 5xx after the fact). */
  createBeforeOverride = false;
  /** What the ping reports. */
  pingBody: Record<string, unknown> | null = null;

  constructor(
    private readonly options: {
      readonly secret: string;
      readonly now: () => Date;
      /** The base URL's own path prefix, e.g. `/nexa`. Default none. */
      readonly basePath?: string;
    },
  ) {}

  private get basePath(): string {
    return (this.options.basePath ?? '').replace(/\/+$/u, '');
  }

  /** Changes a payment, as the payment service behind the bridge would. */
  set(invoiceId: string, status: BridgePayment['status'], amountPaid: bigint | null = null): void {
    const payment = this.payments.get(invoiceId);
    if (payment === undefined) throw new Error(`no bridge payment for ${invoiceId}`);
    payment.status = status;
    payment.amountPaid = amountPaid;
  }

  /** The bridge's signature header over a body (§5). */
  signatureFor(
    direction: 'response' | 'callback',
    body: string,
    requestNonce: string | null,
    t: number = Math.floor(this.options.now().getTime() / 1000),
  ): string {
    const prefix =
      direction === 'response'
        ? `NEXA-CGW-V1-RESPONSE\n${String(t)}\n${requestNonce ?? ''}\n`
        : `NEXA-CGW-V1-CALLBACK\n${String(t)}\n`;
    const bytes = Buffer.concat([Buffer.from(prefix, 'utf8'), Buffer.from(body, 'utf8')]);
    const secrets = [this.responseSecret ?? this.options.secret, ...this.alsoSignWith];
    return [`t=${String(t)}`, ...secrets.map((secret) => `v1=${hex(secret, bytes)}`)].join(',');
  }

  /** A signed status-change callback for one payment (§3.3), as bytes and headers. */
  callback(
    invoiceId: string,
    options: {
      readonly deliveryId?: string;
      readonly status?: string;
      readonly t?: number;
      readonly secret?: string;
      readonly event?: string;
      /** Override the reference sent (`null`: a callback that names only the invoice id). */
      readonly reference?: string | null;
    } = {},
  ): { body: string; headers: Record<string, string> } {
    const payment = this.payments.get(invoiceId);
    const deliveryId = options.deliveryId ?? `dlv-${String((this.sequence += 1))}`;
    const body = JSON.stringify({
      version: '1',
      event: options.event ?? 'payment.status_changed',
      delivery_id: deliveryId,
      invoice_id: invoiceId,
      reference: options.reference !== undefined ? options.reference : (payment?.reference ?? null),
      status: options.status ?? payment?.status ?? 'PENDING',
      occurred_at: this.options.now().toISOString(),
    });
    const t = options.t ?? Math.floor(this.options.now().getTime() / 1000);
    const bytes = Buffer.concat([
      Buffer.from(`NEXA-CGW-V1-CALLBACK\n${String(t)}\n`, 'utf8'),
      Buffer.from(body, 'utf8'),
    ]);
    return {
      body,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        [SIGNATURE_HEADER]: `t=${String(t)},v1=${hex(options.secret ?? this.options.secret, bytes)}`,
        'x-nexa-delivery-id': deliveryId,
      },
    };
  }

  private verifyRequest(request: BridgeRequest, path: string): string | null {
    const timestamp = request.headers['x-nexa-timestamp'] ?? '';
    const nonce = request.headers['x-nexa-nonce'] ?? '';
    const signature = request.headers['x-nexa-signature'] ?? '';
    if (!/^[0-9]{1,12}$/u.test(timestamp) || !/^[0-9a-f]{32}$/u.test(nonce)) {
      return 'SIGNATURE_INVALID';
    }
    const text = [
      'NEXA-CGW-V1-REQUEST',
      request.method,
      path,
      timestamp,
      nonce,
      createHash('sha256').update(request.body, 'utf8').digest('hex'),
    ].join('\n');
    const expected = Buffer.from(`v1=${hex(this.options.secret, Buffer.from(text, 'utf8'))}`);
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      return 'SIGNATURE_INVALID';
    }
    const skew = Math.abs(Math.floor(this.options.now().getTime() / 1000) - Number(timestamp));
    if (skew > 300) return 'TIMESTAMP_OUT_OF_WINDOW';
    if (this.nonces.has(nonce)) return 'NONCE_REPLAYED';
    this.nonces.add(nonce);
    return null;
  }

  private answer(
    status: number,
    body: unknown,
    nonce: string | null,
    options: { readonly sign?: boolean; readonly headers?: Record<string, string> } = {},
  ): BridgeAnswer {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const headers: Record<string, string> = {
      'content-type': 'application/json; charset=utf-8',
      ...(options.headers ?? {}),
    };
    const sign = options.sign ?? (status >= 200 && status < 300 && this.signResponses);
    if (sign) headers[SIGNATURE_HEADER] = this.signatureFor('response', text, nonce);
    return { status, headers, body: text };
  }

  private error(status: number, code: string, nonce: string | null): BridgeAnswer {
    return this.answer(status, { error: { code, message: 'mock bridge' } }, nonce, { sign: false });
  }

  private money(value: bigint | null): { value: string; currency: 'IRR' } | null {
    return value === null ? null : { value: value.toString(), currency: 'IRR' };
  }

  /** The protocol, as a bridge implements it. `'DROP'`: the connection dies without an answer. */
  handle(request: BridgeRequest): BridgeAnswer | 'DROP' {
    if (!request.path.startsWith(`${this.basePath}/`)) {
      return this.error(404, 'NOT_FOUND', null);
    }
    const path = request.path.slice(this.basePath.length);
    const failed = this.verifyRequest(request, path);
    this.received.push({ method: request.method, path, verdict: failed ?? 'ok' });
    if (failed !== null) return this.error(401, failed, null);
    const nonce = request.headers['x-nexa-nonce'] ?? null;
    const override = (which: Override | null): BridgeAnswer | 'DROP' | null => {
      if (which === null) return null;
      if (which.kind === 'drop') return 'DROP';
      return this.answer(which.status, which.body, nonce, {
        ...(which.sign === undefined ? {} : { sign: which.sign }),
        ...(which.headers === undefined ? {} : { headers: which.headers }),
      });
    };

    if (request.method === 'GET' && path === '/v1/ping') {
      const scripted = override(this.nextPing);
      this.nextPing = null;
      if (scripted !== null) return scripted;
      return this.answer(
        200,
        this.pingBody ?? {
          protocol: 'nexa-custom-gateway',
          version: '1',
          bridge_time: this.options.now().toISOString(),
          currencies: ['IRR'],
          capabilities: { cancel: false },
        },
        nonce,
      );
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(request.body) as Record<string, unknown>;
    } catch {
      return this.error(400, 'BAD_REQUEST', nonce);
    }

    if (request.method === 'POST' && path === '/v1/payments') {
      if (request.headers['idempotency-key'] !== body['invoice_id']) {
        return this.error(400, 'BAD_REQUEST', nonce);
      }
      const invoiceId = String(body['invoice_id']);
      const amount = body['amount'] as { value?: unknown; currency?: unknown } | undefined;
      if (amount?.currency !== 'IRR' || typeof amount.value !== 'string') {
        return this.error(422, 'UNSUPPORTED_CURRENCY', nonce);
      }
      const existing = this.payments.get(invoiceId);
      const make = (): BridgePayment => {
        const payment: BridgePayment = {
          invoiceId,
          reference: `brg-${String((this.sequence += 1)).padStart(6, '0')}`,
          amount: BigInt(amount.value as string),
          requestBody: request.body,
          callbackUrl: (body['callback_url'] as string | null) ?? null,
          expiresAt: String(body['expires_at']),
          customerRef: String(body['customer_ref']),
          status: 'PENDING',
          amountPaid: null,
        };
        this.payments.set(invoiceId, payment);
        return payment;
      };
      const scripted = this.nextCreate;
      if (scripted !== null) {
        this.nextCreate = null;
        if (this.createBeforeOverride && existing === undefined) make();
        return override(scripted) ?? 'DROP';
      }
      if (existing !== undefined) {
        // Idempotent on invoice_id: the same body, the same payment; another body, a conflict.
        return existing.requestBody === request.body
          ? this.answer(200, this.created(existing), nonce)
          : this.error(409, 'INVOICE_CONFLICT', nonce);
      }
      return this.answer(201, this.created(make()), nonce);
    }

    if (request.method === 'POST' && path === '/v1/payments/inquiry') {
      const scripted = override(this.nextInquiry);
      this.nextInquiry = null;
      if (scripted !== null) return scripted;
      const payment = this.payments.get(String(body['invoice_id']));
      const reference = body['reference'];
      if (payment === undefined || (reference !== null && reference !== payment.reference)) {
        return this.error(404, 'NOT_FOUND', nonce);
      }
      return this.answer(200, this.inquiryAnswer(payment), nonce);
    }
    return this.error(404, 'NOT_FOUND', nonce);
  }

  inquiryAnswer(payment: BridgePayment): Record<string, unknown> {
    return {
      invoice_id: payment.invoiceId,
      reference: payment.reference,
      status: payment.status,
      amount: this.money(payment.amount),
      amount_paid: this.money(payment.amountPaid),
      paid_at: payment.amountPaid === null ? null : this.options.now().toISOString(),
      updated_at: this.options.now().toISOString(),
    };
  }

  private created(payment: BridgePayment): Record<string, unknown> {
    return {
      invoice_id: payment.invoiceId,
      reference: payment.reference,
      payment_url: `https://pay.bridge.test/p/${payment.reference}`,
      status: 'PENDING',
      amount: this.money(payment.amount),
    };
  }

  /**
   * An in-process `SafeHttpClient`: the base URL and the adapter's relative path resolved the
   * way that client resolves them, the body serialised the way it serialises it.
   */
  readonly http = {
    send: async (baseUrl: string, request: ProviderHttpRequest): Promise<ProviderHttpResult> => {
      const url = new URL(request.path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
      const body =
        request.body === undefined
          ? ''
          : request.body.kind === 'json'
            ? JSON.stringify(request.body.value)
            : request.body.kind === 'json-text'
              ? request.body.text
              : new URLSearchParams(request.body.value).toString();
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers ?? {})) {
        headers[key.toLowerCase()] = value;
      }
      const answer = this.handle({ method: request.method, path: url.pathname, headers, body });
      if (answer === 'DROP') {
        return {
          ok: false,
          failure: 'TIMEOUT',
          status: null,
          ...(request.method === 'GET' ? {} : { detail: 'CONNECTION_LOST_AFTER_SEND' as const }),
        };
      }
      return {
        ok: true,
        status: answer.status,
        headers: answer.headers,
        bodyText: answer.body,
        setCookie: [],
      };
    },
  };

  /** The same core over real TLS, on 127.0.0.1. */
  async listen(tls: { readonly cert: string; readonly key: string }): Promise<{
    readonly server: Server;
    readonly port: number;
  }> {
    const server = createServer({ cert: tls.cert, key: tls.key }, (incoming, outgoing) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => {
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (typeof value === 'string') headers[key] = value;
        }
        const answer = this.handle({
          method: incoming.method ?? 'GET',
          path: new URL(incoming.url ?? '/', 'https://bridge.test').pathname,
          headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        if (answer === 'DROP') {
          incoming.socket.destroy();
          return;
        }
        outgoing.writeHead(answer.status, answer.headers);
        outgoing.end(answer.body);
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    return { server, port: address.port };
  }
}
