import {
  COMMERCE_ERROR_CODES,
  MAX_ORDER_QUANTITY,
  ORDER_MACHINE,
  errors,
  isNexaError,
  money,
  nextState,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type OrderId,
  type PermissionKey,
  type SalesCurrencyCode,
  type TenantContext,
  type TrialRejection,
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
import type { FeatureFlagResolver } from '../../../control/features/application/feature-flags.service.js';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { ProductRecord, ProductRepository } from '../../catalog/application/ports.js';
import type { CustomerRepository } from '../../customers/application/ports.js';
import type { OrderRecord, OrderRepository } from '../../orders/application/ports.js';
import { quoteTrial } from '../../orders/application/order-pricing.js';
import { isFreeTrial } from '../../orders/application/undeliverable-order-refunder.js';
import type { ProvisioningService } from '../../provisioning/application/provisioning.service.js';
import type { OrderUsernameLane } from '../../provisioning/application/username-lane.js';
import type { WalletRepository } from '../../wallet/application/ports.js';
import type { PanelSalesGate } from '../../../platform/panels/application/panel-sales-gate.js';
import type { TrialGrantRepository } from './ports.js';

/**
 * The permission a customer's own trial claim is charged against.
 *
 * The same one every customer-initiated commercial write takes — `ORDER_PLACE_PERMISSION`
 * and `COMMERCIAL_ACTION_PERMISSION` — because the actor is the same: the Telegram
 * webhook's `SYSTEM_JOB`, acting for a customer the update resolved. Ownership is not a
 * permission; it is the customer id the surface passes, resolved from the update.
 */
export const TRIAL_CLAIM_PERMISSION: PermissionKey = 'maintenance.run';

const TRIAL_NAMESPACE = 'TELEGRAM' as const;

/**
 * The username lane's refusals that mean "this panel cannot name a trial account", as
 * opposed to a fault. Each is an answer about the PANEL's policy or namespace, so each
 * becomes `PRODUCT_UNAVAILABLE`: the customer cannot fix any of them by trying again.
 */
const USERNAME_REFUSALS: readonly string[] = [
  COMMERCE_ERROR_CODES.SERVICE_USERNAME_REQUIRED,
  COMMERCE_ERROR_CODES.SERVICE_USERNAME_MODE_UNAVAILABLE,
  COMMERCE_ERROR_CODES.SERVICE_USERNAME_TAKEN,
  COMMERCE_ERROR_CODES.SERVICE_USERNAME_UNGENERATABLE,
  COMMERCE_ERROR_CODES.SERVICE_USERNAME_EXHAUSTED,
];

/** Whether this customer could take a trial right now, and if not, why. */
export type TrialAvailability =
  { readonly available: true } | { readonly available: false; readonly reason: TrialRejection };

/**
 * What a claim's idempotency record holds: the trial it issued, or the refusal it gave.
 *
 * A refusal is remembered too (Codex, PR #64). Without it, two deliveries of one
 * Telegram update could answer "issued" and "unavailable" to the same tap, and a
 * refusal replayed after the configuration changed could issue a trial for an update
 * that was already answered.
 */
type TrialReplay =
  { readonly orderId: string; readonly serviceId: string } | { readonly refused: TrialRejection };

export type TrialClaimResult =
  | {
      readonly outcome: 'ISSUED';
      readonly orderId: OrderId;
      readonly serviceId: string;
      /** True when this call answered from the idempotency record. */
      readonly replayed: boolean;
    }
  | {
      readonly outcome: 'REFUSED';
      readonly reason: TrialRejection;
      /** Present when this call answered from the idempotency record. */
      readonly replayed?: true;
    };

/** The configured trial product, with the panel it is issued on known to exist. */
type TrialProduct = ProductRecord & { readonly panelId: NonNullable<ProductRecord['panelId']> };

/**
 * A refusal discovered AFTER something was written, carried out of the transaction so
 * the writes roll back and the caller still gets an answer rather than an error.
 */
class TrialRefused extends Error {
  constructor(readonly reason: TrialRejection) {
    super(`trial refused: ${reason}`);
  }
}

export interface TrialServiceDeps {
  readonly grants: TrialGrantRepository;
  readonly orders: OrderRepository;
  readonly products: ProductRepository;
  readonly customers: Pick<CustomerRepository, 'findById'>;
  /** The customer row lock — the same lock settlement and the wallet take. */
  readonly wallet: Pick<WalletRepository, 'lockCustomer'>;
  readonly usernames: Pick<OrderUsernameLane, 'require' | 'modesFor'>;
  /**
   * The catalogue's own panel eligibility, read-only. Only `availabilityFor` asks it:
   * the claim decides the panel again under its lock in `prepareFulfilment`.
   */
  readonly panelSales: Pick<PanelSalesGate, 'evaluateMany'>;
  readonly provisioning: Pick<ProvisioningService, 'prepareFulfilment' | 'planForSettledOrder'>;
  readonly settings: SettingsResolver;
  readonly features: FeatureFlagResolver;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * The trial, end to end on the application side. `docs/wp6-audit.md` §2.
 *
 * A trial is an ORDER — purpose `TRIAL`, total zero — that reaches `PAID` through the
 * order machine's `GRANT` edge and is then provisioned by exactly the path a purchase
 * takes: `ProvisioningService.prepareFulfilment` decides the panel under its lock and
 * `planForSettledOrder` records the service and the `PROVISION` operation. Nothing here
 * talks to a panel, and nothing here touches money: no wallet entry, no payment, no
 * discount, no referral, no reseller margin (plan §7.1).
 *
 * Eligibility is ADR-0015's limit minus used, decided under the customer's row lock so
 * two concurrent claims serialise and the second counts the first. The limit is
 * `trial.limit_per_customer`; used is the customer's unreleased grants. A trial whose
 * service definitively could not be created is released by
 * `UndeliverableOrderRefunder`, and stops counting.
 */
export class TrialService {
  constructor(private readonly deps: TrialServiceDeps) {}

  /**
   * Whether to OFFER a trial. A courtesy for the surface, never trusted: `claim`
   * decides every one of these again inside its transaction, under the lock.
   */
  async availabilityFor(
    scope: TenantContext,
    actor: ActorContext,
    customerId: UserId,
  ): Promise<TrialAvailability> {
    await this.deps.guard.check(scope, actor, TRIAL_CLAIM_PERMISSION);
    const decision = await this.decideBeforeWriting(scope, customerId);
    if ('refusal' in decision) return { available: false, reason: decision.refusal };
    /*
     * The two things a claim would find out only after writing: whether the panel can
     * take a new account now, and whether its username policy lets the installation
     * choose the name. Asked of the SAME evaluator the catalogue lists by and the same
     * lane the claim reserves through, read-only. Without them the button was offered
     * for a trial the tap could only refuse (Codex, PR #64).
     */
    const panelId = decision.product.panelId;
    const verdict = (await this.deps.panelSales.evaluateMany(scope, [panelId])).get(panelId);
    if (verdict?.eligible !== true) return { available: false, reason: 'PRODUCT_UNAVAILABLE' };
    if (!(await this.deps.usernames.modesFor(scope, panelId)).includes('AUTOMATIC')) {
      return { available: false, reason: 'PRODUCT_UNAVAILABLE' };
    }
    return { available: true };
  }

  /**
   * Take a trial for this customer. Idempotent by `idempotencyKey`.
   *
   * Every refusal is an ANSWER, not an error: the surface says one sentence for all of
   * them, and the reason is kept in the audit row for an operator.
   */
  async claim(
    scope: TenantContext,
    actor: ActorContext,
    customerId: UserId,
    input: { readonly idempotencyKey: string },
  ): Promise<TrialClaimResult> {
    const requestHash = hashRequest({ customerId, kind: 'TRIAL' });
    const denial = { action: 'trial.claim', entityType: 'Customer', entityId: customerId };
    await this.authorize(scope, actor, denial);

    const replayed = await this.replay(scope, input.idempotencyKey, requestHash);
    if (replayed !== null) return replayed;

    const now = this.deps.clock.now();
    const orderId = this.deps.ids.uuid() as OrderId;

    let result: TrialClaimResult;
    try {
      result = await runAuthorizedMutation(
        this.mutationDeps(),
        scope,
        actor,
        TRIAL_CLAIM_PERMISSION,
        denial,
        async (tx) => {
          await this.assertScopeActive(scope, tx);

          /*
           * The customer's row lock FIRST, before any read the decision rests on — and
           * before the panel's, which `prepareFulfilment` takes below. Customer before
           * panel is the order settlement uses, so the two cannot deadlock.
           */
          if (!(await this.deps.wallet.lockCustomer(scope, customerId, tx))) {
            throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
          }
          /*
           * The key again, now that the lock is held. Two deliveries of one update both
           * miss the lookup above; the second waits here for the first, and the first
           * has committed its record by the time the lock is released. Answering from
           * it makes the second an exact replay rather than a fresh decision that finds
           * the limit spent and says "unavailable" to a tap that was just served.
           */
          const already = await this.replay(scope, input.idempotencyKey, requestHash);
          if (already !== null) return already;

          const decision = await this.decideBeforeWriting(scope, customerId, tx);
          if ('refusal' in decision) {
            return { outcome: 'REFUSED', reason: decision.refusal } as const;
          }
          // The record the decision approved, carried rather than read again: a second
          // read could find the product gone and had to be cast past that possibility.
          const product = decision.product;
          const currency = await this.deps.settings.valueOf<SalesCurrencyCode>(
            scope,
            'sales.currency',
            tx,
          );
          const expiryMinutes = await this.deps.settings.valueOf<number>(
            scope,
            'sales.order_expiry_minutes',
            tx,
          );
          const expiresAt = new Date(now.getTime() + expiryMinutes * 60_000);

          /*
           * The snapshot. Panel, duration, traffic and device limit are copied from the
           * product as it reads NOW, and `nexa_orders_snapshot_guard` freezes them the
           * moment `confirmed_at` is written below — so editing the trial product later
           * changes no trial already issued (plan §7.1). No category: a trial is not
           * something a customer browsed to, and the column's null is its honest value.
           */
          const draft = await this.deps.orders.create(
            scope,
            {
              id: orderId,
              customerId,
              purpose: 'TRIAL',
              line: {
                productId: product.id,
                panelId: product.panelId,
                title: product.title,
                category: null,
                specification: product.specification,
                unitPrice: money(0n, currency),
                quantity: MAX_ORDER_QUANTITY,
              },
              totals: quoteTrial(product, currency, now),
              expiresAt,
              now,
            },
            tx,
          );
          if (!isFreeTrial(draft)) {
            // `orderIsFreeTrial` is the guard on `GRANT`. Unreachable while `quoteTrial`
            // is what priced this, and asserted rather than assumed, because the edge
            // below is the one way to `PAID` that no money guards.
            throw new Error(`trial order ${draft.id} is not a zero-total TRIAL`);
          }

          /*
           * The username, by the panel's automatic mode — a trial has no step where the
           * customer types one. A panel whose policy requires a typed name cannot take a
           * trial, and says so, rather than being handed an `nx…` name its operator
           * chose to forbid.
           */
          try {
            await this.deps.usernames.require(
              scope,
              { orderId: draft.id, customerId, panelId: product.panelId, expiresAt },
              tx,
            );
          } catch (error) {
            if (isNexaError(error) && USERNAME_REFUSALS.includes(error.code)) {
              throw new TrialRefused('PRODUCT_UNAVAILABLE');
            }
            throw error;
          }

          const to = nextState(ORDER_MACHINE, 'DRAFT', 'GRANT');
          if (to === null) throw new Error('ORDER_MACHINE no longer allows GRANT from DRAFT.');
          const moved = await this.deps.orders.transition(
            scope,
            draft.id,
            'DRAFT',
            to,
            { confirmedAt: now, settledAt: now },
            now,
            tx,
          );
          if (!moved) throw new Error(`trial order ${draft.id} left DRAFT under its own insert`);
          const granted: OrderRecord = { ...draft, state: to, confirmedAt: now, settledAt: now };

          /*
           * The panel, decided by the one evaluator settlement uses, under the panel's
           * lock and against its live capacity. `REFUND` so an ineligible panel comes
           * back as an answer: a trial moved no money, so there is nothing to refund and
           * the whole transaction — order, name, everything — rolls back instead.
           */
          const fulfilment = await this.deps.provisioning.prepareFulfilment(
            scope,
            granted,
            tx,
            'REFUND',
          );
          if (fulfilment.outcome === 'UNFULFILLABLE') throw new TrialRefused('PRODUCT_UNAVAILABLE');

          const { service } = await this.deps.provisioning.planForSettledOrder(
            scope,
            actor,
            granted,
            now,
            tx,
          );

          const recorded = await this.deps.grants.create(
            scope,
            {
              id: this.deps.ids.uuid(),
              customerId,
              orderId: granted.id,
              productId: product.id,
              serviceId: service.id,
              now,
            },
            tx,
          );
          if (!recorded) {
            throw new Error(`trial order ${granted.id} already has a grant; the order id is new`);
          }

          await this.deps.outbox.write(tx, actor, {
            eventType: 'TrialIssued',
            aggregateType: 'Trial',
            aggregateId: granted.id,
            payload: { customerId, productId: product.id, serviceId: service.id },
          });

          await this.deps.audit.record(
            scope,
            actor,
            {
              action: 'trial.claim',
              entityType: 'Customer',
              entityId: customerId,
              before: null,
              after: {
                orderId: granted.id,
                serviceId: service.id,
                productId: product.id,
                panelId: product.panelId,
                durationDays: product.specification.durationDays,
                trafficBytes: product.specification.trafficBytes.toString(),
              },
              result: 'SUCCESS',
            },
            tx,
          );

          await rememberOnce(
            this.deps.idempotency,
            scope,
            TRIAL_NAMESPACE,
            input.idempotencyKey,
            requestHash,
            { orderId: granted.id, serviceId: service.id },
            tx,
          );
          return {
            outcome: 'ISSUED',
            orderId: granted.id,
            serviceId: service.id,
            replayed: false,
          } as const;
        },
      );
    } catch (error) {
      if (!(error instanceof TrialRefused)) throw error;
      result = { outcome: 'REFUSED', reason: error.reason };
    }

    if (result.outcome === 'REFUSED' && !('replayed' in result)) {
      await this.recordRefusal(scope, actor, customerId, result.reason, {
        key: input.idempotencyKey,
        requestHash,
      });
    }
    return result;
  }

  /**
   * Every refusal that can be decided without writing anything, in the order a
   * customer's situation is most usefully described. `null` means none applies.
   *
   * Shared by `availabilityFor` and `claim` so the button and the tap cannot disagree
   * about what makes a trial available — the second only adds the checks that need a
   * row to exist first.
   */
  private async decideBeforeWriting(
    scope: TenantContext,
    customerId: UserId,
    tx?: TransactionScope,
  ): Promise<{ readonly refusal: TrialRejection } | { readonly product: TrialProduct }> {
    if (!(await this.deps.features.isEnabled(scope, 'trials', tx))) {
      return { refusal: 'UNCONFIGURED' };
    }
    const productId = await this.deps.settings.valueOf<string | null>(
      scope,
      'trial.product_id',
      tx,
    );
    if (productId === null) return { refusal: 'UNCONFIGURED' };

    const customer = await this.deps.customers.findById(scope, customerId, tx);
    if (customer === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
    }
    if (customer.status === 'BLOCKED') return { refusal: 'CUSTOMER_BLOCKED' };

    const limit = await this.deps.settings.valueOf<number>(scope, 'trial.limit_per_customer', tx);
    const used = await this.deps.grants.countCounting(scope, customerId, tx);
    // Zero is zero trials, never unlimited (ADR-0015): `used >= 0` refuses everyone.
    if (used >= limit) return { refusal: 'LIMIT_REACHED' };

    const product = await this.configuredProduct(scope, tx);
    if (product === null) return { refusal: 'PRODUCT_UNAVAILABLE' };
    return { product };
  }

  /**
   * The configured trial product, when it can be issued: it exists in this tenant, it
   * is ACTIVE and it names a panel. A price is not required — a trial product usually
   * has none, which is what keeps it out of the catalogue.
   */
  private async configuredProduct(
    scope: TenantContext,
    tx?: TransactionScope,
  ): Promise<TrialProduct | null> {
    const productId = await this.deps.settings.valueOf<string | null>(
      scope,
      'trial.product_id',
      tx,
    );
    if (productId === null) return null;
    const product = await this.deps.products.findById(scope, productId as ProductRecord['id'], tx);
    if (product === null || product.status !== 'ACTIVE' || product.panelId === null) return null;
    return { ...product, panelId: product.panelId };
  }

  /**
   * The claim's idempotency record, as an answer — or null to decide afresh.
   *
   * An issued record whose order is gone (only a restore produces that) is decided
   * again rather than reported as a trial whose rows no longer exist.
   */
  private async replay(
    scope: TenantContext,
    key: string,
    requestHash: string,
  ): Promise<TrialClaimResult | null> {
    const found = await this.deps.idempotency.find<TrialReplay>(
      scope,
      TRIAL_NAMESPACE,
      key,
      requestHash,
    );
    if (found === null) return null;
    if ('refused' in found.result) {
      return { outcome: 'REFUSED', reason: found.result.refused, replayed: true };
    }
    const order = await this.deps.orders.findById(scope, found.result.orderId as OrderId);
    if (order === null) return null;
    return {
      outcome: 'ISSUED',
      orderId: order.id,
      serviceId: found.result.serviceId,
      replayed: true,
    };
  }

  /**
   * The reason a trial was refused, where an operator can find it — and under the
   * claim's key, so a redelivered update is answered with the same refusal.
   *
   * `remember`, not `rememberOnce`: a concurrent delivery of the same update that
   * reached the same refusal has already stored the same answer, and losing that race
   * is not a conflict worth an error.
   */
  private async recordRefusal(
    scope: TenantContext,
    actor: ActorContext,
    customerId: UserId,
    reason: TrialRejection,
    key: { readonly key: string; readonly requestHash: string },
  ): Promise<void> {
    await this.deps.uow.run(scope, async (tx) => {
      await this.deps.idempotency.remember<TrialReplay>(
        scope,
        TRIAL_NAMESPACE,
        key.key,
        key.requestHash,
        { refused: reason },
        tx,
      );
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: 'trial.claim',
          entityType: 'Customer',
          entityId: customerId,
          before: null,
          after: { refused: reason },
          result: 'FAILED',
        },
        tx,
      );
    });
  }

  private async assertScopeActive(scope: TenantContext, tx: TransactionScope): Promise<void> {
    if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'This installation has stopped accepting work.',
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
      await this.deps.guard.check(scope, actor, TRIAL_CLAIM_PERMISSION);
    } catch (error) {
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        TRIAL_CLAIM_PERMISSION,
        denial,
        error,
      );
      throw error;
    }
  }
}
