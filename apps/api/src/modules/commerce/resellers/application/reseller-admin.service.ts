import {
  COMMERCE_ERROR_CODES,
  PRODUCT_PAGE_MAX,
  RESELLER_ENTITLEMENT_DIMENSIONS,
  RESELLER_GRANT_DIMENSION,
  RESELLER_HISTORY_MAX,
  RESELLER_PAGE_DEFAULT,
  RESELLER_PAGE_MAX,
  RESELLER_PURCHASE_PAGE_DEFAULT,
  RESELLER_PURCHASE_PAGE_MAX,
  errors,
  resellerPriceLayer,
  uuidV7Schema,
  type ActorContext,
  type AuditWriter,
  type BotInstanceId,
  type Clock,
  type CurrencyCode,
  type IdGenerator,
  type IdempotencyStore,
  type Money,
  type OperationalEventRecorder,
  type PermissionKey,
  type ProductCategoryId,
  type ProductId,
  type ProductStatus,
  type ResellerCreditState,
  type ResellerEntitlementDimension,
  type ResellerLimitSource,
  type ResellerMinimumSource,
  type ResellerOverrideMode,
  type ResellerPriceLayer,
  type ResellerPricingMode,
  type ResellerStatus,
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
import type { BotInstanceRepository } from '../../../platform/tenancy/application/ports.js';
import type { PanelRepository } from '../../../platform/panels/application/ports.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  ProductCategoryRepository,
  ProductRepository,
} from '../../catalog/application/ports.js';
import type { CustomerRepository } from '../../customers/application/ports.js';
import type { SettingsResolver } from '../../../control/settings/application/settings-resolver.js';
import {
  AUDIT_VIEW_PERMISSION,
  type AuditHistoryReader,
  type AuditHistoryRecord,
} from '../../../platform/audit/application/ports.js';
import { ORDER_VIEW_PERMISSION } from '../../orders/application/order.service.js';
import type { WalletRepository } from '../../wallet/application/ports.js';
import { WALLET_VIEW_PERMISSION } from '../../wallet/application/wallet.service.js';
import {
  creditAllowanceOf,
  creditFigures,
  creditStateOf,
  effectiveLimitOf,
  type CreditTerms,
} from '../domain/reseller-credit.js';
import {
  decideEntitlement,
  effectiveGrants,
  type EntitlementDecision,
} from '../domain/entitlement.js';
import { effectiveMonthlyMinimum } from '../domain/monthly-minimum.js';
import type {
  OrderResellerTermsRecord,
  ResellerCursor,
  ResellerListing,
  ResellerPurchaseRecord,
  ResellerRepository,
  ResellerTierGrantRecord,
  ResellerTierListing,
  ResellerWrite,
  TierWrite,
} from './ports.js';

export const RESELLERS_VIEW_PERMISSION: PermissionKey = 'resellers.view';
export const RESELLERS_EDIT_PERMISSION: PermissionKey = 'resellers.edit';

const IDEMPOTENCY_NAMESPACE = 'WEB';

export interface ResellerAdminServiceDeps {
  readonly resellers: ResellerRepository;
  readonly customers: Pick<CustomerRepository, 'findById'>;
  readonly products: Pick<ProductRepository, 'findById' | 'list'>;
  readonly categories: Pick<ProductCategoryRepository, 'findById'>;
  readonly panels: Pick<PanelRepository, 'find'>;
  readonly bots: Pick<BotInstanceRepository, 'findById'>;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** WP14 D1: the one balance derivation, read in the selling currency. */
  readonly wallet: Pick<WalletRepository, 'balanceOf'>;
  readonly settings: Pick<SettingsResolver, 'valueOf'>;
  /** WP14 D3: this entity's own audit rows. */
  readonly auditHistory: AuditHistoryReader;
}

/**
 * A reseller's credit standing (WP14 D1). Every figure is a derivation of R8's allowance
 * and the ledger balance — `docs/wp14-reseller-phase2-audit.md` §2. None is a debt, a
 * repayment or a settlement amount; `OQ-WP9-04` defines none of those.
 */
export interface ResellerCreditStandingRecord {
  readonly customerId: string;
  readonly status: ResellerStatus;
  readonly effectiveLimit: Money;
  readonly limitSource: ResellerLimitSource;
  readonly sellingCurrency: CurrencyCode;
  readonly credit: ResellerCreditState;
  /** Every amount below is in `sellingCurrency`. */
  readonly balance: bigint;
  readonly allowance: bigint;
  readonly creditInUse: bigint;
  readonly availableToSpend: bigint;
  readonly overLimitBy: bigint;
}

