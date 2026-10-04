import {
  COMMERCE_ERROR_CODES,
  EMPTY_PRODUCT_DISPLAY,
  errors,
  uuidV7Schema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type LegacyShapeUnresolvedReason,
  type Money,
  type OperationalEventRecorder,
  type PermissionKey,
  type ProductId,
  type SalesCurrencyCode,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
} from '../../../platform/access/application/authorized-mutation.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { SettingsResolver } from '../../../control/settings/application/settings-resolver.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { ProductRecord, ProductRepository } from './ports.js';
import type { LegacyProductShapeRepository, LegacyShapeRecord } from './legacy-product-ports.js';
import {
  legacyHiddenProductTitle,
  legacyShapeKey,
  resolveCurrentTariff,
  type LegacyShapeInput,
  type LegacyShapeUnmappableReason,
} from './legacy-shape.js';
import { PRODUCT_EDIT_PERMISSION, PRODUCT_VIEW_PERMISSION } from './product.service.js';

/**
 * Hidden legacy products (program Item 14, `docs/legacy-migration/hidden-legacy-products.md`).
 *
 * The prerequisites P6 adoption needs, and nothing of P6 itself: the canonical shape of a
 * productless legacy invoice, ONE hidden product per tenant per shape, and the current
 * NEXA tariff that product renews at — or an explicit `UNRESOLVED` state when there is
 * none. No service is adopted here, no provider is called, and nothing is sold new: the
 * hidden product is uncategorised, so an order for a new service refuses it, and the
 * renewal path prices it from its own row through `PricingService.price` like any other
 * product. Discounts, reseller terms and cashback therefore apply to it exactly as they
 * apply to any renewal — no wider, because nothing here grants or scopes anything.
 *
 * Charged against the catalogue's own permissions: a hidden product IS a product, and the
 * catalogue-edit permission is what creating or pricing one already requires.
 */
export const LEGACY_PRODUCT_EDIT_PERMISSION: PermissionKey = PRODUCT_EDIT_PERMISSION;
export const LEGACY_PRODUCT_VIEW_PERMISSION: PermissionKey = PRODUCT_VIEW_PERMISSION;

export type EnsureLegacyShapeResult =
  | { readonly outcome: 'UNMAPPABLE'; readonly reason: LegacyShapeUnmappableReason }
  | {
      readonly outcome: 'CREATED' | 'EXISTING';
      readonly shape: LegacyShapeRecord;
    };

/** What a resolution looked for, and what it found. */
export type LegacyTariffRequest =
  | { readonly kind: 'MATCH' }
  | { readonly kind: 'STATED'; readonly price: Money; readonly reason: string };

export type LegacyTariffFinding =
  | 'MATCHED'
  | 'STATED'
  | 'NO_CURRENT_TARIFF'
  | 'AMBIGUOUS_TARIFF'
  /** A replay: answered from the record, as the shape stands now. */
  | 'REPLAYED';

export interface ResolveLegacyTariffResult {
  readonly shape: LegacyShapeRecord;
  readonly product: ProductRecord;
  readonly finding: LegacyTariffFinding;
  readonly changed: boolean;
}

const REASON_MAX_LENGTH = 500;

