import { createHash } from 'node:crypto';
import {
  COMMERCE_ERROR_CODES,
  LEGACY_SHA256_PATTERN,
  SUBSCRIPTION_REF_BYTES,
  errors,
  isLegacyImportKey,
  telegramUserIdSchema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type PermissionKey,
  type ProductId,
  type SalesCurrencyCode,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
} from '../../../platform/access/application/authorized-mutation.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import type {
  LegacyImportDecision,
  LegacyImportRepository,
} from '../../../platform/legacy-import/application/legacy-import-ports.js';
import type { PanelCapacityRepository } from '../../../platform/panels/application/capacity-ports.js';
import type { ProductRepository } from '../../catalog/application/ports.js';
import type { LegacyProductShapeRepository } from '../../catalog/application/legacy-product-ports.js';
import { legacyShapeAdoptable } from '../../catalog/application/legacy-product.service.js';
import type { ServiceSecretSource } from '../../provisioning/application/ports.js';
import type { ServiceReminderService } from '../../provisioning/application/service-reminder.service.js';
import { namespaceKeyFor } from '../../provisioning/application/username-allocator.js';
import type {
  AdoptionCapacity,
  AdoptionRuntimeFacts,
  LegacyAdoptionCommand,
  LegacyAdoptionOutcome,
  LegacyAdoptionReviewReason,
  LegacyAdoptionStore,
} from './legacy-adoption-ports.js';

/**
 * What the adoption charges. `SYSTEM_JOB_PERMISSIONS` is `maintenance.run` alone and the
 * importer is system work, so this is the key it holds — the one the opening-balance
 * service charges too. No narrower existing key is held by a job. The check is MADE, never
 * skipped by actor type; an administrator holding `maintenance.run` passes it as well, which
 * is why no surface may reach this service (`tests/unit/legacy-adoption-boundary.test.ts`).
 */
export const LEGACY_ADOPTION_PERMISSION: PermissionKey = 'maintenance.run';

const AUDIT_ADOPT = 'legacy.service.adopt';
const AUDIT_DECIDE = 'legacy.invoice.decide';
const LEGACY_TABLE = 'invoice';
const SUBSCRIPTION_URL_MAX = 2048;

