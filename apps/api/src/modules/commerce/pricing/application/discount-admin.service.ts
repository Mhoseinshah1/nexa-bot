import {
  COMMERCE_ERROR_CODES,
  DISCOUNT_PAGE_DEFAULT,
  DISCOUNT_PAGE_MAX,
  errors,
  normaliseDiscountCode,
  uuidV7Schema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type DiscountStatus,
  type IdGenerator,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type PermissionKey,
  type ProductCategoryId,
  type ProductId,
  type SalesCurrencyCode,
  type TenantContext,
  type UnitOfWork,
  type UserId,
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
import type {
  ProductCategoryRepository,
  ProductRepository,
} from '../../catalog/application/ports.js';
import type { CustomerRepository } from '../../customers/application/ports.js';
import type {
  DiscountRepository,
  DiscountRuleRecord,
  DiscountRuleSearch,
  DiscountRuleWrite,
  RuleCursor,
} from './ports.js';

/** Reading rules is catalogue reading; the Sales role holds it beside the edit permission. */
export const DISCOUNT_VIEW_PERMISSION: PermissionKey = 'catalog.view';
/**
 * `catalog.discounts.edit` — "Create or edit discount codes", HIGH risk — covers BOTH
 * kinds of rule. An automatic rule is a discount every customer receives without typing
 * anything, which is more reach than a code, not less; governing it with the weaker
 * `catalog.edit` would let a product editor give the whole catalogue away.
 */
export const DISCOUNT_EDIT_PERMISSION: PermissionKey = 'catalog.discounts.edit';

export interface DiscountAdminServiceDeps {
  readonly discounts: DiscountRepository;
  readonly products: Pick<ProductRepository, 'findById'>;
  readonly categories: Pick<ProductCategoryRepository, 'findById'>;
  readonly customers: Pick<CustomerRepository, 'findById'>;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly settings: SettingsResolver;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** A rule as the operator lists it: the row, and the live count its limits decide on. */
export interface DiscountListing {
  readonly rule: DiscountRuleRecord;
  readonly liveRedemptions: number;
}

export interface DiscountListingPage {
  readonly items: readonly DiscountListing[];
  readonly nextCursor: RuleCursor | null;
}

/**
 * Discount rules, as an operator manages them (`docs/wp8-pricing-audit.md` P3, P12).
 *
 * The seven-step write path `ServiceAddonService` runs: authorize before the replay,
 * the replay, then one transaction that re-authorizes, reads scope activity, validates
 * against the tenant's own rows, writes, audits and remembers the key.
 *
 * What an operator may NOT do here is as deliberate as what they may:
 *
 * - A rule is created `INACTIVE`. Going live is its own command, so no single call
 *   publishes a rule nobody has looked at.
 * - `kind` and `code` never change. A code a customer has been given must keep meaning
 *   the rule it named, and an automatic rule that became a code rule would quietly stop
 *   applying to everyone who never typed it. A different rule is a new rule.
 * - There is no delete. A redemption row names its rule, and a rule nobody may use is a
 *   deactivated one.
 *
 * An edit changes what sells NEXT, never what sold: every confirmed order carries its
 * own quote, and confirmation re-decides only the facts that can make a quote
 * unfulfillable (status, window, limits, first purchase) — never the amount.
 */
export class DiscountAdminService {
  constructor(private readonly deps: DiscountAdminServiceDeps) {}

  async list(
    scope: TenantContext,
    actor: ActorContext,
    query: {
      readonly limit?: number;
      readonly cursor?: RuleCursor;
      readonly search: DiscountRuleSearch;
    },
  ): Promise<DiscountListingPage> {
    await this.deps.guard.check(scope, actor, DISCOUNT_VIEW_PERMISSION);
    const limit = Math.min(Math.max(query.limit ?? DISCOUNT_PAGE_DEFAULT, 1), DISCOUNT_PAGE_MAX);
    const page = await this.deps.discounts.list(scope, query.search, limit, query.cursor ?? null);
    return { items: await this.withUsage(scope, page.items), nextCursor: page.nextCursor };
  }

  async get(scope: TenantContext, actor: ActorContext, id: string): Promise<DiscountListing> {
    await this.deps.guard.check(scope, actor, DISCOUNT_VIEW_PERMISSION);
    const rule = await this.deps.discounts.findById(scope, this.ruleId(id));
    if (rule === null) throw notFound();
    const [listing] = await this.withUsage(scope, [rule]);
    return listing as DiscountListing;
  }

  /** Creates an INACTIVE rule. Idempotent, audited. A taken code is `DISCOUNT_CODE_TAKEN`. */
  async create(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly write: DiscountRuleWrite },
  ): Promise<DiscountListing> {
    const write = normalised(input.write);
    const requestHash = hashRequest({ write: serialisable(write) });
    const denial = { action: 'discount.create', entityType: 'Discount', entityId: null };

    await this.authorize(scope, actor, denial);

    const replay = await this.deps.idempotency.find<{ discountId: string }>(
      scope,
      'WEB',
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      const existing = await this.deps.discounts.findById(scope, replay.result.discountId);
      if (existing !== null) return this.listingOf(scope, existing);
    }

    const now = this.deps.clock.now();
    const id = this.deps.ids.uuid();

    const created = await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      DISCOUNT_EDIT_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        await this.assertReferences(scope, write, tx);

        const row = await this.deps.discounts.create(scope, id, write, now, tx);
        if (row === null) {
          // The unique index decided, under ON CONFLICT DO NOTHING: two operators
          // creating one code at once get one rule and this refusal, never a 23505.
          throw errors.conflict(
            COMMERCE_ERROR_CODES.DISCOUNT_CODE_TAKEN,
            'Another discount already uses that code.',
          );
        }

        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'discount.create',
            entityType: 'Discount',
            entityId: row.id,
            before: null,
            after: auditView(row),
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
          { discountId: row.id },
          tx,
        );
        return row;
      },
    );
    return this.listingOf(scope, created);
  }

  async update(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly discountId: string;
      readonly write: DiscountRuleWrite;
    },
  ): Promise<DiscountListing> {
    const discountId = this.ruleId(input.discountId);
    const write = normalised(input.write);
    const requestHash = hashRequest({ discountId, write: serialisable(write) });
    const denial = { action: 'discount.update', entityType: 'Discount', entityId: discountId };

    await this.authorize(scope, actor, denial);

    const replay = await this.deps.idempotency.find<{ discountId: string }>(
      scope,
      'WEB',
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      const existing = await this.deps.discounts.findById(scope, discountId);
      if (existing !== null) return this.listingOf(scope, existing);
    }

    const now = this.deps.clock.now();

    const updated = await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      DISCOUNT_EDIT_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);

        const before = await this.deps.discounts.findById(scope, discountId, tx);
        if (before === null) throw notFound();
        if (before.kind !== write.kind || before.code !== write.code) {
          throw errors.validation(
            COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
            'A discount keeps its kind and its code. Create a new rule for a different one.',
          );
        }
        await this.assertReferences(scope, write, tx);

        const after = await this.deps.discounts.update(scope, discountId, write, now, tx);
        if (after === null) throw notFound();

        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'discount.update',
            entityType: 'Discount',
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
          { discountId: after.id },
          tx,
        );
        return after;
      },
    );
    return this.listingOf(scope, updated);
  }

  async activate(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly discountId: string },
  ): Promise<DiscountListing> {
    return this.setStatus(scope, actor, { ...input, to: 'ACTIVE' });
  }

  /**
   * Withdraws a rule. It touches no order: a draft that already carries the discount is
   * refused at confirmation with `DISCOUNT_NO_LONGER_VALID` rather than silently
   * re-priced, and a confirmed order keeps what it was sold at.
   */
  async deactivate(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly discountId: string },
  ): Promise<DiscountListing> {
    return this.setStatus(scope, actor, { ...input, to: 'INACTIVE' });
  }

  private async setStatus(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly discountId: string;
      readonly to: DiscountStatus;
    },
  ): Promise<DiscountListing> {
    const discountId = this.ruleId(input.discountId);
    const requestHash = hashRequest({ discountId, to: input.to });
    const action = input.to === 'ACTIVE' ? 'discount.activate' : 'discount.deactivate';
    const denial = { action, entityType: 'Discount', entityId: discountId };

    await this.authorize(scope, actor, denial);

    const replay = await this.deps.idempotency.find<{ discountId: string }>(
      scope,
      'WEB',
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      const existing = await this.deps.discounts.findById(scope, discountId);
      if (existing !== null) return this.listingOf(scope, existing);
    }

    const now = this.deps.clock.now();
    const from: DiscountStatus = input.to === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';

    const after = await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      DISCOUNT_EDIT_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const before = await this.deps.discounts.findById(scope, discountId, tx);
        if (before === null) throw notFound();

        const changed = await this.deps.discounts.setStatus(
          scope,
          discountId,
          from,
          input.to,
          now,
          tx,
        );
        const row = await this.deps.discounts.findById(scope, discountId, tx);
        if (row === null) throw notFound();

        // A no-op still writes its audit row: "withdrew it" and "it was already
        // withdrawn" are different entries in the log.
        await this.deps.audit.record(
          scope,
          actor,
          {
            action,
            entityType: 'Discount',
            entityId: row.id,
            before: { status: before.status },
            after: { status: row.status, changed },
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
          { discountId: row.id },
          tx,
        );
        return row;
      },
    );
    return this.listingOf(scope, after);
  }

  /**
   * Every row a rule names must be THIS tenant's.
   *
   * The composite foreign keys would refuse another tenant's id too, but as a raw 23503
   * naming a constraint. And a fixed amount in a currency the tenant does not sell in is
   * a rule the engine refuses on `CURRENCY` for every order it ever sees — accepted, it
   * would sit `ACTIVE` in the list and never apply, which is the silent success the
   * legacy system was full of.
   */
  private async assertReferences(
    scope: TenantContext,
    write: DiscountRuleWrite,
    tx: TransactionScope,
  ): Promise<void> {
    if (write.productId !== null) {
      const product = await this.deps.products.findById(scope, write.productId as ProductId, tx);
      if (product === null) {
        throw errors.notFound(COMMERCE_ERROR_CODES.PRODUCT_NOT_FOUND, 'Unknown product.');
      }
    }
    if (write.categoryId !== null) {
      const category = await this.deps.categories.findById(
        scope,
        write.categoryId as ProductCategoryId,
        tx,
      );
      if (category === null) {
        throw errors.notFound(COMMERCE_ERROR_CODES.CATEGORY_NOT_FOUND, 'Unknown category.');
      }
    }
    if (write.customerId !== null) {
      const customer = await this.deps.customers.findById(scope, write.customerId as UserId, tx);
      if (customer === null) {
        throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
      }
    }
    if (write.currency !== null) {
      const selling = await this.deps.settings.valueOf<SalesCurrencyCode>(
        scope,
        'sales.currency',
        tx,
      );
      if (write.currency !== selling) {
        throw errors.conflict(
          COMMERCE_ERROR_CODES.PRODUCT_CURRENCY_UNSUPPORTED,
          `This installation sells in ${selling}.`,
        );
      }
    }
  }

  private async listingOf(
    scope: TenantContext,
    rule: DiscountRuleRecord,
  ): Promise<DiscountListing> {
    const [listing] = await this.withUsage(scope, [rule]);
    return listing as DiscountListing;
  }

  /** The LIVE count per rule, in one query for the page — the number the limits use. */
  private async withUsage(
    scope: TenantContext,
    rules: readonly DiscountRuleRecord[],
  ): Promise<DiscountListing[]> {
    if (rules.length === 0) return [];
    const usage = await this.deps.discounts.usage(
      scope,
      rules.map((r) => r.id),
      null,
      null,
    );
    return rules.map((rule) => ({ rule, liveRedemptions: usage.get(rule.id)?.live ?? 0 }));
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

  /** Before the replay lookup: a replay returns a ROW, and would hand it to anybody. */
  private async authorize(
    scope: TenantContext,
    actor: ActorContext,
    denial: { action: string; entityType: string; entityId: string | null },
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, DISCOUNT_EDIT_PERMISSION);
    } catch (error) {
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        DISCOUNT_EDIT_PERMISSION,
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

  /** A uuid, validated in the SERVICE so a malformed path is a 400 and not a 22P02. */
  private ruleId(candidate: string): string {
    const parsed = uuidV7Schema.safeParse(candidate);
    if (!parsed.success) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'That is not a valid discount identifier.',
      );
    }
    return parsed.data;
  }
}

