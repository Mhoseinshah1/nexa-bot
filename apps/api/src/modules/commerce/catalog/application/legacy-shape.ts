import {
  isCategoryPurchasable,
  isPurchasable,
  MAX_DURATION_DAYS,
  MAX_TRAFFIC_BYTES,
  formatTrafficGb,
  parseTrafficGb,
  type Money,
  type ProductAudience,
  type ProductCategoryStatus,
  type ProductStatus,
} from '@nexa/contracts';

/**
 * The canonical key of a legacy tariff shape (program Item 14,
 * `docs/legacy-migration/hidden-legacy-products.md` §2).
 *
 * Pure and deterministic: the same five legacy facts always produce the same key, in any
 * process, on any rerun, so `ensureShape` can be idempotent on it.
 *
 * The five are `code_panel`, `Volume`, `Service_time`, `time_unit` and `is_custom`. The
 * legacy invoice's `price_product` is deliberately NOT an input — it is not even a field
 * of `LegacyShapeInput` — because it is a historical purchase snapshot and the owner
 * decided renewals are at the CURRENT NEXA tariff. Two invoices of one shape bought at two
 * prices are one shape.
 *
 * Nothing is guessed. A unit this evidence has not shown (Q1c,
 * `docs/legacy-migration/sql-evidence.md`), a zero volume or duration — whose legacy
 * meaning ("unlimited"?) is not established — and anything unparseable come back
 * `UNMAPPABLE` with a reason, and no hidden product is created for them. A service of an
 * unmappable shape therefore has no shape row at all, which blocks it from P6 by default.
 */
export interface LegacyShapeInput {
  readonly codePanel: string | null;
  readonly volume: string | number | null;
  readonly serviceTime: string | number | null;
  readonly timeUnit: string | null;
  readonly isCustom: string | number | boolean | null;
}

/** The canonical, price-free tariff dimensions of one shape. */
export interface LegacyShape {
  /** Trimmed legacy panel code; NULL when the invoice named none. */
  readonly legacyCodePanel: string | null;
  readonly trafficBytes: bigint;
  readonly durationDays: number;
  readonly isCustom: boolean;
}

export const LEGACY_SHAPE_UNMAPPABLE_REASONS = [
  'CODE_PANEL_INVALID',
  'VOLUME_INVALID',
  'VOLUME_ZERO',
  'DURATION_INVALID',
  'DURATION_ZERO',
  'TIME_UNIT_UNKNOWN',
  'IS_CUSTOM_INVALID',
] as const;
export type LegacyShapeUnmappableReason = (typeof LEGACY_SHAPE_UNMAPPABLE_REASONS)[number];

export type LegacyShapeKeyResult =
  | { readonly ok: true; readonly key: string; readonly shape: LegacyShape }
  | { readonly ok: false; readonly reason: LegacyShapeUnmappableReason };

/** The version prefix. A change to the canonicalisation is a NEW version, never an edit. */
export const LEGACY_SHAPE_KEY_VERSION = 'legacy-shape:v1';

/** The spellings of "days" the key accepts. Grows only from evidence (Q1c). */
const DAY_UNITS: readonly string[] = ['', 'd', 'day', 'days'];

const CODE_PANEL_MAX_LENGTH = 200;

/** Builds the key from an already-canonical shape. The one place the format lives. */
export function keyOfLegacyShape(shape: LegacyShape): string {
  return `${LEGACY_SHAPE_KEY_VERSION}:${JSON.stringify([
    shape.legacyCodePanel,
    shape.trafficBytes.toString(),
    shape.durationDays,
    shape.isCustom ? 1 : 0,
  ])}`;
}

