import {
  COMMERCE_ERROR_CODES,
  errors,
  locationChangeWindow,
  type Clock,
  type LocationChangeLimits,
  type Money,
  type OrderId,
  type SalesCurrencyCode,
  type ServiceLocationId,
  type TenantContext,
} from '@nexa/contracts';
import type { SettingsResolver } from '../../../control/settings/application/settings-resolver.js';
import type { ServiceRecord } from '../../provisioning/application/ports.js';
import type {
  LocationChangeRepository,
  ServiceLocationRecord,
  ServiceLocationRepository,
} from './ports.js';

/** Where a service is: an adapter-defined key and the name its customer knows it by. */
export interface LocationPosition {
  readonly key: string;
  readonly label: string;
}

/** A configured location a service may be moved to, priced (zero is free). */
export type LocationTarget = ServiceLocationRecord & { readonly price: Money };

/** What one service may be moved to, right now. */
export interface LocationOffer {
  readonly current: LocationPosition;
  /** Never empty: an offer with nothing to move to is no offer. */
  readonly targets: readonly LocationTarget[];
}

export interface LocationChangePolicyDeps {
  readonly locations: Pick<ServiceLocationRepository, 'forPanel'>;
  readonly changes: Pick<LocationChangeRepository, 'countedRequestTimes'>;
  readonly settings: SettingsResolver;
  readonly clock: Clock;
}

/**
 * The ONE place that decides what a service may be moved to (WP-A6).
 *
 * Four callers — the button, the choice screen, the paid quote and its confirmation, and
 * the free request — and one answer, for the reason Phase 6B gave eligibility a single
 * evaluator: a predicate copied into four places disagrees with itself invisibly.
 *
 * What it decides is CONFIGURATION and HISTORY: where the service is, which configured
 * targets apply to it, and whether its cooldown and rolling limit allow another change.
 * What it does not decide is whether the panel can do it or whether the service is in a
 * state to be moved — `decideOperability`, `OPERATION_LEGAL_FROM` and
 * `ProvisioningService.prepareCommercialAction` own those, and every caller asks them too.
 *
 * ## Resolution, most specific first
 *
 * The rows that apply to a service are its panel's, panel-wide or scoped to its product.
 * For each location key the PRODUCT row wins over the panel-wide one, and it wins whatever
 * its switch says — so a product-scoped row that is disabled withdraws that target from
 * that product's services, which is how an operator excludes one product. Only then is
 * the winner asked whether it is enabled, priced, and priced in the selling currency.
 *
 * ## Where the service is
 *
 * Its own recorded location, or — never moved — its panel's INITIAL location. With
 * neither, "the target is where the service already is" cannot be decided, and the
 * service is offered nothing rather than being charged to move where it already is.
 */
export class LocationChangePolicy {
  constructor(private readonly deps: LocationChangePolicyDeps) {}

  /** The offer for one service, or null when there is none. A read. */
  async offer(
    scope: TenantContext,
    service: ServiceRecord,
    tx?: unknown,
  ): Promise<LocationOffer | null> {
    // A custom service (Package D) is extended by nothing in this release, moved included.
    if (service.productId === null) return null;
    const rows = await this.deps.locations.forPanel(scope, service.panelId, tx);
    const current = currentLocation(service, rows);
    if (current === null) return null;
    const currency = await this.salesCurrency(scope, tx);
    /*
     * The cooldown and the rolling limit too, from the same history and through the same
     * `locationChangeWindow` that `decide` asks (Codex review #1 on PR #101): a target its
     * window refuses is not drawn, and a service every target refuses is offered nothing,
     * so the button is not a promise its tap then breaks.
     */
    const history = await this.history(scope, service, null, tx);
    const now = this.deps.clock.now();
    const targets = resolvedTargets(rows, service.productId).filter(
      (row): row is LocationTarget =>
        row.locationKey !== current.key &&
        isOffered(row, currency) &&
        locationChangeWindow(row.limits, history, now).ok,
    );
    return targets.length === 0 ? null : { current, targets };
  }

