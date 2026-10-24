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
 * Ramzinex, read off the owner's recorded answer (Round 8, curl from the production server,
 * 2026-10-24; `docs/fx-audit.md` §8):
 *
 * - `GET /exchange/api/v1.0/exchange/pairs` on `https://api.ramzinex.com`, no key. The body:
 *   `{ "data": [ { "pair_id": 11, "name": { "en": "tether/rial" }, "buy": <n>, "sell": <n>, … }, … ] }`.
 *   The item whose `pair_id` is 11 (and, when it names itself, is `tether/rial`).
 * - The figure is the MID of `buy` and `sell`. They are JSON numbers and RIAL: the mid is
 *   divided by ten here, in this adapter and nowhere else, and rounded half up to a whole
 *   Toman. The numbers are read as their source text (`parseExactJson`), never as doubles.
 * - A missing pair, a name that is not tether/rial, or a figure that is not a plain
 *   positive decimal is this source's failure — never a zero.
 */
export const RAMZINEX_BASE_URL = 'https://api.ramzinex.com';
export const RAMZINEX_PAIRS_PATH = '/exchange/api/v1.0/exchange/pairs';
const RAMZINEX_PAIR_IDS: Readonly<Record<FxBaseAsset, { id: string; name: string }>> = {
  USDT: { id: '11', name: 'tether/rial' },
};

export class RamzinexFxSource implements FxSourceAdapter {
  readonly source = 'RAMZINEX' as const;

  constructor(private readonly http: ProviderHttpClient) {}

  async read(baseAsset: FxBaseAsset): Promise<FxSourceOutcome> {
    assertOutsideTransaction('An exchange-rate read');
    const result = await this.http.send({
      method: 'GET',
      path: RAMZINEX_PAIRS_PATH,
      effect: 'READ',
    });
    const transport = transportOutcome(result, 'ramzinex');
    if (transport !== null) return transport;
    if (!result.ok) return { kind: 'UNAVAILABLE', code: 'ramzinex.unreadable' };
    const body = parseExactJson(result.bodyText);
    if (!isExactObject(body)) return { kind: 'UNAVAILABLE', code: 'ramzinex.not_json' };
    const data = body['data'];
    if (!Array.isArray(data)) return { kind: 'UNAVAILABLE', code: 'ramzinex.no_market' };
    const wanted = RAMZINEX_PAIR_IDS[baseAsset];
    const pair = data.find((item) => isExactObject(item) && item['pair_id'] === wanted.id);
    if (!isExactObject(pair)) return { kind: 'UNAVAILABLE', code: 'ramzinex.no_market' };
    const name = pair['name'];
    if (isExactObject(name) && typeof name['en'] === 'string' && name['en'] !== wanted.name) {
      return { kind: 'UNAVAILABLE', code: 'ramzinex.no_market' };
    }
    const buy = priceOf(pair['buy']);
    const sell = priceOf(pair['sell']);
    if (buy === null || sell === null) return { kind: 'UNAVAILABLE', code: 'ramzinex.bad_price' };
    // Rial in, Toman out: the mid of two Rial figures over ten, one rounding, half up.
    const toman = wholeTomanMean([buy, sell], 10n);
    if (toman === null) return { kind: 'UNAVAILABLE', code: 'ramzinex.bad_price' };
    return {
      kind: 'READ',
      reading: { source: this.source, rate: toman, currency: 'IRT', sourceAt: null },
    };
  }
}
