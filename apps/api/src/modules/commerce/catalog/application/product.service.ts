import {
  COMMERCE_ERROR_CODES,
  PRODUCT_PAGE_DEFAULT,
  PRODUCT_PAGE_MAX,
  errors,
  productIdSchema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type PermissionKey,
  type ProductId,
  type ProductStatus,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import { runAuthorizedMutation } from '../../../platform/access/application/authorized-mutation.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { OperationalEventRecorder } from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  ProductDraft,
  ProductEdit,
  ProductPage,
  ProductRecord,
  ProductRepository,
  ProductSearch,
  ProductCursor,
} from './ports.js';

/**
 * The permissions this service charges, from the FROZEN vocabulary.
 *
 * `catalog.*` and not `products.*`. `permissions.ts` names these two and labels them
 * "View products and categories" / "Create or edit products and categories"; a
 * `products.view` invented beside them would be the second vocabulary
 * `docs/phase4b-audit.md` opens by warning about.
 *
 * `catalog.pricing.edit` is deliberately NOT used. It governs pricing RULES, which do
 * not exist in this phase. A product's own price is a property of the product and moves
 * under `catalog.edit` with the rest of it — charging the HIGH-risk rules permission for
 * an ordinary product edit would train operators to hold a permission they do not need.
 */
export const PRODUCT_VIEW_PERMISSION: PermissionKey = 'catalog.view';
export const PRODUCT_EDIT_PERMISSION: PermissionKey = 'catalog.edit';

/**
 * What an inbound customer browse acts under.
 *
 * `maintenance.run`, exactly as `RESOLVE_CUSTOMER_PERMISSION` does and for the same
 * reason: this is system work triggered by a customer, `SYSTEM_JOB` holds that one key
 * and nothing else, and the check is made for `SYSTEM_JOB` like every other actor
 * because `nexa-conventions` forbids an actor-type exemption.
 */
export const CATALOG_BROWSE_PERMISSION: PermissionKey = 'maintenance.run';

export interface ProductServiceDeps {
  readonly repository: ProductRepository;
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

export interface ProductListQuery {
  readonly limit?: number;
  readonly cursor?: ProductCursor;
  readonly search: ProductSearch;
}

/**
 * Products, as an operator manages them and a customer browses them.
 *
 * Every mutation runs the seven-step write path: authenticate, resolve scope,
 * authorize, validate, idempotency, transact, project. The authorization that counts is
 * the one INSIDE the committing transaction — `runAuthorizedMutation` — so a revoked
 * role cannot be overtaken by a mutation already in flight.
 *
 * No domain events are written here, and that is a decision the contracts made rather
 * than an omission: `AGGREGATE_TYPES` has no `Product` and the event catalogue declares
 * no product event. Adding either would put a name with no consumer into a frozen spec,
 * which is what `0002_drop_callback_refs` exists to record. Audit rows are the
 * repository's normal evidence for an admin mutation and every mutation here writes one.
 */
export class ProductService {
  constructor(private readonly deps: ProductServiceDeps) {}

  async list(
    scope: TenantContext,
    actor: ActorContext,
    query: ProductListQuery,
  ): Promise<ProductPage> {
    await this.deps.guard.check(scope, actor, PRODUCT_VIEW_PERMISSION);
    const limit = Math.min(Math.max(query.limit ?? PRODUCT_PAGE_DEFAULT, 1), PRODUCT_PAGE_MAX);
    return this.deps.repository.list(scope, query.search, limit, query.cursor ?? null);
  }

  async get(scope: TenantContext, actor: ActorContext, id: string): Promise<ProductRecord> {
    await this.deps.guard.check(scope, actor, PRODUCT_VIEW_PERMISSION);
    const productId = this.productId(id);
    const product = await this.deps.repository.findById(scope, productId);
    if (product === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.PRODUCT_NOT_FOUND, 'Unknown product.');
    }
    return product;
  }

  /**
   * The customer-visible catalogue.
   *
   * Charged against `maintenance.run` like every other customer-triggered read, and
   * bounded. The membership rule lives in the repository's WHERE clause so a product a
   * customer may not see never leaves the database.
   */
  async browse(
    scope: TenantContext,
    actor: ActorContext,
    limit: number,
  ): Promise<{ readonly items: readonly ProductRecord[]; readonly hasMore: boolean }> {
    await this.deps.guard.check(scope, actor, CATALOG_BROWSE_PERMISSION);
    const bounded = Math.min(Math.max(limit, 1), PRODUCT_PAGE_MAX);
    return this.deps.repository.listCatalog(scope, bounded);
  }

