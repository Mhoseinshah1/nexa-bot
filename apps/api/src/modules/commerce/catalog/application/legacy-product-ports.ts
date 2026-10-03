import type {
  LegacyShapeResolution,
  LegacyShapeTariffStatus,
  LegacyShapeUnresolvedReason,
  Money,
  ProductId,
  TenantContext,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { LegacyShape, TariffCandidate } from './legacy-shape.js';

/**
 * A hidden legacy product shape as stored (program Item 14).
 *
 * Its own file beside `addon-ports.ts`, for the reason that one gives: nothing here
 * should be reachable by autocomplete from an ordinary product.
 */
export interface LegacyShapeRecord extends LegacyShape {
  readonly id: string;
  readonly shapeKey: string;
  readonly productId: ProductId;
  readonly tariffStatus: LegacyShapeTariffStatus;
  readonly unresolvedReason: LegacyShapeUnresolvedReason | null;
  readonly resolution: LegacyShapeResolution | null;
  readonly tariffSourceProductId: ProductId | null;
  readonly resolvedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type LegacyShapeTariffState =
  | { readonly status: 'UNRESOLVED'; readonly reason: LegacyShapeUnresolvedReason }
  | {
      readonly status: 'RESOLVED';
      readonly resolution: LegacyShapeResolution;
      readonly sourceProductId: ProductId | null;
      readonly resolvedAt: Date;
    };

export interface LegacyProductShapeRepository {
  /**
   * Serialises every ensure of one `(tenant, shapeKey)` for the rest of the transaction.
   * Two importers ensuring one shape at once is the normal case on a rerun, and the
   * second must see the first's product rather than create another.
   */
  lockKey(scope: TenantContext, shapeKey: string, tx: TransactionScope): Promise<void>;
  findByKey(
    scope: TenantContext,
    shapeKey: string,
    tx?: TransactionScope,
  ): Promise<LegacyShapeRecord | null>;
  findById(
    scope: TenantContext,
    id: string,
    tx?: TransactionScope,
  ): Promise<LegacyShapeRecord | null>;
  /** The row lock a resolution decides under. Null when the shape is not this tenant's. */
  lockById(
    scope: TenantContext,
    id: string,
    tx: TransactionScope,
  ): Promise<LegacyShapeRecord | null>;
  insert(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly shapeKey: string;
      readonly shape: LegacyShape;
      readonly productId: ProductId;
      readonly now: Date;
    },
    tx: TransactionScope,
  ): Promise<LegacyShapeRecord>;
  setTariffState(
    scope: TenantContext,
    id: string,
    state: LegacyShapeTariffState,
    now: Date,
    tx: TransactionScope,
  ): Promise<LegacyShapeRecord>;
  /**
   * The products that could be a shape's current tariff: same traffic and duration, any
   * status or audience — `resolveCurrentTariff` is the one place that filters them, so the
   * rule is unit-testable without a database. Unbounded on purpose: a page could cut off
   * the one product at a different price, and a missed ambiguity is a guessed tariff.
   */
  tariffCandidates(
    scope: TenantContext,
    shape: Pick<LegacyShape, 'trafficBytes' | 'durationDays'>,
    tx: TransactionScope,
  ): Promise<readonly TariffCandidate[]>;
  /**
   * Prices and activates the shape's hidden product, and nothing else. Conditional on
   * the product still being HIDDEN and uncategorised; reports whether it was.
   */
  priceHiddenProduct(
    scope: TenantContext,
    productId: ProductId,
    price: Money,
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean>;
}
