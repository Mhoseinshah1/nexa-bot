import type { FxBaseAsset, ProviderHttpClient } from '@nexa/contracts';
import { assertOutsideTransaction } from '../../../../infrastructure/transaction-boundary.js';
import type { FxSourceAdapter, FxSourceOutcome } from '../application/ports.js';
import { bestBid, isExactObject, parseExactJson, priceOf, transportOutcome } from './fx-source-parsing.js';

/**
 * Nobitex, read off its OWN published documentation (`nobitex/docs-api`,
 * `source/includes/_market_data.md`, commit d5330f0 of 2026-04-22; `docs/fx-audit.md` §2.1)
 * and nothing else:
 *
 * - `GET /v3/orderbook/{SYMBOL}` on `https://apiv2.nobitex.ir`, no token, documented at
 *   300 requests per minute, `GET` only (the page says `POST` is not supported here).
 * - The body: `{ "status": "ok", "lastUpdate": <unix ms>, "lastTradePrice": "<decimal>",
 *   "asks": [[price, amount], …], "bids": [[price, amount], …] }`, every price a STRING.
 *   The documentation names `bids` as the BUY orders (سفارش‌های خرید) and `asks` as the
 *   SELL orders, and `lastUpdate` as the book's last update time.
 * - The symbol `USDTIRT` is the Tether–Rial market. The documentation's `market/stats`
 *   example for the same markets is queried with `dstCurrency=rls` (ریال), and the 2022
 *   `USDTIRT` example book (`"277990"`) is a Rial figure; so every price here is RIAL,
 *   and the service converts to the sales currency exactly (one Toman is ten Rial).
 *
 * The figure taken is the BEST BID — the highest price in `bids` — because the merchant
 * sells the USDT it received (`FX_QUOTE_SIDE`). The highest is computed rather than the
 * first entry trusted: the documentation shows the books sorted but does not promise it.
 *
 * `market/stats` (`bestBuy`, 20 requests per minute) carries the same figure with no
 * timestamp and a tighter limit, which is why the order book is read instead.
 */
export const NOBITEX_BASE_URL = 'https://apiv2.nobitex.ir';
export const NOBITEX_ORDERBOOK_PATH = '/v3/orderbook';
/** Nobitex's symbol for each base asset against Rial. */
const NOBITEX_SYMBOLS: Readonly<Record<FxBaseAsset, string>> = { USDT: 'USDTIRT' };

export class NobitexFxSource implements FxSourceAdapter {
  readonly source = 'NOBITEX' as const;

  constructor(private readonly http: ProviderHttpClient) {}

  async read(baseAsset: FxBaseAsset): Promise<FxSourceOutcome> {
    assertOutsideTransaction('An exchange-rate read');
    const result = await this.http.send({
      method: 'GET',
      path: `${NOBITEX_ORDERBOOK_PATH}/${NOBITEX_SYMBOLS[baseAsset]}`,
      effect: 'READ',
    });
    const transport = transportOutcome(result, 'nobitex');
    if (transport !== null) return transport;
    if (!result.ok) return { kind: 'UNAVAILABLE', code: 'nobitex.unreadable' };
    const body = parseExactJson(result.bodyText);
    if (!isExactObject(body)) return { kind: 'UNAVAILABLE', code: 'nobitex.not_json' };
    if (body['status'] !== 'ok') {
      return { kind: 'UNAVAILABLE', code: `nobitex.status_${statusWord(body['status'])}` };
    }
    const bids = body['bids'];
    if (!Array.isArray(bids)) return { kind: 'UNAVAILABLE', code: 'nobitex.no_bids' };
    const best = bestBid(
      bids.map((level) => (Array.isArray(level) ? priceOf(level[0]) : null)),
    );
    if (best === null) return { kind: 'UNAVAILABLE', code: 'nobitex.no_bids' };
    const lastUpdate = body['lastUpdate'];
    const sourceAt =
      typeof lastUpdate === 'string' && /^[0-9]{1,16}$/u.test(lastUpdate)
        ? new Date(Number(lastUpdate))
        : null;
    return {
      kind: 'READ',
      reading: { source: this.source, rate: best, currency: 'IRR', sourceAt },
    };
  }
}

function statusWord(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[^a-z0-9_]/giu, '').slice(0, 24) : 'unknown';
}