export interface LegacyProductServiceDeps {
  readonly shapes: LegacyProductShapeRepository;
  readonly products: Pick<ProductRepository, 'create' | 'findById'>;
  readonly settings: SettingsResolver;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export class LegacyProductService {
  constructor(private readonly deps: LegacyProductServiceDeps) {}

  /**
   * The shape's one hidden product, created on first sight. Idempotent twice over: by the
   * key, and — whatever key a rerun brings — by the shape, under an advisory lock on
   * `(tenant, shapeKey)` so two concurrent ensures cannot both create a product.
   *
   * An unmappable shape writes nothing and is answered as such; it has no shape row,
   * which is what keeps a service of that shape out of P6 by default.
   */
  async ensureShape(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly legacy: LegacyShapeInput },
  ): Promise<EnsureLegacyShapeResult> {
    const denial = { action: 'legacy.product_shape.ensure', entityType: 'Product', entityId: null };
    await this.authorize(scope, actor, LEGACY_PRODUCT_EDIT_PERMISSION, denial);

    const keyed = legacyShapeKey(input.legacy);
    if (!keyed.ok) return { outcome: 'UNMAPPABLE', reason: keyed.reason };
    const requestHash = hashRequest({ shapeKey: keyed.key });

    const replay = await this.deps.idempotency.find<{ shapeId: string }>(
      scope,
      actor.surface,
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      const recorded = await this.deps.shapes.findById(scope, replay.result.shapeId);
      if (recorded !== null) return { outcome: 'EXISTING', shape: recorded };
    }

    const now = this.deps.clock.now();
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      LEGACY_PRODUCT_EDIT_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        await this.deps.shapes.lockKey(scope, keyed.key, tx);
        const existing = await this.deps.shapes.findByKey(scope, keyed.key, tx);
        if (existing !== null) {
          await rememberOnce(
            this.deps.idempotency,
            scope,
            actor.surface,
            input.idempotencyKey,
            requestHash,
            { shapeId: existing.id },
            tx,
          );
          return { outcome: 'EXISTING' as const, shape: existing };
        }

        const product = await this.deps.products.create(
          scope,
          {
            id: this.deps.ids.uuid() as ProductId,
            draft: {
              title: legacyHiddenProductTitle(keyed.shape),
              description: null,
              audience: 'HIDDEN',
              sortOrder: 0,
              // No panel and no category: a renewal reads the SERVICE's panel, and an
              // uncategorised product is refused for a new purchase (`NOT_CATEGORISED`).
              panelId: null,
              categoryId: null,
              specification: {
                durationDays: keyed.shape.durationDays,
                trafficBytes: keyed.shape.trafficBytes,
                deviceLimit: null,
              },
              // Unpriced until a CURRENT tariff is resolved. Never the legacy price.
              price: null,
              display: EMPTY_PRODUCT_DISPLAY,
            },
            now,
          },
          tx,
        );
        const shape = await this.deps.shapes.insert(
          scope,
          {
            id: this.deps.ids.uuid(),
            shapeKey: keyed.key,
            shape: keyed.shape,
            productId: product.id,
            now,
          },
          tx,
        );
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'legacy.product_shape.ensure',
            entityType: 'Product',
            entityId: product.id,
            before: null,
            after: shapeAudit(shape, product),
            result: 'SUCCESS',
          },
          tx,
        );
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          input.idempotencyKey,
          requestHash,
          { shapeId: shape.id },
          tx,
        );
        return { outcome: 'CREATED' as const, shape };
      },
    );
  }

  /**
   * Resolve — or re-resolve — the shape's CURRENT NEXA tariff, and price its hidden
   * product with it. `docs/legacy-migration/hidden-legacy-products.md` §3.
   *
   * `MATCH` takes the one current public price for this traffic and duration
   * (`resolveCurrentTariff`). Run again after the public tariff changes, it follows it:
   * the hidden product's price is a copy of the CURRENT tariff, refreshed on demand, never
   * a lock on the price a customer paid in the legacy bot. A run that finds no tariff, or
   * several, records that on an UNRESOLVED shape and leaves a RESOLVED one as it is —
   * withdrawing a renewal price an operator already accepted is a decision, not a finding.
   *
   * `STATED` is the manual-review exit: an operator states the current tariff for this
   * shape, with a reason, audited. It is how a custom shape with no public equivalent
   * becomes renewable.
   */
  async resolveTariff(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly shapeId: string;
      readonly request: LegacyTariffRequest;
    },
  ): Promise<ResolveLegacyTariffResult> {
    const shapeId = this.shapeId(input.shapeId);
    const denial = {
      action: 'legacy.product_shape.resolve',
      entityType: 'LegacyProductShape',
      entityId: shapeId,
    };
    await this.authorize(scope, actor, LEGACY_PRODUCT_EDIT_PERMISSION, denial);
    const request = this.request(input.request);
    const requestHash = hashRequest({
      shapeId,
      kind: request.kind,
      ...(request.kind === 'STATED'
        ? {
            amountMinor: request.price.amountMinor.toString(),
            currency: request.price.currency,
            reason: request.reason,
          }
        : {}),
    });

    const replay = await this.deps.idempotency.find<{ shapeId: string }>(
      scope,
      actor.surface,
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      const shape = await this.deps.shapes.findById(scope, shapeId);
      const product =
        shape === null ? null : await this.deps.products.findById(scope, shape.productId);
      if (shape !== null && product !== null) {
        return { shape, product, finding: 'REPLAYED', changed: false };
      }
    }

    const now = this.deps.clock.now();
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      LEGACY_PRODUCT_EDIT_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const before = await this.deps.shapes.lockById(scope, shapeId, tx);
        if (before === null) {
          throw errors.notFound(COMMERCE_ERROR_CODES.PRODUCT_NOT_FOUND, 'Unknown legacy shape.');
        }
        const productBefore = await this.requireProduct(scope, before.productId, tx);
        const currency = await this.deps.settings.valueOf<SalesCurrencyCode>(
          scope,
          'sales.currency',
          tx,
        );

        let finding: LegacyTariffFinding;
        let shape = before;
        if (request.kind === 'STATED') {
          if (request.price.currency !== currency || request.price.amountMinor <= 0n) {
            throw errors.validation(
              COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
              'A tariff is a positive amount in the currency this installation sells in.',
            );
          }
          await this.price(scope, before.productId, request.price, now, tx);
          shape = await this.deps.shapes.setTariffState(
            scope,
            shapeId,
            {
              status: 'RESOLVED',
              resolution: 'OPERATOR_STATED',
              sourceProductId: null,
              resolvedAt: now,
            },
            now,
            tx,
          );
          finding = 'STATED';
        } else {
          const candidates = await this.deps.shapes.tariffCandidates(scope, before, tx);
          const resolved = resolveCurrentTariff(before, candidates, currency);
          if (resolved.kind === 'MATCHED') {
            await this.price(scope, before.productId, resolved.price, now, tx);
            shape = await this.deps.shapes.setTariffState(
              scope,
              shapeId,
              {
                status: 'RESOLVED',
                resolution: 'MATCHED_PUBLIC_PRODUCT',
                sourceProductId: resolved.sourceProductId as ProductId,
                resolvedAt: now,
              },
              now,
              tx,
            );
            finding = 'MATCHED';
          } else {
            if (before.tariffStatus === 'UNRESOLVED') {
              shape = await this.deps.shapes.setTariffState(
                scope,
                shapeId,
                { status: 'UNRESOLVED', reason: resolved.kind },
                now,
                tx,
              );
            }
            finding = resolved.kind;
          }
        }

        const product = await this.requireProduct(scope, before.productId, tx);
        const changed =
          shape.tariffStatus !== before.tariffStatus ||
          shape.unresolvedReason !== before.unresolvedReason ||
          shape.resolution !== before.resolution ||
          shape.tariffSourceProductId !== before.tariffSourceProductId ||
          product.status !== productBefore.status ||
          product.price?.amountMinor !== productBefore.price?.amountMinor ||
          product.price?.currency !== productBefore.price?.currency;

        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'legacy.product_shape.resolve',
            entityType: 'LegacyProductShape',
            entityId: shapeId,
            before: shapeAudit(before, productBefore),
            after: { ...shapeAudit(shape, product), finding, changed },
            result: 'SUCCESS',
            ...(request.kind === 'STATED' ? { reason: request.reason } : {}),
          },
          tx,
        );
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          input.idempotencyKey,
          requestHash,
          { shapeId },
          tx,
        );
        return { shape, product, finding, changed };
      },
    );
  }

  /** One shape, for the operator and for P6's adoption gate. */
  async get(
    scope: TenantContext,
    actor: ActorContext,
    shapeId: string,
  ): Promise<{ readonly shape: LegacyShapeRecord; readonly product: ProductRecord }> {
    await this.deps.guard.check(scope, actor, LEGACY_PRODUCT_VIEW_PERMISSION);
    const shape = await this.deps.shapes.findById(scope, this.shapeId(shapeId));
    if (shape === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.PRODUCT_NOT_FOUND, 'Unknown legacy shape.');
    }
    return { shape, product: await this.requireProduct(scope, shape.productId) };
  }

  private async price(
    scope: TenantContext,
    productId: ProductId,
    price: Money,
    now: Date,
    tx: TransactionScope,
  ): Promise<void> {
    if (!(await this.deps.shapes.priceHiddenProduct(scope, productId, price, now, tx))) {
      // `nexa_legacy_shape_product_hidden` makes this unreachable through any edit; a row
      // that is somehow listed or categorised is not priced as a legacy tariff.
      throw errors.conflict(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'This legacy product is no longer hidden and cannot carry a legacy tariff.',
      );
    }
  }

  private async requireProduct(
    scope: TenantContext,
    productId: ProductId,
    tx?: TransactionScope,
  ): Promise<ProductRecord> {
    const product = await this.deps.products.findById(scope, productId, tx);
    if (product === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.PRODUCT_NOT_FOUND, 'Unknown product.');
    }
    return product;
  }

  private request(raw: LegacyTariffRequest): LegacyTariffRequest {
    if (raw.kind === 'MATCH') return raw;
    const reason = raw.reason.trim();
    if (reason === '') {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'Stating a legacy tariff needs a reason.',
      );
    }
    return { kind: 'STATED', price: raw.price, reason: reason.slice(0, REASON_MAX_LENGTH) };
  }

  private shapeId(candidate: string): string {
    const parsed = uuidV7Schema.safeParse(candidate);
    if (!parsed.success) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'That is not a valid legacy shape identifier.',
      );
    }
    return parsed.data;
  }

  private async assertScopeActive(scope: TenantContext, tx: TransactionScope): Promise<void> {
    if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'This installation has stopped accepting work.',
      );
    }
  }

  private mutationDeps() {
    return {
      uow: this.deps.uow,
      guard: this.deps.guard,
      audit: this.deps.audit,
      opsLog: this.deps.opsLog,
      sessions: this.deps.sessions,
      clock: this.deps.clock,
    };
  }

  /** `recordMutationDenial`, not a bare check — see `ProductService.authorize`. */
  private async authorize(
    scope: TenantContext,
    actor: ActorContext,
    permission: PermissionKey,
    denial: { action: string; entityType: string; entityId: string | null },
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, permission);
    } catch (error) {
      await recordMutationDenial(this.mutationDeps(), scope, actor, permission, denial, error);
      throw error;
    }
  }
}

