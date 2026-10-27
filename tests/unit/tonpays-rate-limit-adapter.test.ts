import { describe, expect, it } from 'vitest';
import { TonPaysAdapter } from '../../apps/api/src/modules/commerce/payments/infrastructure/tonpays-adapter';
import type { FetchLike } from '../../apps/api/src/modules/commerce/payments/infrastructure/tonpays-adapter';
import { TonPaysTelegramAdapter } from '../../apps/api/src/modules/commerce/payments/infrastructure/tonpays-telegram-adapter';
import { TonPaysRateLimiter } from '../../apps/api/src/modules/commerce/payments/infrastructure/tonpays-rate-limiter';
import { TONPAYS_HELD_CODE } from '../../apps/api/src/modules/commerce/payments/domain/tonpays';

/**
 * Round 11 A8: the limiter as the TonPays adapters meet it — inside `tonpaysRequest`, so every
 * endpoint of both routes is paced, a 429 pauses the key, and a call it holds never reaches
 * `fetch`. The outcome the application maps is typed: RATE_LIMITED with `retryAfterMs`, and
 * `notSent` only for a call that never left.
 */

const WEBSITE_KEY = 'tp_live_SECRET_website_key';
const TELEGRAM_KEY = 'tpt_live_SECRET_telegram_key';
const ORDER_ID = 'NXAAAAAAAAAAAAAAAAAA';

function rig(answers: (() => Response)[]) {
  let now = Date.UTC(2026, 9, 27, 9, 0, 0);
  const calls: string[] = [];
  const fetch: FetchLike = (url) => {
    calls.push(url);
    const next = answers.shift();
    if (next === undefined) throw new Error('no answer queued');
    return Promise.resolve(next());
  };
  const limiter = new TonPaysRateLimiter({
    clock: { now: () => new Date(now) },
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
    random: () => 0.5,
    pacingFor: () => Promise.resolve({ callsPerMinute: 30, burst: 3 }),
  });
  return {
    calls,
    advance: (ms: number) => {
      now += ms;
    },
    website: new TonPaysAdapter({ fetch, timeoutMs: 1_000, limiter }),
    telegram: new TonPaysTelegramAdapter({ fetch, timeoutMs: 1_000, limiter }),
  };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const rateLimited = (headers: Record<string, string> = {}) =>
  json(429, { detail: { code: 'RATE_LIMIT_EXCEEDED', message: 'slow down' } }, headers);

const createRequest = {
  orderId: ORDER_ID,
  amount: 50_000n,
  callbackUrl: null,
  buyerChatId: null,
  presentation: null,
};

describe('a create the provider rate limits', () => {
  it('is RATE_LIMITED with the provider’s Retry-After, and a create during the pause is HELD — never sent, so never a second invoice', async () => {
    const r = rig([() => rateLimited({ 'retry-after': '30' })]);
    const first = await r.website.createInvoice(WEBSITE_KEY, createRequest);
    expect(first).toEqual({
      kind: 'RATE_LIMITED',
      code: 'RATE_LIMIT_EXCEEDED',
      httpStatus: 429,
      retryAfterMs: 30_000,
    });
    r.advance(10_000);
    const again = await r.website.createInvoice(WEBSITE_KEY, createRequest);
    expect(again).toEqual({
      kind: 'RATE_LIMITED',
      code: TONPAYS_HELD_CODE,
      retryAfterMs: 20_000,
      notSent: true,
    });
    // One request reached the provider, not two.
    expect(r.calls).toHaveLength(1);
  });

  it('a 429 with no readable code stays UNKNOWN (the lost-create rule, OQ-R11-A8-01) — and still pauses the key', async () => {
    const r = rig([() => new Response('<html>Too Many Requests</html>', { status: 429 })]);
    const outcome = await r.website.createInvoice(WEBSITE_KEY, createRequest);
    expect(outcome.kind).toBe('UNKNOWN');
    // The next call on the key — an inquiry — waits the back-off without being sent.
    const inquiry = await r.website.inquire(WEBSITE_KEY, 'TP-1');
    expect(inquiry).toMatchObject({ kind: 'RATE_LIMITED', code: TONPAYS_HELD_CODE, notSent: true });
    expect(r.calls).toHaveLength(1);
  });
});

describe('a 429 whose body never arrives (Codex P2 on #351)', () => {
  it('pauses the key from the 429’s headers even when the body stalls past the timeout: the create stays UNKNOWN, the next call is HELD', async () => {
    let fetches = 0;
    const stalled: FetchLike = (_url, init) => {
      fetches += 1;
      const signal = init.signal;
      const body = new ReadableStream<Uint8Array>({
        pull: () =>
          new Promise<void>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      });
      return Promise.resolve(
        new Response(body, {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '120' },
        }),
      );
    };
    const now = Date.UTC(2026, 9, 27, 9, 0, 0);
    const limiter = new TonPaysRateLimiter({
      clock: { now: () => new Date(now) },
      sleep: () => Promise.resolve(),
      pacingFor: () => Promise.resolve({ callsPerMinute: 30, burst: 3 }),
    });
    const website = new TonPaysAdapter({ fetch: stalled, timeoutMs: 50, limiter });
    const created = await website.createInvoice(WEBSITE_KEY, createRequest);
    // A lost answer is still a lost answer: UNKNOWN, never re-sent.
    expect(created).toEqual({ kind: 'UNKNOWN', code: 'http.timeout' });
    // But the key is paused for the 429's Retry-After: the next call never leaves.
    const next = await website.inquire(WEBSITE_KEY, 'TP-1');
    expect(next).toEqual({
      kind: 'RATE_LIMITED',
      code: TONPAYS_HELD_CODE,
      retryAfterMs: 120_000,
      notSent: true,
    });
    expect(fetches).toBe(1);
  });
});

