import {
  COMMERCE_ERROR_CODES,
  SERVICE_ADDON_PAGE_DEFAULT,
  SERVICE_ADDON_PAGE_MAX,
  errors,
  serviceAddonIdSchema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type SalesCurrencyCode,
  type ServiceAddonId,
  type ServiceAddonKind,
  type ServiceAddonStatus,
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
import { PRODUCT_EDIT_PERMISSION, PRODUCT_VIEW_PERMISSION } from './product.service.js';
import type {
  ServiceAddonCursor,
  ServiceAddonDraft,
  ServiceAddonEdit,
  ServiceAddonPage,
  ServiceAddonRecord,
  ServiceAddonRepository,
  ServiceAddonSearch,
} from './addon-ports.js';

export interface ServiceAddonServiceDeps {
  readonly repository: ServiceAddonRepository;
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

export interface ServiceAddonListQuery {
  readonly limit?: number;
  readonly cursor?: ServiceAddonCursor;
  readonly search: ServiceAddonSearch;
}

/**
 * Add-ons, as an operator manages them.
 *
 * The same seven-step write path `ProductService` runs, under the SAME permissions —
 * `catalog.view` and `catalog.edit` — because an add-on is the same kind of thing: a
 * priced offer an operator curates. A separate permission pair would have meant a
 * contracts change, a migration backfilling grants into every existing role, and an
 * operator discovering they can edit half a catalogue.
 *
 * `catalog.pricing.edit` is deliberately not used here either, for the reason
 * `ProductService` gives: it governs pricing RULES, which do not exist in this phase.
 */
export class ServiceAddonService {
  constructor(private readonly deps: ServiceAddonServiceDeps) {}

  async list(
    scope: TenantContext,
    actor: ActorContext,
    query: ServiceAddonListQuery,
  ): Promise<ServiceAddonPage> {
    await this.deps.guard.check(scope, actor, PRODUCT_VIEW_PERMISSION);
    const limit = Math.min(
      Math.max(query.limit ?? SERVICE_ADDON_PAGE_DEFAULT, 1),
      SERVICE_ADDON_PAGE_MAX,
    );
    return this.deps.repository.list(scope, query.search, limit, query.cursor ?? null);
  }

  async get(scope: TenantContext, actor: ActorContext, id: string): Promise<ServiceAddonRecord> {
    await this.deps.guard.check(scope, actor, PRODUCT_VIEW_PERMISSION);
    const addonId = this.addonId(id);
    const addon = await this.deps.repository.findById(scope, addonId);
    if (addon === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.ADDON_NOT_FOUND, 'Unknown add-on.');
    }
    return addon;
  }

  /** Creates an INACTIVE add-on. Idempotent, audited. */
  async create(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly draft: ServiceAddonDraft },
  ): Promise<ServiceAddonRecord> {
    const requestHash = hashRequest({ draft: serialisableDraft(input.draft) });

    /** Before the replay lookup: a replay returns a ROW, and would hand it to anybody. */
    await this.authorize(scope, actor, {
      action: 'addon.create',
      entityType: 'ServiceAddon',
      entityId: null,
    });

    const replay = await this.deps.idempotency.find<{ addonId: string }>(
      scope,
      'WEB',
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      const existing = await this.deps.repository.findById(
        scope,
        replay.result.addonId as ServiceAddonId,
      );
      if (existing !== null) return existing;
      // The idempotency row outlived its add-on, which a restore can produce. Fall
      // through and create rather than report a stale success for a row that is gone.
    }

    const now = this.deps.clock.now();
    const id = this.deps.ids.uuid() as ServiceAddonId;

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      PRODUCT_EDIT_PERMISSION,
      { action: 'addon.create', entityType: 'ServiceAddon', entityId: null },
      async (tx) => {
        await this.assertScopeActive(scope, tx);
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
            action: 'addon.create',
            entityType: 'ServiceAddon',
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
          { addonId: created.id },
          tx,
        );
        return created;
      },
    );
  }

  /**
   * Edits the mutable properties. The KIND is not one of them.
   *
   * `ServiceAddonEdit` omits it and the repository's UPDATE never names the column, so
   * there is no path by which an edit changes what an add-on IS. Every
   * `service_commercial_actions` row that already bought this one is append-only
   * evidence describing a quantity in its unit, and there is no correcting those.
   *
   * The AMOUNT is editable, and that is safe for the same reason a product's
   * specification is: every purchase snapshots what it bought, onto the order line and
   * onto the action row, so re-tuning an add-on changes what sells next and nothing
   * about what sold.
   */
  async update(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly addonId: string;
      readonly edit: ServiceAddonEdit;
    },
  ): Promise<ServiceAddonRecord> {
    const addonId = this.addonId(input.addonId);
    const requestHash = hashRequest({ addonId, edit: serialisableEdit(input.edit) });

    await this.authorize(scope, actor, {
      action: 'addon.update',
      entityType: 'ServiceAddon',
      entityId: addonId,
    });

    const replay = await this.deps.idempotency.find<{ addonId: string }>(
      scope,
      'WEB',
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      const existing = await this.deps.repository.findById(scope, addonId);
      if (existing !== null) return existing;
    }

    const now = this.deps.clock.now();

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      PRODUCT_EDIT_PERMISSION,
      { action: 'addon.update', entityType: 'ServiceAddon', entityId: addonId },
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        await this.assertPriceCurrency(scope, input.edit.price, tx);

        const before = await this.deps.repository.findById(scope, addonId, tx);
        if (before === null) {
          throw errors.notFound(COMMERCE_ERROR_CODES.ADDON_NOT_FOUND, 'Unknown add-on.');
        }
        /*
         * The amount has to match the kind the row ALREADY has.
         *
         * `service_addons_amount_matches_kind` would refuse the write, but as a raw
         * integrity violation naming a constraint rather than a field. This is the
         * message — and it is a real case rather than a defensive one: an edit form
         * rendered for one kind, submitted against an id that is the other, is one
         * mis-wired route away.
         */
        this.assertAmountMatchesKind(before.kind, input.edit);

        const after = await this.deps.repository.update(scope, addonId, input.edit, now, tx);
        if (after === null) {
          throw errors.notFound(COMMERCE_ERROR_CODES.ADDON_NOT_FOUND, 'Unknown add-on.');
        }

        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'addon.update',
            entityType: 'ServiceAddon',
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
          { addonId: after.id },
          tx,
        );
        return after;
      },
    );
  }

  async activate(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly addonId: string },
  ): Promise<ServiceAddonRecord> {
    return this.setStatus(scope, actor, { ...input, to: 'ACTIVE' });
  }

  /**
   * Withdraws an add-on from sale.
   *
   * It touches no order and no action row. Both carry their own snapshot of what was
   * bought, so a withdrawal changes what can be bought next and nothing about what was.
   */
  async deactivate(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly addonId: string },
  ): Promise<ServiceAddonRecord> {
    return this.setStatus(scope, actor, { ...input, to: 'INACTIVE' });
  }

  private async setStatus(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly addonId: string;
      readonly to: ServiceAddonStatus;
    },
  ): Promise<ServiceAddonRecord> {
    const addonId = this.addonId(input.addonId);
    const requestHash = hashRequest({ addonId, to: input.to });
    const action = input.to === 'ACTIVE' ? 'addon.activate' : 'addon.deactivate';

    await this.authorize(scope, actor, { action, entityType: 'ServiceAddon', entityId: addonId });

    const replay = await this.deps.idempotency.find<{ addonId: string }>(
      scope,
      'WEB',
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      const existing = await this.deps.repository.findById(scope, addonId);
      if (existing !== null) return existing;
    }

    const now = this.deps.clock.now();
    const from: ServiceAddonStatus = input.to === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      PRODUCT_EDIT_PERMISSION,
      { action, entityType: 'ServiceAddon', entityId: addonId },
      async (tx) => {
        await this.assertScopeActive(scope, tx);

        const before = await this.deps.repository.findById(scope, addonId, tx);
        if (before === null) {
          throw errors.notFound(COMMERCE_ERROR_CODES.ADDON_NOT_FOUND, 'Unknown add-on.');
        }
        /*
         * An add-on with no price cannot be activated.
         *
         * `catalog.ts` says an absent price means unsellable rather than free, and
         * `listOfferable` already filters unpriced rows out — so activating one would
         * produce a row an operator can see in the ACTIVE list and no customer is ever
         * offered. Refused where the message can name the reason.
         */
        if (input.to === 'ACTIVE' && before.price === null) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.ADDON_NOT_PURCHASABLE,
            'An add-on with no price cannot be offered.',
          );
        }

        const changed = await this.deps.repository.setStatus(
          scope,
          addonId,
          from,
          input.to,
          now,
          tx,
        );

        const after = await this.deps.repository.findById(scope, addonId, tx);
        if (after === null) {
          throw errors.notFound(COMMERCE_ERROR_CODES.ADDON_NOT_FOUND, 'Unknown add-on.');
        }

        // A no-op is a success that still writes its audit row — the `ProductService`
        // rule: the log has to distinguish "withdrew it" from "it was already withdrawn".
        await this.deps.audit.record(
          scope,
          actor,
          {
            action,
            entityType: 'ServiceAddon',
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
          { addonId: after.id },
          tx,
        );
        return after;
      },
    );
  }

  private assertAmountMatchesKind(kind: ServiceAddonKind, edit: ServiceAddonEdit): void {
    const ok =
      kind === 'ADD_TRAFFIC'
        ? edit.specification.trafficBytes !== null && edit.specification.durationDays === null
        : edit.specification.durationDays !== null && edit.specification.trafficBytes === null;
    if (!ok || edit.specification.kind !== kind) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'That amount is not the kind this add-on sells.',
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

  /** Priced in the currency the tenant sells in, and no other. `ProductService`'s rule. */
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

  /** A uuid, validated in the SERVICE so any later surface inherits the rule. */
  private addonId(candidate: string): ServiceAddonId {
    const parsed = serviceAddonIdSchema.safeParse(candidate);
    if (!parsed.success) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'That is not a valid add-on identifier.',
      );
    }
    return parsed.data;
  }
}

/** `bigint` as text: `hashRequest` serialises to JSON, which throws on one. */
function serialisableEdit(edit: ServiceAddonEdit): Record<string, unknown> {
  return {
    title: edit.title,
    sortOrder: edit.sortOrder,
    trafficBytes: edit.specification.trafficBytes?.toString() ?? null,
    durationDays: edit.specification.durationDays,
    priceAmount: edit.price === null ? null : edit.price.amountMinor.toString(),
    priceCurrency: edit.price === null ? null : edit.price.currency,
  };
}

function serialisableDraft(draft: ServiceAddonDraft): Record<string, unknown> {
  return { kind: draft.kind, ...serialisableEdit(draft) };
}

/** Every mutable field, so a before/after pair answers what an edit changed. */
function auditView(addon: ServiceAddonRecord): Record<string, unknown> {
  return {
    kind: addon.kind,
    title: addon.title,
    status: addon.status,
    sortOrder: addon.sortOrder,
    trafficBytes: addon.specification.trafficBytes?.toString() ?? null,
    durationDays: addon.specification.durationDays,
    priceAmount: addon.price === null ? null : addon.price.amountMinor.toString(),
    priceCurrency: addon.price === null ? null : addon.price.currency,
  };
}
