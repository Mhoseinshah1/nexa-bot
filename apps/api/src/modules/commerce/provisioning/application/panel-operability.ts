import {
  OPERATION_REQUIRED_CAPABILITIES,
  PANEL_ACTIVATION_SCHEMAS,
  isProviderType,
  providerDescriptor,
  shapeIsSatisfiedBy,
  supportsCapability,
  type OperationType,
  type PanelActivation,
  type ProviderCapability,
} from '@nexa/contracts';
import type { PanelOperability } from './ports.js';

/**
 * What the decision needs to know about a panel. Deliberately not a `PanelRecord`.
 *
 * Four fields and a credential SUMMARY — three booleans saying which credentials are
 * configured, and not one value. That is the whole reason this function can be called
 * from a surface: answering "can this panel be operated" must not decrypt anything,
 * and a signature that could not receive a secret is a stronger guarantee than a rule
 * about not passing one.
 */
export interface OperabilityInput {
  /** Null when the panel does not exist in this tenant, or has been archived. */
  readonly panel: {
    readonly status: string;
    readonly providerType: string;
    readonly baseUrl: string;
    readonly archivedAt: Date | null;
    /** Exactly as stored. Validated here, never trusted. */
    readonly activation: unknown;
  } | null;
  readonly credentials: {
    readonly usernameSetAt: Date | null;
    readonly passwordSetAt: Date | null;
    readonly apiTokenSetAt: Date | null;
  } | null;
  readonly type: OperationType;
  /**
   * Whether this release has an adapter implementing the SERVICE half for this
   * provider type.
   *
   * Passed in rather than imported, because the registry is infrastructure and this is
   * the application layer. It is also the honest seam: "a descriptor exists" and "code
   * exists that can create a user" are different statements, and Marzban spent three
   * releases being the first without being the second.
   */
  readonly serviceAdapterExists: boolean;
}

/**
 * Whether one operation can run against one panel, and if not, which screen fixes it.
 *
 * ONE place, so the question has one answer. The alternative — each caller checking
 * status, then adapter, then capability, then credentials, then activation — is five
 * checks in five orders, and the one that gets skipped is always the last.
 *
 * The ORDER here is deliberate and is not alphabetical. It goes from the most
 * operator-intentional cause to the most incidental: a `DISABLED` panel is somebody's
 * decision and must be reported as that even when its credentials are also missing,
 * because telling an operator to re-enter a password on a panel they deliberately
 * switched off is telling them to fix the wrong thing.
 *
 * Health is deliberately NOT an input. `panel_health` is latest-state-only and a panel
 * may be `UNCHECKED`; refusing to provision onto an unprobed panel would make a fresh
 * installation unable to sell anything, and a genuinely unhealthy panel fails the real
 * call — which is classified by the existing taxonomy and is more honest than a
 * pre-emptive refusal based on a possibly stale read.
 */
export function decideOperability(input: OperabilityInput): PanelOperability {
  const { panel } = input;
  if (panel === null || panel.archivedAt !== null) {
    return { ok: false, reason: 'PANEL_ABSENT' };
  }
  if (panel.status !== 'ACTIVE') {
    return { ok: false, reason: 'PANEL_DISABLED' };
  }
  if (!isProviderType(panel.providerType) || !input.serviceAdapterExists) {
    return { ok: false, reason: 'PROVIDER_NOT_OPERABLE' };
  }
  const descriptor = providerDescriptor(panel.providerType);
  if (descriptor === undefined) {
    /*
     * A provider type with no descriptor.
     *
     * Unreachable while `isProviderType` and the descriptor list agree, and checked
     * anyway rather than asserted: the alternative is a non-null assertion that would
     * turn a contract edit into a runtime throw on somebody's installation, at the
     * moment they were trying to deliver a service somebody paid for.
     */
    return { ok: false, reason: 'PROVIDER_NOT_OPERABLE' };
  }
  const required = OPERATION_REQUIRED_CAPABILITIES[input.type];
  for (const capability of required) {
    if (!supportsCapability(descriptor, capability as ProviderCapability)) {
      return { ok: false, reason: 'CAPABILITY_UNSUPPORTED' };
    }
  }
  if (
    !shapeIsSatisfiedBy(descriptor.credentialShape, {
      username: input.credentials?.usernameSetAt != null,
      password: input.credentials?.passwordSetAt != null,
      apiToken: input.credentials?.apiTokenSetAt != null,
    })
  ) {
    return { ok: false, reason: 'CREDENTIALS_MISSING' };
  }
  const activation = PANEL_ACTIVATION_SCHEMAS[panel.providerType].safeParse(panel.activation);
  if (!activation.success) {
    /*
     * Unset, or set to something this provider's schema does not accept.
     *
     * The same answer for both, because the remedy is the same screen and the same
     * field. A row that was valid under an older schema and is not under this one is
     * the interesting case, and it is handled here rather than at read time: refusing
     * the operation is right, and rewriting somebody's configuration to make it parse
     * would be the legacy behaviour of silently changing what an operator set.
     */
    return { ok: false, reason: 'ACTIVATION_INCOMPLETE' };
  }
  return {
    ok: true,
    providerType: panel.providerType,
    baseUrl: panel.baseUrl,
    activation: activation.data as PanelActivation,
  };
}
