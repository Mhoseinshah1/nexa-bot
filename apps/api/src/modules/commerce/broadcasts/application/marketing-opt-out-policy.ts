import type { BroadcastPurpose, TenantContext } from '@nexa/contracts';

/** Spec §9: the one question a MARKETING send asks of the opt-out switch. */
export interface MarketingOptOutPolicy {
  honoured(scope: TenantContext, tx?: unknown): Promise<boolean>;
}

/**
 * Spec §9: whether THIS send leaves out customers who opted out — a MARKETING send while the
 * installation honours the opt-out, and never a service announcement. One function for the
 * preview, the launch and the dispatcher's stamp, so the three cannot disagree on the rule.
 */
export async function excludesMarketingOptOuts(
  purpose: BroadcastPurpose,
  policy: MarketingOptOutPolicy | undefined,
  scope: TenantContext,
  tx?: unknown,
): Promise<boolean> {
  if (purpose !== 'MARKETING') return false;
  return policy === undefined ? true : policy.honoured(scope, tx);
}