/**
 * Why a service of this shape may not be adopted — a CLOSED set, so P6 routes the
 * service to manual review with a reason instead of re-deriving one:
 *
 * - `NO_SHAPE` — no shape row (an unmappable shape writes none) or no product for it;
 * - `NOT_YET_RESOLVED` / `NO_CURRENT_TARIFF` / `AMBIGUOUS_TARIFF` — the shape's own
 *   UNRESOLVED reason: there is no safe current tariff, and none is invented;
 * - `PRODUCT_NOT_ADOPTABLE` — resolved, but its hidden product is not live, hidden,
 *   uncategorised, priced and the shape's own (an operator withdrew or edited it).
 */
export type LegacyShapeAdoptionBlocker =
  'NO_SHAPE' | LegacyShapeUnresolvedReason | 'PRODUCT_NOT_ADOPTABLE';

export type LegacyShapeAdoption =
  | { readonly adoptable: true }
  | { readonly adoptable: false; readonly reason: LegacyShapeAdoptionBlocker };

/**
 * Whether a service of this shape may be adopted (P6's gate, decided here so P6 cannot
 * decide it differently): the shape is RESOLVED and its hidden product is live, hidden,
 * uncategorised and priced. Anything else blocks adoption — including no shape at all —
 * with the closed reason above.
 */
