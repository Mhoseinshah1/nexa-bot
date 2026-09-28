import {
  COMMERCE_ERROR_CODES,
  errors,
  money,
  uuidV7Schema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type CustomServiceRuleDimension,
  type IdGenerator,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type PermissionKey,
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
import type { PanelRepository } from '../../../platform/panels/application/ports.js';
import type { SettingsResolver } from '../../../control/settings/application/settings-resolver.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { CustomerRepository } from '../../customers/application/ports.js';
import type { ResellerRepository } from '../../resellers/application/ports.js';
import { ruleAmountFits, rulesOverlap } from '../domain/custom-service-pricing.js';
import {
  CUSTOM_SERVICE_MAX_RULES,
  type CustomServiceLocationRecord,
  type CustomServiceLocationRepository,
  type CustomServiceRuleRecord,
  type CustomServiceRuleRepository,
  type OrderCustomServiceTerms,
  type OrderCustomServiceTermsRepository,
} from './ports.js';

/** Reading the rules and the locations: the catalogue's own read permission. */
export const CUSTOM_SERVICE_VIEW_PERMISSION: PermissionKey = 'catalog.view';
/**
 * Writing them: `catalog.pricing.edit`, "Edit pricing rules", HIGH risk — what the
 * permission was reserved for, and what cashback rules already use. A custom-service rule
 * sets what every custom purchase costs.
 */
export const CUSTOM_SERVICE_EDIT_PERMISSION: PermissionKey = 'catalog.pricing.edit';

/** A rule as the operator submits it, its bounds already in units (§4 of the audit). */
export interface CustomServiceRuleInput {
  readonly dimension: CustomServiceRuleDimension;
  readonly label: string | null;
  readonly minUnits: bigint;
  readonly maxUnits: bigint;
  readonly unitPriceMinor: bigint;
  readonly customerId: string | null;
  readonly resellerTierId: string | null;
  readonly panelId: string | null;
  readonly enabled: boolean;
}

export interface CustomServiceAdminServiceDeps {
  readonly rules: CustomServiceRuleRepository;
  readonly locations: CustomServiceLocationRepository;
  readonly terms: Pick<OrderCustomServiceTermsRepository, 'findByOrder'>;
  readonly panels: Pick<PanelRepository, 'find'>;
  readonly customers: Pick<CustomerRepository, 'findById'>;
  readonly tiers: Pick<ResellerRepository, 'findTier'>;
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

type Denial = { action: string; entityType: string; entityId: string | null };

/**
 * The operator's side of the custom service (brief D2, D7).
 *
 * Every rule write takes the tenant's rules lock EXCLUSIVELY and then checks the rule
 * against every other rule of the tenant, so two concurrent saves cannot both pass the
 * overlap check. A rule is priced in `sales.currency`, read here, never taken from the
 * client. An edit or a delete changes what the NEXT quote costs: a quoted order's terms
 * are its own frozen row, and confirmation refuses one whose rules changed underneath it.
 */
export class CustomServiceAdminService {
  constructor(private readonly deps: CustomServiceAdminServiceDeps) {}

  async listRules(
    scope: TenantContext,
    actor: ActorContext,
  ): Promise<readonly CustomServiceRuleRecord[]> {
    await this.deps.guard.check(scope, actor, CUSTOM_SERVICE_VIEW_PERMISSION);
    return this.deps.rules.list(scope);
  }

  async getRule(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
  ): Promise<CustomServiceRuleRecord> {
    await this.deps.guard.check(scope, actor, CUSTOM_SERVICE_VIEW_PERMISSION);
    const rule = await this.deps.rules.findById(scope, this.id(id, 'rule'));
    if (rule === null) throw ruleNotFound();
    return rule;
  }

  async createRule(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly rule: CustomServiceRuleInput },
  ): Promise<CustomServiceRuleRecord> {
    const requestHash = hashRequest({ create: serialisable(input.rule) });
    const denial: Denial = {
      action: 'custom_service_rule.create',
      entityType: 'CustomServiceRule',
      entityId: null,
    };
    await this.authorize(scope, actor, denial);
    const replay = await this.replayRule(scope, input.idempotencyKey, requestHash);
    if (replay !== null) return replay;

    const now = this.deps.clock.now();
    const id = this.deps.ids.uuid();
    return this.mutate(scope, actor, denial, async (tx) => {
      await this.deps.rules.lockForWrite(scope, tx);
      const write = await this.validated(scope, input.rule, tx);
      const existing = await this.deps.rules.list(scope, tx);
      if (existing.length >= CUSTOM_SERVICE_MAX_RULES) {
        throw errors.conflict(
          COMMERCE_ERROR_CODES.CUSTOM_SERVICE_RULE_INVALID,
          `A tenant may hold at most ${CUSTOM_SERVICE_MAX_RULES} custom-service rules.`,
          { field: 'count' },
        );
      }
      assertNoOverlap({ id, ...write }, existing);
      const row = await this.deps.rules.insert(scope, { id, write, now }, tx);
      await this.audit(scope, actor, tx, denial.action, row.id, null, ruleView(row));
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
    });
  }

  async updateRule(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly ruleId: string;
      readonly rule: CustomServiceRuleInput;
    },
  ): Promise<CustomServiceRuleRecord> {
    const ruleId = this.id(input.ruleId, 'rule');
    const requestHash = hashRequest({ ruleId, update: serialisable(input.rule) });
    const denial: Denial = {
      action: 'custom_service_rule.update',
      entityType: 'CustomServiceRule',
      entityId: ruleId,
    };
    await this.authorize(scope, actor, denial);
    const replay = await this.replayRule(scope, input.idempotencyKey, requestHash);
    if (replay !== null) return replay;

    const now = this.deps.clock.now();
    return this.mutate(scope, actor, denial, async (tx) => {
      await this.deps.rules.lockForWrite(scope, tx);
      const before = await this.deps.rules.findById(scope, ruleId, tx);
      if (before === null) throw ruleNotFound();
      const write = await this.validated(scope, input.rule, tx);
      assertNoOverlap({ id: ruleId, ...write }, await this.deps.rules.list(scope, tx));
      const after = await this.deps.rules.update(scope, ruleId, write, now, tx);
      if (after === null) throw ruleNotFound();
      await this.audit(scope, actor, tx, denial.action, ruleId, ruleView(before), ruleView(after));
      await rememberOnce(
        this.deps.idempotency,
        scope,
        'WEB',
        input.idempotencyKey,
        requestHash,
        { ruleId },
        tx,
      );
      return after;
    });
  }

  /**
   * Deletes a rule. History is untouched: a custom order copied the rule's id, level and
   * prices into its own frozen terms, so deleting the rule rewrites nothing it priced.
   */
  async deleteRule(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly ruleId: string },
  ): Promise<{ readonly deleted: boolean }> {
    const ruleId = this.id(input.ruleId, 'rule');
    const requestHash = hashRequest({ ruleId, delete: true });
    const denial: Denial = {
      action: 'custom_service_rule.delete',
      entityType: 'CustomServiceRule',
      entityId: ruleId,
    };
    await this.authorize(scope, actor, denial);
    const replay = await this.deps.idempotency.find<{ deleted: boolean }>(
      scope,
      'WEB',
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) return { deleted: replay.result.deleted };

    return this.mutate(scope, actor, denial, async (tx) => {
      await this.deps.rules.lockForWrite(scope, tx);
      const before = await this.deps.rules.findById(scope, ruleId, tx);
      if (before === null) throw ruleNotFound();
      const deleted = await this.deps.rules.delete(scope, ruleId, tx);
      await this.audit(scope, actor, tx, denial.action, ruleId, ruleView(before), null);
      await rememberOnce(
        this.deps.idempotency,
        scope,
        'WEB',
        input.idempotencyKey,
        requestHash,
        { deleted },
        tx,
      );
      return { deleted };
    });
  }

  /**
   * What a custom order was priced by, from its frozen terms, or null for any other order.
   * `orders.view`, the permission its order detail needs: these are that order's facts.
   */
  async orderTerms(
    scope: TenantContext,
    actor: ActorContext,
    orderId: string,
  ): Promise<OrderCustomServiceTerms | null> {
    await this.deps.guard.check(scope, actor, 'orders.view');
    return this.deps.terms.findByOrder(scope, this.id(orderId, 'order'));
  }

  async listLocations(
    scope: TenantContext,
    actor: ActorContext,
  ): Promise<readonly CustomServiceLocationRecord[]> {
    await this.deps.guard.check(scope, actor, CUSTOM_SERVICE_VIEW_PERMISSION);
    return this.deps.locations.list(scope);
  }

  /** Offers a panel as a location, or edits its label and switch. Upsert by panel. */
  async saveLocation(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly panelId: string;
      readonly label: string;
      readonly enabled: boolean;
    },
  ): Promise<{ readonly location: CustomServiceLocationRecord; readonly created: boolean }> {
    const panelId = this.id(input.panelId, 'panel');
    const requestHash = hashRequest({ panelId, label: input.label, enabled: input.enabled });
    const denial: Denial = {
      action: 'custom_service_location.save',
      entityType: 'CustomServiceLocation',
      entityId: panelId,
    };
    await this.authorize(scope, actor, denial);
    const replay = await this.deps.idempotency.find<{ created: boolean }>(
      scope,
      'WEB',
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      const existing = await this.deps.locations.find(scope, panelId);
      if (existing !== null) return { location: existing, created: replay.result.created };
    }

    const now = this.deps.clock.now();
    return this.mutate(scope, actor, denial, async (tx) => {
      // The panel must be this tenant's. Its health and capacity are not asked here: a
      // location is an offer, and whether the panel can take a sale is decided per sale.
      if ((await this.deps.panels.find(scope, panelId, tx)) === null) {
        throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOM_SERVICE_RULE_INVALID, 'Unknown panel.', {
          field: 'panelId',
        });
      }
      const before = await this.deps.locations.find(scope, panelId, tx);
      const saved = await this.deps.locations.upsert(
        scope,
        { panelId, label: input.label.trim(), enabled: input.enabled, now },
        tx,
      );
      await this.audit(
        scope,
        actor,
        tx,
        denial.action,
        panelId,
        before === null ? null : locationView(before),
        locationView(saved.record),
      );
      await rememberOnce(
        this.deps.idempotency,
        scope,
        'WEB',
        input.idempotencyKey,
        requestHash,
        { created: saved.created },
        tx,
      );
      return { location: saved.record, created: saved.created };
    });
  }

  async deleteLocation(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly panelId: string },
  ): Promise<{ readonly deleted: boolean }> {
    const panelId = this.id(input.panelId, 'panel');
    const requestHash = hashRequest({ panelId, delete: true });
    const denial: Denial = {
      action: 'custom_service_location.delete',
      entityType: 'CustomServiceLocation',
      entityId: panelId,
    };
    await this.authorize(scope, actor, denial);
    const replay = await this.deps.idempotency.find<{ deleted: boolean }>(
      scope,
      'WEB',
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) return { deleted: replay.result.deleted };

    return this.mutate(scope, actor, denial, async (tx) => {
      const before = await this.deps.locations.find(scope, panelId, tx);
      if (before === null) {
        throw errors.notFound(
          COMMERCE_ERROR_CODES.CUSTOM_SERVICE_LOCATION_NOT_FOUND,
          'Unknown custom-service location.',
        );
      }
      const deleted = await this.deps.locations.delete(scope, panelId, tx);
      await this.audit(scope, actor, tx, denial.action, panelId, locationView(before), null);
      await rememberOnce(
        this.deps.idempotency,
        scope,
        'WEB',
        input.idempotencyKey,
        requestHash,
        { deleted },
        tx,
      );
      return { deleted };
    });
  }

  /**
   * The references a rule names must be this tenant's, and its price is in the sales
   * currency. Read inside the write's transaction, like every other rule here.
   */
  private async validated(
    scope: TenantContext,
    input: CustomServiceRuleInput,
    tx: TransactionScope,
  ) {
    if (input.customerId !== null && input.resellerTierId !== null) {
      throw invalid('resellerTierId', 'A rule names a customer or a tier, not both.');
    }
    if (input.minUnits < 1n || input.maxUnits < input.minUnits) {
      throw invalid('maximum', 'The range is empty.');
    }
    if (input.unitPriceMinor <= 0n) throw invalid('unitPriceAmount', 'A price is positive.');
    if (!ruleAmountFits(input.maxUnits, input.unitPriceMinor)) {
      throw invalid(
        'unitPriceAmount',
        'This price across this range is more than an order can carry.',
      );
    }
    if (
      input.panelId !== null &&
      (await this.deps.panels.find(scope, input.panelId, tx)) === null
    ) {
      throw invalid('panelId', 'Unknown panel.');
    }
    if (
      input.customerId !== null &&
      (await this.deps.customers.findById(scope, input.customerId as UserId, tx)) === null
    ) {
      throw invalid('customerId', 'Unknown customer.');
    }
    if (
      input.resellerTierId !== null &&
      (await this.deps.tiers.findTier(scope, input.resellerTierId, tx)) === null
    ) {
      throw invalid('resellerTierId', 'Unknown reseller tier.');
    }
    const currency = await this.deps.settings.valueOf<SalesCurrencyCode>(
      scope,
      'sales.currency',
      tx,
    );
    return {
      dimension: input.dimension,
      label: input.label,
      minUnits: input.minUnits,
      maxUnits: input.maxUnits,
      unitPrice: money(input.unitPriceMinor, currency),
      customerId: input.customerId,
      resellerTierId: input.resellerTierId,
      panelId: input.panelId,
      enabled: input.enabled,
    };
  }

  private async replayRule(
    scope: TenantContext,
    key: string,
    requestHash: string,
  ): Promise<CustomServiceRuleRecord | null> {
    const replay = await this.deps.idempotency.find<{ ruleId: string }>(
      scope,
      'WEB',
      key,
      requestHash,
    );
    if (replay === null) return null;
    return this.deps.rules.findById(scope, replay.result.ruleId);
  }

  private async mutate<T>(
    scope: TenantContext,
    actor: ActorContext,
    denial: Denial,
    work: (tx: TransactionScope) => Promise<T>,
  ): Promise<T> {
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      CUSTOM_SERVICE_EDIT_PERMISSION,
      denial,
      async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
            'This installation has stopped accepting work.',
          );
        }
        return work(tx);
      },
    );
  }

  private async audit(
    scope: TenantContext,
    actor: ActorContext,
    tx: TransactionScope,
    action: string,
    entityId: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
  ): Promise<void> {
    await this.deps.audit.record(
      scope,
      actor,
      {
        action,
        entityType: action.startsWith('custom_service_rule')
          ? 'CustomServiceRule'
          : 'CustomServiceLocation',
        entityId,
        before,
        after,
        result: 'SUCCESS',
      },
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
  private async authorize(scope: TenantContext, actor: ActorContext, denial: Denial) {
    try {
      await this.deps.guard.check(scope, actor, CUSTOM_SERVICE_EDIT_PERMISSION);
    } catch (error) {
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        CUSTOM_SERVICE_EDIT_PERMISSION,
        denial,
        error,
      );
      throw error;
    }
  }

  private id(candidate: string, what: 'rule' | 'panel' | 'order'): string {
    const parsed = uuidV7Schema.safeParse(candidate);
    if (!parsed.success) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        `That is not a valid ${what} identifier.`,
      );
    }
    return parsed.data;
  }
}

