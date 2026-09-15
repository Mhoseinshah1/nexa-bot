import { z } from 'zod';

/**
 * The catalogue — what a tenant sells.
 *
 * ## What the research does and does not fix
 *
 * The corpus describes the legacy system's product surface but records no pricing
 * precedence (`PRICING_PRECEDENCE = UNKNOWN`, SBR-033) and no commercial values at
 * all. So this file fixes the SHAPE of a sellable thing and nothing about its price:
 * a price is tenant data, entered by an operator, and a product with no price is a
 * product that cannot be sold rather than a product that is free.
 *
 * That is the whole of the "do not invent values" rule expressed in a schema: there
 * is no default price, and `priceAmount` has no default in the request shape.
 *
 * ## Why specification is a snapshot, not a reference
 *
 * A product's duration and traffic are mutable — an operator re-tunes a plan — and a
 * purchase made last month was a purchase of what the plan said THEN. The legacy
 * system attributes history by current reference, so renaming a product rewrites past
 * reports and deleting one collapses them to «محصول حذف‌شده». So the fields below are
 * copied onto the order line at confirmation time (`commerce.ts`), and nothing
 * reconstructs a past purchase by reading a product row.
 */

export const PRODUCT_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];
export const productStatusSchema = z.enum(PRODUCT_STATUSES);

/**
 * The technical specification a purchase entitles the customer to.
 *
 * Two dimensions, because those are the two every observed provider expresses:
 * a time window and a traffic allowance. Both are integers and both have an explicit
 * "unlimited" encoding rather than a null, because a null would have to mean
 * "unlimited" in one place and "not yet decided" in another.
 *
 * `durationDays` is DAYS rather than an expiry timestamp: a plan is "thirty days",
 * and the expiry is computed from the moment provisioning succeeds. Storing an
 * absolute date on a product would make every plan expire at once.
 *
 * `trafficBytes` is BYTES rather than gigabytes. Providers report usage in bytes, and
 * a gigabyte field would mean converting on every comparison with a provider
 * response — which is where a factor of 1000 versus 1024 becomes a silent overcharge.
 */
export interface ProductSpecification {
  /** Days of validity. `UNLIMITED_DURATION_DAYS` means no time limit. */
  readonly durationDays: number;
  /** Traffic allowance in bytes. `UNLIMITED_TRAFFIC_BYTES` means no traffic limit. */
  readonly trafficBytes: bigint;
  /**
   * Simultaneous device cap, or null for "the provider's default".
   *
   * Null rather than zero: `LIMIT_DEVICES` is a provider CAPABILITY that not every
   * panel has, so "no cap configured here" and "a cap of zero devices" are different
   * statements and only one of them is sane.
   */
  readonly deviceLimit: number | null;
}

/** The sentinel for a plan with no time limit. Zero, so a sum is still a sum. */
export const UNLIMITED_DURATION_DAYS = 0;
/** The sentinel for a plan with no traffic limit. */
export const UNLIMITED_TRAFFIC_BYTES = 0n;

export const MAX_DURATION_DAYS = 3650;
export const MAX_TRAFFIC_BYTES = 1_099_511_627_776_000n; // 1 PiB, far past any real plan
export const MAX_DEVICE_LIMIT = 1000;

export const PRODUCT_TITLE_MAX_LENGTH = 120;
export const PRODUCT_DESCRIPTION_MAX_LENGTH = 2000;

export const productSpecificationSchema = z.object({
  durationDays: z.number().int().min(0).max(MAX_DURATION_DAYS),
  trafficBytes: z.coerce.bigint().min(0n).max(MAX_TRAFFIC_BYTES),
  deviceLimit: z.number().int().min(1).max(MAX_DEVICE_LIMIT).nullable(),
});

/**
 * Who may see a product.
 *
 * The legacy system reuses one customer-tier enum across product visibility, pricing,
 * discount scoping, cashback and mass tools — "one enum, four subsystems" — and the
 * research records the consequences. So visibility here is its OWN vocabulary with
 * three values and no relationship to pricing.
 *
 * `RESELLERS_ONLY` is declared now and consumed in 4F. It is not speculative: a
 * reseller catalogue with no way to mark a product reseller-only is a catalogue where
 * the distinction has to live in a price rule, which is exactly the conflation above.
 */
export const PRODUCT_AUDIENCES = ['EVERYONE', 'RESELLERS_ONLY', 'HIDDEN'] as const;
export type ProductAudience = (typeof PRODUCT_AUDIENCES)[number];
export const productAudienceSchema = z.enum(PRODUCT_AUDIENCES);

/**
 * `HIDDEN` is not `INACTIVE`.
 *
 * An INACTIVE product cannot be bought by anyone, including through a link an
 * operator pasted into a conversation. A HIDDEN product is live and simply not
 * listed — which is how a tenant sells something to one customer without publishing
 * it. Collapsing them would make "unlist this" and "stop selling this" the same
 * button, and only one of those is reversible without refunds.
 */
export function isPurchasable(status: ProductStatus): boolean {
  return status === 'ACTIVE';
}

