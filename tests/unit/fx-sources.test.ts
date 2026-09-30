import { describe, expect, it } from 'vitest';
import type { ProviderHttpClient, ProviderHttpRequest, ProviderHttpResult } from '@nexa/contracts';
import {
  NOBITEX_BASE_URL,
  NobitexFxSource,
} from '../../apps/api/src/modules/commerce/fx/infrastructure/nobitex-source';
import {
  WALLEX_BASE_URL,
  WallexFxSource,
} from '../../apps/api/src/modules/commerce/fx/infrastructure/wallex-source';
import {
  parseExactJson,
  priceOf,
} from '../../apps/api/src/modules/commerce/fx/infrastructure/fx-source-parsing';

/**
 * Package FX — the two source adapters against RECORDED shapes (`docs/fx-audit.md` §2).
 *
 * Nobitex's body is the example its own documentation prints for `GET /v3/orderbook/all`
 * (`nobitex/docs-api`, `_market_data.md`, the `USDTIRT` entry) with the single-market
 * envelope the same page documents. Wallex's is the shape two open-source clients agree
 * on for `GET /v1/depth`. The live hosts were unreachable from the build session, so what
 * these prove is that the adapters read the DOCUMENTED shapes exactly; §6 of the audit
 * records the live acceptance still owed.
 */

function client(
  answer: (request: ProviderHttpRequest) => ProviderHttpResult,
): ProviderHttpClient & {
  readonly requests: ProviderHttpRequest[];
} {
  const requests: ProviderHttpRequest[] = [];
  return {
    requests,
    send: (request) => {
      requests.push(request);
      return Promise.resolve(answer(request));
    },
  };
}

const ok = (bodyText: string, status = 200): ProviderHttpResult => ({
  ok: true,
  status,
  headers: {},
  bodyText,
  setCookie: [],
});

/** The documented Nobitex `USDTIRT` book, in the single-market envelope. Rial. */
const NOBITEX_BODY = JSON.stringify({
  status: 'ok',
  lastUpdate: 1644991767392,
  lastTradePrice: '277980',
  asks: [
    ['277990', '6688.3'],
    ['278000', '28185.03'],
  ],
  bids: [
    ['277960', '119.31'],
    ['271240', '1079.75'],
  ],
});

/** The shape the Wallex clients read for `GET /v1/depth?symbol=USDTTMN`. Toman. */
const WALLEX_BODY = JSON.stringify({
  success: true,
  message: 'The operation was successful',
  result: {
    ask: [
      { price: '103560', quantity: 12.5, sum: '1294500' },
      { price: '103570', quantity: 3, sum: '310710' },
    ],
    bid: [
      { price: '103550', quantity: 40.2, sum: '4162710' },
      { price: '103540', quantity: 8, sum: '828320' },
    ],
  },
});

describe('exact JSON', () => {
  it('keeps a numeric price as its source text, so no float ever carries a rate', () => {
    const parsed = parseExactJson('{"price": 103550.10, "n": 1e3, "s": "7"}') as Record<
      string,
      unknown
    >;
    expect(parsed['price']).toBe('103550.10');
    expect(parsed['s']).toBe('7');
    expect(priceOf(parsed['price'] as string)).toEqual({ mantissa: 1_035_501n, scale: 1 });
    // An exponent is not a plain decimal: refused, never evaluated.
    expect(priceOf(parsed['n'] as string)).toBeNull();
    expect(parseExactJson('not json')).toBeUndefined();
  });
});

