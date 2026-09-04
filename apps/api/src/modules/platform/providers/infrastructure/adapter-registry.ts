import {
  isProviderType,
  NexaError,
  PANEL_ERROR_CODES,
  PROVIDER_TYPES,
  type ProviderConnectionAdapter,
  type ProviderType,
} from '@nexa/contracts';
import { MarzbanAdapter } from './marzban.adapter.js';
import { SanaeiAdapter } from './sanaei.adapter.js';

/**
 * Provider type to adapter. The only place a type becomes behaviour.
 *
 * Exhaustive over `ProviderType` by construction — `Record<ProviderType, …>`
 * means adding a member to the contract without adding an adapter here is a
 * compile error rather than a runtime surprise on somebody's installation.
 *
 * `sanaei` joined the map in Phase 3B, and the ORDER of those two events is
 * the point: the type, the CHECK constraint and the descriptor shipped in
 * Phase 3A as one contract change, and `providerAdapter` refused a panel of
 * that type for a whole release rather than advertising a provider nothing
 * could operate. A registration is therefore a statement that an adapter
 * exists and has been tested against the wire, which is why this map — and not
 * the descriptor list — is what `IMPLEMENTED_PROVIDER_TYPES` is built from.
 *
 * The map stays `Partial` because that refusal is a real state a future
 * provider will pass through again, and because `providerAdapter` failing
 * closed is worth keeping whether or not anything currently needs it.
 *
 * What must not happen is a panel of one type being silently operated by a
 * DIFFERENT adapter, and that is what this file makes impossible.
 */
const ADAPTERS: Partial<Record<ProviderType, () => ProviderConnectionAdapter>> = {
  marzban: () => new MarzbanAdapter(),
  sanaei: () => new SanaeiAdapter(),
};

/** The provider types this release can actually operate, as opposed to name. */
export const IMPLEMENTED_PROVIDER_TYPES: readonly ProviderType[] = PROVIDER_TYPES.filter(
  (type) => ADAPTERS[type] !== undefined,
);

/**
 * The adapter for a persisted provider type.
 *
 * Fails closed, twice over. An unrecognised string — from a migration, a direct
 * database write, or a downgrade to a release that knows fewer providers —
 * throws rather than falling back to a default adapter, because a default here
 * would be operating somebody's production panel with the wrong protocol. And a
 * type this release knows but cannot yet operate throws the same way, with a
 * message that says which.
 *
 * `CONFIGURATION` rather than `NOT_FOUND`: the panel exists and the
 * installation cannot act on it, which is an operator's problem to solve rather
 * than a caller's mistake.
 */
export function providerAdapter(providerType: string): ProviderConnectionAdapter {
  const factory = isProviderType(providerType) ? ADAPTERS[providerType] : undefined;
  if (factory === undefined) {
    throw new NexaError({
      kind: 'CONFIGURATION',
      code: PANEL_ERROR_CODES.PROVIDER_TYPE_UNSUPPORTED,
      message: isProviderType(providerType)
        ? `This release does not yet implement the "${providerType}" provider. The panel is unchanged; nothing was contacted.`
        : 'This panel names a provider this release does not know. It may have been created by a newer release.',
      // The TYPE is not a secret and naming it is what makes the message
      // actionable. Nothing else about the panel appears here.
      details: { providerType },
    });
  }
  return factory();
}
