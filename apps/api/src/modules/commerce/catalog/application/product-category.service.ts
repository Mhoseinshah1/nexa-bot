import {
  COMMERCE_ERROR_CODES,
  PRODUCT_CATEGORY_NAME_MAX_LENGTH,
  errors,
  isValidCategoryEmoji,
  productCategoryIdSchema,
  productIdSchema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type ProductCategoryId,
  type ProductCategoryStatus,
  type ProductCategoryVisibility,
  type ProductId,
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
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import { PRODUCT_EDIT_PERMISSION, PRODUCT_VIEW_PERMISSION } from './product.service.js';
import type {
  ProductCategoryDraft,
  ProductCategoryEdit,
  ProductCategoryListing,
  ProductCategoryRecord,
  ProductCategoryRepository,
  ProductRepository,
} from './ports.js';

/**
 * The bound on how many categories one reorder may name.
 *
 * Not a page size — the operator list is deliberately unpaged — but a bound on one
 * statement's input, so a caller cannot ask the database to unnest an array of any size
 * it likes. A tenant with more categories than this has a catalogue problem that a
 * larger constant would not solve.
 */
export const CATEGORY_REORDER_MAX = 200;

/**
 * The highest position an operator may assign.
 *
 * Mirrors `product_categories_sort_check` in migration 0097. Stated here as well so the
 * refusal names the field instead of arriving as a constraint violation; the CHECK is
 * what GUARANTEES it, this is what explains it.
 */
export const CATEGORY_SORT_ORDER_MAX = 100_000;

export interface ProductCategoryServiceDeps {
  readonly categories: ProductCategoryRepository;
  /**
   * Read on one path only: the reassignment that moves a product between categories.
   *
   * The category service owns that write rather than `ProductService`, because what it
   * has to be atomic with is the DESTINATION category's continued existence, which is
   * this aggregate's business.
   */
  readonly products: ProductRepository;
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

/**
 * Categories, as an operator manages them.
 *
 * It charges `catalog.view` and `catalog.edit` — the same two keys products move under,
 * because `permissions.ts` labels them "View products and categories" and "Create or
 * edit products and categories". A `categories.edit` invented beside them would be the
 * second vocabulary `docs/phase4b-audit.md` opens by warning about, and would leave
 * every existing role unable to do something its label promises.
 *
 * What is NOT here, deliberately: any decision about what a customer sees. That lives
 * in `catalog-visibility.ts` and in the SQL of `listCustomerCategories`, with one
 * evaluator and four callers. A service that also decided visibility would be the
 * second interpretation the audit's §6.3 forbids.
 */
export class ProductCategoryService {
  constructor(private readonly deps: ProductCategoryServiceDeps) {}

  /** Every category with its product count, in the operator's order. */
  async list(
    scope: TenantContext,
    actor: ActorContext,
  ): Promise<readonly ProductCategoryListing[]> {
    await this.deps.guard.check(scope, actor, PRODUCT_VIEW_PERMISSION);
    return this.deps.categories.listForOperator(scope);
  }

  async get(scope: TenantContext, actor: ActorContext, id: string): Promise<ProductCategoryRecord> {
    await this.deps.guard.check(scope, actor, PRODUCT_VIEW_PERMISSION);
    const found = await this.deps.categories.findById(scope, this.categoryId(id));
    if (found === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.CATEGORY_NOT_FOUND, 'Unknown category.');
    }
    return found;
  }

  /**
   * Creates a category. ACTIVE and VISIBLE, and neither is an argument.
   *
   * The asymmetry with `ProductService.create`, which forces INACTIVE, is deliberate and
   * is about what each thing costs to get wrong. A product created ACTIVE is on sale
   * before its operator has checked its price, so it starts withdrawn. An empty category
   * is invisible to customers whatever its flags say — `listCustomerCategories` decides
   * emptiness structurally — so there is nothing to protect them from, and a category
   * that arrived switched off would need a second press before the operator could file
   * anything under it.
   */
  async create(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly draft: ProductCategoryDraft },
  ): Promise<ProductCategoryRecord> {
    const draft = this.validateDraft(input.draft);
    const requestHash = hashRequest({ draft });

    /** Before the replay, for the reason `ProductService.create` states: a replay returns a row. */
    await this.authorize(scope, actor, {
      action: 'category.create',
      entityType: 'ProductCategory',
      entityId: null,
    });

    const replay = await this.deps.idempotency.find<{ categoryId: string }>(
      scope,
      'WEB',
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      const existing = await this.deps.categories.findById(
        scope,
        replay.result.categoryId as ProductCategoryId,
      );
      if (existing !== null) return existing;
      /*
       * The key is SPENT and its category is gone — deleted since, or lost to a restore.
       *
       * This fell through to creating a replacement, which could never commit: the
       * idempotency row for this key still exists, so `rememberOnce` refused the new one
       * as `IDEMPOTENCY_IN_FLIGHT` and rolled the category back, on every retry, with a
       * message telling the caller to retry. Found by the Codex review of this branch.
       *
       * The defined outcome is the truth about the key: what it created no longer
       * exists. A caller who wants a category makes a new request, under a new key.
       */
      throw errors.notFound(
        COMMERCE_ERROR_CODES.CATEGORY_NOT_FOUND,
        'The category this request created has since been deleted.',
      );
    }

    const now = this.deps.clock.now();
    const id = this.deps.ids.uuid() as ProductCategoryId;

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      PRODUCT_EDIT_PERMISSION,
      { action: 'category.create', entityType: 'ProductCategory', entityId: null },
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const created = await this.deps.categories.create(scope, { id, draft, now }, tx);
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'category.create',
            entityType: 'ProductCategory',
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
          { categoryId: created.id },
          tx,
        );
        return created;
      },
    );
  }

  /**
   * Renames a category, or changes its description or emoji.
   *
   * A rename reaches every order that was placed under it, because an order's category
   * SNAPSHOT is a copy rather than a reference — so nothing here rewrites history. That
   * is the whole reason the snapshot exists, and the legacy «محصول حذف‌شده» is what a
   * rename looks like without it.
   */
  async update(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly categoryId: string;
      readonly edit: ProductCategoryEdit;
    },
  ): Promise<ProductCategoryRecord> {
    const categoryId = this.categoryId(input.categoryId);
    const edit = this.validateEdit(input.edit);
    const requestHash = hashRequest({ categoryId, edit });

    await this.authorize(scope, actor, {
      action: 'category.update',
      entityType: 'ProductCategory',
      entityId: categoryId,
    });

    const replay = await this.deps.idempotency.find<{ categoryId: string }>(
      scope,
      'WEB',
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      const existing = await this.deps.categories.findById(scope, categoryId);
      if (existing !== null) return existing;
    }

    const now = this.deps.clock.now();

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      PRODUCT_EDIT_PERMISSION,
      { action: 'category.update', entityType: 'ProductCategory', entityId: categoryId },
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const before = await this.requireCategory(scope, categoryId, tx);
        const after = await this.deps.categories.update(scope, categoryId, edit, now, tx);
        if (after === null) {
          throw errors.notFound(COMMERCE_ERROR_CODES.CATEGORY_NOT_FOUND, 'Unknown category.');
        }
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'category.update',
            entityType: 'ProductCategory',
            entityId: categoryId,
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
          { categoryId },
          tx,
        );
        return after;
      },
    );
  }

  async activate(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly categoryId: string },
  ): Promise<ProductCategoryRecord> {
    return this.transition(scope, actor, { ...input, kind: 'status', to: 'ACTIVE' });
  }

  /**
   * Withdraws a whole category from sale.
   *
   * Unorderable, not merely unlisted — including through a direct reference a customer
   * already holds, which is exactly what separates INACTIVE from HIDDEN. The
   * confirmation transaction re-decides under its own lock, so a tap on a message sent
   * before this commit is refused rather than honoured. §6.3 of the audit.
   *
   * It terminates nothing. Services already sold under this category keep running, and
   * orders already placed keep their snapshot: this changes what may be bought next.
   */
  async deactivate(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly categoryId: string },
  ): Promise<ProductCategoryRecord> {
    return this.transition(scope, actor, { ...input, kind: 'status', to: 'INACTIVE' });
  }

  async show(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly categoryId: string },
  ): Promise<ProductCategoryRecord> {
    return this.transition(scope, actor, { ...input, kind: 'visibility', to: 'VISIBLE' });
  }

  /**
   * Takes a category out of the lists, and leaves it orderable.
   *
   * The half of §6.3 that is easy to implement as the other one. A hidden category is
   * not browsable and not discoverable, and a customer holding a reference to a product
   * inside it may still buy that product — product-level eligibility still applies. An
   * implementation that refused the purchase would have made HIDDEN a second INACTIVE
   * and left the product with no way to be sold quietly.
   */
  async hide(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly categoryId: string },
  ): Promise<ProductCategoryRecord> {
    return this.transition(scope, actor, { ...input, kind: 'visibility', to: 'HIDDEN' });
  }

  /**
   * Writes a new order for the categories named, and refuses a partial one.
   *
   * Every id must belong to this tenant and must exist: the repository's UPDATE carries
   * the tenant predicate, so a foreign or unknown id simply matches nothing, and the
   * returned count is compared against what was asked for. Accepting a short count would
   * let a caller reorder the categories it does own while silently failing on one it
   * mistyped, and the operator would be looking at a list that is half what they asked
   * for with a success message above it.
   */
  async reorder(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly positions: readonly { readonly id: string; readonly sortOrder: number }[];
    },
  ): Promise<readonly ProductCategoryListing[]> {
    const positions = this.validatePositions(input.positions);
    const requestHash = hashRequest({ positions });

    await this.authorize(scope, actor, {
      action: 'category.reorder',
      entityType: 'ProductCategory',
      entityId: null,
    });

    const replay = await this.deps.idempotency.find<{ moved: number }>(
      scope,
      'WEB',
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) return this.deps.categories.listForOperator(scope);

    const now = this.deps.clock.now();

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      PRODUCT_EDIT_PERMISSION,
      { action: 'category.reorder', entityType: 'ProductCategory', entityId: null },
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const before = await this.deps.categories.listForOperator(scope, tx);
        const moved = await this.deps.categories.reorder(scope, positions, now, tx);
        if (moved !== positions.length) {
          throw errors.notFound(
            COMMERCE_ERROR_CODES.CATEGORY_NOT_FOUND,
            'One of those categories does not exist.',
          );
        }
        const after = await this.deps.categories.listForOperator(scope, tx);
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'category.reorder',
            entityType: 'ProductCategory',
            entityId: null,
            before: { order: before.map((c) => ({ id: c.id, sortOrder: c.sortOrder })) },
            after: { order: after.map((c) => ({ id: c.id, sortOrder: c.sortOrder })) },
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
          { moved },
          tx,
        );
        return after;
      },
    );
  }

  /**
   * Moves a product from whichever category it is in to another.
   *
   * Both reads happen inside the transaction and the DESTINATION is locked first, so the
   * category a product is filed under is one that still exists at commit. Without the
   * lock a concurrent delete of the destination would be refused by
   * `products_tenant_category_fk` — correct, but as a constraint violation rather than
   * as a sentence.
   *
   * The audit row carries the id the product moved FROM, which may be null: a product
   * that was never categorised is reassigned by exactly this path, and `before: null`
   * would lose the fact that it had no category rather than record it.
   */
  async reassignProduct(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly productId: string;
      readonly categoryId: string;
    },
  ): Promise<{ readonly productId: string; readonly categoryId: ProductCategoryId }> {
    const categoryId = this.categoryId(input.categoryId);
    const productId = this.productId(input.productId);
    const requestHash = hashRequest({ productId, categoryId });

    await this.authorize(scope, actor, {
      action: 'category.reassign_product',
      entityType: 'Product',
      entityId: productId,
    });

    const replay = await this.deps.idempotency.find<{ categoryId: string }>(
      scope,
      'WEB',
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      return { productId, categoryId };
    }

    const now = this.deps.clock.now();

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      PRODUCT_EDIT_PERMISSION,
      {
        action: 'category.reassign_product',
        entityType: 'Product',
        entityId: productId,
      },
      async (tx) => {
        await this.assertScopeActive(scope, tx);

        // The DESTINATION first, and locked: what this write depends on is that the
        // category it names is still there when the product row is updated.
        if (!(await this.deps.categories.lock(scope, categoryId, tx))) {
          throw errors.notFound(COMMERCE_ERROR_CODES.CATEGORY_NOT_FOUND, 'Unknown category.');
        }

        const before = await this.deps.products.findById(scope, productId, tx);
        if (before === null) {
          throw errors.notFound(COMMERCE_ERROR_CODES.PRODUCT_NOT_FOUND, 'Unknown product.');
        }

        const after = await this.deps.products.setCategory(scope, before.id, categoryId, now, tx);
        if (after === null) {
          throw errors.notFound(COMMERCE_ERROR_CODES.PRODUCT_NOT_FOUND, 'Unknown product.');
        }

        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'category.reassign_product',
            entityType: 'Product',
            entityId: before.id,
            before: { categoryId: before.categoryId },
            after: { categoryId: after.categoryId },
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
          { categoryId },
          tx,
        );
        return { productId: after.id, categoryId };
      },
    );
  }

  /**
   * Deletes a category, and refuses while it still holds products.
   *
   * The lock is taken BEFORE the count, which is the whole correctness of this method: a
   * count read before the lock answers the state the loser of a race started from, so a
   * product created into the category concurrently would be counted as zero and the
   * delete would be attempted anyway. Under the lock, the count is what we commit on.
   *
   * `products_tenant_category_fk` is `ON DELETE NO ACTION`, so the database refuses this
   * independently. That is the guarantee; the count is the message — "there are eleven
   * products in this category" is what lets an operator act, and a constraint name is
   * not.
   */
  async remove(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly categoryId: string },
  ): Promise<{ readonly deleted: true }> {
    const categoryId = this.categoryId(input.categoryId);
    const requestHash = hashRequest({ categoryId });

    await this.authorize(scope, actor, {
      action: 'category.delete',
      entityType: 'ProductCategory',
      entityId: categoryId,
    });

    const replay = await this.deps.idempotency.find<{ deleted: boolean }>(
      scope,
      'WEB',
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) return { deleted: true };

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      PRODUCT_EDIT_PERMISSION,
      { action: 'category.delete', entityType: 'ProductCategory', entityId: categoryId },
      async (tx) => {
        await this.assertScopeActive(scope, tx);

        if (!(await this.deps.categories.lock(scope, categoryId, tx))) {
          throw errors.notFound(COMMERCE_ERROR_CODES.CATEGORY_NOT_FOUND, 'Unknown category.');
        }
        const before = await this.requireCategory(scope, categoryId, tx);

        const held = await this.deps.categories.countProducts(scope, categoryId, tx);
        if (held > 0) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.CATEGORY_NOT_EMPTY,
            'This category still holds products.',
            { productCount: held },
          );
        }

        const deleted = await this.deps.categories.delete(scope, categoryId, tx);
        if (!deleted) {
          throw errors.notFound(COMMERCE_ERROR_CODES.CATEGORY_NOT_FOUND, 'Unknown category.');
        }

        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'category.delete',
            entityType: 'ProductCategory',
            entityId: categoryId,
            before: auditView(before),
            after: null,
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
          { deleted: true },
          tx,
        );
        return { deleted: true as const };
      },
    );
  }

  /**
   * The one transition path, for both flags.
   *
   * One method rather than two near-identical ones, because what differs between status
   * and visibility is which column moves and nothing about the shape: conditional on the
   * current value, audited once, and a second press is a success that changed nothing.
   * Two copies is how the two flags eventually stop agreeing about what a repeat press
   * means.
   */
  private async transition(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly categoryId: string;
      readonly kind: 'status' | 'visibility';
      readonly to: ProductCategoryStatus | ProductCategoryVisibility;
    },
  ): Promise<ProductCategoryRecord> {
    const categoryId = this.categoryId(input.categoryId);
    const requestHash = hashRequest({ categoryId, kind: input.kind, to: input.to });
    const action = ACTIONS[input.to];

    await this.authorize(scope, actor, {
      action,
      entityType: 'ProductCategory',
      entityId: categoryId,
    });

    const replay = await this.deps.idempotency.find<{ categoryId: string }>(
      scope,
      'WEB',
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      const existing = await this.deps.categories.findById(scope, categoryId);
      if (existing !== null) return existing;
    }

    const now = this.deps.clock.now();

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      PRODUCT_EDIT_PERMISSION,
      { action, entityType: 'ProductCategory', entityId: categoryId },
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const before = await this.requireCategory(scope, categoryId, tx);

        const moved =
          input.kind === 'status'
            ? await this.deps.categories.setStatus(
                scope,
                categoryId,
                before.status,
                input.to as ProductCategoryStatus,
                now,
                tx,
              )
            : await this.deps.categories.setVisibility(
                scope,
                categoryId,
                before.visibility,
                input.to as ProductCategoryVisibility,
                now,
                tx,
              );

        /*
         * Already there, so nothing moved and nothing is audited.
         *
         * `moved === null` here can only mean the conditional UPDATE found no row whose
         * current value was `before`'s — and `before` was read in this same transaction
         * under the same snapshot, so the one reachable cause is that it was ALREADY the
         * target value. Auditing it would put a transition in the log that never
         * happened, which is the defect `docs/wp4-falsification.md` M?-class rows exist
         * to stop.
         */
        const current = (input.kind === 'status' ? before.status : before.visibility) === input.to;
        if (current) {
          await rememberOnce(
            this.deps.idempotency,
            scope,
            'WEB',
            input.idempotencyKey,
            requestHash,
            { categoryId },
            tx,
          );
          return before;
        }
        if (moved === null) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
            'This category changed while the request was running. Try again.',
          );
        }

        await this.deps.audit.record(
          scope,
          actor,
          {
            action,
            entityType: 'ProductCategory',
            entityId: categoryId,
            before: auditView(before),
            after: auditView(moved),
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
          { categoryId },
          tx,
        );
        return moved;
      },
    );
  }

  private async requireCategory(
    scope: TenantContext,
    id: ProductCategoryId,
    tx: TransactionScope,
  ): Promise<ProductCategoryRecord> {
    const found = await this.deps.categories.findById(scope, id, tx);
    if (found === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.CATEGORY_NOT_FOUND, 'Unknown category.');
    }
    return found;
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
   * Charges `catalog.edit` before the replay lookup, and records the denial.
   *
   * The same division of labour `ProductService.authorize` documents: the early check
   * closes the hole where a replay returns a row without ever reaching the transaction,
   * and `recordMutationDenial` is what stops that early check being a silent refusal.
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

  private async assertScopeActive(scope: TenantContext, tx: TransactionScope): Promise<void> {
    if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'This installation has stopped accepting work.',
      );
    }
  }

  /**
   * A category id, or a refusal that is not a 500.
   *
   * `product_categories.id` is a `uuid` column, so a path segment that is not one
   * reaches PostgreSQL as `invalid input syntax for type uuid`. Validated in the SERVICE
   * so every later surface inherits the rule instead of rediscovering it, exactly as
   * `ProductService.productId` records.
   */
  private categoryId(candidate: string): ProductCategoryId {
    const parsed = productCategoryIdSchema.safeParse(candidate);
    if (!parsed.success) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'That is not a valid category identifier.',
      );
    }
    return parsed.data;
  }

  /** As `categoryId`, for the product a reassignment names. */
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

  private validateEdit(edit: ProductCategoryEdit): ProductCategoryEdit {
    const name = edit.name.trim();
    if (name.length === 0 || name.length > PRODUCT_CATEGORY_NAME_MAX_LENGTH) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'A category needs a name, and it must be short enough to show on a button.',
      );
    }
    /*
     * The emoji bound is `isValidCategoryEmoji` and not a length in characters.
     *
     * A family emoji is seven code points and one grapheme; a naive `.length` check
     * admits or refuses it for reasons that have nothing to do with how wide the button
     * is. `catalog.ts` owns that decision so both surfaces and the CHECK constraint
     * agree, and absence is valid — §6.1.
     */
    if (edit.emoji !== null && !isValidCategoryEmoji(edit.emoji)) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'That is not something this catalogue can show as a category icon.',
      );
    }
    return {
      name,
      description: edit.description === null ? null : edit.description.trim() || null,
      emoji: edit.emoji,
    };
  }

  private validateDraft(draft: ProductCategoryDraft): ProductCategoryDraft {
    const edit = this.validateEdit(draft);
    if (
      !Number.isInteger(draft.sortOrder) ||
      draft.sortOrder < 0 ||
      draft.sortOrder > CATEGORY_SORT_ORDER_MAX
    ) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'That is not a position a category can be put in.',
      );
    }
    return { ...edit, sortOrder: draft.sortOrder };
  }

  private validatePositions(
    positions: readonly { readonly id: string; readonly sortOrder: number }[],
  ): readonly { readonly id: ProductCategoryId; readonly sortOrder: number }[] {
    if (positions.length === 0 || positions.length > CATEGORY_REORDER_MAX) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'That is not a number of categories this can reorder at once.',
      );
    }
    const seen = new Set<string>();
    const parsed = positions.map((p) => {
      const id = this.categoryId(p.id);
      if (seen.has(id)) {
        /*
         * A repeated id would give one category two positions in the same statement,
         * and which one won would be decided by the order `unnest` happened to produce.
         * Refused rather than deduplicated: the caller asked for something that has no
         * answer, and silently picking one is how a list ends up in an order nobody
         * chose.
         */
        throw errors.validation(
          COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
          'The same category was given two positions.',
        );
      }
      seen.add(id);
      if (
        !Number.isInteger(p.sortOrder) ||
        p.sortOrder < 0 ||
        p.sortOrder > CATEGORY_SORT_ORDER_MAX
      ) {
        throw errors.validation(
          COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
          'That is not a position a category can be put in.',
        );
      }
      return { id, sortOrder: p.sortOrder };
    });
    return parsed;
  }
}

/**
 * The four transitions, each with the action name its audit row carries.
 *
 * Keyed by the exact union rather than by `string`, so the lookup is TOTAL. Typed
 * loosely it is `string | undefined`, and the `undefined` would reach an audit row as a
 * mutation with no action name — which is a row nobody can search for, in the table
 * whose whole job is being searchable.
 */
const ACTIONS: Record<ProductCategoryStatus | ProductCategoryVisibility, string> = {
  ACTIVE: 'category.activate',
  INACTIVE: 'category.deactivate',
  VISIBLE: 'category.show',
  HIDDEN: 'category.hide',
};

/**
 * What an audit row records about a category.
 *
 * Explicit rather than the whole record, for the reason every other `auditView` here is:
 * an audit row is a projection somebody reads years later, and spreading the record
 * would silently start carrying any column a future migration adds.
 */
function auditView(category: ProductCategoryRecord): Record<string, unknown> {
  return {
    name: category.name,
    description: category.description,
    emoji: category.emoji,
    status: category.status,
    visibility: category.visibility,
    sortOrder: category.sortOrder,
  };
}
