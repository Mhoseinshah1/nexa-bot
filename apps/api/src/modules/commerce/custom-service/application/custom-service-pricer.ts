import {
  CUSTOM_SERVICE_MAX_DAYS,
  CUSTOM_SERVICE_MAX_VOLUME_UNITS,
  type CustomServiceRuleDimension,
  type SalesCurrencyCode,
  type TenantContext,
} from '@nexa/contracts';
import type { FeatureFlagResolver } from '../../../control/features/application/feature-flags.service.js';
import type { SettingsResolver } from '../../../control/settings/application/settings-resolver.js';
import type { PanelSalesGate } from '../../../platform/panels/application/panel-sales-gate.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { ResellerService } from '../../resellers/application/reseller.service.js';
import {
  anyRuleFor,
  ruleLevelFor,
  priceCustomService,
  selectCustomServiceRule,
  type CustomServicePrice,
  type CustomServiceSubject,
} from '../domain/custom-service-pricing.js';
import type {
  CustomServiceLocationRecord,
  CustomServiceLocationRepository,
  CustomServiceRuleRepository,
} from './ports.js';

export interface CustomServicePricerDeps {
  readonly rules: CustomServiceRuleRepository;
  readonly locations: CustomServiceLocationRepository;
  readonly panelSales: Pick<PanelSalesGate, 'evaluate' | 'eligiblePanelIds'>;
  readonly resellers: Pick<ResellerService, 'standing'>;
  readonly features: Pick<FeatureFlagResolver, 'isEnabled'>;
  readonly settings: SettingsResolver;
}

/** The inclusive bounds the configured rules price for one dimension, in the rule's own unit. */
export interface CustomServiceRange {
  readonly min: bigint;
  readonly max: bigint;
}

/** A location a customer may be offered, by its customer-facing label. */
export interface OfferedLocation {
  readonly panelId: string;
  readonly label: string;
}

export type CustomServiceUnavailableReason =
  | 'LOCATION_NOT_OFFERED'
  | 'PANEL_NOT_ELIGIBLE'
  | 'NO_VOLUME_RULE'
  | 'NO_TIME_RULE'
  | 'AMBIGUOUS_VOLUME_RULE'
  | 'AMBIGUOUS_TIME_RULE'
  | 'CURRENCY_MISMATCH';

export type CustomServiceQuote =
  | {
      readonly kind: 'PRICED';
      readonly location: CustomServiceLocationRecord;
      readonly price: CustomServicePrice;
    }
  | { readonly kind: 'UNAVAILABLE'; readonly reason: CustomServiceUnavailableReason };

/**
 * The one answer to "can this customer buy this custom service, and for how much"
 * (`docs/package-d-custom-service-audit.md` §4, §8).
 *
 * The location list, the volume check before the days are asked, the draft and the
 * confirmation all ask HERE, so none of them can disagree with the others about which
 * rule prices a request. Inside a transaction the tenant's rules lock is taken SHARED
 * before the rules are read, and the location FOR SHARE, so an operator's edit either
 * lands before and is seen, or waits for the transaction that relies on what it read.
 */
export class CustomServicePricer {
  constructor(private readonly deps: CustomServicePricerDeps) {}

  async enabled(scope: TenantContext, tx?: unknown): Promise<boolean> {
    return this.deps.features.isEnabled(scope, 'custom_service', tx);
  }

  /**
   * The locations to offer this customer, now — a COURTESY, like the catalogue: every
   * figure is decided again when it is typed, and again at confirmation. Empty when the
   * flag is off.
   */
  async offeredLocations(
    scope: TenantContext,
    customerId: string,
  ): Promise<readonly OfferedLocation[]> {
    if (!(await this.enabled(scope))) return [];
    const locations = (await this.deps.locations.list(scope)).filter((l) => l.enabled);
    if (locations.length === 0) return [];
    const eligible = new Set(await this.deps.panelSales.eligiblePanelIds(scope));
    const rules = await this.deps.rules.list(scope);
    const tierId = await this.tierOf(scope, customerId);
    return locations
      .filter((location) => eligible.has(location.panelId))
      .filter((location) => {
        const subject: CustomServiceSubject = { customerId, tierId, panelId: location.panelId };
        return anyRuleFor(rules, 'VOLUME', subject) && anyRuleFor(rules, 'TIME', subject);
      })
      .map((location) => ({ panelId: location.panelId, label: location.label }));
  }

  /** One offered location, re-decided, or null. What the location tap and the volume turn ask. */
  async offeredLocation(
    scope: TenantContext,
    customerId: string,
    panelId: string,
  ): Promise<OfferedLocation | null> {
    const offered = await this.offeredLocations(scope, customerId);
    return offered.find((location) => location.panelId === panelId) ?? null;
  }