export function legacyShapeAdoption(
  shape: LegacyShapeRecord | null,
  product: ProductRecord | null,
): LegacyShapeAdoption {
  if (shape === null || product === null) return { adoptable: false, reason: 'NO_SHAPE' };
  if (shape.tariffStatus !== 'RESOLVED') {
    return { adoptable: false, reason: shape.unresolvedReason ?? 'NOT_YET_RESOLVED' };
  }
  const live =
    shape.productId === product.id &&
    product.status === 'ACTIVE' &&
    product.audience === 'HIDDEN' &&
    product.categoryId === null &&
    product.price !== null;
  return live ? { adoptable: true } : { adoptable: false, reason: 'PRODUCT_NOT_ADOPTABLE' };
}

/** `legacyShapeAdoption` as a yes/no, for a caller that needs no reason. */
export function legacyShapeAdoptable(
  shape: LegacyShapeRecord | null,
  product: ProductRecord | null,
): boolean {
  return legacyShapeAdoption(shape, product).adoptable;
}

/** Values for the audit row: the shape's dimensions and tariff, never a legacy price. */
function shapeAudit(shape: LegacyShapeRecord, product: ProductRecord): Record<string, unknown> {
  return {
    shapeId: shape.id,
    shapeKey: shape.shapeKey,
    productId: product.id,
    tariffStatus: shape.tariffStatus,
    unresolvedReason: shape.unresolvedReason,
    resolution: shape.resolution,
    tariffSourceProductId: shape.tariffSourceProductId,
    productStatus: product.status,
    price:
      product.price === null
        ? null
        : { amountMinor: product.price.amountMinor.toString(), currency: product.price.currency },
  };
}
