import type { ServiceId } from './ids.js';

/**
 * The provider adapter contract.
 *
 * Every panel type is an adapter implementing this interface and DECLARING its
 * capabilities as data. Capabilities are never inferred from a version string,
 * and no code outside the adapter registry branches on provider type.
 *
 * The evidence says the differences are of kind, not degree: 3X-UI carries a
 * single opaque token where Marzban has a username and password, and requires a
 * separately configured subscription-link domain because its sub URL is not
 * derived from the panel address. A manual-sale provider has no backend at all.
 * An interface validated against one implementation is not an interface.
 *
 * Phase 0 ships the interface and the capability vocabulary only. Adapters —
 * and any network call to a real panel — are Phase 3.
 */

export const PROVIDER_CAPABILITIES = [
  'CREATE_USER',
  'RENEW_USER',
  'DELETE_USER',
  'DISABLE_USER',
  'ENABLE_USER',
  'READ_USAGE',
  'RESET_USAGE',
  'ADD_VOLUME',
  'ADD_TIME',
  'ROTATE_SUBSCRIPTION_LINK',
  'DELIVER_SUBSCRIPTION_LINK',
  'DELIVER_RAW_CONFIGS',
  'DELIVER_CONFIG_FILE',
  'LIMIT_DEVICES',
  'INACTIVE_ACCOUNT_INBOUND',
  'HEALTH_CHECK',
] as const;
export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];

export const CREDENTIAL_SHAPES = ['USERNAME_PASSWORD', 'OPAQUE_TOKEN', 'NONE'] as const;
export type CredentialShape = (typeof CREDENTIAL_SHAPES)[number];

/**
 * Static description of a provider type. Display names come from the template
 * catalog; `key` is the stable identifier and is never a display string.
 */
export interface ProviderDescriptor {
  readonly key: string;
  readonly canonicalName: string;
  readonly credentialShape: CredentialShape;
  readonly capabilities: readonly ProviderCapability[];
  /**
   * Fields that must be configured before this provider can build a config at
   * all. 3X-UI needs a subscription-link domain; Marzban does not.
   */
  readonly requiredActivationFields: readonly string[];
}

/**
 * What a customer actually receives. The payload is provider-specific — a
 * subscription link, raw configs, a file, or a credential pair — so the adapter
 * returns a typed delivery object rather than a link string.
 */
export type ServiceDelivery =
  | { readonly kind: 'SUBSCRIPTION_LINK'; readonly url: string }
  | { readonly kind: 'RAW_CONFIGS'; readonly configs: readonly string[] }
  | {
      readonly kind: 'CONFIG_FILE';
      readonly filename: string;
      readonly contentType: string;
      readonly content: Uint8Array;
    }
  | { readonly kind: 'CREDENTIALS'; readonly username: string; readonly secretRef: string }
  | { readonly kind: 'NONE' };

export interface ProviderUsage {
  readonly usedBytes: bigint;
  readonly totalBytes: bigint | null;
  readonly expiresAt: Date | null;
  readonly lastConnectionAt: Date | null;
}

export interface CreateProviderUserInput {
  /**
   * Deterministic, derived from stable order identifiers, so that a retry after
   * a timeout converges on one remote user instead of creating a second.
   * It is opaque and carries no Telegram id.
   */
  readonly username: string;
  readonly serviceId: ServiceId;
  readonly volumeBytes: bigint | null;
  readonly durationDays: number | null;
  readonly deviceLimit: number | null;
}

export interface ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  supports(capability: ProviderCapability): boolean;
  createUser(input: CreateProviderUserInput): Promise<ServiceDelivery>;
  readUsage(username: string): Promise<ProviderUsage>;
  healthCheck(): Promise<{ healthy: boolean; detail: string }>;
}

export function supportsCapability(
  descriptor: ProviderDescriptor,
  capability: ProviderCapability,
): boolean {
  return descriptor.capabilities.includes(capability);
}

/** Phase 0 registers no providers. Marzban, 3X-UI and manual-sale land in Phase 3. */
export const PROVIDER_DESCRIPTORS: readonly ProviderDescriptor[] = [];
