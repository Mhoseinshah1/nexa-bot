import { createServer } from 'node:http';
import { once } from 'node:events';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { ProviderHttpClient, ProviderHttpRequest, ProviderHttpResult } from '@nexa/contracts';
import { SafeHttpClient } from '../../apps/api/src/infrastructure/net/safe-http';
import { BitpinFxSource } from '../../apps/api/src/modules/commerce/fx/infrastructure/bitpin-source';
import { RamzinexFxSource } from '../../apps/api/src/modules/commerce/fx/infrastructure/ramzinex-source';
import { TabdealFxSource } from '../../apps/api/src/modules/commerce/fx/infrastructure/tabdeal-source';
import { WallexFxSource } from '../../apps/api/src/modules/commerce/fx/infrastructure/wallex-source';
import {
  FX_BITPIN_MAX_RESPONSE_BYTES,
  FX_SOURCE_MAX_RESPONSE_BYTES,
  wholeTomanMean,
} from '../../apps/api/src/modules/commerce/fx/infrastructure/fx-source-parsing';

/**
 * Round 8 — the four Toman-quoting sources against the owner's recorded answers
 * (curl from the production server, 2026-10-24). The Tabdeal, Bitpin and Ramzinex shapes are
 * the ones in the round prompt; Wallex's is `result.markets[]` with `symbol` and `price`.
 * What these prove is that each adapter reads that shape exactly, converts the unit in the
 * adapter alone, rounds half up to a whole Toman, and fails — never zero — on a shape it
 * does not recognise. The live acceptance stays the owner's (`docs/fx-audit.md` §8).
 */