/** Round N R1: one entitlement dimension, as the tier grants it and as the reseller does. */
export interface ResellerPolicyDimension {
  readonly dimension: ResellerEntitlementDimension;
  readonly source: 'TIER' | 'RESELLER';
  readonly tierGrants: readonly ResellerTierGrantRecord[];
  /** Null: not overridden. */
  readonly overrideGrants: readonly ResellerTierGrantRecord[] | null;
  readonly effectiveGrants: readonly ResellerTierGrantRecord[];
}

/** Round N R1: what a reseller can do, and where each part of it comes from. */
export interface ResellerPolicyRecord {
  readonly customerId: string;
  readonly status: ResellerStatus;
  readonly tier: { readonly id: string; readonly name: string };
  readonly dimensions: readonly ResellerPolicyDimension[];
  readonly pricing: {
    readonly tierMode: ResellerPricingMode;
    readonly tierPercent: number | null;
    readonly overrideMode: ResellerOverrideMode;
    readonly overridePercent: number | null;
    readonly layer: ResellerPriceLayer;
    readonly percent: number | null;
  };
  readonly monthlyMinimum: {
    readonly tier: Money | null;
    readonly own: Money | null;
    readonly effective: Money | null;
    readonly source: ResellerMinimumSource;
  };
  readonly botBasis: 'ANY_BOT' | 'GRANTED_BOT' | 'NO_BOT';
  readonly products: readonly {
    readonly productId: string;
    readonly title: string;
    readonly status: ProductStatus;
    readonly categoryId: string | null;
    readonly panelId: string | null;
    readonly decision: EntitlementDecision;
  }[];
  readonly productsComplete: boolean;
}

/** Round N R1: the override write — the dimensions overridden and the grants of each. */
export interface ResellerOverrideWrite {
  readonly dimension: ResellerEntitlementDimension;
  readonly grants: readonly ResellerTierGrantRecord[];
}

/**
 * Reseller tiers, their grants and resellers, as an operator manages them
 * (`docs/wp9-reseller-audit.md` R2, R5, R11).
 *
 * Every write needs `resellers.edit`, carries an idempotency key, reads scope activity
 * inside its transaction and is audited with its before and after. Reads need
 * `resellers.view`. Nothing here moves money; a credit limit is a policy the wallet reads.
 */
export class ResellerAdminService {
  constructor(private readonly deps: ResellerAdminServiceDeps) {}

  // -- Tiers --------------------------------------------------------------------------

  async listTiers(
    scope: TenantContext,
    actor: ActorContext,
  ): Promise<readonly ResellerTierListing[]> {
    await this.deps.guard.check(scope, actor, RESELLERS_VIEW_PERMISSION);
    return this.deps.resellers.listTiers(scope);
  }

  async getTier(
    scope: TenantContext,
    actor: ActorContext,
    rawId: string,
  ): Promise<ResellerTierListing> {
    await this.deps.guard.check(scope, actor, RESELLERS_VIEW_PERMISSION);
    return this.tierListing(scope, this.id(rawId, 'tier'));
  }

