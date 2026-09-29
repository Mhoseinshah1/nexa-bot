import {
  COMMERCE_ERROR_CODES,
  errors,
  money,
  SERVICE_LOCATIONS_PER_PANEL_MAX,
  serviceLocationIdSchema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type CurrencyCode,
  type IdGenerator,
  type IdempotencyStore,
  type LocationChangeLimits,
  type OperationalEventRecorder,
  type PanelId,
  type PermissionKey,
  type ProductId,
  type SalesCurrencyCode,
  type ServiceLocationId,
  type ServiceState,
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
import type {
  ServiceLocationConflict,
  ServiceLocationDraft,
  ServiceLocationRecord,
  ServiceLocationRepository,
} from './ports.js';

/** Reading the configured locations: the catalogue's own read permission. */
export const SERVICE_LOCATION_VIEW_PERMISSION: PermissionKey = 'catalog.view';
/**
 * Writing them: `catalog.edit`, the pair every add-on price is written under — a location
 * change is sold beside extra traffic, time and users, and configured the same way.
 */
export const SERVICE_LOCATION_EDIT_PERMISSION: PermissionKey = 'catalog.edit';

/**
 * The most locations one tenant may configure, and so how many its list returns: every
 * row is always on the one list, so none can be created and then never be seen again.
 */
export const SERVICE_LOCATION_LIST_LIMIT = 500;

/** What an operator submits, parsed at the surface. */
export interface ServiceLocationInput {
  readonly panelId: string;
  readonly productId: string | null;
  readonly locationKey: string;
  readonly label: string;
  readonly initial: boolean;
  readonly enabled: boolean;
  readonly price: { readonly amountMinor: bigint; readonly currency: CurrencyCode } | null;
  readonly limits: LocationChangeLimits;
  readonly sortOrder: number;
}

export interface ServiceLocationAdminServiceDeps {
  readonly repository: ServiceLocationRepository;
  /** Whether a panel / product named here exists in THIS tenant. */
  readonly targets: {
    panelExists(scope: TenantContext, panelId: string, tx: TransactionScope): Promise<boolean>;
    /** The product's own panel, or `undefined` when there is no such product in THIS tenant. */
    productPanel(
      scope: TenantContext,
      productId: string,
      tx: TransactionScope,
    ): Promise<string | null | undefined>;
  };
  /** Where a panel's never-moved services are frozen before its initial location changes. */
  readonly services: {
    recordLocationForUnmoved(
      scope: TenantContext,
      panelId: string,
      location: { readonly key: string; readonly label: string },
      legalFrom: readonly ServiceState[],
      now: Date,
      tx: TransactionScope,
    ): Promise<number>;
  };
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
 * The never-moved services an initial-location change freezes: every state with an
 * account that exists or may, and not `TERMINATED`, which has none. A `PENDING_PROVISION`
 * service is frozen too once its create has STARTED — its account may already be at the
 * old location — which the repository decides under the row lock that create's stamp
 * takes (Codex review #2 on PR #101). One whose create has not started keeps NULL: it will
 * be made wherever the panel places new accounts from now on.
 */
const UNMOVED_FREEZE_STATES: readonly ServiceState[] = [
  'ACTIVE',
  'SUSPENDED',
  'EXPIRED',
  'UNRECONCILED',
];

/**
 * The operator's side of the location change (WP-A6): a panel's locations, the one new
 * accounts start in, and which may be moved to at what price, cooldown and limit.
 *
 * Nothing here decides that a service CAN be moved — that is the panel adapter's
 * capability and `LocationChangePolicy`'s resolution, both re-asked on every customer
 * write — so a location saved for a panel whose adapter cannot move an account is sold
 * to nobody, which is correct and what the Web Admin says beside it.
 *
 * Every write is audited with before and after, idempotent by key, refused for a stopped
 * tenant inside its transaction, and bumps the row's version, so a change request names
 * the exact terms it was quoted from. Editing or deleting a location rewrites no history:
 * a change request froze its names, key and price when it was made.
 */
export class ServiceLocationAdminService {
  constructor(private readonly deps: ServiceLocationAdminServiceDeps) {}

  async list(scope: TenantContext, actor: ActorContext): Promise<readonly ServiceLocationRecord[]> {
    await this.deps.guard.check(scope, actor, SERVICE_LOCATION_VIEW_PERMISSION);
    return this.deps.repository.list(scope, SERVICE_LOCATION_LIST_LIMIT);
  }

  async create(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly location: ServiceLocationInput },
  ): Promise<{ readonly location: ServiceLocationRecord; readonly changed: boolean }> {
    const requestHash = hashRequest({ create: serialisable(input.location) });
    const denial: Denial = {
      action: 'service_location.create',
      entityType: 'ServiceLocation',
      entityId: null,
    };
    await this.authorize(scope, actor, denial);
    const replay = await this.replayed(scope, input.idempotencyKey, requestHash);
    if (replay !== null) return { location: replay, changed: false };

    const now = this.deps.clock.now();
    const id = this.deps.ids.uuid() as ServiceLocationId;
    return this.mutate(scope, actor, denial, async (tx) => {
      // FIRST, so two concurrent creates cannot both read a count one below a cap.
      await this.deps.repository.lockForWrite(scope, tx);
      const draft = await this.validated(scope, input.location, tx);
      await this.assertPanelHasRoom(scope, draft.panelId, tx);
      const existing = await this.deps.repository.list(scope, SERVICE_LOCATION_LIST_LIMIT, tx);
      if (existing.length >= SERVICE_LOCATION_LIST_LIMIT) {
        throw invalid(
          'COUNT',
          `A tenant may hold at most ${SERVICE_LOCATION_LIST_LIMIT} service locations.`,
        );
      }
      const created = await this.deps.repository.create(scope, { id, draft, now }, tx);
      if (!created.ok) throw conflictError(created.conflict);
      await this.audit(scope, actor, tx, denial.action, id, null, view(created.record));
      await rememberOnce(
        this.deps.idempotency,
        scope,
        'WEB',
        input.idempotencyKey,
        requestHash,
        { locationId: id },
        tx,
      );
      return { location: created.record, changed: true };
    });
  }

  async update(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly locationId: string;
      readonly location: ServiceLocationInput;
    },
  ): Promise<{ readonly location: ServiceLocationRecord; readonly changed: boolean }> {
    const locationId = this.locationId(input.locationId);
    const requestHash = hashRequest({ locationId, update: serialisable(input.location) });
    const denial: Denial = {
      action: 'service_location.update',
      entityType: 'ServiceLocation',
      entityId: locationId,
    };
    await this.authorize(scope, actor, denial);
    const replay = await this.replayed(scope, input.idempotencyKey, requestHash);
    if (replay !== null) return { location: replay, changed: false };

    const now = this.deps.clock.now();
    return this.mutate(scope, actor, denial, async (tx) => {
      await this.deps.repository.lockForWrite(scope, tx);
      const before = await this.deps.repository.findById(scope, locationId, tx);
      if (before === null) throw notFound();
      const draft = await this.validated(scope, input.location, tx);
      if (draft.panelId !== before.panelId) await this.assertPanelHasRoom(scope, draft.panelId, tx);
      /*
       * A save that lands on exactly what is stored changes nothing and says so — and
       * bumps no version, so a change request quoted a moment ago is not refused over an
       * edit that edited nothing.
       */
      if (sameTerms(before, draft)) {
        await rememberOnce(
          this.deps.idempotency,
          scope,
          'WEB',
          input.idempotencyKey,
          requestHash,
          { locationId },
          tx,
        );
        return { location: before, changed: false };
      }
      /*
       * Whether the panel's initial location stays the SAME place. A rename alone does:
       * never-moved services are still there and read the new name. A new key, another
       * panel or an unmarked row does not, and freezes the old one onto them first.
       */
      const stillInitial =
        draft.initial &&
        draft.panelId === before.panelId &&
        draft.locationKey === before.locationKey;
      const frozen =
        before.initial && !stillInitial ? await this.freezeUnmoved(scope, before, now, tx) : 0;
      const updated = await this.deps.repository.update(scope, locationId, draft, now, tx);
      if (!updated.ok) throw conflictError(updated.conflict);
      if (updated.record === null) throw notFound();
      await this.audit(scope, actor, tx, denial.action, locationId, view(before), {
        ...view(updated.record),
        ...(before.initial && !stillInitial ? { unmovedServicesFrozen: frozen } : {}),
      });
      await rememberOnce(
        this.deps.idempotency,
        scope,
        'WEB',
        input.idempotencyKey,
        requestHash,
        { locationId },
        tx,
      );
      return { location: updated.record, changed: true };
    });
  }

  /**
   * Deletes a location nothing has been quoted from. One a change request or a commercial
   * action names is refused — that row's history points at it — and the operator switches
   * it off instead, which withdraws it from sale exactly as deleting would.
   */
  async remove(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly locationId: string },
  ): Promise<{ readonly deleted: boolean }> {
    const locationId = this.locationId(input.locationId);
    const requestHash = hashRequest({ locationId, delete: true });
    const denial: Denial = {
      action: 'service_location.delete',
      entityType: 'ServiceLocation',
      entityId: locationId,
    };
    await this.authorize(scope, actor, denial);
    const replay = await this.deps.idempotency.find<{ deleted: boolean }>(
      scope,
      'WEB',
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) return { deleted: replay.result.deleted };

    const now = this.deps.clock.now();
    return this.mutate(scope, actor, denial, async (tx) => {
      await this.deps.repository.lockForWrite(scope, tx);
      const before = await this.deps.repository.findById(scope, locationId, tx);
      if (before === null) throw notFound();
      if (await this.deps.repository.isReferenced(scope, locationId, tx)) {
        throw errors.conflict(
          COMMERCE_ERROR_CODES.SERVICE_LOCATION_INVALID,
          'A change request names this location. Switch it off instead of deleting it.',
          { reason: 'IN_USE' },
        );
      }
      const frozen = before.initial ? await this.freezeUnmoved(scope, before, now, tx) : 0;
      const deleted = await this.deps.repository.delete(scope, locationId, tx);
      await this.audit(
        scope,
        actor,
        tx,
        denial.action,
        locationId,
        view(before),
        before.initial ? { unmovedServicesFrozen: frozen } : null,
      );
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

  /** The references must be this tenant's, and a price is in the selling currency. */
  private async validated(
    scope: TenantContext,
    input: ServiceLocationInput,
    tx: TransactionScope,
  ): Promise<ServiceLocationDraft> {
    if (!(await this.deps.targets.panelExists(scope, input.panelId, tx))) {
      throw invalid('PANEL', 'Unknown panel.');
    }
    if (input.productId !== null) {
      const productPanel = await this.deps.targets.productPanel(scope, input.productId, tx);
      if (productPanel === undefined) throw invalid('PRODUCT', 'Unknown product.');
      // A product-scoped offer names a product sold on THIS panel; any other could never
      // apply to a service here, and would read as though it did (Codex #1, PR #101).
      if (productPanel !== input.panelId) {
        throw invalid('PRODUCT_PANEL', 'That product is not sold on this panel.');
      }
    }
    if (input.initial && input.productId !== null) {
      throw invalid('INITIAL_SCOPE', 'The initial location belongs to the whole panel.');
    }
    if (input.enabled && input.price === null) {
      throw invalid('UNPRICED', 'An enabled location needs a price. Zero is free.');
    }
    const selling = await this.deps.settings.valueOf<SalesCurrencyCode>(
      scope,
      'sales.currency',
      tx,
    );
    if (input.price !== null && input.price.currency !== selling) {
      throw invalid('CURRENCY', `This installation sells in ${selling}.`);
    }
    if ((input.limits.maxChanges === null) !== (input.limits.periodDays === null)) {
      throw invalid('LIMIT', 'A limit is a number of changes over a number of days.');
    }
    return {
      panelId: input.panelId as PanelId,
      productId: input.productId as ProductId | null,
      locationKey: input.locationKey.trim(),
      label: input.label.trim(),
      initial: input.initial,
      enabled: input.enabled,
      price: input.price === null ? null : money(input.price.amountMinor, input.price.currency),
      limits: input.limits,
      sortOrder: input.sortOrder,
    };
  }

  /** A panel holds at most `SERVICE_LOCATIONS_PER_PANEL_MAX` rows: one choice screen. */
  private async assertPanelHasRoom(
    scope: TenantContext,
    panelId: string,
    tx: TransactionScope,
  ): Promise<void> {
    const rows = await this.deps.repository.forPanel(scope, panelId, tx);
    if (rows.length >= SERVICE_LOCATIONS_PER_PANEL_MAX) {
      throw invalid(
        'PANEL_FULL',
        `A panel may hold at most ${SERVICE_LOCATIONS_PER_PANEL_MAX} locations.`,
      );
    }
  }

  /**
   * Before a panel's initial location changes, freeze it onto every never-moved service
   * there (Codex review #1 on PR #101). A service with no recorded location is read as
   * being in its panel's CURRENT initial location, so editing, unmarking, moving or
   * deleting that row without this would silently relocate every such service — and the
   * next quote would name the wrong origin, or refuse a move as "already there". In the
   * write's own transaction, under the tenant's location lock.
   */
  private async freezeUnmoved(
    scope: TenantContext,
    initial: ServiceLocationRecord,
    now: Date,
    tx: TransactionScope,
  ): Promise<number> {
    return this.deps.services.recordLocationForUnmoved(
      scope,
      initial.panelId,
      { key: initial.locationKey, label: initial.label },
      UNMOVED_FREEZE_STATES,
      now,
      tx,
    );
  }

  private async replayed(
    scope: TenantContext,
    key: string,
    requestHash: string,
  ): Promise<ServiceLocationRecord | null> {
    const replay = await this.deps.idempotency.find<{ locationId: string }>(
      scope,
      'WEB',
      key,
      requestHash,
    );
    if (replay === null) return null;
    return this.deps.repository.findById(scope, replay.result.locationId as ServiceLocationId);
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
      SERVICE_LOCATION_EDIT_PERMISSION,
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
      { action, entityType: 'ServiceLocation', entityId, before, after, result: 'SUCCESS' },
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
      await this.deps.guard.check(scope, actor, SERVICE_LOCATION_EDIT_PERMISSION);
    } catch (error) {
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        SERVICE_LOCATION_EDIT_PERMISSION,
        denial,
        error,
      );
      throw error;
    }
  }

  private locationId(candidate: string): ServiceLocationId {
    const parsed = serviceLocationIdSchema.safeParse(candidate);
    if (!parsed.success) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'That is not a valid location identifier.',
      );
    }
    return parsed.data;
  }
}