  /** Creates an INACTIVE product. Idempotent, audited. */
  async create(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly draft: ProductDraft },
  ): Promise<ProductRecord> {
    const requestHash = hashRequest({ draft: serialisableDraft(input.draft) });
    const replay = await this.deps.idempotency.find<{ productId: string }>(
      scope,
      'WEB',
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      const existing = await this.deps.repository.findById(
        scope,
        replay.result.productId as ProductId,
      );
      if (existing !== null) return existing;
      // The idempotency row outlived its product, which a restore can produce. Falling
      // through creates a new one under the same key rather than reporting a stale
      // success for a row that is gone.
    }

    const now = this.deps.clock.now();
    const id = this.deps.ids.uuid() as ProductId;

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      PRODUCT_EDIT_PERMISSION,
      { action: 'product.create', entityType: 'Product', entityId: null },
      async (tx) => {
        await this.assertScopeActive(scope, tx);

        const created = await this.deps.repository.create(
          scope,
          { id, draft: input.draft, now },
          tx,
        );

        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'product.create',
            entityType: 'Product',
            entityId: created.id,
            before: null,
            after: auditView(created),
            result: 'SUCCESS',
          },
          tx,
        );

        await rememberOnce(
          this.deps.idempotency,
          scope,
          'WEB',
          input.idempotencyKey,
          requestHash,
          { productId: created.id },
          tx,
        );
        return created;
      },
    );
  }

  /**
   * Edits the mutable properties of a product. Idempotent, audited.
   *
   * Editing is safe precisely because every field here is snapshotted onto an order at
   * confirmation. That is the invariant the whole phase turns on, and it is enforced by
   * the order path rather than by refusing edits: a catalogue nobody can re-tune is a
   * catalogue an operator works around.
   */
  async update(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly productId: string;
      readonly edit: ProductEdit;
    },
  ): Promise<ProductRecord> {
    const productId = this.productId(input.productId);
    const requestHash = hashRequest({ productId, edit: serialisableDraft(input.edit) });
    const replay = await this.deps.idempotency.find<{ productId: string }>(
      scope,
      'WEB',
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      const existing = await this.deps.repository.findById(scope, productId);
      if (existing !== null) return existing;
    }

    const now = this.deps.clock.now();

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      PRODUCT_EDIT_PERMISSION,
      { action: 'product.update', entityType: 'Product', entityId: productId },
      async (tx) => {
        await this.assertScopeActive(scope, tx);

        const before = await this.deps.repository.findById(scope, productId, tx);
        if (before === null) {
          throw errors.notFound(COMMERCE_ERROR_CODES.PRODUCT_NOT_FOUND, 'Unknown product.');
        }

        const after = await this.deps.repository.update(scope, productId, input.edit, now, tx);
        if (after === null) {
          throw errors.notFound(COMMERCE_ERROR_CODES.PRODUCT_NOT_FOUND, 'Unknown product.');
        }

        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'product.update',
            entityType: 'Product',
            entityId: after.id,
            before: auditView(before),
            after: auditView(after),
            result: 'SUCCESS',
          },
          tx,
        );

        await rememberOnce(
          this.deps.idempotency,
          scope,
          'WEB',
          input.idempotencyKey,
          requestHash,
          { productId: after.id },
          tx,
        );
        return after;
      },
    );
  }

  /** Makes a product purchasable. */
  async activate(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly productId: string },
  ): Promise<ProductRecord> {
    return this.setStatus(scope, actor, { ...input, to: 'ACTIVE' });
  }

  /**
   * Withdraws a product from sale.
   *
   * It does NOT touch any existing order. Every order carries its own snapshot, so a
   * withdrawal changes what can be bought next and nothing about what was bought — the
   * legacy «محصول حذف‌شده» is what happens when that is not true.
   */
  async deactivate(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly productId: string },
  ): Promise<ProductRecord> {
    return this.setStatus(scope, actor, { ...input, to: 'INACTIVE' });
  }

  private async setStatus(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly productId: string;
      readonly to: ProductStatus;
    },
  ): Promise<ProductRecord> {
    const productId = this.productId(input.productId);
    const requestHash = hashRequest({ productId, to: input.to });
    const replay = await this.deps.idempotency.find<{ productId: string }>(
      scope,
      'WEB',
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      const existing = await this.deps.repository.findById(scope, productId);
      if (existing !== null) return existing;
    }

    const now = this.deps.clock.now();
    const from: ProductStatus = input.to === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    const action = input.to === 'ACTIVE' ? 'product.activate' : 'product.deactivate';

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      PRODUCT_EDIT_PERMISSION,
      { action, entityType: 'Product', entityId: productId },
      async (tx) => {
        await this.assertScopeActive(scope, tx);

        const before = await this.deps.repository.findById(scope, productId, tx);
        if (before === null) {
          throw errors.notFound(COMMERCE_ERROR_CODES.PRODUCT_NOT_FOUND, 'Unknown product.');
        }

        const changed = await this.deps.repository.setStatus(
          scope,
          productId,
          from,
          input.to,
          now,
          tx,
        );

        const after = await this.deps.repository.findById(scope, productId, tx);
        if (after === null) {
          throw errors.notFound(COMMERCE_ERROR_CODES.PRODUCT_NOT_FOUND, 'Unknown product.');
        }

        /*
         * A no-op is a success that still writes its audit row.
         *
         * `changed: false` means the product was already in the target state. The row
         * records it so the log distinguishes "withdrew it" from "it was already
         * withdrawn", and the command does not throw — the end state the operator asked
         * for holds, and a double-clicked button that fails the second time teaches an
         * operator that the button is unreliable.
         */
        await this.deps.audit.record(
          scope,
          actor,
          {
            action,
            entityType: 'Product',
            entityId: after.id,
            before: { status: before.status },
            after: { status: after.status, changed },
            result: 'SUCCESS',
          },
          tx,
        );

        await rememberOnce(
          this.deps.idempotency,
          scope,
          'WEB',
          input.idempotencyKey,
          requestHash,
          { productId: after.id },
          tx,
        );
        return after;
      },
    );
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

  /**
   * Refuses a scope that has stopped accepting work, INSIDE the transaction.
   *
   * `nexa-conventions` requires this of every write path, and names the module that
   * skipped it: panels, which let a tenant an operator had stopped be given new panels.
   * A surface checking on arrival is not enough because a stop can commit in between.
   */
  private async assertScopeActive(scope: TenantContext, tx: TransactionScope): Promise<void> {
    if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'This installation has stopped accepting work.',
      );
    }
  }

  /**
   * A product id, or a refusal that is not a 500.
   *
   * `products.id` is a `uuid` column, so a path segment that is not one reaches
   * PostgreSQL as `invalid input syntax for type uuid` and is answered 500. Lower-cased
   * by `productIdSchema` for the reason `customerId` records: Postgres compares `uuid`
   * case-insensitively while JavaScript `===` does not.
   *
   * Validated in the SERVICE rather than the controller, so any later surface inherits
   * the rule instead of rediscovering it.
   */
  private productId(candidate: string): ProductId {
    const parsed = productIdSchema.safeParse(candidate);
    if (!parsed.success) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'That is not a valid product identifier.',
      );
    }
    return parsed.data;
  }
}

