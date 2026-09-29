import type { ClientAppDeliveryKind, ClientAppProtocol, ProviderType } from '@nexa/contracts';

/** What an entry declares it works with. Empty is "any", per dimension. */
export interface ClientAppCompatibility {
  readonly deliveryKinds: readonly ClientAppDeliveryKind[];
  readonly protocols: readonly ClientAppProtocol[];
  readonly providerTypes: readonly ProviderType[];
}

/** What is known about one live service. `null` is "not known". */
export interface ServiceCompatibilityFacts {
  readonly deliveryKinds: readonly ClientAppDeliveryKind[];
  readonly protocols: readonly ClientAppProtocol[] | null;
  readonly providerType: ProviderType | null;
}

/**
 * Whether an app is worth showing to a customer whose live services are `services`.
 *
 * The rule, in full:
 *   - a customer with NO live service is shown every enabled app of the platform — there
 *     is nothing to filter by, and "I have not bought yet, which app do I need" is a real
 *     question;
 *   - otherwise an app is shown when it fits AT LEAST ONE of their services;
 *   - an app fits a service when, on every dimension, the app names nothing (any), OR the
 *     service's fact is unknown, OR the two share a member.
 *
 * Capability- and type-driven, and nothing else: no provider is named here, and a new
 * provider needs no line in this function. An unknown fact never excludes, because an app
 * hidden on a guess is an app the customer needed and was never told about; a KNOWN fact
 * that disagrees does, which is the whole point — a files-only client is noise to a
 * customer whose panel cannot hand over files.
 */
export function isClientAppRelevant(
  app: ClientAppCompatibility,
  services: readonly ServiceCompatibilityFacts[],
): boolean {
  if (services.length === 0) return true;
  return services.some(
    (service) =>
      fits(app.deliveryKinds, service.deliveryKinds) &&
      fits(app.protocols, service.protocols) &&
      fits(app.providerTypes, service.providerType === null ? null : [service.providerType]),
  );
}

function fits<T extends string>(declared: readonly T[], known: readonly T[] | null): boolean {
  if (declared.length === 0 || known === null) return true;
  return declared.some((member) => known.includes(member));
}