  async createTier(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly write: TierWrite },
  ): Promise<ResellerTierListing> {
    const write = { ...input.write, name: input.write.name.trim() };
    const requestHash = hashRequest({ tier: serialisableTier(write) });
    const denial = { action: 'reseller_tier.create', entityType: 'ResellerTier', entityId: null };
    await this.authorize(scope, actor, denial);

    const replay = await this.replay<{ tierId: string }>(scope, input.idempotencyKey, requestHash);
    if (replay !== null) return this.tierListing(scope, replay.tierId);

    const now = this.deps.clock.now();
    const id = this.deps.ids.uuid();
    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      RESELLERS_EDIT_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        if (!(await this.deps.resellers.createTier(scope, { ...write, id, now }, tx))) {
          throw nameTaken();
        }
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'reseller_tier.create',
            entityType: 'ResellerTier',
            entityId: id,
            before: null,
            after: serialisableTier(write),
            result: 'SUCCESS',
          },
          tx,
        );
        await this.remember(scope, input.idempotencyKey, requestHash, { tierId: id }, tx);
      },
    );
    return this.tierListing(scope, id);
  }

  async updateTier(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly tierId: string; readonly write: TierWrite },
  ): Promise<ResellerTierListing> {
    const tierId = this.id(input.tierId, 'tier');
    const write = { ...input.write, name: input.write.name.trim() };
    const requestHash = hashRequest({ tierId, tier: serialisableTier(write) });
    const denial = { action: 'reseller_tier.update', entityType: 'ResellerTier', entityId: tierId };
    await this.authorize(scope, actor, denial);

    const replay = await this.replay<{ tierId: string }>(scope, input.idempotencyKey, requestHash);
    if (replay !== null) return this.tierListing(scope, replay.tierId);

    const now = this.deps.clock.now();
    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      RESELLERS_EDIT_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const before = await this.deps.resellers.lockTier(scope, tierId, tx);
        if (before === null) throw tierNotFound();
        const after = await this.deps.resellers.updateTier(scope, tierId, { ...write, now }, tx);
        if (after === 'NAME_TAKEN') throw nameTaken();
        if (after === null) throw tierNotFound();
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'reseller_tier.update',
            entityType: 'ResellerTier',
            entityId: tierId,
            before: serialisableTier(before),
            after: serialisableTier(after),
            result: 'SUCCESS',
          },
          tx,
        );
        await this.remember(scope, input.idempotencyKey, requestHash, { tierId }, tx);
      },
    );
    return this.tierListing(scope, tierId);
  }

  /**
   * Replaces a tier's whole grant set (R5), under the tier's row lock, with the old and new
   * sets in one audit row. Every subject must name a row of this tenant: a grant for another
   * tenant's product would be a grant for nothing today and a leak the day an id is reused.
   */
  async replaceGrants(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly tierId: string;
      readonly grants: readonly ResellerTierGrantRecord[];
    },
  ): Promise<ResellerTierListing> {
    const tierId = this.id(input.tierId, 'tier');
    const grants = [...input.grants].sort((a, b) =>
      `${a.kind}:${a.subject ?? '*'}`.localeCompare(`${b.kind}:${b.subject ?? '*'}`),
    );
    const requestHash = hashRequest({ tierId, grants });
    const denial = {
      action: 'reseller_tier.grants',
      entityType: 'ResellerTier',
      entityId: tierId,
    };
    await this.authorize(scope, actor, denial);

    const replay = await this.replay<{ tierId: string }>(scope, input.idempotencyKey, requestHash);
    if (replay !== null) return this.tierListing(scope, replay.tierId);

    const now = this.deps.clock.now();
    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      RESELLERS_EDIT_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        if ((await this.deps.resellers.lockTier(scope, tierId, tx)) === null) throw tierNotFound();
        await this.assertSubjectsExist(scope, grants, tx);
        const before = await this.deps.resellers.grantsOf(scope, tierId, tx);
        await this.deps.resellers.replaceGrants(scope, tierId, grants, now, tx);
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'reseller_tier.grants',
            entityType: 'ResellerTier',
            entityId: tierId,
            before: { grants: before.map((g) => ({ ...g })) },
            after: { grants: grants.map((g) => ({ ...g })) },
            result: 'SUCCESS',
          },
          tx,
        );
        await this.remember(scope, input.idempotencyKey, requestHash, { tierId }, tx);
      },
    );
    return this.tierListing(scope, tierId);
  }

  // -- Resellers --------------------------------------------------------------------------

  async list(
    scope: TenantContext,
    actor: ActorContext,
    query: {
      readonly limit?: number;
      readonly cursor?: ResellerCursor;
      readonly status?: ResellerStatus;
      readonly tierId?: string;
      readonly search?: string;
    },
  ): Promise<{ readonly items: readonly ResellerListing[]; readonly next: ResellerCursor | null }> {
    await this.deps.guard.check(scope, actor, RESELLERS_VIEW_PERMISSION);
    const limit =
      query.limit === undefined
        ? RESELLER_PAGE_DEFAULT
        : Math.min(Math.max(1, Math.trunc(query.limit)), RESELLER_PAGE_MAX);
    return this.deps.resellers.list(
      scope,
      {
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.tierId === undefined ? {} : { tierId: query.tierId }),
        ...(query.search === undefined ? {} : { search: query.search }),
      },
      limit,
      query.cursor ?? null,
    );
  }

  /** One reseller, by CUSTOMER id. Another tenant's customer is not found, never empty. */
  async get(
    scope: TenantContext,
    actor: ActorContext,
    rawCustomerId: string,
  ): Promise<ResellerListing> {
    await this.deps.guard.check(scope, actor, RESELLERS_VIEW_PERMISSION);
    const parsed = uuidV7Schema.safeParse(rawCustomerId);
    const listing = parsed.success
      ? await this.deps.resellers.findListing(scope, parsed.data)
      : null;
    if (listing === null) throw resellerNotFound();
    return listing;
  }

  /** The terms an order was confirmed on, for the order's pricing read. */
  async termsFor(scope: TenantContext, orderId: string): Promise<OrderResellerTermsRecord | null> {
    return this.deps.resellers.findTerms(scope, orderId);
  }

  async register(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly customerId: string;
      readonly write: Omit<ResellerWrite, 'status'>;
    },
  ): Promise<ResellerListing> {
    const customerId = this.id(input.customerId, 'customer');
    const write: ResellerWrite = { ...input.write, status: 'ACTIVE' };
    const requestHash = hashRequest({ customerId, reseller: serialisableReseller(write) });
    const denial = { action: 'reseller.register', entityType: 'Customer', entityId: customerId };
    await this.authorize(scope, actor, denial);

    const replay = await this.replay<{ customerId: string }>(
      scope,
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) return this.resellerListing(scope, replay.customerId);

    const now = this.deps.clock.now();
    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      RESELLERS_EDIT_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        if ((await this.deps.customers.findById(scope, customerId as UserId, tx)) === null) {
          throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
        }
        if ((await this.deps.resellers.findTier(scope, write.tierId, tx)) === null) {
          throw tierNotFound();
        }
        const registered = await this.deps.resellers.register(
          scope,
          { ...write, id: this.deps.ids.uuid(), customerId, now },
          tx,
        );
        if (!registered) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.RESELLER_ALREADY_REGISTERED,
            'This customer is already a reseller.',
          );
        }
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'reseller.register',
            entityType: 'Customer',
            entityId: customerId,
            before: null,
            after: serialisableReseller(write),
            result: 'SUCCESS',
          },
          tx,
        );
        await this.remember(scope, input.idempotencyKey, requestHash, { customerId }, tx);
      },
    );
    return this.resellerListing(scope, customerId);
  }

  /**
   * Replaces a reseller's tier, status, pricing override and credit limit. Affects only
   * commercial actions CONFIRMED afterwards (R2): a confirmed order keeps its terms, and a
   * draft priced on the old terms is refused at confirmation rather than re-priced (R9).
   */
  async update(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly customerId: string;
      readonly write: ResellerWrite;
    },
  ): Promise<ResellerListing> {
    const customerId = this.id(input.customerId, 'customer');
    const requestHash = hashRequest({ customerId, reseller: serialisableReseller(input.write) });
    const denial = { action: 'reseller.update', entityType: 'Customer', entityId: customerId };
    await this.authorize(scope, actor, denial);

    const replay = await this.replay<{ customerId: string }>(
      scope,
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) return this.resellerListing(scope, replay.customerId);

    const now = this.deps.clock.now();
    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      RESELLERS_EDIT_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        /*
         * The before-image is read under the row's `FOR UPDATE`, not plainly. Two
         * concurrent updates both read the old row without it, and the second audit row
         * then records a "before" that was never the state it replaced — the first
         * update's after-image is lost from the trail. Locked, the second waits for the
         * first to commit and reads what it wrote. It also waits for a commercial
         * transaction holding the row `FOR SHARE` (`ResellerService.standing`), exactly
         * as the UPDATE below would.
         */
        const before = await this.deps.resellers.lockByCustomer(scope, customerId, tx);
        if (before === null) throw resellerNotFound();
        if ((await this.deps.resellers.findTier(scope, input.write.tierId, tx)) === null) {
          throw tierNotFound();
        }
        const after = await this.deps.resellers.update(
          scope,
          customerId,
          { ...input.write, now },
          tx,
        );
        if (after === null) throw resellerNotFound();
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'reseller.update',
            entityType: 'Customer',
            entityId: customerId,
            before: serialisableReseller(before),
            after: serialisableReseller(after),
            result: 'SUCCESS',
          },
          tx,
        );
        await this.remember(scope, input.idempotencyKey, requestHash, { customerId }, tx);
      },
    );
    return this.resellerListing(scope, customerId);
  }

  // -- Round N: plan controls and the monthly minimum --------------------------------------

  /**
   * A tier's monthly minimum (R2). Null or a zero amount: none. Tracking only — nothing this
   * writes, or that reads it, charges, debits, settles, demotes or blocks anybody.
   */
  async setTierMinimum(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly tierId: string;
      readonly minimum: Money | null;
    },
  ): Promise<ResellerTierListing> {
    const tierId = this.id(input.tierId, 'tier');
    const minimum = normaliseMinimum(input.minimum, 'TIER');
    const requestHash = hashRequest({ tierId, minimum: serialisableMoney(minimum) });
    const denial = {
      action: 'reseller_tier.monthly_minimum',
      entityType: 'ResellerTier',
      entityId: tierId,
    };
    await this.authorize(scope, actor, denial);

    const replay = await this.replay<{ tierId: string }>(scope, input.idempotencyKey, requestHash);
    if (replay !== null) return this.tierListing(scope, replay.tierId);

    const now = this.deps.clock.now();
    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      RESELLERS_EDIT_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const before = await this.deps.resellers.lockTier(scope, tierId, tx);
        if (before === null) throw tierNotFound();
        const after = await this.deps.resellers.setTierMinimum(scope, tierId, minimum, now, tx);
        if (after === null) throw tierNotFound();
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'reseller_tier.monthly_minimum',
            entityType: 'ResellerTier',
            entityId: tierId,
            before: { monthlyMinimum: serialisableMoney(before.monthlyMinimum) },
            after: { monthlyMinimum: serialisableMoney(after.monthlyMinimum) },
            result: 'SUCCESS',
          },
          tx,
        );
        await this.remember(scope, input.idempotencyKey, requestHash, { tierId }, tx);
      },
    );
    return this.tierListing(scope, tierId);
  }

  /**
   * A reseller's own monthly minimum (R2): null inherits the tier's, a zero amount is an
   * explicit "no minimum for this reseller". Under the reseller row's `FOR UPDATE`, like
   * every other write to the row.
   */
  async setMinimum(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly customerId: string;
      readonly minimum: Money | null;
    },
  ): Promise<ResellerListing> {
    const customerId = this.id(input.customerId, 'customer');
    const minimum = normaliseMinimum(input.minimum, 'RESELLER');
    const requestHash = hashRequest({ customerId, minimum: serialisableMoney(minimum) });
    const denial = {
      action: 'reseller.monthly_minimum',
      entityType: 'Customer',
      entityId: customerId,
    };
    await this.authorize(scope, actor, denial);

    const replay = await this.replay<{ customerId: string }>(
      scope,
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) return this.resellerListing(scope, replay.customerId);

    const now = this.deps.clock.now();
    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      RESELLERS_EDIT_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const before = await this.deps.resellers.lockByCustomer(scope, customerId, tx);
        if (before === null) throw resellerNotFound();
        const after = await this.deps.resellers.setMinimum(scope, customerId, minimum, now, tx);
        if (after === null) throw resellerNotFound();
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'reseller.monthly_minimum',
            entityType: 'Customer',
            entityId: customerId,
            before: { monthlyMinimum: serialisableMoney(before.monthlyMinimum) },
            after: { monthlyMinimum: serialisableMoney(after.monthlyMinimum) },
            result: 'SUCCESS',
          },
          tx,
        );
        await this.remember(scope, input.idempotencyKey, requestHash, { customerId }, tx);
      },
    );
    return this.resellerListing(scope, customerId);
  }

  /**
   * Replaces a reseller's whole entitlement override (R1), under the reseller row's
   * `FOR UPDATE` — the row every commercial transaction reads `FOR SHARE` before it reads
   * the override — with the old and new sets in one audit row. Every subject must name a
   * row of this tenant, exactly as for a tier's grants.
   */
  async replaceOverrides(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly customerId: string;
      readonly overrides: readonly ResellerOverrideWrite[];
    },
  ): Promise<ResellerPolicyRecord> {
    const customerId = this.id(input.customerId, 'customer');
    const override = normaliseOverride(input.overrides);
    const requestHash = hashRequest({ customerId, override: serialisableOverride(override) });
    const denial = {
      action: 'reseller.grants_override',
      entityType: 'Customer',
      entityId: customerId,
    };
    await this.authorize(scope, actor, denial);

    const replay = await this.replay<{ customerId: string }>(
      scope,
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) return this.policyOf(scope, replay.customerId);

    const now = this.deps.clock.now();
    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      RESELLERS_EDIT_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        if ((await this.deps.resellers.lockByCustomer(scope, customerId, tx)) === null) {
          throw resellerNotFound();
        }
        await this.assertSubjectsExist(scope, override.grants, tx);
        const before = await this.deps.resellers.overridesOf(scope, customerId, tx);
        await this.deps.resellers.replaceOverrides(scope, customerId, override, now, tx);
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'reseller.grants_override',
            entityType: 'Customer',
            entityId: customerId,
            before: serialisableOverride(before),
            after: serialisableOverride(override),
            result: 'SUCCESS',
          },
          tx,
        );
        await this.remember(scope, input.idempotencyKey, requestHash, { customerId }, tx);
      },
    );
    return this.policyOf(scope, customerId);
  }

  /**
   * The effective-policy preview (R1): per dimension the tier's grants, the override and
   * what applies; the pricing layer; the monthly minimum; and one page of the existing
   * Products, each with `decideEntitlement`'s own answer for a new purchase. `resellers.view`.
   */
  async policy(
    scope: TenantContext,
    actor: ActorContext,
    rawCustomerId: string,
  ): Promise<ResellerPolicyRecord> {
    await this.deps.guard.check(scope, actor, RESELLERS_VIEW_PERMISSION);
    return this.policyOf(scope, this.id(rawCustomerId, 'customer'));
  }

  private async policyOf(scope: TenantContext, customerId: string): Promise<ResellerPolicyRecord> {
    const listing = await this.resellerListing(scope, customerId);
    const tierGrants = await this.deps.resellers.grantsOf(scope, listing.tier.id);
    const override = await this.deps.resellers.overridesOf(scope, customerId);
    // The SAME function `ResellerService.standing` judges every sale by.
    const effective = effectiveGrants(tierGrants, override);
    const ofDimension = (
      grants: readonly ResellerTierGrantRecord[],
      dimension: ResellerEntitlementDimension,
    ) => grants.filter((g) => RESELLER_GRANT_DIMENSION[g.kind] === dimension);

    const everyBot = effective.some((g) => g.kind === 'BOT' && g.subject === null);
    const firstBot = effective.find((g) => g.kind === 'BOT' && g.subject !== null)?.subject ?? null;
    const botBasis = everyBot ? 'ANY_BOT' : firstBot !== null ? 'GRANTED_BOT' : 'NO_BOT';
    const botInstanceId = everyBot ? null : firstBot;

    const page = await this.deps.products.list(scope, {}, PRODUCT_PAGE_MAX, null);
    const layer = resellerPriceLayer(
      { mode: listing.tier.pricingMode, percent: listing.tier.discountPercentage },
      { mode: listing.pricingMode, percent: listing.discountPercentage },
    );
    const minimum = effectiveMonthlyMinimum(listing.tier.monthlyMinimum, listing.monthlyMinimum);
    return {
      customerId: listing.customerId,
      status: listing.status,
      tier: { id: listing.tier.id, name: listing.tier.name },
      dimensions: RESELLER_ENTITLEMENT_DIMENSIONS.map((dimension) => {
        const overridden = override.dimensions.includes(dimension);
        return {
          dimension,
          source: overridden ? ('RESELLER' as const) : ('TIER' as const),
          tierGrants: ofDimension(tierGrants, dimension),
          overrideGrants: overridden ? ofDimension(override.grants, dimension) : null,
          effectiveGrants: ofDimension(effective, dimension),
        };
      }),
      pricing: {
        tierMode: listing.tier.pricingMode,
        tierPercent: listing.tier.discountPercentage,
        overrideMode: listing.pricingMode,
        overridePercent: listing.discountPercentage,
        layer: layer.layer,
        percent: layer.percent,
      },
      monthlyMinimum: {
        tier: listing.tier.monthlyMinimum,
        own: listing.monthlyMinimum,
        effective: minimum.minimum,
        source: minimum.source,
      },
      botBasis,
      products: page.items.map((product) => ({
        productId: product.id,
        title: product.title,
        status: product.status,
        categoryId: product.categoryId,
        panelId: product.panelId,
        decision: decideEntitlement(effective, {
          operation: 'NEW_SERVICE',
          productId: product.id,
          categoryId: product.categoryId,
          // A product with no panel yet is unsellable anyway; the preview answers only
          // whether the reseller's grants would allow it, and no grant names an empty id.
          panelId: product.panelId ?? '',
          botInstanceId,
        }),
      })),
      productsComplete: page.nextCursor === null,
    };
  }

  // -- Phase 2 reads (WP14) -----------------------------------------------------------------

  /**
   * How much of a reseller's credit line is in use (D1). `resellers.view` for the terms and
   * `users.view` for the balance, which is the customer's wallet.
   *
   * The allowance comes from `creditAllowanceOf`, the function settlement calls under the
   * wallet lock, so "available" here is what a purchase would be allowed at this instant.
   * It is a read, not a reservation: a purchase committed a moment later changes it.
   */
  async creditStanding(
    scope: TenantContext,
    actor: ActorContext,
    rawCustomerId: string,
  ): Promise<ResellerCreditStandingRecord> {
    await this.deps.guard.check(scope, actor, RESELLERS_VIEW_PERMISSION);
    await this.deps.guard.check(scope, actor, WALLET_VIEW_PERMISSION);
    const listing = await this.resellerListing(scope, this.id(rawCustomerId, 'customer'));
    const terms: CreditTerms = {
      status: listing.status,
      ownLimit: listing.creditLimit,
      tierLimit: listing.tier.creditLimit,
    };
    const selling = await this.deps.settings.valueOf<SalesCurrencyCode>(scope, 'sales.currency');
    const balance = await this.deps.wallet.balanceOf(scope, listing.customerId as UserId, selling);
    const allowance = creditAllowanceOf(terms, selling);
    const { limit, source } = effectiveLimitOf(terms);
    return {
      customerId: listing.customerId,
      status: listing.status,
      effectiveLimit: limit,
      limitSource: source,
      sellingCurrency: selling,
      credit: creditStateOf(terms, selling),
      balance: balance.amountMinor,
      allowance,
      ...creditFigures(balance.amountMinor, allowance),
    };
  }

  /**
   * A reseller's purchases as confirmation recorded them (D2, R9). `resellers.view` and
   * `orders.view`: every row names an order.
   */
  async purchases(
    scope: TenantContext,
    actor: ActorContext,
    rawCustomerId: string,
    query: { readonly limit?: number; readonly cursor?: ResellerCursor },
  ): Promise<{
    readonly items: readonly ResellerPurchaseRecord[];
    readonly next: ResellerCursor | null;
  }> {
    await this.deps.guard.check(scope, actor, RESELLERS_VIEW_PERMISSION);
    await this.deps.guard.check(scope, actor, ORDER_VIEW_PERMISSION);
    const customerId = this.id(rawCustomerId, 'customer');
    if ((await this.deps.resellers.findByCustomer(scope, customerId)) === null) {
      throw resellerNotFound();
    }
    const limit =
      query.limit === undefined
        ? RESELLER_PURCHASE_PAGE_DEFAULT
        : Math.min(Math.max(1, Math.trunc(query.limit)), RESELLER_PURCHASE_PAGE_MAX);
    return this.deps.resellers.listPurchases(scope, customerId, limit, query.cursor ?? null);
  }

  /**
   * The reseller's own change history (D3): `reseller.*` rows on this customer, and
   * nothing else recorded against the customer. `resellers.view` and `audit.view`.
   */
  async history(
    scope: TenantContext,
    actor: ActorContext,
    rawCustomerId: string,
  ): Promise<readonly AuditHistoryRecord[]> {
    await this.deps.guard.check(scope, actor, RESELLERS_VIEW_PERMISSION);
    await this.deps.guard.check(scope, actor, AUDIT_VIEW_PERMISSION);
    const customerId = this.id(rawCustomerId, 'customer');
    if ((await this.deps.resellers.findByCustomer(scope, customerId)) === null) {
      throw resellerNotFound();
    }
    return this.deps.auditHistory.entityHistory(
      scope,
      { entityType: 'Customer', entityId: customerId, actionPrefix: 'reseller.' },
      RESELLER_HISTORY_MAX,
    );
  }

  /** A tier's change history (D3): `reseller_tier.*` rows on this tier. */
  async tierHistory(
    scope: TenantContext,
    actor: ActorContext,
    rawTierId: string,
  ): Promise<readonly AuditHistoryRecord[]> {
    await this.deps.guard.check(scope, actor, RESELLERS_VIEW_PERMISSION);
    await this.deps.guard.check(scope, actor, AUDIT_VIEW_PERMISSION);
    const tierId = this.id(rawTierId, 'tier');
    if ((await this.deps.resellers.findTier(scope, tierId)) === null) throw tierNotFound();
    return this.deps.auditHistory.entityHistory(
      scope,
      { entityType: 'ResellerTier', entityId: tierId, actionPrefix: 'reseller_tier.' },
      RESELLER_HISTORY_MAX,
    );
  }

  // -- Helpers -----------------------------------------------------------------------------

  private async tierListing(scope: TenantContext, tierId: string): Promise<ResellerTierListing> {
    const listing = (await this.deps.resellers.listTiers(scope)).find((t) => t.id === tierId);
    if (listing === undefined) throw tierNotFound();
    return listing;
  }

  private async resellerListing(
    scope: TenantContext,
    customerId: string,
  ): Promise<ResellerListing> {
    const listing = await this.deps.resellers.findListing(scope, customerId);
    if (listing === null) throw resellerNotFound();
    return listing;
  }

  private async assertSubjectsExist(
    scope: TenantContext,
    grants: readonly ResellerTierGrantRecord[],
    tx: TransactionScope,
  ): Promise<void> {
    for (const grant of grants) {
      if (grant.subject === null || grant.kind === 'OPERATION') continue;
      const exists =
        grant.kind === 'PRODUCT'
          ? (await this.deps.products.findById(scope, grant.subject as ProductId, tx)) !== null
          : grant.kind === 'CATEGORY'
            ? (await this.deps.categories.findById(
                scope,
                grant.subject as ProductCategoryId,
                tx,
              )) !== null
            : grant.kind === 'PANEL'
              ? (await this.deps.panels.find(scope, grant.subject, tx)) !== null
              : await this.botBelongs(scope, grant.subject);
      if (!exists) {
        throw errors.validation(
          COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
          'A grant names something this installation does not have.',
          { kind: grant.kind, subject: grant.subject },
        );
      }
    }
  }

  private async botBelongs(scope: TenantContext, botId: string): Promise<boolean> {
    const bot = await this.deps.bots.findById(botId as BotInstanceId);
    return bot !== null && bot.tenantId === scope.tenantId;
  }

  private async replay<T>(
    scope: TenantContext,
    key: string,
    requestHash: string,
  ): Promise<T | null> {
    const found = await this.deps.idempotency.find<T>(
      scope,
      IDEMPOTENCY_NAMESPACE,
      key,
      requestHash,
    );
    return found === null ? null : found.result;
  }

  private async remember(
    scope: TenantContext,
    key: string,
    requestHash: string,
    result: Record<string, string>,
    tx: TransactionScope,
  ): Promise<void> {
    await rememberOnce(
      this.deps.idempotency,
      scope,
      IDEMPOTENCY_NAMESPACE,
      key,
      requestHash,
      result,
      tx,
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

  /** Before the replay lookup: a replay returns a ROW, and would hand it to anybody. */
  private async authorize(
    scope: TenantContext,
    actor: ActorContext,
    denial: { action: string; entityType: string; entityId: string | null },
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, RESELLERS_EDIT_PERMISSION);
    } catch (error) {
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        RESELLERS_EDIT_PERMISSION,
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

  /** A uuid, validated in the SERVICE so a malformed path is refused and never a 22P02. */
  private id(candidate: string, what: 'tier' | 'customer'): string {
    const parsed = uuidV7Schema.safeParse(candidate);
    if (!parsed.success) {
      throw what === 'tier' ? tierNotFound() : resellerNotFound();
    }
    return parsed.data;
  }
}

function serialisableTier(t: TierWrite) {
  return {
    name: t.name,
    pricingMode: t.pricingMode,
    discountPercentage: t.discountPercentage,
    creditLimit: { amount: t.creditLimit.amountMinor.toString(), currency: t.creditLimit.currency },
  };
}

function serialisableReseller(r: ResellerWrite) {
  return {
    tierId: r.tierId,
    status: r.status,
    pricingMode: r.pricingMode,
    discountPercentage: r.discountPercentage,
    creditLimit:
      r.creditLimit === null
        ? null
        : { amount: r.creditLimit.amountMinor.toString(), currency: r.creditLimit.currency },
  };
}

/**
 * A minimum as stored. On a tier a zero amount and a null both mean none, and are stored as
 * null so "none" has one spelling; on a reseller a zero is kept, because it is the explicit
 * "no minimum for this reseller" that overrides a tier's.
 */
function normaliseMinimum(minimum: Money | null, on: 'TIER' | 'RESELLER'): Money | null {
  if (minimum === null) return null;
  if (minimum.amountMinor < 0n) {
    throw errors.validation(
      COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
      'A monthly minimum cannot be negative.',
    );
  }
  return on === 'TIER' && minimum.amountMinor === 0n ? null : minimum;
}

function serialisableMoney(value: Money | null) {
  return value === null ? null : { amount: value.amountMinor.toString(), currency: value.currency };
}

/**
 * The override in its one canonical order — dimensions in the contract's order, grants by
 * `kind:subject` — so the same set is the same fingerprint however it was listed. A grant
 * outside the dimension it is listed under is refused (the schema refuses it first).
 */
function normaliseOverride(overrides: readonly ResellerOverrideWrite[]): {
  readonly dimensions: readonly ResellerEntitlementDimension[];
  readonly grants: readonly ResellerTierGrantRecord[];
} {
  for (const o of overrides) {
    if (o.grants.some((g) => RESELLER_GRANT_DIMENSION[g.kind] !== o.dimension)) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'Every grant of an override belongs to the dimension it overrides.',
      );
    }
  }
  const listed = new Set(overrides.map((o) => o.dimension));
  const key = (g: ResellerTierGrantRecord) => `${g.kind}:${g.subject ?? '*'}`;
  return {
    dimensions: RESELLER_ENTITLEMENT_DIMENSIONS.filter((d) => listed.has(d)),
    grants: overrides
      .flatMap((o) => o.grants.map((g) => ({ kind: g.kind, subject: g.subject })))
      .sort((a, b) => key(a).localeCompare(key(b))),
  };
}

function serialisableOverride(o: {
  readonly dimensions: readonly ResellerEntitlementDimension[];
  readonly grants: readonly ResellerTierGrantRecord[];
}) {
  return { dimensions: [...o.dimensions], grants: o.grants.map((g) => ({ ...g })) };
}

function tierNotFound() {
  return errors.notFound(COMMERCE_ERROR_CODES.RESELLER_TIER_NOT_FOUND, 'Unknown reseller tier.');
}

function resellerNotFound() {
  return errors.notFound(COMMERCE_ERROR_CODES.RESELLER_NOT_FOUND, 'Unknown reseller.');
}

function nameTaken() {
  return errors.conflict(
    COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
    'Another reseller tier already has that name.',
  );
}