/**
 * The overlap rule (brief D2), against every other rule of the tenant. Only ENABLED rules
 * conflict: a disabled one is a draft the operator can keep beside the live one, and
 * enabling it re-runs this check.
 */
function assertNoOverlap(
  candidate: Parameters<typeof rulesOverlap>[0],
  existing: readonly CustomServiceRuleRecord[],
): void {
  const other = existing.find((rule) => rulesOverlap(candidate, rule));
  if (other !== undefined) {
    throw errors.conflict(
      COMMERCE_ERROR_CODES.CUSTOM_SERVICE_RULE_OVERLAP,
      'This range overlaps an enabled rule of the same kind for the same customers and panel.',
      { otherRuleId: other.id },
    );
  }
}

function invalid(field: string, message: string) {
  return errors.validation(COMMERCE_ERROR_CODES.CUSTOM_SERVICE_RULE_INVALID, message, { field });
}

function ruleNotFound() {
  return errors.notFound(
    COMMERCE_ERROR_CODES.CUSTOM_SERVICE_RULE_NOT_FOUND,
    'Unknown custom-service rule.',
  );
}

function serialisable(rule: CustomServiceRuleInput): Record<string, unknown> {
  return {
    ...rule,
    minUnits: rule.minUnits.toString(),
    maxUnits: rule.maxUnits.toString(),
    unitPriceMinor: rule.unitPriceMinor.toString(),
  };
}

function ruleView(rule: CustomServiceRuleRecord): Record<string, unknown> {
  return {
    dimension: rule.dimension,
    label: rule.label,
    minUnits: rule.minUnits.toString(),
    maxUnits: rule.maxUnits.toString(),
    unitPriceMinor: rule.unitPrice.amountMinor.toString(),
    currency: rule.unitPrice.currency,
    customerId: rule.customerId,
    resellerTierId: rule.resellerTierId,
    panelId: rule.panelId,
    enabled: rule.enabled,
  };
}

function locationView(location: CustomServiceLocationRecord): Record<string, unknown> {
  return { panelId: location.panelId, label: location.label, enabled: location.enabled };
}