export interface LegacyAdoptionDeps {
  readonly store: LegacyAdoptionStore;
  readonly map: Pick<LegacyImportRepository, 'findByLegacyKeys' | 'recordDecision'>;
  readonly products: Pick<ProductRepository, 'findById'>;
  readonly shapes: Pick<LegacyProductShapeRepository, 'findById'>;
  readonly capacity: Pick<PanelCapacityRepository, 'read'>;
  readonly reminders: Pick<ServiceReminderService, 'seedPassedThresholds'>;
  readonly settings: {
    valueOf<T>(scope: TenantContext, key: 'sales.currency', tx?: unknown): Promise<T>;
  };
  readonly secrets: ServiceSecretSource;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly scopeActivity: ScopeActivityReader;
  readonly outbox: OutboxWriter;
  readonly idempotency: IdempotencyStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** The NEXA state an adoptable RickPanel state becomes (§5); null = not representable. */
export function adoptedServiceState(
  state: AdoptionRuntimeFacts['state'],
): 'ACTIVE' | 'SUSPENDED' | 'EXPIRED' | null {
  switch (state) {
    case 'active':
    case 'limited':
      return 'ACTIVE';
    case 'disabled':
      return 'SUSPENDED';
    case 'expired':
      return 'EXPIRED';
    case 'on_hold':
    case 'UNKNOWN':
      return null;
  }
}

/** A link a provider served: absolute http(s), bounded. Anything else is not stored. */
function acceptableLink(url: string): boolean {
  if (url.length === 0 || url.length > SUBSCRIPTION_URL_MAX) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/** The request's identity for the idempotency store: every field but the key, canonical. */
export function adoptionRequestHash(command: LegacyAdoptionCommand): string {
  const runtime = command.runtime;
  const canonical = JSON.stringify([
    command.runId,
    command.legacyInvoiceKey,
    command.sourceChecksum,
    command.telegramUserId,
    command.match,
    runtime === null
      ? null
      : [
          runtime.state,
          runtime.usage === null
            ? null
            : [
                runtime.usage.usedBytes.toString(),
                runtime.usage.totalBytes?.toString() ?? null,
                runtime.usage.expiresAt?.toISOString() ?? null,
              ],
          runtime.observedAt.toISOString(),
          runtime.subscriptionUrl,
        ],
    command.productId,
    command.legacyPurchasedAt?.toISOString() ?? null,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

type Decision =
  | { readonly kind: 'REVIEW'; readonly reason: LegacyAdoptionReviewReason }
  | { readonly kind: 'SKIP' };

/**
 * Migration P6 — adopts one live legacy invoice's existing RickPanel account as a NEXA
 * service (`docs/migration-p6-service-adoption.md`).
 *
 * ADOPTION IS NOT PROVISIONING. This service holds no provider client, adapter or
 * transport; the account's runtime facts are inputs. It writes, in ONE transaction: a
 * `NEW_SERVICE` + `LEGACY_ADOPTION` order at zero, the live service, the funded username
 * hold, the burst-protection reminder seed, the `legacy_import_map` provenance row, an audit
 * row and a `ServiceAdopted` event — or, when it would have to guess, only a MANUAL_REVIEW
 * map row with a closed reason.
 *
 * Migration-only: the P7 importer is its one caller.
 */
export class LegacyAdoptionService {
  constructor(private readonly deps: LegacyAdoptionDeps) {}

  async adopt(
    scope: TenantContext,
    actor: ActorContext,
    command: LegacyAdoptionCommand,
  ): Promise<LegacyAdoptionOutcome> {
    if (command.idempotencyKey.trim().length === 0) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'An adoption needs an idempotency key.',
      );
    }
    if (!LEGACY_SHA256_PATTERN.test(command.sourceChecksum)) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'The source checksum is not a lowercase SHA-256 hex.',
      );
    }
    const denial = { action: AUDIT_ADOPT, entityType: 'Service', entityId: null };
    try {
      await this.deps.guard.check(scope, actor, LEGACY_ADOPTION_PERMISSION);
    } catch (error) {
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        LEGACY_ADOPTION_PERMISSION,
        denial,
        error,
      );
      throw error;
    }

    /*
     * A key outside the map's evidenced invoice shape cannot be recorded at all (the map
     * refuses it, by design), so it is answered as manual review with NOTHING written — the
     * importer reports it from its own run. Never guessed into shape.
     */
    if (!isLegacyImportKey(LEGACY_TABLE, command.legacyInvoiceKey)) {
      return { kind: 'MANUAL_REVIEW', reason: 'INVALID_SOURCE_ROW', recorded: false };
    }

    const hash = adoptionRequestHash(command);
    const replay = await this.deps.idempotency.find<LegacyAdoptionOutcome>(
      scope,
      actor.surface,
      command.idempotencyKey,
      hash,
    );
    if (replay !== null) return replay.result;

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      LEGACY_ADOPTION_PERMISSION,
      denial,
      async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
            'This installation has stopped accepting work.',
          );
        }
        const outcome = await this.decideAndWrite(scope, actor, command, tx);
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          command.idempotencyKey,
          hash,
          outcome,
          tx,
        );
        return outcome;
      },
    );
  }

  private async decideAndWrite(
    scope: TenantContext,
    actor: ActorContext,
    command: LegacyAdoptionCommand,
    tx: TransactionScope,
  ): Promise<LegacyAdoptionOutcome> {
    // 1. Every adoption of this invoice, serialised. First lock taken; see §3.
    await this.deps.store.lockInvoice(scope, command.legacyInvoiceKey, tx);

    // 2. Already decided as a service: the same mapping, whatever the new key.
    const [existing] = await this.deps.map.findByLegacyKeys(
      scope,
      LEGACY_TABLE,
      [command.legacyInvoiceKey],
      tx,
    );
    if (existing?.status === 'IMPORTED' && existing.entityType === 'SERVICE' && existing.entityId) {
      const service = await this.deps.store.findService(scope, existing.entityId, tx);
      if (service === null) {
        throw new Error('legacy_import_map names an adopted service that does not exist');
      }
      return {
        kind: 'ALREADY_ADOPTED',
        ...service,
        sourceChanged: existing.checksum !== command.sourceChecksum,
      };
    }

    const decided = await this.decide(scope, command, tx);
    if ('kind' in decided) {
      if (decided.kind === 'SKIP') {
        await this.record(scope, command, { status: 'SKIPPED', reasonCode: 'TEST_PANEL' }, tx);
        await this.auditDecision(scope, actor, command, 'SKIPPED', 'TEST_PANEL', tx);
        return { kind: 'SKIPPED', reason: 'TEST_PANEL' };
      }
      await this.record(
        scope,
        command,
        { status: 'MANUAL_REVIEW', reasonCode: decided.reason },
        tx,
      );
      await this.auditDecision(scope, actor, command, 'MANUAL_REVIEW', decided.reason, tx);
      return { kind: 'MANUAL_REVIEW', reason: decided.reason, recorded: true };
    }
    return this.write(scope, actor, command, decided, tx);
  }

  /**
   * Everything that can send the invoice to review, in a fixed order, before anything is
   * written. Reads under the invoice lock and, for the panel, under the panel's row lock.
   */
  private async decide(
    scope: TenantContext,
    command: LegacyAdoptionCommand,
    tx: TransactionScope,
  ): Promise<Decision | Plan> {
    const match = command.match;
    switch (match.kind) {
      case 'SKIPPED':
        return { kind: 'SKIP' };
      case 'INVALID':
        return { kind: 'REVIEW', reason: 'INVALID_SOURCE_ROW' };
      case 'UNDECIDABLE':
        return { kind: 'REVIEW', reason: 'INVENTORY_INCOMPLETE' };
      case 'MANUAL_REVIEW':
        return { kind: 'REVIEW', reason: match.reason };
      case 'ELIGIBLE':
        break;
    }
    const review = (reason: LegacyAdoptionReviewReason): Decision => ({ kind: 'REVIEW', reason });

    // The exact spelling must be the one the match folded: C3 constraint 3.
    const exact = match.providerUsername;
    if (
      exact.length === 0 ||
      exact.length > 128 ||
      !/^[\x21-\x7e]+$/.test(exact) ||
      exact.toLowerCase() !== match.username
    ) {
      return review('INVALID_SOURCE_ROW');
    }
    if (!telegramUserIdSchema.safeParse(command.telegramUserId).success) {
      return review('INVALID_SOURCE_ROW');
    }

    const runtime = command.runtime;
    if (runtime === null) return review('PROVIDER_READ_FAILED');
    const state = adoptedServiceState(runtime.state);
    if (state === null) return review('UNSUPPORTED_SHAPE');
    const usage = runtime.usage;
    if (
      usage === null ||
      usage.usedBytes < 0n ||
      (usage.totalBytes !== null && usage.totalBytes <= 0n)
    ) {
      return review('PROVIDER_READ_FAILED');
    }
    if (runtime.subscriptionUrl !== null && !acceptableLink(runtime.subscriptionUrl)) {
      return review('PROVIDER_READ_FAILED');
    }

    const customerId = await this.deps.store.findCustomerByTelegramId(
      scope,
      command.telegramUserId,
      tx,
    );
    if (customerId === null) return review('CUSTOMER_MISSING');

    if (command.productId === null) return review('PRODUCT_MAPPING_UNRESOLVED');
    const product = await this.deps.products.findById(scope, command.productId as ProductId, tx);
    if (product === null) return review('PRODUCT_MAPPING_UNRESOLVED');
    const shapeId = await this.deps.store.shapeIdForProduct(scope, product.id, tx);
    const currency = await this.deps.settings.valueOf<SalesCurrencyCode>(
      scope,
      'sales.currency',
      tx,
    );
    if (shapeId !== null) {
      const shape = await this.deps.shapes.findById(scope, shapeId, tx);
      if (!legacyShapeAdoptable(shape, product)) return review('PRODUCT_MAPPING_UNRESOLVED');
    } else if (product.status !== 'ACTIVE' || product.price === null) {
      return review('PRODUCT_MAPPING_UNRESOLVED');
    }
    if (product.price === null || product.price.currency !== currency) {
      return review('PRODUCT_MAPPING_UNRESOLVED');
    }
    // A renewal must be shape-compatible (quoteRenewal): otherwise it is adopted unrenewable.
    if ((usage.expiresAt !== null) !== product.specification.durationDays > 0) {
      return review('PRODUCT_MAPPING_UNRESOLVED');
    }

    // The panel's row lock, the one capacity `reserve` takes first (§3).
    const panel = await this.deps.store.lockPanel(scope, match.panelId, tx);
    if (panel === null) return review('PANEL_UNMAPPED');
    if (panel.providerType !== 'rickpanel') return review('SUBSCRIPTION_REF_BLOCKED');
    const namespaceKey = namespaceKeyFor(panel.providerType, panel.baseUrl);
    if (
      await this.deps.store.usernameTaken(
        scope,
        { panelId: panel.id, namespaceKey, canonical: match.username },
        tx,
      )
    ) {
      return review('CONFLICTING_EXISTING_ENTITY');
    }

    return {
      customerId,
      panelId: panel.id,
      productId: product.id,
      currency,
      line: {
        title: product.title,
        durationDays: product.specification.durationDays,
        trafficBytes: product.specification.trafficBytes,
        deviceLimit: product.specification.deviceLimit,
      },
      state,
      providerUsername: exact,
      canonical: match.username,
      namespaceKey,
      expiresAt: usage.expiresAt,
      trafficLimitBytes: usage.totalBytes ?? 0n,
      trafficUsedBytes: usage.usedBytes,
      observedAt: runtime.observedAt,
      subscriptionUrl: runtime.subscriptionUrl,
    };
  }

  private async write(
    scope: TenantContext,
    actor: ActorContext,
    command: LegacyAdoptionCommand,
    plan: Plan,
    tx: TransactionScope,
  ): Promise<LegacyAdoptionOutcome> {
    const now = this.deps.clock.now();
    const orderId = this.deps.ids.uuid();
    const serviceId = this.deps.ids.uuid();
    const settledAt =
      command.legacyPurchasedAt !== null && command.legacyPurchasedAt.getTime() <= now.getTime()
        ? command.legacyPurchasedAt
        : now;
    // A figure read "in the future" is a skewed importer clock; it is never stored as such.
    const usageSyncedAt = plan.observedAt.getTime() <= now.getTime() ? plan.observedAt : now;

    await this.deps.store.insertAdoption(
      scope,
      {
        orderId,
        serviceId,
        reservationId: this.deps.ids.uuid(),
        customerId: plan.customerId,
        panelId: plan.panelId,
        productId: plan.productId,
        line: plan.line,
        currency: plan.currency,
        settledAt,
        service: {
          state: plan.state,
          providerUsername: plan.providerUsername,
          // Minted the normal way (C3 constraint 2), never derived from the legacy row.
          subscriptionRef: this.deps.secrets.hex(SUBSCRIPTION_REF_BYTES),
          providerClientId: this.deps.secrets.clientId(),
          subscriptionUrl: plan.subscriptionUrl,
          expiresAt: plan.expiresAt,
          trafficLimitBytes: plan.trafficLimitBytes,
          trafficUsedBytes: plan.trafficUsedBytes,
          usageSyncedAt,
        },
        reservation: { namespaceKey: plan.namespaceKey, username: plan.canonical },
        now,
      },
      tx,
    );

    await this.record(
      scope,
      command,
      { status: 'IMPORTED', entityType: 'SERVICE', entityId: serviceId, reasonCode: null },
      tx,
    );

    // Item 8: nothing already behind the service is ever announced.
    const seed = await this.deps.reminders.seedPassedThresholds(scope, serviceId, tx);

    const counted = await this.deps.capacity.read(scope, plan.panelId, now, tx);
    const capacity: AdoptionCapacity = {
      maxServices: counted?.maxServices ?? null,
      usedAfter: counted?.used ?? 0,
      overCap:
        counted !== null && counted.maxServices !== null && counted.used > counted.maxServices,
    };

    await this.deps.audit.record(
      scope,
      actor,
      {
        action: AUDIT_ADOPT,
        entityType: 'Service',
        entityId: serviceId,
        before: null,
        after: {
          orderId,
          customerId: plan.customerId,
          panelId: plan.panelId,
          productId: plan.productId,
          state: plan.state,
          origin: 'LEGACY_ADOPTION',
          runId: command.runId,
          legacyTable: LEGACY_TABLE,
          // Whether a link was stored, never the link: it is a bearer capability.
          hasLink: plan.subscriptionUrl !== null,
          remindersSeeded: seed.passed.length,
          capacity,
        },
        result: 'SUCCESS',
      },
      tx,
    );
    await this.deps.outbox.write(tx, actor, {
      eventType: 'ServiceAdopted',
      aggregateType: 'Service',
      aggregateId: serviceId,
      payload: {
        customerId: plan.customerId,
        orderId,
        panelId: plan.panelId,
        state: plan.state,
      },
    });

    return {
      kind: 'ADOPTED',
      serviceId,
      orderId,
      customerId: plan.customerId,
      panelId: plan.panelId,
      state: plan.state,
      capacity,
      remindersSeeded: seed.passed,
    };
  }

  /** The map row; a refusal here is a broken invariant, never an outcome to absorb. */
  private async record(
    scope: TenantContext,
    command: LegacyAdoptionCommand,
    decision: LegacyImportDecision,
    tx: TransactionScope,
  ): Promise<void> {
    const written = await this.deps.map.recordDecision(
      scope,
      {
        runId: command.runId,
        legacyTable: LEGACY_TABLE,
        legacyId: command.legacyInvoiceKey,
        checksum: command.sourceChecksum,
        decision,
        now: this.deps.clock.now(),
      },
      tx,
    );
    if (written.kind === 'REFUSED') {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        `The legacy import map refused this decision (${written.reason}).`,
      );
    }
  }

  private async auditDecision(
    scope: TenantContext,
    actor: ActorContext,
    command: LegacyAdoptionCommand,
    status: 'SKIPPED' | 'MANUAL_REVIEW',
    reason: string,
    tx: TransactionScope,
  ): Promise<void> {
    await this.deps.audit.record(
      scope,
      actor,
      {
        action: AUDIT_DECIDE,
        entityType: 'LegacyImportMap',
        entityId: null,
        before: null,
        after: { legacyTable: LEGACY_TABLE, runId: command.runId, status, reason },
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
}

/** What `decide` hands `write` when nothing needs review. */
interface Plan {
  readonly customerId: string;
  readonly panelId: string;
  readonly productId: string;
  readonly currency: SalesCurrencyCode;
  readonly line: {
    readonly title: string;
    readonly durationDays: number;
    readonly trafficBytes: bigint;
    readonly deviceLimit: number | null;
  };
  readonly state: 'ACTIVE' | 'SUSPENDED' | 'EXPIRED';
  readonly providerUsername: string;
  readonly canonical: string;
  readonly namespaceKey: string;
  readonly expiresAt: Date | null;
  readonly trafficLimitBytes: bigint;
  readonly trafficUsedBytes: bigint;
  readonly observedAt: Date;
  readonly subscriptionUrl: string | null;
}