describe('Nobitex (primary)', () => {
  it('reads the best bid of the documented order book as a Rial rate with the book time', async () => {
    const http = client(() => ok(NOBITEX_BODY));
    const outcome = await new NobitexFxSource(http).read('USDT');
    expect(outcome).toEqual({
      kind: 'READ',
      reading: {
        source: 'NOBITEX',
        // The HIGHEST bid, whatever the order the book came in.
        rate: { mantissa: 277_960n, scale: 0 },
        currency: 'IRR',
        sourceAt: new Date(1644991767392),
      },
    });
    expect(http.requests).toEqual([
      { method: 'GET', path: '/v3/orderbook/USDTIRT', effect: 'READ' },
    ]);
    expect(NOBITEX_BASE_URL).toBe('https://apiv2.nobitex.ir');
  });

  it('takes the highest bid rather than the first entry', async () => {
    const body = JSON.stringify({
      status: 'ok',
      lastUpdate: 1,
      bids: [
        ['271240', '1'],
        ['277960', '2'],
        ['100', '3'],
      ],
      asks: [],
    });
    const outcome = await new NobitexFxSource(client(() => ok(body))).read('USDT');
    expect(outcome.kind === 'READ' && outcome.reading.rate.mantissa).toBe(277_960n);
  });

  it('maps a 429 to RATE_LIMITED and everything else unusable to UNAVAILABLE with a machine code', async () => {
    const cases: [ProviderHttpResult, { kind: string; code: string }][] = [
      [ok('{}', 429), { kind: 'RATE_LIMITED', code: 'nobitex.rate_limited' }],
      [ok('oops', 502), { kind: 'UNAVAILABLE', code: 'nobitex.http_502' }],
      [
        { ok: false, failure: 'TIMEOUT', status: null },
        { kind: 'UNAVAILABLE', code: 'nobitex.timeout' },
      ],
      [
        { ok: false, failure: 'UNREACHABLE', status: null },
        { kind: 'UNAVAILABLE', code: 'nobitex.unreachable' },
      ],
      [
        { ok: false, failure: 'BLOCKED_TARGET', status: null },
        { kind: 'UNAVAILABLE', code: 'nobitex.blocked_target' },
      ],
      [ok('<html>'), { kind: 'UNAVAILABLE', code: 'nobitex.not_json' }],
      [
        ok('{"status":"failed","message":"x"}'),
        { kind: 'UNAVAILABLE', code: 'nobitex.status_failed' },
      ],
      [ok('{"status":"ok","bids":[],"asks":[]}'), { kind: 'UNAVAILABLE', code: 'nobitex.no_bids' }],
      [
        ok('{"status":"ok","bids":[["abc","1"]],"asks":[]}'),
        { kind: 'UNAVAILABLE', code: 'nobitex.no_bids' },
      ],
    ];
    for (const [result, expected] of cases) {
      const outcome = await new NobitexFxSource(client(() => result)).read('USDT');
      expect(outcome, JSON.stringify(result)).toMatchObject(expected);
    }
  });
});

describe('Wallex (fallback)', () => {
  it('reads the best bid of the depth book as a Toman rate with no source time', async () => {
    const http = client(() => ok(WALLEX_BODY));
    const outcome = await new WallexFxSource(http).read('USDT');
    expect(outcome).toEqual({
      kind: 'READ',
      reading: {
        source: 'WALLEX',
        rate: { mantissa: 103_550n, scale: 0 },
        currency: 'IRT',
        sourceAt: null,
      },
    });
    expect(http.requests).toEqual([
      { method: 'GET', path: '/v1/depth?symbol=USDTTMN', effect: 'READ' },
    ]);
    expect(WALLEX_BASE_URL).toBe('https://api.wallex.ir');
  });

  it('reads a numeric price exactly as written, and refuses an unsuccessful envelope', async () => {
    const numeric = JSON.stringify({
      success: true,
      result: { ask: [], bid: [{ price: 103550.5, quantity: 1 }] },
    });
    const outcome = await new WallexFxSource(client(() => ok(numeric))).read('USDT');
    expect(outcome.kind === 'READ' && outcome.reading.rate).toEqual({
      mantissa: 1_035_505n,
      scale: 1,
    });

    const failed = await new WallexFxSource(client(() => ok('{"success":false,"result":[]}'))).read(
      'USDT',
    );
    expect(failed).toMatchObject({ kind: 'UNAVAILABLE', code: 'wallex.not_success' });
    const limited = await new WallexFxSource(client(() => ok('', 429))).read('USDT');
    expect(limited).toMatchObject({ kind: 'RATE_LIMITED', code: 'wallex.rate_limited' });
    const empty = await new WallexFxSource(
      client(() => ok('{"success":true,"result":{"ask":[],"bid":[]}}')),
    ).read('USDT');
    expect(empty).toMatchObject({ kind: 'UNAVAILABLE', code: 'wallex.no_bids' });
  });
});
