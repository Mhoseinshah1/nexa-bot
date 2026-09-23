import {
  COMMERCE_ERROR_CODES,
  DISCOUNT_PAGE_DEFAULT,
  DISCOUNT_PAGE_MAX,
  errors,
  uuidV7Schema,
  type ActorContext,
  type AuditWriter,
  type CashbackRuleStatus,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type PermissionKey,
  type ProductCategoryId,
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
import type {
  ProductCategoryRepository,
  ProductRepository,
} from '../../catalog/application/ports.js';
import type {
  CashbackRulePage,
  CashbackRuleRecord,
  CashbackRuleRepository,
  CashbackRuleWrite,
  RuleCursor,
} from './ports.js';

export const CASHBACK_RULE_VIEW_PERMISSION: PermissionKey = 'catalog.view';
/**
 * `catalog.pricing.edit` — "Edit pricing rules", HIGH risk. Cashback is not a discount
 * code, so `catalog.discounts.edit` does not describe it; it is a rule that promises
 * money back on every qualifying sale, which is exactly what this permission was
 * reserved for when products took their own price under `catalog.edit`.
 */
export const CASHBACK_RULE_EDIT_PERMISSION: PermissionKey = 'catalog.pricing.edit';

export interface CashbackRuleAdminServiceDeps {
  readonly rules: CashbackRuleRepository;
  readonly products: Pick<ProductRepository, 'findById'>;
  readonly categories: Pick<ProductCategoryRepository, 'findById'>;
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
 * Cashback rules, as an operator manages them (`docs/wp8-pricing-audit.md` P8, P12).
 *
 * `DiscountAdminService`'s write path under a different permission. An edit changes
 * what is promised NEXT: a confirmed order's promise is a row of its own carrying the
 * rule's label, percent and amount as they were, and `nexa_order_cashback_guard`
 * freezes those terms. So re-tuning or withdrawing a rule never touches cashback
 * already promised or earned.
 */
export class CashbackRuleAdminService {
  constructor(private readonly deps: CashbackRuleAdminServiceDeps) {}

  async list(
    scope: TenantContext,
    actor: ActorContext,
    query: {
      readonly limit?: number;
      readonly cursor?: RuleCursor;
      readonly status?: CashbackRuleStatus;
    },
  ): Promise<CashbackRulePage> {
    await this.deps.guard.check(scope, actor, CASHBACK_RULE_VIEW_PERMISSION);
    const limit = Math.min(Math.max(query.limit ?? DISCOUNT_PAGE_DEFAULT, 1), DISCOUNT_PAGE_MAX);
    return this.deps.rules.list(
      scope,
      query.status === undefined ? {} : { status: query.status },
      limit,
      query.cursor ?? null,
    );
  }

  async get(scope: TenantContext, actor: ActorContext, id: string): Promise<CashbackRuleRecord> {
    await this.deps.guard.check(scope, actor, CASHBACK_RULE_VIEW_PERMISSION);
    const rule = await this.deps.rules.findById(scope, this.ruleId(id));
    if (rule === null) throw notFound();
    return rule;
  }

  /** Creates an INACTIVE rule. Idempotent, audited. */
  async create(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly write: CashbackRuleWrite },
  ): Promise<CashbackRuleRecord> {
    const requestHash = hashRequest({ write: serialisable(input.write) });
    const denial = { action: 'cashback_rule.create', entityType: 'CashbackRule', entityId: null };

    await this.authorize(scope, actor, denial);

    const replay = await this.deps.idempotency.find<{ ruleId: string }>(
      scope,
      'WEB',
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      const existing = await this.deps.rules.findById(scope, replay.result.ruleId);
      if (existing !== null) return existing;
    }

    const now = this.deps.clock.now();
    const id = this.deps.ids.uuid();

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      CASHBACK_RULE_EDIT_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        await this.assertReferences(scope, input.write, tx);

        const row = await this.deps.rules.create(scope, id, input.write, now, tx);
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'cashback_rule.create',
            entityType: 'CashbackRule',
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
          { ruleId: row.id },
          tx,
        );
        return row;
      },
    );
  }

  async update(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly ruleId: string;
      readonly write: CashbackRuleWrite;
    },
  ): Promise<CashbackRuleRecord> {
    const ruleId = this.ruleId(input.ruleId);
    const requestHash = hashRequest({ ruleId, write: serialisable(input.write) });
    const denial = { action: 'cashback_rule.update', entityType: 'CashbackRule', entityId: ruleId };

    await this.authorize(scope, actor, denial);

    const replay = await this.deps.idempotency.find<{ ruleId: string }>(
      scope,
      'WEB',
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      const existing = await this.deps.rules.findById(scope, ruleId);
      if (existing !== null) return existing;
    }

    const now = this.deps.clock.now();

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      CASHBACK_RULE_EDIT_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const before = await this.deps.rules.findById(scope, ruleId, tx);
        if (before === null) throw notFound();
        await this.assertReferences(scope, input.write, tx);

        const after = await this.deps.rules.update(scope, ruleId, input.write, now, tx);
        if (after === null) throw notFound();

        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'cashback_rule.update',
            entityType: 'CashbackRule',
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
          { ruleId: after.id },
          tx,
        );
        return after;
      },
    );
  }

  async activate(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly ruleId: string },
  ): Promise<CashbackRuleRecord> {
    return this.setStatus(scope, actor, { ...input, to: 'ACTIVE' });
  }

  async deactivate(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly ruleId: string },
  ): Promise<CashbackRuleRecord> {
    return this.setStatus(scope, actor, { ...input, to: 'INACTIVE' });
  }

  private async setStatus(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly ruleId: string;
      readonly to: CashbackRuleStatus;
    },
  ): Promise<CashbackRuleRecord> {
    const ruleId = this.ruleId(input.ruleId);
    const requestHash = hashRequest({ ruleId, to: input.to });
    const action = input.to === 'ACTIVE' ? 'cashback_rule.activate' : 'cashback_rule.deactivate';
    const denial = { action, entityType: 'CashbackRule', entityId: ruleId };

    await this.authorize(scope, actor, denial);

    const replay = await this.deps.idempotency.find<{ ruleId: string }>(
      scope,
      'WEB',
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      const existing = await this.deps.rules.findById(scope, ruleId);
      if (existing !== null) return existing;
    }

    const now = this.deps.clock.now();
    const from: CashbackRuleStatus = input.to === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      CASHBACK_RULE_EDIT_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const before = await this.deps.rules.findById(scope, ruleId, tx);
        if (before === null) throw notFound();

        const changed = await this.deps.rules.setStatus(scope, ruleId, from, input.to, now, tx);
        const row = await this.deps.rules.findById(scope, ruleId, tx);
        if (row === null) throw notFound();

        await this.deps.audit.record(
          scope,
          actor,
          {
            action,
            entityType: 'CashbackRule',
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
          { ruleId: row.id },
          tx,
        );
        return row;
      },
    );
  }

  private async assertReferences(
    scope: TenantContext,
    write: CashbackRuleWrite,
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
      await this.deps.guard.check(scope, actor, CASHBACK_RULE_EDIT_PERMISSION);
    } catch (error) {
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        CASHBACK_RULE_EDIT_PERMISSION,
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

  private ruleId(candidate: string): string {
    const parsed = uuidV7Schema.safeParse(candidate);
    if (!parsed.success) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'That is not a valid cashback rule identifier.',
      );
    }
    return parsed.data;
  }
}

function notFound() {
  return errors.notFound(COMMERCE_ERROR_CODES.CASHBACK_RULE_NOT_FOUND, 'Unknown cashback rule.');
}

function serialisable(write: CashbackRuleWrite): Record<string, unknown> {
  return {
    ...write,
    appliesTo: [...write.appliesTo],
    startsAt: write.startsAt?.toISOString() ?? null,
    endsAt: write.endsAt?.toISOString() ?? null,
  };
}

function auditView(rule: CashbackRuleRecord): Record<string, unknown> {
  return {
    label: rule.label,
    percent: rule.percent,
    appliesTo: [...rule.appliesTo],
    productId: rule.productId,
    categoryId: rule.categoryId,
    startsAt: rule.startsAt?.toISOString() ?? null,
    endsAt: rule.endsAt?.toISOString() ?? null,
    status: rule.status,
  };
}