/**
 * The draft in a form the idempotency hash can serialise.
 *
 * `trafficBytes` and the price amount are `bigint`, and `JSON.stringify` throws on one.
 * The hash exists to catch a key reused with a different payload, so a field that
 * silently fails to serialise is a field whose change cannot be caught — which is the
 * defect `hashRequest`'s own comment records from the customer service's private copy.
 */
function serialisableDraft(draft: ProductDraft): Record<string, unknown> {
  return {
    title: draft.title,
    description: draft.description,
    audience: draft.audience,
    sortOrder: draft.sortOrder,
    panelId: draft.panelId,
    durationDays: draft.specification.durationDays,
    trafficBytes: draft.specification.trafficBytes.toString(),
    deviceLimit: draft.specification.deviceLimit,
    priceAmount: draft.price === null ? null : draft.price.amountMinor.toString(),
    priceCurrency: draft.price === null ? null : draft.price.currency,
  };
}

/**
 * What an audit row records about a product.
 *
 * Every mutable field, so a before/after pair answers "what did this edit change" —
 * which is the question `/admin/logs` could not answer in the legacy system, where an
 * audit entry was a free-text Persian sentence with no before and no after.
 *
 * `bigint` is rendered as text for the same reason as above: an audit row is `jsonb`.
 */
function auditView(product: ProductRecord): Record<string, unknown> {
  return {
    title: product.title,
    description: product.description,
    status: product.status,
    audience: product.audience,
    sortOrder: product.sortOrder,
    panelId: product.panelId,
    durationDays: product.specification.durationDays,
    trafficBytes: product.specification.trafficBytes.toString(),
    deviceLimit: product.specification.deviceLimit,
    priceAmount: product.price === null ? null : product.price.amountMinor.toString(),
    priceCurrency: product.price === null ? null : product.price.currency,
  };
}