export function legacyShapeKey(input: LegacyShapeInput): LegacyShapeKeyResult {
  const codePanel = input.codePanel === null ? '' : input.codePanel.trim();
  if (codePanel.length > CODE_PANEL_MAX_LENGTH || /\p{Cc}/u.test(codePanel)) {
    return { ok: false, reason: 'CODE_PANEL_INVALID' };
  }

  const volumeText = scalarText(input.volume);
  const trafficBytes = volumeText === null ? null : parseTrafficGb(volumeText);
  if (trafficBytes === null || trafficBytes > MAX_TRAFFIC_BYTES) {
    return { ok: false, reason: 'VOLUME_INVALID' };
  }
  if (trafficBytes === 0n) return { ok: false, reason: 'VOLUME_ZERO' };

  const unit = (input.timeUnit ?? '').trim().toLowerCase();
  if (!DAY_UNITS.includes(unit)) return { ok: false, reason: 'TIME_UNIT_UNKNOWN' };

  const timeText = scalarText(input.serviceTime);
  if (timeText === null || !/^[0-9]{1,6}$/u.test(timeText)) {
    return { ok: false, reason: 'DURATION_INVALID' };
  }
  const durationDays = Number(timeText);
  if (durationDays === 0) return { ok: false, reason: 'DURATION_ZERO' };
  if (durationDays > MAX_DURATION_DAYS) return { ok: false, reason: 'DURATION_INVALID' };

  const isCustom = flag(input.isCustom);
  if (isCustom === null) return { ok: false, reason: 'IS_CUSTOM_INVALID' };

  const shape: LegacyShape = {
    legacyCodePanel: codePanel === '' ? null : codePanel,
    trafficBytes,
    durationDays,
    isCustom,
  };
  return { ok: true, key: keyOfLegacyShape(shape), shape };
}

/**
 * The hidden product's title: what a renewal line shows, until an operator renames it.
 * Operator data like any product title, not a template — the numbers are the shape's.
 */
export function legacyHiddenProductTitle(shape: LegacyShape): string {
  const custom = shape.isCustom ? ' · دلخواه' : '';
  return `سرویس قدیمی · ${formatTrafficGb(shape.trafficBytes)} GB · ${String(shape.durationDays)} روز${custom}`;
}

/** A product as the current-tariff resolution reads it. */
export interface TariffCandidate {
  readonly id: string;
  readonly status: ProductStatus;
  readonly audience: ProductAudience;
  readonly durationDays: number;
  readonly trafficBytes: bigint;
  readonly price: Money | null;
  /** Whether a panel is bound — without one, nothing bought is delivered. */
  readonly panelBound: boolean;
  /** The product's category's status; null when it has none. */
  readonly categoryStatus: ProductCategoryStatus | null;
}

export type TariffResolution =
  | { readonly kind: 'MATCHED'; readonly price: Money; readonly sourceProductId: string }
  | { readonly kind: 'NO_CURRENT_TARIFF' }
  | { readonly kind: 'AMBIGUOUS_TARIFF' };

/**
 * The current NEXA tariff for a shape, or why there is none (§3 of the design).
 *
 * A candidate is a product that is ACTIVE, PUBLIC (`EVERYONE` — never `RESELLERS_ONLY`,
 * whose price is a reseller's, and never `HIDDEN`, which includes the legacy products
 * themselves), priced in the tenant's sales currency, with exactly the shape's traffic and
 * duration — and that a customer can actually buy TODAY: bound to a panel and in a
 * purchasable category, the two further terms `unorderableReason` refuses a new purchase
 * on. A product in a withdrawn category, or one with nothing to deliver on, is a price
 * from the past, not a current tariff. One distinct price among them is the tariff, taken from the lowest product id
 * so the source is deterministic; none is `NO_CURRENT_TARIFF`; several prices is
 * `AMBIGUOUS_TARIFF`. Nothing is interpolated from a nearby plan and nothing reads the
 * legacy price.
 */
export function resolveCurrentTariff(
  shape: Pick<LegacyShape, 'trafficBytes' | 'durationDays'>,
  candidates: readonly TariffCandidate[],
  salesCurrency: string,
): TariffResolution {
  const matching = candidates
    .filter(
      (product) =>
        isPurchasable(product.status) &&
        product.audience === 'EVERYONE' &&
        product.panelBound &&
        product.categoryStatus !== null &&
        isCategoryPurchasable(product.categoryStatus) &&
        product.price !== null &&
        product.price.currency === salesCurrency &&
        product.trafficBytes === shape.trafficBytes &&
        product.durationDays === shape.durationDays,
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const first = matching[0];
  if (first === undefined || first.price === null) return { kind: 'NO_CURRENT_TARIFF' };
  const prices = new Set(matching.map((product) => product.price?.amountMinor.toString()));
  if (prices.size > 1) return { kind: 'AMBIGUOUS_TARIFF' };
  return { kind: 'MATCHED', price: first.price, sourceProductId: first.id };
}

function scalarText(value: string | number | null): string | null {
  if (value === null) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? String(value) : null;
  }
  return value.trim();
}

function flag(value: string | number | boolean | null): boolean | null {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  return null;
}
