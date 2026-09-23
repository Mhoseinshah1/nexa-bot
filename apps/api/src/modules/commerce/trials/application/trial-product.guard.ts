import type { ProductId, ScopeContext, TenantContext } from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { SettingChangeGuard } from '../../../control/settings/application/settings.service.js';
import type { ProductRepository } from '../../catalog/application/ports.js';

/** The key this guard speaks for, named once. */
export const TRIAL_PRODUCT_KEY = 'trial.product_id';

/**
 * `trial.product_id` names a product this tenant actually has.
 *
 * The registry's schema can say "a UUIDv7 or empty" and nothing more; whether the id
 * belongs to a product — and to THIS tenant's product, since the repository reads by
 * tenant — is a question only the catalogue can answer. Without this a typo is stored,
 * the flag is turned on, and every customer is told there is no trial while the
 * settings screen shows one configured.
 *
 * It does not refuse a product that is merely unsellable today (inactive, no panel):
 * an operator configuring the trial before finishing the product is an ordinary order
 * of work, and `TrialService` decides availability at claim time anyway.
 */
export class TrialProductGuard implements SettingChangeGuard {
  readonly key = TRIAL_PRODUCT_KEY;

  constructor(private readonly products: Pick<ProductRepository, 'findById'>) {}

  async refuseChange(
    scope: ScopeContext,
    change: { readonly from: unknown; readonly to: unknown },
    tx: TransactionScope,
  ): Promise<string | null> {
    const next = change.to;
    if (next === null) return null;
    if (typeof next !== 'string') return 'The trial product must be a product id, or empty.';
    const product = await this.products.findById(scope as TenantContext, next as ProductId, tx);
    return product === null ? 'No product with that id exists in this installation.' : null;
  }
}
