import {
  COMMERCE_ERROR_CODES,
  MAX_ORDER_QUANTITY,
  ORDER_MACHINE,
  errors,
  isNexaError,
  money,
  nextState,
  uuidV7Schema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type OrderId,
  type PanelId,
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
import type { CustomerRepository } from '../../customers/application/ports.js';
import type { OrderRecord, OrderRepository } from '../../orders/application/ports.js';
import { quoteTrial } from '../../orders/application/order-pricing.js';
import { isFreeTrial } from '../../orders/application/undeliverable-order-refunder.js';
import type { ProvisioningService } from '../../provisioning/application/provisioning.service.js';
import type { OrderUsernameLane } from '../../provisioning/application/username-lane.js';
import type { WalletRepository } from '../../wallet/application/ports.js';
import type { PanelSalesGate } from '../../../platform/panels/application/panel-sales-gate.js';
import type { PanelRepository } from '../../../platform/panels/application/ports.js';
import type {
  PanelTrialConfigRecord,
  PanelTrialConfigRepository,
  TrialGrantRepository,
  TrialOverrideRepository,
} from './ports.js';
import { trialAllowanceFor } from './trial-allowance.js';
import { trialOffersFor, type TrialOffer } from './trial-offers.js';

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

/**
 * Whether this customer could take a trial right now, and if so on which panels — one or
 * more, never zero — and if not, why.
 */
export type TrialAvailability =
  | { readonly available: true; readonly offers: readonly TrialOffer[] }
  | { readonly available: false; readonly reason: TrialRejection };

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
  /** The customer's custom limit, read by the one allowance evaluator. */
  readonly overrides: Pick<TrialOverrideRepository, 'find'>;
  readonly orders: OrderRepository;
  /** R1: each panel's trial — what a trial IS since the product setting was retired. */
  readonly configs: Pick<PanelTrialConfigRepository, 'find' | 'list'>;
  /** The panel's name, the title of a trial whose configuration names none. */
  readonly panels: Pick<PanelRepository, 'find' | 'findMany'>;
  readonly customers: Pick<CustomerRepository, 'findById'>;
  /** The customer row lock — the same lock settlement and the wallet take. */
  readonly wallet: Pick<WalletRepository, 'lockCustomer'>;
  readonly usernames: Pick<OrderUsernameLane, 'require' | 'modesFor'>;
  /**
   * The catalogue's own panel eligibility, read-only. Only the offer asks it: the claim
   * decides the panel again under its lock in `prepareFulfilment`.
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
 * The trial, end to end on the application side. `docs/wp6-audit.md` §2; R1.
 *
 * A trial is an ORDER — purpose `TRIAL`, total zero — that reaches `PAID` through the
 * order machine's `GRANT` edge and is then provisioned by exactly the path a purchase
 * takes: `ProvisioningService.prepareFulfilment` decides the panel under its lock and
 * `planForSettledOrder` records the service and the `PROVISION` operation. Nothing here
 * talks to a panel, and nothing here touches money: no wallet entry, no payment, no
 * discount, no referral, no reseller margin (plan §7.1).
 *
 * Since R1 the order names NO product. What it grants is the chosen panel's trial
 * configuration (`panel_trial_configs`): its traffic, its hours — frozen on the order's
 * line, so editing the configuration later changes no trial already issued — and its
 * name as the line's title. The service the order produces is marked `is_trial` by the
 * database itself. Delivery, the service card and its actions are the ordinary ones.
 *
 * Eligibility is ADR-0015's limit minus used, decided under the customer's row lock so
 * two concurrent claims serialise and the second counts the first. The limit is the
 * customer's override or `trial.limit_per_customer`; used is the customer's grants that
 * are neither released nor reset (`trialAllowanceFor`). A trial whose
 * service definitively could not be created is released by
 * `UndeliverableOrderRefunder`, and stops counting.
 */
export class TrialService {
  constructor(private readonly deps: TrialServiceDeps) {}

  /**
   * Whether to OFFER a trial, and on which panels. A courtesy for the surface, never
   * trusted: `claim` decides every one of these again inside its transaction, under the
   * customer's lock and the panel's.
   *
   * The panels are `trialOffersFor`'s: enabled, eligible by the one evaluator, and able
   * to name the account themselves. Without that the button was offered for a trial the
   * tap could only refuse (Codex, PR #64).
   */
  async availabilityFor(
    scope: TenantContext,
    actor: ActorContext,
    customerId: UserId,
  ): Promise<TrialAvailability> {
    await this.deps.guard.check(scope, actor, TRIAL_CLAIM_PERMISSION);
    const refusal = await this.refusalBeforeWriting(scope, customerId);
    if (refusal !== null) return { available: false, reason: refusal };
    const offers = await trialOffersFor(this.deps, scope);
    if (offers.length > 0) return { available: true, offers };
    /*
     * UNCONFIGURED when no panel has an enabled trial at all, PRODUCT_UNAVAILABLE when one
     * has and none can take a new account now. The customer hears one sentence for both;
     * the operator's audit row does not.
     */
    const configured = (await this.deps.configs.list(scope)).some((config) => config.enabled);
    return { available: false, reason: configured ? 'PRODUCT_UNAVAILABLE' : 'UNCONFIGURED' };
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
    input: {
      readonly idempotencyKey: string;
      /** The panel whose trial the customer chose — or the only one offered. */
      readonly panelId: string;
    },
  ): Promise<TrialClaimResult> {
    const requestHash = hashRequest({ customerId, kind: 'TRIAL', panelId: input.panelId });
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

          const refusal = await this.refusalBeforeWriting(scope, customerId, tx);
          if (refusal !== null) return { outcome: 'REFUSED', reason: refusal } as const;
          /*
           * The chosen panel's trial, read inside the transaction: a trial switched off, or
           * a panel id the customer never had offered, is refused here and nothing is
           * written. Whether the panel may take the account is decided below, under its
           * lock, by the evaluator settlement uses.
           */
          const config = await this.configFor(scope, input.panelId, tx);
          if (config === null) throw new TrialRefused('PRODUCT_UNAVAILABLE');
          const panel = await this.deps.panels.find(scope, config.panelId, tx);
          if (panel === null) throw new TrialRefused('PRODUCT_UNAVAILABLE');
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
           * The snapshot: the panel, the traffic and the hours, copied from the panel's
           * trial configuration as it reads NOW, and frozen by `nexa_orders_snapshot_guard`
           * the moment `confirmed_at` is written below — so editing the trial later
           * changes no trial already issued. No product and no category: a trial is not
           * something a customer bought or browsed to, and a null is the honest value for
           * both. `durationDays` is the hours rounded UP, for every reader that knows only
           * days; the provisioner computes the expiry from the hours.
           */
          const draft = await this.deps.orders.create(
            scope,
            {
              id: orderId,
              customerId,
              purpose: 'TRIAL',
              line: {
                productId: null,
                panelId: config.panelId,
                title: config.label ?? panel.panel.name,
                category: null,
                specification: {
                  durationDays: Math.ceil(config.durationHours / 24),
                  trafficBytes: config.trafficBytes,
                  deviceLimit: null,
                },
                durationHours: config.durationHours,
                unitPrice: money(0n, currency),
                quantity: MAX_ORDER_QUANTITY,
              },
              totals: quoteTrial(null, currency, now),
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
              { orderId: draft.id, customerId, panelId: config.panelId, expiresAt },
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
              productId: null,
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
            payload: { customerId, productId: null, serviceId: service.id, panelId: config.panelId },
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
                panelId: config.panelId,
                durationHours: config.durationHours,
                trafficBytes: config.trafficBytes.toString(),
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
   * Every refusal about the CUSTOMER that can be decided without writing anything, in the
   * order a customer's situation is most usefully described. `null` means none applies.
   *
   * Shared by `availabilityFor` and `claim` so the button and the tap cannot disagree
   * about what makes a trial available — the second only adds the checks that need a row
   * to exist first.
   */
  private async refusalBeforeWriting(
    scope: TenantContext,
    customerId: UserId,
    tx?: TransactionScope,
  ): Promise<TrialRejection | null> {
    if (!(await this.deps.features.isEnabled(scope, 'trials', tx))) return 'UNCONFIGURED';

    const customer = await this.deps.customers.findById(scope, customerId, tx);
    if (customer === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
    }
    if (customer.status === 'BLOCKED') return 'CUSTOMER_BLOCKED';

    /*
     * The ONE allowance evaluator, the same function the operator's view renders
     * (`docs/wp6-audit.md` B1): the customer's override when there is one, the global
     * limit otherwise, minus the grants that are neither released nor reset. Zero is
     * zero trials, never unlimited (ADR-0015): `used >= 0` refuses everyone.
     */
    const allowance = await trialAllowanceFor(this.deps, scope, customerId, tx);
    if (allowance.used >= allowance.effectiveLimit) return 'LIMIT_REACHED';
    return null;
  }

  /**
   * The chosen panel's trial, when it can be issued: configured on this tenant's panel
   * and enabled. A panel id that is not a uuid is simply no trial — it came from a
   * customer's callback, which Telegram signs nothing about.
   */
  private async configFor(
    scope: TenantContext,
    panelId: string,
    tx: TransactionScope,
  ): Promise<(PanelTrialConfigRecord & { readonly panelId: PanelId }) | null> {
    if (!uuidV7Schema.safeParse(panelId).success) return null;
    const config = await this.deps.configs.find(scope, panelId, tx);
    return config === null || !config.enabled ? null : config;
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