function client(
  answer: (request: ProviderHttpRequest) => ProviderHttpResult,
): ProviderHttpClient & { readonly requests: ProviderHttpRequest[] } {
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
const rateOf = (outcome: { kind: string; reading?: { rate: unknown } }) =>
  outcome.kind === 'READ' ? outcome.reading?.rate : outcome;

const TABDEAL_BODY =
  '{"asks":[["268840.00000000","51.00000000"]],"bids":[["268502.00000000","124.00000000"]]}';

describe('wholeTomanMean', () => {
  it('is exact and rounds half up, with the Rial divisor applied once', () => {
    const r = (m: bigint, scale = 0) => ({ mantissa: m, scale });
    expect(wholeTomanMean([r(268_840n), r(268_502n)], 1n)).toEqual(r(268_671n));
    expect(wholeTomanMean([r(26_884_150n, 2), r(268_502n)], 1n)).toEqual(r(268_672n)); // 268841.5 and 268502: 268671.75
    expect(wholeTomanMean([r(268_841n), r(268_502n)], 1n)).toEqual(r(268_672n)); // exactly .5 rounds up
    expect(wholeTomanMean([r(2_688_005n), r(2_688_000n)], 10n)).toEqual(r(268_800n)); // .25 down
    expect(wholeTomanMean([r(2_688_009n), r(2_688_001n)], 10n)).toEqual(r(268_801n)); // .5 up
    expect(wholeTomanMean([r(4n)], 10n)).toBeNull(); // 0.4 Toman is not a rate
    expect(wholeTomanMean([], 1n)).toBeNull();
    expect(wholeTomanMean([r(0n), r(5n)], 1n)).toBeNull();
  });
});

describe('Tabdeal', () => {
  it('reads the recorded depth as the exact mid of the top ask and top bid, in Toman', async () => {
    const http = client(() => ok(TABDEAL_BODY));
    const outcome = await new TabdealFxSource(http).read('USDT');
    expect(outcome).toEqual({
      kind: 'READ',
      reading: {
        source: 'TABDEAL',
        rate: { mantissa: 268_671n, scale: 0 },
        currency: 'IRT',
        sourceAt: null,
      },
    });
    expect(http.requests).toEqual([
      { method: 'GET', path: '/r/api/v1/depth?tabdealSymbol=USDT_IRT&limit=1', effect: 'READ' },
    ]);
  });

  it('rounds the mid half up to a whole Toman', async () => {
    const body = (ask: string, bid: string) => `{"asks":[["${ask}","1"]],"bids":[["${bid}","1"]]}`;
    const at = async (ask: string, bid: string) =>
      rateOf((await new TabdealFxSource(client(() => ok(body(ask, bid)))).read('USDT')) as never);
    expect(await at('268841', '268502')).toEqual({ mantissa: 268_672n, scale: 0 });
    expect(await at('268840.5', '268502')).toEqual({ mantissa: 268_671n, scale: 0 });
  });

  it('fails the source, never a zero, on an empty side, a bad price or a wrong shape', async () => {
    const cases: [string, string][] = [
      ['{"asks":[],"bids":[["268502","1"]]}', 'tabdeal.bad_price'],
      ['{"asks":[["268840","1"]],"bids":[]}', 'tabdeal.bad_price'],
      ['{"asks":[["abc","1"]],"bids":[["268502","1"]]}', 'tabdeal.bad_price'],
      ['{"asks":[["0","1"]],"bids":[["0","1"]]}', 'tabdeal.bad_price'],
      ['{"asks":[["-5","1"]],"bids":[["268502","1"]]}', 'tabdeal.bad_price'],
      ['{"asks":[[268840,"1"]],"bids":[["1e3","1"]]}', 'tabdeal.bad_price'],
      ['[]', 'tabdeal.not_json'],
      ['<html>', 'tabdeal.not_json'],
    ];
    for (const [body, code] of cases) {
      const outcome = await new TabdealFxSource(client(() => ok(body))).read('USDT');
      expect(outcome, body).toEqual({ kind: 'UNAVAILABLE', code });
    }
    expect(await new TabdealFxSource(client(() => ok('', 429))).read('USDT')).toEqual({
      kind: 'RATE_LIMITED',
      code: 'tabdeal.rate_limited',
    });
  });
});

const BITPIN_BODY = JSON.stringify({
  count: 3,
  results: [
    { id: 1, code: 'BTC_IRT', price: '9876543210.5' },
    { id: 7, code: 'USDT_IRT', price: '268450', title: 'Tether' },
    { id: 9, code: 'ETH_IRT', price: '123' },
  ],
});

describe('Bitpin', () => {
  it('reads the price of the USDT_IRT item among the others, in Toman', async () => {
    const http = client(() => ok(BITPIN_BODY));
    const outcome = await new BitpinFxSource(http).read('USDT');
    expect(outcome).toEqual({
      kind: 'READ',
      reading: {
        source: 'BITPIN',
        rate: { mantissa: 268_450n, scale: 0 },
        currency: 'IRT',
        sourceAt: null,
      },
    });
    expect(http.requests).toEqual([{ method: 'GET', path: '/v1/mkt/markets/', effect: 'READ' }]);
  });

  it('rounds a fractional price half up and fails on a missing symbol or a bad price', async () => {
    const one = (item: string) => `{"results":[${item}]}`;
    const read = (body: string) => new BitpinFxSource(client(() => ok(body))).read('USDT');
    expect(rateOf((await read(one('{"code":"USDT_IRT","price":"268450.5"}'))) as never)).toEqual({
      mantissa: 268_451n,
      scale: 0,
    });
    expect(rateOf((await read(one('{"code":"USDT_IRT","price":"268450.49"}'))) as never)).toEqual({
      mantissa: 268_450n,
      scale: 0,
    });
    expect(await read(one('{"code":"BTC_IRT","price":"5"}'))).toEqual({
      kind: 'UNAVAILABLE',
      code: 'bitpin.no_market',
    });
    expect(await read('{"results":[]}')).toEqual({ kind: 'UNAVAILABLE', code: 'bitpin.no_market' });
    expect(await read('{}')).toEqual({ kind: 'UNAVAILABLE', code: 'bitpin.no_market' });
    for (const price of ['"abc"', '"0"', 'null', '""', '"0.3"']) {
      expect(await read(one(`{"code":"USDT_IRT","price":${price}}`)), price).toEqual({
        kind: 'UNAVAILABLE',
        code: 'bitpin.bad_price',
      });
    }
  });
});

const RAMZINEX_BODY = JSON.stringify({
  status: 0,
  data: [
    { pair_id: 2, name: { en: 'bitcoin/rial' }, buy: 99999999999, sell: 99999999990 },
    { pair_id: 11, name: { en: 'tether/rial', fa: 'تتر' }, buy: 2688500, sell: 2684500 },
  ],
});

describe('Ramzinex', () => {
  it('reads pair 11, takes the mid of buy and sell in Rial and divides by ten once', async () => {
    const http = client(() => ok(RAMZINEX_BODY));
    const outcome = await new RamzinexFxSource(http).read('USDT');
    expect(outcome).toEqual({
      kind: 'READ',
      reading: {
        source: 'RAMZINEX',
        // (2688500 + 2684500) / 2 = 2686500 Rial = 268650 Toman.
        rate: { mantissa: 268_650n, scale: 0 },
        currency: 'IRT',
        sourceAt: null,
      },
    });
    expect(http.requests).toEqual([
      { method: 'GET', path: '/exchange/api/v1.0/exchange/pairs', effect: 'READ' },
    ]);
  });

  it('rounds half up in Toman, and fails on a missing pair, another name or a bad figure', async () => {
    const pair = (fields: string) => `{"data":[{"pair_id":11,${fields}}]}`;
    const read = (body: string) => new RamzinexFxSource(client(() => ok(body))).read('USDT');
    expect(rateOf((await read(pair('"buy":2688009,"sell":2688001'))) as never)).toEqual({
      mantissa: 268_801n,
      scale: 0,
    });
    expect(rateOf((await read(pair('"buy":2688005,"sell":2688000'))) as never)).toEqual({
      mantissa: 268_800n,
      scale: 0,
    });
    expect(await read('{"data":[{"pair_id":12,"buy":1,"sell":1}]}')).toEqual({
      kind: 'UNAVAILABLE',
      code: 'ramzinex.no_market',
    });
    expect(await read(pair('"name":{"en":"bitcoin/rial"},"buy":2688009,"sell":2688001'))).toEqual({
      kind: 'UNAVAILABLE',
      code: 'ramzinex.no_market',
    });
    for (const fields of [
      '"buy":2688009',
      '"sell":2688009',
      '"buy":0,"sell":0',
      '"buy":"x","sell":"y"',
      '"buy":null,"sell":2688001',
      '"buy":5,"sell":4',
    ]) {
      expect(await read(pair(fields)), fields).toEqual({
        kind: 'UNAVAILABLE',
        code: 'ramzinex.bad_price',
      });
    }
  });
});

const WALLEX_BODY = JSON.stringify({
  success: true,
  result: {
    markets: [
      { symbol: 'BTCTMN', price: '9876543210' },
      { symbol: 'USDTTMN', price: '268490', quoteAsset: 'TMN' },
    ],
  },
});

describe('Wallex (markets)', () => {
  it('reads the USDTTMN item of /hector/web/v1/markets, in Toman', async () => {
    const http = client(() => ok(WALLEX_BODY));
    const outcome = await new WallexFxSource(http).read('USDT');
    expect(outcome).toEqual({
      kind: 'READ',
      reading: {
        source: 'WALLEX',
        rate: { mantissa: 268_490n, scale: 0 },
        currency: 'IRT',
        sourceAt: null,
      },
    });
    expect(http.requests).toEqual([
      { method: 'GET', path: '/hector/web/v1/markets', effect: 'READ' },
    ]);
  });

  it('accepts a numeric price as written, and fails on a missing symbol or a bad price', async () => {
    const markets = (items: string) => `{"result":{"markets":[${items}]}}`;
    const read = (body: string) => new WallexFxSource(client(() => ok(body))).read('USDT');
    expect(rateOf((await read(markets('{"symbol":"USDTTMN","price":268490.5}'))) as never)).toEqual(
      {
        mantissa: 268_491n,
        scale: 0,
      },
    );
    expect(await read(markets('{"symbol":"BTCTMN","price":"5"}'))).toEqual({
      kind: 'UNAVAILABLE',
      code: 'wallex.no_market',
    });
    expect(await read('{"result":{}}')).toEqual({ kind: 'UNAVAILABLE', code: 'wallex.no_market' });
    expect(await read('{"success":true}')).toEqual({
      kind: 'UNAVAILABLE',
      code: 'wallex.no_result',
    });
    expect(await read('[]')).toEqual({ kind: 'UNAVAILABLE', code: 'wallex.not_json' });
    for (const price of ['"abc"', '0', 'null', '"-1"']) {
      expect(await read(markets(`{"symbol":"USDTTMN","price":${price}}`)), price).toEqual({
        kind: 'UNAVAILABLE',
        code: 'wallex.bad_price',
      });
    }
  });
});

describe("Bitpin's ~275 KB list over the real outbound client", () => {
  /** A market list that decompresses to about 275 KB, with USDT_IRT near the end. */
  function bigBitpinBody(): string {
    const filler = Array.from({ length: 3_000 }, (_, index) => ({
      id: index + 100,
      code: `COIN${String(index)}_IRT`,
      title: `Coin number ${String(index)} against Toman`,
      price: String(index * 1_000 + 12_345),
    }));
    return JSON.stringify({
      count: 3_001,
      results: [...filler, { code: 'USDT_IRT', price: '268450' }],
    });
  }

  async function serve(encoding: 'br' | 'gzip', body: string, cap: number) {
    const payload = encoding === 'br' ? brotliCompressSync(body) : gzipSync(body);
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': encoding });
      response.end(payload);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const http = new SafeHttpClient({
      allowLoopback: true,
      totalTimeoutMs: 5_000,
      maxResponseBytes: cap,
      maxRetries: 0,
    }).forBase(`http://127.0.0.1:${String(address.port)}`);
    return {
      http,
      close: () => {
        server.closeAllConnections();
        server.close();
      },
    };
  }

  it('is read through Brotli and gzip at the Bitpin cap and refused at the general one', async () => {
    const body = bigBitpinBody();
    const size = Buffer.byteLength(body);
    // The fixture really is Bitpin-sized: past the general cap, inside Bitpin's.
    expect(size).toBeGreaterThan(FX_SOURCE_MAX_RESPONSE_BYTES);
    expect(size).toBeLessThan(FX_BITPIN_MAX_RESPONSE_BYTES);
    for (const encoding of ['br', 'gzip'] as const) {
      const raised = await serve(encoding, body, FX_BITPIN_MAX_RESPONSE_BYTES);
      try {
        expect(await new BitpinFxSource(raised.http).read('USDT')).toMatchObject({
          kind: 'READ',
          reading: { source: 'BITPIN', rate: { mantissa: 268_450n, scale: 0 } },
        });
      } finally {
        raised.close();
      }
      const general = await serve(encoding, body, FX_SOURCE_MAX_RESPONSE_BYTES);
      try {
        // The cap is on DECOMPRESSED bytes: the wire size is tiny and it is still refused.
        expect(await new BitpinFxSource(general.http).read('USDT')).toEqual({
          kind: 'UNAVAILABLE',
          code: 'bitpin.malformed_response',
        });
      } finally {
        general.close();
      }
    }
  });

  it('keeps the decompressed cap at the raised figure: a body past it is refused', async () => {
    const huge = JSON.stringify({
      results: [{ code: 'X', pad: 'a'.repeat(FX_BITPIN_MAX_RESPONSE_BYTES) }],
    });
    const raised = await serve('gzip', huge, FX_BITPIN_MAX_RESPONSE_BYTES);
    try {
      expect(await new BitpinFxSource(raised.http).read('USDT')).toEqual({
        kind: 'UNAVAILABLE',
        code: 'bitpin.malformed_response',
      });
    } finally {
      raised.close();
    }
  });
});