  /**
   * One chosen target, decided for a quote, a confirmation or a free request — or refused
   * with the code the customer's sentence is chosen by.
   *
   * `excludeOrderId` leaves the order being confirmed out of the history it is checked
   * against. Called under the service's lifecycle lock by every write, so two requests for
   * one service count each other rather than both passing on one reading.
   *
   * `frozenLimits` is a paid move's confirmation: the window is decided against the
   * cooldown and limit the QUOTE was made under, never against terms written since — the
   * quote is honoured, and only what makes it unfulfillable is decided again.
   */
  async decide(
    scope: TenantContext,
    service: ServiceRecord,
    locationId: ServiceLocationId,
    now: Date,
    excludeOrderId: OrderId | null,
    tx?: unknown,
    frozenLimits?: LocationChangeLimits,
  ): Promise<{ readonly current: LocationPosition; readonly target: LocationTarget }> {
    const unavailable = () =>
      errors.conflict(
        COMMERCE_ERROR_CODES.SERVICE_ACTION_UNAVAILABLE,
        'That location is not offered for this service.',
      );
    if (service.productId === null) throw unavailable();
    const rows = await this.deps.locations.forPanel(scope, service.panelId, tx);
    const current = currentLocation(service, rows);
    if (current === null) throw unavailable();
    const currency = await this.salesCurrency(scope, tx);

    const chosen = resolvedTargets(rows, service.productId).find((row) => row.id === locationId);
    // Not this panel's, another product's, superseded by a more specific row, or switched
    // off or unpriced since the button was drawn: the same sentence for all of them.
    if (chosen === undefined || !isOffered(chosen, currency)) throw unavailable();
    if (chosen.locationKey === current.key) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.LOCATION_CHANGE_SAME_LOCATION,
        'The service is already in that location.',
      );
    }

    const history = await this.history(scope, service, excludeOrderId, tx);
    const window = locationChangeWindow(frozenLimits ?? chosen.limits, history, now);
    if (!window.ok) {
      throw window.reason === 'COOLDOWN'
        ? errors.conflict(
            COMMERCE_ERROR_CODES.LOCATION_CHANGE_COOLDOWN,
            'This service was moved too recently.',
          )
        : errors.conflict(
            COMMERCE_ERROR_CODES.LOCATION_CHANGE_LIMIT_REACHED,
            'This service has had as many location changes as the period allows.',
          );
    }
    return { current, target: chosen };
  }

  /** The request times that still count against this service's window. */
  private async history(
    scope: TenantContext,
    service: ServiceRecord,
    excludeOrderId: OrderId | null,
    tx?: unknown,
  ): Promise<readonly Date[]> {
    return this.deps.changes.countedRequestTimes(scope, service.id, excludeOrderId, tx);
  }

  private async salesCurrency(scope: TenantContext, tx?: unknown): Promise<SalesCurrencyCode> {
    return this.deps.settings.valueOf<SalesCurrencyCode>(scope, 'sales.currency', tx);
  }
}

/** Recorded, else the panel's initial location, else unknown. Exported for tests. */
export function currentLocation(
  service: Pick<ServiceRecord, 'locationKey' | 'locationLabel'>,
  rows: readonly ServiceLocationRecord[],
): LocationPosition | null {
  if (service.locationKey !== null && service.locationLabel !== null) {
    return { key: service.locationKey, label: service.locationLabel };
  }
  const initial = rows.find((row) => row.initial && row.productId === null);
  return initial === undefined ? null : { key: initial.locationKey, label: initial.label };
}

/**
 * The rows that apply to a service of `productId`, one per location key, the product row
 * winning over the panel-wide one. Order kept from the repository's (the operator's).
 */
export function resolvedTargets(
  rows: readonly ServiceLocationRecord[],
  productId: string,
): readonly ServiceLocationRecord[] {
  const byKey = new Map<string, ServiceLocationRecord>();
  for (const row of rows) {
    if (row.productId !== null && row.productId !== productId) continue;
    const held = byKey.get(row.locationKey);
    if (held === undefined || (held.productId === null && row.productId !== null)) {
      byKey.set(row.locationKey, row);
    }
  }
  return rows.filter((row) => byKey.get(row.locationKey) === row);
}

/** Enabled, priced, and priced in what this installation sells in. Zero is free. */
function isOffered(row: ServiceLocationRecord, currency: SalesCurrencyCode): row is LocationTarget {
  return row.enabled && row.price !== null && row.price.currency === currency;
}
