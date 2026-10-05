import { errors, isSystemContext, type ScopeContext, type TenantContext } from '@nexa/contracts';
import type { SupportContextBuilder } from '../../../commerce/support-context/application/support-context.builder.js';
import type { SupportContextSource } from '../application/support-assist.service.js';

/**
 * TB5 — the Assist service's view of the TB3 support context.
 *
 * The model reads the allowlisted payload as JSON. The operator, beside the draft, reads a
 * short label per alias the draft cited — the service's own username, an order's title, a
 * payment's method and amount — never a row id: the id map (`references`) stays inside TB3.
 */
export class TbSupportContextSource implements SupportContextSource {
  constructor(private readonly builder: Pick<SupportContextBuilder, 'build'>) {}

  async build(scope: ScopeContext, customerId: string | null) {
    const { payload } = await this.builder.build(tenantOf(scope), customerId);
    const aliases = new Map<string, string>();
    for (const service of payload.services) aliases.set(service.alias, service.label);
    for (const order of payload.orders) aliases.set(order.alias, order.title);
    for (const payment of payload.payments) {
      aliases.set(
        payment.alias,
        `${payment.method} ${payment.amount.amountMinor} ${payment.amount.currency}`,
      );
    }
    return {
      json: JSON.stringify(payload),
      aliases,
      linked: payload.flags.identityLinked,
      flags: payload.flags,
    };
  }
}

function tenantOf(scope: ScopeContext): TenantContext {
  if (isSystemContext(scope)) {
    throw errors.internal('support_ai.scope', 'The support context needs a tenant scope.');
  }
  return scope;
}
