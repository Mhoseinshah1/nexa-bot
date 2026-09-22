import {
  COMMERCE_ERROR_CODES,
  PANEL_ERROR_CODES,
  PRODUCT_PAGE_DEFAULT,
  PRODUCT_PAGE_MAX,
  errors,
  productIdSchema,
  type ActorContext,
  type AuditWriter,
  type SalesCurrencyCode,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type PanelId,
  type ProductCategoryId,
  type PermissionKey,
  type ProductId,
  type ProductStatus,
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
import type { PanelSalesGate } from '../../../platform/panels/application/panel-sales-gate.js';
import type { SettingsResolver } from '../../../control/settings/application/settings-resolver.js';
import type { OperationalEventRecorder } from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  CustomerPage,
  PanelDirectory,
  ProductDraft,
  ProductEdit,
  ProductPage,
  ProductRecord,
  ProductRepository,
  ProductSearch,
  ProductCursor,
  ProductCategoryRecord,
  ProductCategoryRepository,
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
  /** Membership only — see `PanelDirectory`. Never a panel projection. */
  readonly panels: PanelDirectory;
  /**
   * Whether the panel behind a product can take one more service today.
   *
   * Used by `browse` and nowhere else in this service. The catalogue is the one
   * place this is a UX question: an ineligible panel is hidden rather than shown
   * and then refused, because a customer who taps a plan and is told no learns
   * nothing and tries again. Every place it MATTERS re-decides for itself — see
   * `PanelSalesGate`.
   */
  readonly panelSales: PanelSalesGate;
  /**
   * The category a product is filed under, read under a SHARE lock by the two writes
   * that name one. Only `findForShare`: this service decides whether a category EXISTS
   * in the tenant, and every other category rule belongs to `ProductCategoryService`.
   */
  readonly categories: Pick<ProductCategoryRepository, 'findForShare'>;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  /** Reads `sales.currency`. See `assertPriceCurrency`. */
  readonly settings: SettingsResolver;
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

    /*
     * The fleet filter is decided FIRST, and goes into the query.
     *
     * Filtering what a bounded query returned is the shape this was twice, and each
     * time it left a number at which the catalogue silently emptied: with the bound
     * applied first, twenty ineligible products hid an eligible twenty-first; scanning
     * `PRODUCT_PAGE_MAX` moved that to a hundred; widening to `PRODUCT_PAGE_MAX * 5`
     * moved it to five hundred. Any filter applied after a LIMIT can be defeated by
     * enough ineligible rows in front of the eligible one, so the ceiling was never
     * going to be removed by raising it. Found, and then found again twice, by the
     * Codex review of this branch.
     *
     * So the eligible panels are read once — the fleet is small, operator-provisioned
     * and bounded by nothing the catalogue controls — and handed to the repository as
     * a WHERE clause. The LIMIT then applies to products that are already sellable,
     * which makes the first eligible product reachable however many ineligible ones
     * precede it.
     *
     * ## Where the counting happens, and where it must not
     *
     * `eligiblePanelIds` counts services and unexpired holds, inside `PanelSalesGate`,
     * which is the one evaluator with four callers. The catalogue query itself still
     * counts nothing: it is given ids. A predicate that counted services in the
     * product query would be the second implementation of that rule and would drift
     * from it silently.
     *
     * ## Still a snapshot, and still not trusted
     *
     * A panel can fill between this read and the customer's tap, and a product id
     * travels in a screenshot. Confirmation re-decides under the panel's lock and
     * settlement re-decides again; this is the courtesy filter, unchanged in status
     * by becoming correct.
     */
    const eligiblePanelIds = await this.deps.panelSales.eligiblePanelIds(scope);
    return this.deps.repository.listCatalog(scope, bounded, eligiblePanelIds);
  }

  /**
   * One PAGE of the categories a customer may browse.
   *
   * Offset-paged, which the owner settled in `docs/wp5-categories-audit.md` §6.4 — and
   * deliberately NOT a keyset cursor on `sort_order`, because `sort_order` is
   * operator-mutable and so is not a stable cursor key. The consequence is stated
   * rather than hidden: an operator reordering while a customer pages can move a row
   * across a boundary, and this offset is therefore not snapshot-stable.
   *
   * `hasMore` is READ and not computed — the query asks for `limit + 1` rows and
   * discards the extra — so "there is a next page" is a fact about the data rather
   * than an inference from a count that would be stale anyway.
   *
   * Emptiness is structural. A category with no sellable product is excluded by the
   * SQL's own EXISTS, not by a count taken here; counting to decide what a customer
   * sees is precisely what §6.4 forbids, and a category that passed a count and then
   * showed an empty list is the failure it exists to prevent.
   */
  async browseCategories(
    scope: TenantContext,
    actor: ActorContext,
    limit: number,
    offset: number,
  ): Promise<CustomerPage<ProductCategoryRecord>> {
    await this.deps.guard.check(scope, actor, CATALOG_BROWSE_PERMISSION);
    const bounded = Math.min(Math.max(limit, 1), PRODUCT_PAGE_MAX);
    // The same eligible-panel set the flat browse uses, and for the same reason:
    // every predicate goes into the query, ahead of LIMIT/OFFSET.
    const eligiblePanelIds = await this.deps.panelSales.eligiblePanelIds(scope);
    return this.deps.repository.listCustomerCategories(
      scope,
      bounded,
      Math.max(offset, 0),
      eligiblePanelIds,
    );
  }

  /**
   * One PAGE of the products inside one category.
   *
   * The category id is passed straight to the query rather than validated against a
   * separate read first. That is not a missing check: the SQL carries the category's
   * own status and visibility predicates, so an id naming an INACTIVE category — or
   * another tenant's — matches no rows and the page is empty. Reading the category
   * first would be a second decision about what a customer may see, which §6.3 forbids.
   *
   * An empty page for a category the customer was just offered is possible and is
   * ORDINARY: the last product in it can be withdrawn between the two taps. The
   * surface says so rather than pretending the category is gone.
   */
  async browseCategory(
    scope: TenantContext,
    actor: ActorContext,
    categoryId: string,
    limit: number,
    offset: number,
  ): Promise<CustomerPage<ProductRecord>> {
    await this.deps.guard.check(scope, actor, CATALOG_BROWSE_PERMISSION);
    const bounded = Math.min(Math.max(limit, 1), PRODUCT_PAGE_MAX);
    const eligiblePanelIds = await this.deps.panelSales.eligiblePanelIds(scope);
    return this.deps.repository.listCustomerProductsInCategory(
      scope,
      categoryId,
      bounded,
      Math.max(offset, 0),
      eligiblePanelIds,
    );
  }

  /** Creates an INACTIVE product. Idempotent, audited. */
  async create(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly draft: ProductDraft },
  ): Promise<ProductRecord> {
    const requestHash = hashRequest({ draft: serialisableDraft(input.draft) });

    /*
     * Authorized BEFORE the replay lookup, not only inside the transaction.
     *
     * `runAuthorizedMutation` re-checks inside the committing transaction, which is the
     * rule — but a REPLAY never reaches it, and a replay returns a PRODUCT. Without this
     * an unauthorized caller replaying somebody else's idempotency key would be answered
     * with the row, which is `catalog.view` handed out by the write path.
     *
     * The check is made twice on a first call and exactly once on a replay. That is the
     * shape `CustomerService.resolveFromUpdate` records and `OrderService` copies; this
     * service was the one that did not, found by the Codex review of this branch.
     */
    await this.authorize(scope, actor, {
      action: 'product.create',
      entityType: 'Product',
      entityId: null,
    });

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
        await this.assertPanelIsOurs(scope, input.draft.panelId, tx);
        await this.assertCategoryIsOurs(scope, input.draft.categoryId, tx);
        await this.assertPriceCurrency(scope, input.draft.price, tx);

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

    /** Before the replay, for the reason `create` states: a replay returns a row. */
    await this.authorize(scope, actor, {
      action: 'product.update',
      entityType: 'Product',
      entityId: productId,
    });

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
        await this.assertPanelIsOurs(scope, input.edit.panelId, tx);
        await this.assertCategoryIsOurs(scope, input.edit.categoryId, tx);
        await this.assertPriceCurrency(scope, input.edit.price, tx);

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
    const action = input.to === 'ACTIVE' ? 'product.activate' : 'product.deactivate';

    /** Before the replay, for the reason `create` states: a replay returns a row. */
    await this.authorize(scope, actor, { action, entityType: 'Product', entityId: productId });

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
  /**
   * Charges `catalog.edit` BEFORE the replay lookup, leaving the same trail as a
   * refusal inside the transaction.
   *
   * `runAuthorizedMutation` re-checks inside the committing transaction, which is the
   * rule — but a REPLAY returns before it, so without an early check an unauthorized
   * caller replaying somebody else's idempotency key would be answered with the
   * product. Found by the Codex review of this branch; `OrderService` and
   * `CustomerService.resolveFromUpdate` already had it.
   *
   * `recordMutationDenial` rather than a bare `guard.check`, and that is the half that
   * is easy to leave out: an early check that simply throws writes NO audit row, so
   * closing the read hole would have opened a silent-refusal one. It is the same
   * division of labour `PanelService.authorize` uses, and it is called from exactly one
   * place per attempt, so a denial is one audit row on either path.
   */
  private async authorize(
    scope: TenantContext,
    actor: ActorContext,
    denial: { action: string; entityType: string; entityId: string | null },
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, PRODUCT_EDIT_PERMISSION);
    } catch (error) {
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        PRODUCT_EDIT_PERMISSION,
        denial,
        error,
      );
      throw error;
    }
  }

  /**
   * A product may only be fulfilled on a panel of its own tenant.
   *
   * `products_tenant_panel_fk` (migration 0037) is the GUARANTEE; this is the message.
   * Without the constraint this check is a read-then-write race — a panel deleted
   * between the two would still be written. Without this check the constraint answers
   * an operator's typo with a raw integrity violation, which is a 500 naming a
   * constraint rather than a field.
   *
   * Inside the transaction, like every other precondition here, so the panel that was
   * checked is the panel the product is written against.
   *
   * The refusal is `PANEL_NOT_FOUND` and NOT a distinct "belongs to another tenant".
   * The two cases must be indistinguishable, or the difference between the refusals
   * tells an operator which panel ids exist in somebody else's installation.
   *
   * A null panel is not checked and must not be: `catalog.ts` makes an unconfigured
   * product a real state, and the catalogue refuses it as NOT_FULFILLABLE later where
   * the message names the product.
   */
  private async assertPanelIsOurs(
    scope: TenantContext,
    panelId: PanelId | null,
    tx: TransactionScope,
  ): Promise<void> {
    if (panelId === null) return;
    if (!(await this.deps.panels.existsInScope(scope, panelId, tx))) {
      throw errors.notFound(PANEL_ERROR_CODES.PANEL_NOT_FOUND, 'No such panel.');
    }
  }

  /**
   * The category a product is filed under exists, in THIS tenant.
   *
   * `products_tenant_category_fk` refuses anything else — but as a constraint violation,
   * which `DomainErrorFilter` answers with a 500, where the dedicated reassignment
   * endpoint answers the same foreign or unknown id with `CATEGORY_NOT_FOUND`. Two
   * answers to one question depending on which route asked it. Found by the Codex review
   * of this branch.
   *
   * Under a SHARE lock, so a delete of the category cannot commit between this check and
   * the write: the delete takes the row FOR UPDATE and waits. Null is allowed and means
   * uncategorised — a real state, refused at confirmation with `PRODUCT_NOT_CATEGORISED`.
   */
  private async assertCategoryIsOurs(
    scope: TenantContext,
    categoryId: ProductCategoryId | null,
    tx: TransactionScope,
  ): Promise<void> {
    if (categoryId === null) return;
    if ((await this.deps.categories.findForShare(scope, categoryId, tx)) === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.CATEGORY_NOT_FOUND, 'Unknown category.');
    }
  }

  /**
   * A product is priced in the currency the tenant SELLS in, and in no other.
   *
   * `sales.currency` was declared, rendered by the admin, and enforced by nothing — the
   * defect Codex found. A tenant selling in Toman could hold a product priced in USD,
   * and `products_price_currency_check` would accept it because that constraint admits
   * the whole money vocabulary, which exists for converted payment quotes rather than
   * for store prices.
   *
   * A catalogue in two currencies is the legacy defect made durable. The research
   * records one card-to-card template saying تومان where its twin says ریال for the
   * same `{price}` placeholder — a factor of ten, invisible in either screen alone.
   *
   * Read INSIDE the transaction and from the resolver, not from a cached value: the
   * setting is RUNTIME-mutable, and a price written against a stale reading is exactly
   * the disagreement this check exists to prevent.
   *
   * A null price is not checked, because there is no currency to disagree with. The
   * catalogue refuses such a product as NOT_PRICED where the message names it.
   */
  private async assertPriceCurrency(
    scope: TenantContext,
    price: { readonly currency: string } | null,
    tx: TransactionScope,
  ): Promise<void> {
    if (price === null) return;
    const selling = await this.deps.settings.valueOf<SalesCurrencyCode>(
      scope,
      'sales.currency',
      tx,
    );
    if (price.currency !== selling) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.PRODUCT_CURRENCY_UNSUPPORTED,
        `This installation sells in ${selling}.`,
      );
    }
  }

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
    /*
     * In the fingerprint because it is writable: without it, reusing a key with only the
     * category changed replayed the earlier product instead of refusing a different
     * request under the same key. Found by the Codex review of this branch.
     */
    categoryId: draft.categoryId,
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
    // A move between categories is an edit like any other, and an audit pair that
    // omitted the field recorded it as a change of nothing.
    categoryId: product.categoryId,
    durationDays: product.specification.durationDays,
    trafficBytes: product.specification.trafficBytes.toString(),
    deviceLimit: product.specification.deviceLimit,
    priceAmount: product.price === null ? null : product.price.amountMinor.toString(),
    priceCurrency: product.price === null ? null : product.price.currency,
  };
}
