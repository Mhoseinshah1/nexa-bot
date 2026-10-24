import type { FxBaseAsset, ProviderHttpClient } from '@nexa/contracts';
import { assertOutsideTransaction } from '../../../../infrastructure/transaction-boundary.js';
import type { FxSourceAdapter, FxSourceOutcome } from '../application/ports.js';
import {
  isExactObject,
  parseExactJson,
  priceOf,
  transportOutcome,
  wholeTomanMean,
} from './fx-source-parsing.js';

/**
 * Bitpin, read off the owner's recorded answer (Round 8, curl from the production server,
 * 2026-10-24; `docs/fx-audit.md` §8):
 *
 * - `GET /v1/mkt/markets/` on `https://api.bitpin.ir`, no key. About 275 KB, Brotli or gzip
 *   (the outbound client decodes both; Bitpin has its own 320 KiB decompressed cap).
 * - The body: `{ "results": [ { "code": "USDT_IRT", "price": "<decimal string>", … }, … ] }`.
 *   The item whose `code` is `USDT_IRT`; the field `price` (the last trade). The unit is
 *   TOMAN.
 * - A list without the market, or a price that is not a plain positive decimal, is this
 *   source's failure — never a zero. Rounded half up to a whole Toman.
 */
export const BITPIN_BASE_URL = 'https://api.bitpin.ir';
export const BITPIN_MARKETS_PATH = '/v1/mkt/markets/';
const BITPIN_CODES: Readonly<Record<FxBaseAsset, string>> = { USDT: 'USDT_IRT' };

export class BitpinFxSource implements FxSourceAdapter {
  readonly source = 'BITPIN' as const;

  constructor(private readonly http: ProviderHttpClient) {}

  async read(baseAsset: FxBaseAsset): Promise<FxSourceOutcome> {
    assertOutsideTransaction('An exchange-rate read');
    const result = await this.http.send({
      method: 'GET',
      path: BITPIN_MARKETS_PATH,
      effect: 'READ',
    });
    const transport = transportOutcome(result, 'bitpin');
    if (transport !== null) return transport;
    if (!result.ok) return { kind: 'UNAVAILABLE', code: 'bitpin.unreadable' };
    const body = parseExactJson(result.bodyText);
    if (!isExactObject(body)) return { kind: 'UNAVAILABLE', code: 'bitpin.not_json' };
    const results = body['results'];
    if (!Array.isArray(results)) return { kind: 'UNAVAILABLE', code: 'bitpin.no_market' };
    const market = results.find(
      (item) => isExactObject(item) && item['code'] === BITPIN_CODES[baseAsset],
    );
    if (!isExactObject(market)) return { kind: 'UNAVAILABLE', code: 'bitpin.no_market' };
    const price = priceOf(market['price']);
    const toman = price === null ? null : wholeTomanMean([price], 1n);
    if (toman === null) return { kind: 'UNAVAILABLE', code: 'bitpin.bad_price' };
    return {
      kind: 'READ',
      reading: { source: this.source, rate: toman, currency: 'IRT', sourceAt: null },
    };
  }
}