describe('an inquiry the provider rate limits', () => {
  it('backs off exponentially without Retry-After, growing with each consecutive 429', async () => {
    const r = rig([() => rateLimited(), () => rateLimited(), () => rateLimited()]);
    const pauses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const outcome = await r.website.inquire(WEBSITE_KEY, 'TP-1');
      expect(outcome.kind).toBe('RATE_LIMITED');
      const pause = outcome.kind === 'RATE_LIMITED' ? (outcome.retryAfterMs ?? 0) : 0;
      pauses.push(pause);
      r.advance(pause);
    }
    expect(pauses).toEqual([5_000, 10_000, 20_000]);
    expect(r.calls).toHaveLength(3);
  });

  it('an answer that is not a 429 starts the back-off over', async () => {
    const r = rig([
      () => rateLimited(),
      () => json(200, { invoice_id: 'TP-1', order_id: ORDER_ID, status: 'pending', paid: false }),
      () => rateLimited(),
    ]);
    await r.website.inquire(WEBSITE_KEY, 'TP-1');
    r.advance(5_000);
    expect((await r.website.inquire(WEBSITE_KEY, 'TP-1')).kind).toBe('OBSERVED');
    const outcome = await r.website.inquire(WEBSITE_KEY, 'TP-1');
    expect(outcome).toMatchObject({ kind: 'RATE_LIMITED', retryAfterMs: 5_000 });
  });
});

describe('every TonPays Telegram endpoint takes the same limiter', () => {
  it('a 429 on one call holds the create, check, card change, receipt, cancel and refund on that key — none is sent', async () => {
    const r = rig([() => rateLimited({ 'retry-after': '60' })]);
    const cancelled = await r.telegram.cancelInvoice(TELEGRAM_KEY, 'TPT-1001');
    expect(cancelled).toEqual({
      kind: 'RATE_LIMITED',
      code: 'RATE_LIMIT_EXCEEDED',
      retryAfterMs: 60_000,
    });
    const held = { kind: 'RATE_LIMITED', code: TONPAYS_HELD_CODE, notSent: true };
    expect(
      await r.telegram.createInvoice(TELEGRAM_KEY, {
        ...createRequest,
        orderId: 'NTAAAAAAAAAAAAAAAAAA',
        buyerChatId: '910910',
      }),
    ).toMatchObject(held);
    expect(await r.telegram.inquire(TELEGRAM_KEY, 'TPT-1001')).toMatchObject(held);
    expect(await r.telegram.changeCard(TELEGRAM_KEY, 'TPT-1001')).toMatchObject(held);
    expect(
      await r.telegram.uploadReceipt(TELEGRAM_KEY, 'TPT-1001', {
        bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1]),
        mimeType: 'image/jpeg',
        fileName: 'receipt.jpg',
      }),
    ).toMatchObject(held);
    expect(await r.telegram.cancelInvoice(TELEGRAM_KEY, 'TPT-1001')).toMatchObject(held);
    expect(
      await r.telegram.refundInvoice(TELEGRAM_KEY, 'TPT-1001', {
        cardNumber: '6037991122334455',
        cardHolder: 'علی رضایی',
      }),
    ).toMatchObject(held);
    expect(r.calls).toHaveLength(1);
  });

  it('keeps the two routes’ keys apart: a pause on the Telegram key does not hold the website key', async () => {
    const r = rig([
      () => rateLimited({ 'retry-after': '60' }),
      () => json(200, { invoice_id: 'TP-1', order_id: ORDER_ID, status: 'pending', paid: false }),
    ]);
    await r.telegram.inquire(TELEGRAM_KEY, 'TPT-1001');
    expect((await r.website.inquire(WEBSITE_KEY, 'TP-1')).kind).toBe('OBSERVED');
    expect(r.calls).toHaveLength(2);
  });

  it('paces a volley: a fourth call in the same instant waits for its token instead of leaving with the burst', async () => {
    const answers = Array.from(
      { length: 4 },
      () => () =>
        json(200, { invoice_id: 'TP-1', order_id: ORDER_ID, status: 'pending', paid: false }),
    );
    let now = Date.UTC(2026, 9, 27, 9, 0, 0);
    const sentAt: number[] = [];
    const fetch: FetchLike = () => {
      sentAt.push(now);
      return Promise.resolve(answers.shift()!());
    };
    const limiter = new TonPaysRateLimiter({
      clock: { now: () => new Date(now) },
      sleep: (ms) => {
        now += ms;
        return Promise.resolve();
      },
      pacingFor: () => Promise.resolve({ callsPerMinute: 30, burst: 3 }),
    });
    const website = new TonPaysAdapter({ fetch, timeoutMs: 1_000, limiter });
    for (let i = 0; i < 4; i += 1) await website.inquire(WEBSITE_KEY, 'TP-1');
    const t0 = sentAt[0]!;
    expect(sentAt.map((t) => t - t0)).toEqual([0, 0, 0, 2_000]);
  });
});
