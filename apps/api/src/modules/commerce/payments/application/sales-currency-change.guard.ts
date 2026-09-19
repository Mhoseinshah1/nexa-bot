import type { CurrencyCode, ScopeContext, TenantContext } from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { SettingChangeGuard } from '../../../control/settings/application/settings.service.js';
import type { RefundRepository } from './refund-ports.js';

/** The key this guard speaks for, named once. */
export const SALES_CURRENCY_KEY = 'sales.currency';

/**
 * `sales.currency` cannot move while money is still owed in the currency it is leaving.
 *
 * ## The defect this exists for
 *
 * An automatic refund credits the wallet in the PAYMENT's currency, frozen when the
 * payment was made — it has to, because that is the amount that arrived, and
 * converting it would be an implicit FX conversion at a rate nobody chose, which
 * `FBR-010` and the money model both refuse.
 *
 * Every wallet READ, though, is denominated in what the tenant sells in TODAY:
 * `balance`, `balanceForCustomer`, the history and every future settlement all resolve
 * `sales.currency`. So after a currency change, an automatic refund of an older
 * payment writes a credit the customer is TOLD about by
 * `ORDER_REFUNDED_TO_WALLET` and can then neither see nor spend. Money returned in
 * name only, with the notification lane vouching for it. Found by Codex.
 *
 * `confirmAndCredit` already refuses exactly this condition for a top-up
 * (`WALLET_CURRENCY_UNSUPPORTED`), which is the precedent: this product does not
 * write wallet entries in a denomination the wallet cannot read back.
 *
 * ## Why the change is refused rather than the refund
 *
 * Refusing the refund would be truthful and would put an undeliverable order back in
 * front of a human, which is the state the owner's two-outcome decision deleted. The
 * exposure is also bounded and temporary — it clears as those payments are settled or
 * refunded — while a retired-currency balance is a permanent second denomination in a
 * product built on exactly one.
 *
 * So the operator is stopped at the moment the problem is still cheap, and told what
 * stands in the way.
 */
export class SalesCurrencyChangeGuard implements SettingChangeGuard {
  readonly key = SALES_CURRENCY_KEY;

  constructor(private readonly refunds: Pick<RefundRepository, 'refundableExposureIn'>) {}

  async refuseChange(
    scope: ScopeContext,
    change: { readonly from: unknown; readonly to: unknown },
    tx: TransactionScope,
  ): Promise<string | null> {
    /*
     * The currency being LEFT is what matters. The one being adopted has no history
     * behind it yet, and an installation that has never sold has nothing to protect.
     */
    const leaving = change.from;
    if (typeof leaving !== 'string' || leaving === change.to) return null;

    const exposed = await this.refunds.refundableExposureIn(
      scope as TenantContext,
      leaving as CurrencyCode,
      tx,
    );
    if (exposed === 0) return null;

    return (
      `This installation still has ${String(exposed)} confirmed payment(s) in ${leaving} ` +
      'that could be refunded. A refund is credited in the currency it was paid in, and a ' +
      'wallet balance is read in the currency you sell in — so changing it now would ' +
      'return money the customer cannot see or spend. Refund or settle those payments first.'
    );
  }
}
