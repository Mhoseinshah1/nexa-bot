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
 * Wallex, read off the owner's recorded answer (Round 8, curl from the production server,
 * 2026-10-24; `docs/fx-audit.md` §8):
 *
 * - `GET /hector/web/v1/markets` on `https://api.wallex.ir`, no key. The body:
 *   `{ "result": { "markets": [ { "symbol": "USDTTMN", "price": <decimal>, … }, … ] } }`.
 *   The item whose `symbol` is `USDTTMN` (Tether–Toman); the field `price`. The unit is
 *   TOMAN. Rounded half up to a whole Toman. A list without the symbol, or a price that is
 *   not a plain positive decimal, is this source's failure — never a zero.
 *
 * Until Round 8 this adapter read `GET /v1/depth?symbol=USDTTMN`, a path taken from two
 * open-source clients and never confirmed against the live host (`OQ-FX-02`). The old
 * `wallex.not_json` is recorded in `docs/fx-audit.md` §8.
 */
export const WALLEX_BASE_URL = 'https://api.wallex.ir';
export const WALLEX_MARKETS_PATH = '/hector/web/v1/markets';
/** Wallex's symbol for each base asset against Toman. */
const WALLEX_SYMBOLS: Readonly<Record<FxBaseAsset, string>> = { USDT: 'USDTTMN' };

export class WallexFxSource implements FxSourceAdapter {
  readonly source = 'WALLEX' as const;

  constructor(private readonly http: ProviderHttpClient) {}

  async read(baseAsset: FxBaseAsset): Promise<FxSourceOutcome> {
    assertOutsideTransaction('An exchange-rate read');
    const result = await this.http.send({
      method: 'GET',
      path: WALLEX_MARKETS_PATH,
      effect: 'READ',
    });
    const transport = transportOutcome(result, 'wallex');
    if (transport !== null) return transport;
    if (!result.ok) return { kind: 'UNAVAILABLE', code: 'wallex.unreadable' };
    const body = parseExactJson(result.bodyText);
    if (!isExactObject(body)) return { kind: 'UNAVAILABLE', code: 'wallex.not_json' };
    const payload = body['result'];
    if (!isExactObject(payload)) return { kind: 'UNAVAILABLE', code: 'wallex.no_result' };
    const markets = payload['markets'];
    if (!Array.isArray(markets)) return { kind: 'UNAVAILABLE', code: 'wallex.no_market' };
    const market = markets.find(
      (item) => isExactObject(item) && item['symbol'] === WALLEX_SYMBOLS[baseAsset],
    );
    if (!isExactObject(market)) return { kind: 'UNAVAILABLE', code: 'wallex.no_market' };
    const price = priceOf(market['price']);
    const toman = price === null ? null : wholeTomanMean([price], 1n);
    if (toman === null) return { kind: 'UNAVAILABLE', code: 'wallex.bad_price' };
    return {
      kind: 'READ',
      reading: { source: this.source, rate: toman, currency: 'IRT', sourceAt: null },
    };
  }
}