  /**
   * Whether a VOLUME rule would price this figure for this customer on this location —
   * asked when the volume is typed, so an unpriceable figure is refused before the days
   * are asked for. A courtesy: the draft decides both dimensions again.
   */
  async volumePriceable(
    scope: TenantContext,
    customerId: string,
    panelId: string,
    volumeUnits: bigint,
  ): Promise<boolean> {
    const rules = await this.deps.rules.list(scope);
    const tierId = await this.tierOf(scope, customerId);
    const subject: CustomServiceSubject = { customerId, tierId, panelId };
    return selectCustomServiceRule(rules, 'VOLUME', volumeUnits, subject).kind === 'SELECTED';
  }

  /**
   * Whether a TIME rule would price this many days for this customer on this location —
   * the days counterpart of `volumePriceable`, asked when the days are typed.
   */
  async daysPriceable(
    scope: TenantContext,
    customerId: string,
    panelId: string,
    days: number,
  ): Promise<boolean> {
    const rules = await this.deps.rules.list(scope);
    const tierId = await this.tierOf(scope, customerId);
    const subject: CustomServiceSubject = { customerId, tierId, panelId };
    return selectCustomServiceRule(rules, 'TIME', BigInt(days), subject).kind === 'SELECTED';
  }

  /**
   * The bounds of what this customer can be priced for on this location: the lowest
   * `min` and the highest `max` over every enabled rule of the dimension that applies to
   * them, clamped to what the typed-figure parsers accept. Shown BEFORE the figure is
   * asked, and repeated when one is refused. Null when no rule applies. A gap between two
   * rules is inside the range and is refused at the figure (`volumePriceable`).
   */
  async rangeFor(
    scope: TenantContext,
    customerId: string,
    panelId: string,
    dimension: CustomServiceRuleDimension,
  ): Promise<CustomServiceRange | null> {
    const rules = await this.deps.rules.list(scope);
    const tierId = await this.tierOf(scope, customerId);
    const subject: CustomServiceSubject = { customerId, tierId, panelId };
    const applicable = rules.filter(
      (rule) =>
        rule.enabled && rule.dimension === dimension && ruleLevelFor(rule, subject) !== null,
    );
    if (applicable.length === 0) return null;
    const ceiling =
      dimension === 'VOLUME' ? CUSTOM_SERVICE_MAX_VOLUME_UNITS : BigInt(CUSTOM_SERVICE_MAX_DAYS);
    let min = applicable[0]!.minUnits;
    let max = applicable[0]!.maxUnits;
    for (const rule of applicable) {
      if (rule.minUnits < min) min = rule.minUnits;
      if (rule.maxUnits > max) max = rule.maxUnits;
    }
    if (min < 1n) min = 1n;
    if (max > ceiling) max = ceiling;
    return min > max ? null : { min, max };
  }

  /**
   * The authoritative price, inside the caller's transaction: the draft's and the
   * confirmation's. The flag is the caller's to check (it refuses with its own code).
   *
   * `panelEligibility: 'SKIP'` is the confirmation's: whether the panel can take a new
   * account is not part of the frozen terms, and confirmation re-decides it straight
   * afterwards through `panelSales.acquire`, which refuses with the ordinary
   * `PANEL_NOT_ELIGIBLE`. Deciding it here as well would tell a customer whose panel filled
   * up that the PRICE changed (Codex, PR #88).
   */
  async quote(
    scope: TenantContext,
    input: {
      readonly customerId: string;
      readonly panelId: string;
      readonly volumeUnits: bigint;
      readonly durationDays: number;
    },
    tx: TransactionScope,
    options: { readonly panelEligibility: 'CHECK' | 'SKIP' } = { panelEligibility: 'CHECK' },
  ): Promise<CustomServiceQuote> {
    await this.deps.rules.lockForRead(scope, tx);
    const location = await this.deps.locations.find(scope, input.panelId, tx);
    if (location === null || !location.enabled) {
      return { kind: 'UNAVAILABLE', reason: 'LOCATION_NOT_OFFERED' };
    }
    if (options.panelEligibility === 'CHECK') {
      const eligibility = await this.deps.panelSales.evaluate(scope, input.panelId, tx);
      if (!eligibility.eligible) return { kind: 'UNAVAILABLE', reason: 'PANEL_NOT_ELIGIBLE' };
    }

    const tierId = await this.tierOf(scope, input.customerId, tx);
    const rules = await this.deps.rules.list(scope, tx);
    const currency = await this.deps.settings.valueOf<SalesCurrencyCode>(
      scope,
      'sales.currency',
      tx,
    );
    const priced = priceCustomService(
      rules,
      { customerId: input.customerId, tierId, panelId: input.panelId },
      input.volumeUnits,
      input.durationDays,
      currency,
    );
    if (priced.kind === 'UNAVAILABLE') return priced;
    return { kind: 'PRICED', location, price: priced.price };
  }

  /**
   * The customer's pricing tier: their reseller tier while they are an ACTIVE reseller,
   * else null — the ordinary customers'. A SUSPENDED reseller is an ordinary customer
   * (`standing` answers null for one), exactly as everywhere else.
   */
  private async tierOf(
    scope: TenantContext,
    customerId: string,
    tx?: unknown,
  ): Promise<string | null> {
    const standing = await this.deps.resellers.standing(scope, customerId, tx);
    return standing === null ? null : standing.tier.id;
  }
}