export function isListed(status: ProductStatus, audience: ProductAudience): boolean {
  return isPurchasable(status) && audience !== 'HIDDEN';
}

/**
 * Where a product is fulfilled.
 *
 * A product names a PANEL, not a provider type. The provider type is a property of
 * the panel (`panels.ts`), resolved when the panel row is read, and a product that
 * named a type would have to be re-pointed every time an operator migrated a panel.
 *
 * Null means "not fulfillable yet" — a product an operator is still configuring. Such
 * a product is refused at order confirmation rather than at browse time, because the
 * refusal message an operator needs names the product, and a product that silently
 * vanishes from a list teaches nobody anything.
 */
export const PRODUCT_SORT_MIN = 0;
export const PRODUCT_SORT_MAX = 100_000;

/**
 * What a customer can buy for a service they already own.
 *
 * Two kinds, because a panel performs them with two different fields and a customer
 * asks for them for two different reasons: more traffic on the allowance, or more time
 * on the window. A renewal is NOT one of these — it is bought from the ordinary
 * product catalogue, which is what the legacy system does too (`TBR-008`: the renewal
 * entry point offers the current plan at its current price, or the full picker).
 */
export const SERVICE_ADDON_KINDS = ['ADD_TRAFFIC', 'ADD_TIME'] as const;
export type ServiceAddonKind = (typeof SERVICE_ADDON_KINDS)[number];
export const serviceAddonKindSchema = z.enum(SERVICE_ADDON_KINDS);

export const SERVICE_ADDON_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type ServiceAddonStatus = (typeof SERVICE_ADDON_STATUSES)[number];
export const serviceAddonStatusSchema = z.enum(SERVICE_ADDON_STATUSES);

/**
 * An add-on is a CONFIGURED QUANTITY at a configured price, and the quantity is the
 * reason this is a row rather than a rate.
 *
 * The legacy flows take a free-text number — a GB count, a day count — priced at a flat
 * per-unit rate configured per panel (`TBR-009`, `PBR-009`). This bot has no FSM and no
 * conversation state, by a rule with an incident behind it: the legacy prompt capture
 * swallowed an ordinary message and overwrote a production gateway setting
 * (`INCIDENT-FIN-001`). There is nowhere for a typed quantity to arrive, and a callback
 * carries an intent and an identifier rather than a number — so the purchasable amounts
 * have to be rows a customer selects, with the amount, the unit and the price all
 * server-side. `OQ-4F-05` records that as a deliberate divergence rather than an
 * oversight, and what would have to exist for the per-unit form to come back.
 *
 * `trafficBytes` and `durationDays` are a UNION expressed as two nullable fields
 * because the kind decides which one means anything: an `ADD_TRAFFIC` row carries bytes
 * and no days, an `ADD_TIME` row the reverse. `serviceAddonAmountMatchesKind` is the
 * check, and the schema below refuses a row that carries both or neither — a row with
 * an amount in the wrong field is a row that would be sold for a quantity of nothing.
 *
 * Neither amount may be zero. `UNLIMITED_TRAFFIC_BYTES` and `UNLIMITED_DURATION_DAYS`
 * are both zero, and they mean "no limit" on a PRODUCT; on an add-on the same value
 * would have to mean "add no limit", which is not a thing that can be added to an
 * existing allowance, and reading it as "add nothing" would sell a customer a no-op.
 */
export interface ServiceAddonSpecification {
  readonly kind: ServiceAddonKind;
  /** Bytes to add to the allowance. Set for `ADD_TRAFFIC`, null otherwise. */
  readonly trafficBytes: bigint | null;
  /** Days to add to the window. Set for `ADD_TIME`, null otherwise. */
  readonly durationDays: number | null;
}

export const SERVICE_ADDON_TITLE_MAX_LENGTH = 120;

/** Whether the amount a specification carries is the one its kind can use. */
export function serviceAddonAmountMatchesKind(spec: ServiceAddonSpecification): boolean {
  return spec.kind === 'ADD_TRAFFIC'
    ? spec.trafficBytes !== null && spec.durationDays === null
    : spec.durationDays !== null && spec.trafficBytes === null;
}

export const serviceAddonSpecificationSchema = z
  .object({
    kind: serviceAddonKindSchema,
    trafficBytes: z.coerce.bigint().min(1n).max(MAX_TRAFFIC_BYTES).nullable(),
    durationDays: z.number().int().min(1).max(MAX_DURATION_DAYS).nullable(),
  })
  .refine(serviceAddonAmountMatchesKind, {
    message: 'an add-on carries exactly the amount its kind can use',
  });

/** The same predicate products use: withdrawn means unsellable, never free. */
export function isAddonPurchasable(status: ServiceAddonStatus): boolean {
  return status === 'ACTIVE';
}

/**
 * The operation type an add-on kind is bought as.
 *
 * One function rather than two call sites agreeing, because the kind is what a customer
 * chose and the operation type is what a panel is asked to do, and the day they stop
 * matching is the day a customer's extra traffic is executed as extra time.
 */
export function operationTypeForAddonKind(kind: ServiceAddonKind): 'ADD_TRAFFIC' | 'ADD_TIME' {
  return kind;
}