function invalid(reason: string, message: string) {
  return errors.validation(COMMERCE_ERROR_CODES.SERVICE_LOCATION_INVALID, message, { reason });
}

function notFound() {
  return errors.notFound(COMMERCE_ERROR_CODES.SERVICE_LOCATION_NOT_FOUND, 'Unknown location.');
}

function conflictError(conflict: ServiceLocationConflict) {
  return errors.conflict(
    COMMERCE_ERROR_CODES.SERVICE_LOCATION_INVALID,
    conflict === 'DUPLICATE_KEY'
      ? 'This panel already has this location for the same products.'
      : 'This panel already has an initial location.',
    { reason: conflict },
  );
}

function sameTerms(row: ServiceLocationRecord, draft: ServiceLocationDraft): boolean {
  return (
    row.panelId === draft.panelId &&
    row.productId === draft.productId &&
    row.locationKey === draft.locationKey &&
    row.label === draft.label &&
    row.initial === draft.initial &&
    row.enabled === draft.enabled &&
    (row.price === null
      ? draft.price === null
      : draft.price !== null &&
        row.price.amountMinor === draft.price.amountMinor &&
        row.price.currency === draft.price.currency) &&
    row.limits.cooldownHours === draft.limits.cooldownHours &&
    row.limits.maxChanges === draft.limits.maxChanges &&
    row.limits.periodDays === draft.limits.periodDays &&
    row.sortOrder === draft.sortOrder
  );
}

function serialisable(input: ServiceLocationInput): Record<string, unknown> {
  return {
    ...input,
    price:
      input.price === null
        ? null
        : { amountMinor: input.price.amountMinor.toString(), currency: input.price.currency },
  };
}

/** The audit view: every term, and the version it is. Keys are not secrets. */
function view(row: ServiceLocationRecord): Record<string, unknown> {
  return {
    panelId: row.panelId,
    productId: row.productId,
    locationKey: row.locationKey,
    label: row.label,
    initial: row.initial,
    enabled: row.enabled,
    priceAmount: row.price?.amountMinor.toString() ?? null,
    priceCurrency: row.price?.currency ?? null,
    cooldownHours: row.limits.cooldownHours,
    maxChanges: row.limits.maxChanges,
    periodDays: row.limits.periodDays,
    sortOrder: row.sortOrder,
    version: row.version,
  };
}