function notFound() {
  return errors.notFound(COMMERCE_ERROR_CODES.DISCOUNT_NOT_FOUND, 'Unknown discount.');
}

/** The code in its stored form, so a replay typed in another case hashes the same. */
function normalised(write: DiscountRuleWrite): DiscountRuleWrite {
  return { ...write, code: write.code === null ? null : normaliseDiscountCode(write.code) };
}

/** `bigint` and `Date` as text: `hashRequest` serialises to JSON. */
function serialisable(write: DiscountRuleWrite): Record<string, unknown> {
  return {
    ...write,
    value: write.value.toString(),
    minimumSubtotal: write.minimumSubtotal?.toString() ?? null,
    startsAt: write.startsAt?.toISOString() ?? null,
    endsAt: write.endsAt?.toISOString() ?? null,
    appliesTo: [...write.appliesTo],
  };
}

/** Every mutable field, so a before/after pair answers what an edit changed. */
function auditView(rule: DiscountRuleRecord): Record<string, unknown> {
  return {
    kind: rule.kind,
    code: rule.code,
    label: rule.label,
    type: rule.type,
    value: rule.value.toString(),
    currency: rule.currency,
    appliesTo: [...rule.appliesTo],
    productId: rule.productId,
    categoryId: rule.categoryId,
    customerId: rule.customerId,
    firstPurchaseOnly: rule.firstPurchaseOnly,
    minimumSubtotal: rule.minimumSubtotal?.toString() ?? null,
    startsAt: rule.startsAt?.toISOString() ?? null,
    endsAt: rule.endsAt?.toISOString() ?? null,
    totalLimit: rule.totalLimit,
    perCustomerLimit: rule.perCustomerLimit,
    priority: rule.priority,
    stackable: rule.stackable,
    status: rule.status,
  };
}
