import {
  errors,
  resolvePanelPolicy,
  COMMERCE_ERROR_CODES,
  customerActionVerdict,
  type PanelCustomerAction,
  type PanelPolicy,
  type ResolvedPanelPolicy,
  type TenantContext,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';

/**
 * A panel's operator policy, as stored (WP-A8).
 *
 * `policy` is `unknown` for the reason `PanelRecord.activation` is: the row holds whatever
 * a release wrote, and only `resolvePanelPolicy` decides what it means — including that a
 * row which does not parse refuses every customer action rather than allowing them.
 */
export interface StoredPanelPolicy {
  readonly policy: unknown;
  readonly revision: number;
  readonly updatedAt: Date;
}

export interface PanelPolicyRepository {
  find(
    scope: TenantContext,
    panelId: string,
    tx?: TransactionScope,
  ): Promise<StoredPanelPolicy | null>;
  /**
   * Stores `policy` if and only if the stored revision is `expectedRevision` — zero
   * meaning "no row yet". Null when it is not, which the caller reports as stale: the
   * conditional write is the rule, and the panel lock the caller holds only makes the
   * refusal rare.
   */
  save(
    scope: TenantContext,
    panelId: string,
    policy: PanelPolicy,
    expectedRevision: number,
    now: Date,
    tx: TransactionScope,
  ): Promise<StoredPanelPolicy | null>;
}

/**
 * The ONE reader every customer-action decision asks.
 *
 * Narrow on purpose — a scope, a panel, an optional transaction and a resolved policy
 * back — so the four services that consult it (commercial actions, customer operations,
 * subscription files, delivery) hold no way to write one.
 */
export interface PanelPolicyGate {
  forPanel(scope: TenantContext, panelId: string, tx?: unknown): Promise<ResolvedPanelPolicy>;
}

export class PanelPolicyReader implements PanelPolicyGate {
  constructor(private readonly repository: Pick<PanelPolicyRepository, 'find'>) {}

  async forPanel(
    scope: TenantContext,
    panelId: string,
    tx?: unknown,
  ): Promise<ResolvedPanelPolicy> {
    const stored = await this.repository.find(scope, panelId, tx as TransactionScope | undefined);
    return resolvePanelPolicy(stored?.policy ?? null);
  }
}

/**
 * Refuses a customer action a panel's policy does not allow.
 *
 * `PANEL_NOT_OPERABLE`, the code a customer already receives when the panel cannot
 * perform the action, and therefore the sentence they already receive: "this is not
 * available for your service". Telling them an operator switched it off would describe
 * the tenant's configuration to a customer, which the refusal table in `bot-runtime`
 * declines to do for every other configuration refusal. The reason is in the details,
 * for the operational log and a test.
 */
export function assertCustomerPolicyAllows(
  resolved: ResolvedPanelPolicy,
  action: PanelCustomerAction,
): void {
  const verdict = customerActionVerdict(resolved, action);
  if (!verdict.allowed) {
    throw errors.conflict(
      COMMERCE_ERROR_CODES.PANEL_NOT_OPERABLE,
      'The panel this service lives on does not offer that action to customers.',
      { reason: 'CUSTOMER_POLICY', policy: verdict.reason, action },
    );
  }
}
