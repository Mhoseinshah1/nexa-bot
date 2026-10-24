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
 * Tabdeal, read off the owner's recorded answer (Round 8, curl from the production server,
 * 2026-10-24; `docs/fx-audit.md` §8):
 *
 * - `GET /r/api/v1/depth?tabdealSymbol=USDT_IRT&limit=1` on `https://api1.tabdeal.org`, no
 *   key. The body: `{ "asks": [["268840.00…", "51.0…"]], "bids": [["268502.00…", "124.0…"]] }`,
 *   every figure a decimal STRING.
 * - The unit is TOMAN.
 * - The figure is the MID of `asks[0][0]` and `bids[0][0]`, the owner's rule for this source
 *   (the other adapters read a best bid). Computed exactly on scaled integers and rounded
 *   half up to a whole Toman. A book with an empty side, or a price that is not a plain
 *   positive decimal, is this source's failure — never a one-sided figure and never a zero.
 */
export const TABDEAL_BASE_URL = 'https://api1.tabdeal.org';
export const TABDEAL_DEPTH_PATH = '/r/api/v1/depth';
const TABDEAL_SYMBOLS: Readonly<Record<FxBaseAsset, string>> = { USDT: 'USDT_IRT' };

export class TabdealFxSource implements FxSourceAdapter {
  readonly source = 'TABDEAL' as const;

  constructor(private readonly http: ProviderHttpClient) {}

  async read(baseAsset: FxBaseAsset): Promise<FxSourceOutcome> {
    assertOutsideTransaction('An exchange-rate read');
    const result = await this.http.send({
      method: 'GET',
      path: `${TABDEAL_DEPTH_PATH}?tabdealSymbol=${TABDEAL_SYMBOLS[baseAsset]}&limit=1`,
      effect: 'READ',
    });
    const transport = transportOutcome(result, 'tabdeal');
    if (transport !== null) return transport;
    if (!result.ok) return { kind: 'UNAVAILABLE', code: 'tabdeal.unreadable' };
    const body = parseExactJson(result.bodyText);
    if (!isExactObject(body)) return { kind: 'UNAVAILABLE', code: 'tabdeal.not_json' };
    const asks = body['asks'];
    const bids = body['bids'];
    const topAsk = Array.isArray(asks) && Array.isArray(asks[0]) ? asks[0][0] : undefined;
    const topBid = Array.isArray(bids) && Array.isArray(bids[0]) ? bids[0][0] : undefined;
    const ask = priceOf(topAsk);
    const bid = priceOf(topBid);
    if (ask === null || bid === null) return { kind: 'UNAVAILABLE', code: 'tabdeal.bad_price' };
    const mid = wholeTomanMean([ask, bid], 1n);
    if (mid === null) return { kind: 'UNAVAILABLE', code: 'tabdeal.bad_price' };
    return {
      kind: 'READ',
      reading: { source: this.source, rate: mid, currency: 'IRT', sourceAt: null },
    };
  }
}
