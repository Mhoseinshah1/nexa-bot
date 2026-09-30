import type { FxBaseAsset, ProviderHttpClient } from '@nexa/contracts';
import { assertOutsideTransaction } from '../../../../infrastructure/transaction-boundary.js';
import type { FxSourceAdapter, FxSourceOutcome } from '../application/ports.js';
import { bestBid, isExactObject, parseExactJson, priceOf, transportOutcome } from './fx-source-parsing.js';

/**
 * Wallex, read off what its public API is documented to return (`docs/fx-audit.md` §2.2).
 *
 * The documentation hosts (`api-docs.wallex.ir`, `developers.wallex.ir`) could not be
 * fetched from the build session, so the shape is taken from two open-source clients
 * that mirror it (`darhelm/go-wallex`, 2025-11-23, and `amiwrpremium/wallex`,
 * 2022-11-22), which agree:
 *
 * - `GET /v1/depth?symbol={SYMBOL}` on `https://api.wallex.ir`, no authentication.
 * - The body: `{ "success": true, "result": { "ask": [{ "price", "quantity", "sum" }, …],
 *   "bid": [{ "price", "quantity", "sum" }, …] } }`. The Go client's own comment says
 *   `price` is a number-string in some answers and a number in others, and reads both;
 *   so does this, exactly, through the source-text reviver.
 * - The Tether–Toman market is `USDTTMN` (`TMN`: Toman), so every price here is TOMAN.
 *
 * The figure is the BEST BID, the highest price in `bid` — the merchant sells the USDT it
 * received (`FX_QUOTE_SIDE`) — computed rather than read from the first entry. Wallex
 * supplies no timestamp on the book, so `sourceAt` is null and only the fetch time is
 * recorded. `GET /v1/markets` carries `stats.bidPrice` for every market at once; the
 * single-market book is read instead because its body is small and bounded.
 *
 * What the live endpoint actually answers is still to be confirmed (§6 of the audit).
 */
export const WALLEX_BASE_URL = 'https://api.wallex.ir';
export const WALLEX_DEPTH_PATH = '/v1/depth';
/** Wallex's symbol for each base asset against Toman. */
const WALLEX_SYMBOLS: Readonly<Record<FxBaseAsset, string>> = { USDT: 'USDTTMN' };

export class WallexFxSource implements FxSourceAdapter {
  readonly source = 'WALLEX' as const;

  constructor(private readonly http: ProviderHttpClient) {}

  async read(baseAsset: FxBaseAsset): Promise<FxSourceOutcome> {
    assertOutsideTransaction('An exchange-rate read');
    const result = await this.http.send({
      method: 'GET',
      path: `${WALLEX_DEPTH_PATH}?symbol=${WALLEX_SYMBOLS[baseAsset]}`,
      effect: 'READ',
    });
    const transport = transportOutcome(result, 'wallex');
    if (transport !== null) return transport;
    if (!result.ok) return { kind: 'UNAVAILABLE', code: 'wallex.unreadable' };
    const body = parseExactJson(result.bodyText);
    if (!isExactObject(body)) return { kind: 'UNAVAILABLE', code: 'wallex.not_json' };
    if (body['success'] !== true) return { kind: 'UNAVAILABLE', code: 'wallex.not_success' };
    const payload = body['result'];
    if (!isExactObject(payload)) return { kind: 'UNAVAILABLE', code: 'wallex.no_result' };
    const bids = payload['bid'];
    if (!Array.isArray(bids)) return { kind: 'UNAVAILABLE', code: 'wallex.no_bids' };
    const best = bestBid(
      bids.map((level) => (isExactObject(level) ? priceOf(level['price']) : null)),
    );
    if (best === null) return { kind: 'UNAVAILABLE', code: 'wallex.no_bids' };
    return {
      kind: 'READ',
      reading: { source: this.source, rate: best, currency: 'IRT', sourceAt: null },
    };
  }
}
